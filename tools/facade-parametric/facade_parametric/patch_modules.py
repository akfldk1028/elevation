"""Clip a complete evaluated module, never fit a new aperture into a fold fragment.

Coordinates are (host u, host z, fractional outward depth). Manifold's boolean
intersection caps cut solids, including seams through the funnel and concave hosts.
The instance carries this mesh to both the drawing and the 3D compiler.
"""
import math
import numpy as np
import manifold3d as md
from shapely.geometry import Polygon


def _open(ring):
    return ring[:-1] if ring[0] == ring[-1] else ring


def _solid(cell):
    if not cell.get('outline_far_m'):
        return md.CrossSection([_open(cell['outline_m'])]).extrude(1)
    tile, mouth, throat = [_open(cell[k]) for k in ('tile_m','outline_m','outline_far_m')]
    if not Polygon(tile).exterior.is_ccw:
        tile, mouth, throat = [list(reversed(r)) for r in (tile,mouth,throat)]
    profile=cell.get('profile') or {'kind':'linear','rings':0}
    sections=[]
    for i in range(profile.get('rings',0)):
        t=(i+1)/(profile['rings']+1)
        blend, depth=(math.sin(t*math.pi/2),1-math.cos(t*math.pi/2)) if profile['kind']=='quarter_ellipse' else (t,t)
        sections.append([[u+(throat[j][0]-u)*blend,v+(throat[j][1]-v)*blend,1-depth] for j,(u,v) in enumerate(mouth)])
    blocks=[[[u,v,1] for u,v in tile],[[u,v,1] for u,v in mouth],*sections,
            [[u,v,0] for u,v in throat],[[u,v,0] for u,v in tile]]
    count=len(tile); triangles=[]
    at=lambda block,i:block*count+i%count
    def quad(a,b,c,d): triangles.extend([[a,b,c],[a,c,d]])
    last=len(blocks)-1
    for i in range(count):
        j=i+1
        quad(at(0,i),at(0,j),at(1,j),at(1,i))
        quad(at(last,j),at(last,i),at(last-1,i),at(last-1,j))
        quad(at(last,i),at(last,j),at(0,j),at(0,i))
        for b in range(1,last-1): quad(at(b,i),at(b,j),at(b+1,j),at(b+1,i))
    solid=md.Manifold(md.Mesh(np.array([v for b in blocks for v in b],dtype=np.float32),np.array(triangles,dtype=np.uint32)))
    if solid.status()!=md.Error.NoError: raise ValueError(f'invalid evaluated module: {solid.status()}')
    return solid


def clip_module(cell, polygon):
    from shapely.affinity import translate
    # Manifold outputs float32. Boolean operations in packed global chart U
    # lose microns at distant courses; work near the cell, then restore double
    # precision coordinates. The source containment tolerance stays unchanged.
    ox,oy=polygon.centroid.x,polygon.centroid.y
    local=dict(cell)
    for key in ('outline_m','outline_far_m','tile_m'):
        if cell.get(key):local[key]=[[u-ox,z-oy] for u,z in cell[key]]
    local_polygon=translate(polygon,xoff=-ox,yoff=-oy)
    rings=[list(local_polygon.exterior.coords)[:-1],*[list(r.coords)[:-1] for r in local_polygon.interiors]]
    mask=md.CrossSection(rings,md.FillRule.EvenOdd).extrude(1)
    solid=_solid(local) ^ mask
    if solid.status()!=md.Error.NoError: raise ValueError(f'wall-patch intersection failed: {solid.status()}')
    if solid.is_empty(): return None
    mesh=solid.to_mesh()
    aperture=Polygon(cell['outline_far_m']).intersection(polygon).area if cell.get('outline_far_m') else 0
    return {'mesh_uzn':{'vertices':[[float(u)+ox,float(z)+oy,float(n)] for u,z,n in mesh.vert_properties[:,:3]],
                        'triangles':mesh.tri_verts.astype(int).tolist()},
            'aperture_area_m2':aperture}


def split_by_wall_patches(instances,segments):
    from .evaluate import fit_points
    from shapely.affinity import translate, affine_transform
    out=[]; offset=0
    for k,seg in enumerate(segments):
        patch=Polygon(seg['rings_m'][0],seg['rings_m'][1:])
        affine=seg.get('chart_affine')
        if affine:
            a,b,c=affine
            patch=affine_transform(patch,[a,b,0,1,c,0])
        shift=seg['u_min_m']-offset
        for cell in instances:
            footprint=Polygon(cell.get('tile_m') or cell['outline_m'])
            x0,_,x1,_=footprint.bounds
            if affine:
                if x1<patch.bounds[0] or x0>patch.bounds[2]:continue
            elif x1<offset or x0>offset+seg['length_m']: continue
            local=dict(cell)
            for key in ('outline_m','outline_far_m','tile_m'):
                if cell.get(key): local[key]=[[x+(0 if affine else shift),y] for x,y in cell[key]]
            overlap=(footprint if affine else translate(footprint,xoff=shift)).intersection(patch)
            if overlap.is_empty or overlap.area<1e-8: continue
            pieces=[overlap] if overlap.geom_type=='Polygon' else list(overlap.geoms)
            for j,piece in enumerate(pieces):
                if piece.geom_type!='Polygon' or piece.area<1e-8: continue
                result=clip_module(local,piece)
                if result is None: continue
                if affine:
                    result['mesh_uzn']['vertices']=[[(u-b*z-c)/a,z,n] for u,z,n in result['mesh_uzn']['vertices']]
                    result['aperture_area_m2']/=a
                    piece=affine_transform(piece,[1/a,-b/a,0,1,-c/a,0])
                part={**cell,**result,'id':f"{cell['id']}-p{k}-{j}",'segment_id':seg['id'],
                      'center_m':[piece.centroid.x,piece.centroid.y],
                      'outline_m':fit_points([list(p) for p in piece.exterior.coords],32)}
                for key in ('outline_far_m','tile_m','profile','throat_scale'): part.pop(key,None)
                out.append(part)
        offset+=seg['length_m']
    return out


def active_patch_indices(lattice,mouth,segments):
    """Allocate only cells touching the unfolded wall domain, not its mostly empty
    rectangle. Indices retain their original basis and phase across every fold."""
    from shapely.affinity import translate, affine_transform
    from .contracts import MAX_CELLS
    if not mouth or mouth.get('kind')!='parallelogram':
        raise ValueError('preserve_pattern currently requires a parallelogram module family')
    a=lattice['basis_a_uv_m'];b=lattice['basis_b_uv_m'];ox,oy=lattice['origin_uv_m']
    det=a[0]*b[1]-a[1]*b[0]
    L,S=[[i*a[0]+j*b[0],i*a[1]+j*b[1]] for i,j in mouth['sides']]
    ou,ov=mouth.get('offset',[0,0])
    tile=Polygon([[s*L[0]+t*S[0]+ou*L[0]+ov*S[0],s*L[1]+t*S[1]+ou*L[1]+ov*S[1]] for s,t in [(-.5,-.5),(.5,-.5),(.5,.5),(-.5,.5)]])
    tx0,ty0,tx1,ty1=tile.bounds
    active=set();offset=0
    for seg in segments:
        patch=Polygon(seg['rings_m'][0],seg['rings_m'][1:])
        if seg.get('chart_affine'):
            ca,cb,cc=seg['chart_affine'];patch=affine_transform(patch,[ca,cb,0,1,cc,0])
        else:patch=translate(patch,xoff=offset-seg['u_min_m'])
        x0,y0,x1,y1=patch.bounds
        corners=[(x-ox,y-oy) for x in [x0-tx1,x1-tx0] for y in [y0-ty1,y1-ty0]]
        ij=[((b[1]*x-b[0]*y)/det,(-a[1]*x+a[0]*y)/det) for x,y in corners]
        i0=max(0,math.floor(min(i for i,j in ij))-1);i1=min(lattice['columns']-1,math.ceil(max(i for i,j in ij))+1)
        j0=max(0,math.floor(min(j for i,j in ij))-1);j1=min(lattice['rows']-1,math.ceil(max(j for i,j in ij))+1)
        for j in range(j0,j1+1):
            shift=lattice.get('stagger_a_fraction',0) if j%2 else 0
            for i in range(i0,i1+1):
                x=ox+(i+shift)*a[0]+j*b[0];y=oy+(i+shift)*a[1]+j*b[1]
                if translate(tile,xoff=x,yoff=y).intersection(patch).area>1e-8: active.add((i,j))
                if len(active)>MAX_CELLS: raise ValueError(f'more than {MAX_CELLS} cells touching wall patches')
        offset+=seg['length_m']
    return [list(p) for p in sorted(active,key=lambda p:(p[1],p[0]))]
