import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {massDir} from './helpers/roots.ts';
import * as facade from '../plugins/elevation-3d/lib/facade-agent/punched-facade.mjs';
import {moduleFitsWallPatch,validateModuleMesh} from '../plugins/elevation-3d/lib/facade-agent/wall-patch.mjs';
import * as wallPatch from '../plugins/elevation-3d/lib/facade-agent/wall-patch.mjs';

test('polygon backing keeps true fold clearance in the wedge omitted by an inscribed rectangle',()=>{
 const patch={rings:[[[0,0],[4,0],[0,4]]],triangles:[[[0,0],[4,0],[0,4]]]};
 assert.equal(typeof wallPatch.openingFitsWallPatch,'function');
 assert.ok(wallPatch.openingFitsWallPatch([[.4,2.3],[.8,2.3],[.4,2.8]],patch,.3));
 assert.ok(!wallPatch.openingFitsWallPatch([[.1,2.3],[.8,2.3],[.1,2.8]],patch,.3),'no fold clearance waiver');
 assert.ok(!wallPatch.openingFitsWallPatch([[.4,2.3],[2,2.3],[.4,2.8]],patch,.3),'no source boundary overflow');
});

test('builder uses actual triangular wall backing and rejects a forged module beyond it',()=>{
 const mesh={vertices:[[0,0,0],[4,0,0],[0,0,4],[0,2,0],[4,2,0],[0,2,4]],
  triangles:[[0,1,2],[3,5,4],[0,3,4],[0,4,1],[1,4,5],[1,5,2],[2,5,3],[2,3,0]]};
 const authority=facade.deriveFacadeSegmentsFromMass({mesh});
 const plane=authority.facade_planes.find(s=>s.normal[1]<-.99);
 const patch=facade.deriveFacadeWallPatches({mesh}).find(p=>p.segment_id===plane.segment_id);
 const shape={vertices:[[.2,3,0],[.5,3,0],[.5,3.2,0],[.2,3.2,0],[.2,3,1],[.5,3,1],[.5,3.2,1],[.2,3.2,1]],
  triangles:[[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]};
 validateModuleMesh(shape);
 assert.ok(moduleFitsWallPatch(shape,patch));
 const primitive={kind:'louvre',segment_id:plane.segment_id,wall_patch:true,mesh_uzn:shape,
  lattice:{family:'test',cell:'a'},depth_m:.3,local_bounds:{u_min:.2,u_max:.5,z_min:3,z_max:3.2}};
 const details=facade.buildTypedFacadeDetails({mesh,floorGuides:{floor_guides_m:[0,4]},facadePlanes:authority,primitives:[primitive]});
 assert.equal(details.length,1);
 assert.ok(details[0].positions.some(v=>v[2]===3.2),'module occupies wall above the old inscribed rectangle');
 const second=structuredClone(primitive);second.lattice.cell='b';
 second.mesh_uzn.vertices=second.mesh_uzn.vertices.map(([u,z,n])=>[u,z-.3,n]);
 second.local_bounds.z_min-=.3;second.local_bounds.z_max-=.3;
 const combined=facade.buildTypedFacadeDetails({mesh,floorGuides:{floor_guides_m:[0,4]},facadePlanes:authority,primitives:[primitive,second]});
 assert.equal(combined.length,1,'same-plane modules share a GLB draw object, without dropping geometry');
 assert.equal(combined[0].positions.length,16);
 assert.equal(combined[0].indices.length,24);
 const table=combined[0].lattice;
 const cells=table.cells.map(row=>Object.fromEntries(table.cell_columns.map((key,i)=>[key,row[i]])));
 assert.deepEqual(cells,[
  {cell:'a',vertex_start:0,vertex_count:8,triangle_start:0,triangle_count:12,design_primitive_index:0},
  {cell:'b',vertex_start:8,vertex_count:8,triangle_start:12,triangle_count:12,design_primitive_index:1},
 ],'compact provenance recovers every original cell and its exact geometry ranges');
 const forged=structuredClone(primitive);
 forged.mesh_uzn.vertices=forged.mesh_uzn.vertices.map(([u,z,n])=>[u+2,z,n]);
 assert.ok(!moduleFitsWallPatch(forged.mesh_uzn,patch));
 assert.throws(()=>facade.buildTypedFacadeDetails({mesh,floorGuides:{floor_guides_m:[0,4]},facadePlanes:authority,primitives:[forged]}),/outside verified MASS/);
 const open=structuredClone(shape);open.triangles.pop();
 assert.throws(()=>validateModuleMesh(open),/closed outward solid/);
});

test('wall patches recover all source wall area without changing rectangle authority or source mesh', async () => {
 const mesh=JSON.parse(await readFile(join(massDir('creative-004'),'mesh','indexed-mesh.json'),'utf8'));
 const before=JSON.stringify(mesh);
 const rectangles=facade.deriveFacadeSegmentsFromMass({mesh});
 assert.equal(typeof facade.deriveFacadeWallPatches,'function');
 const patches=facade.deriveFacadeWallPatches({mesh});
 assert.deepEqual(facade.deriveFacadeSegmentsFromMass({mesh}),rectangles);
 assert.equal(JSON.stringify(mesh),before);
 assert.equal(patches.length,rectangles.facade_planes.length);
 let area=0;
 for(const p of patches) {
   assert.ok(rectangles.facade_planes.some(s=>s.segment_id===p.segment_id));
   for(let k=0;k<p.rings.length;k++) {
     const r=p.rings[k];
     const signed=r.reduce((sum,a,i)=>{const b=r[(i+1)%r.length];return sum+a[0]*b[1]-b[0]*a[1];},0)/2;
     area+=(k?-1:1)*Math.abs(signed)/Math.hypot(...p.normal.slice(0,2));
   }
 }
 assert.ok(Math.abs(area-1331.274090)<0.001,`recovered ${area} m2; inscribed rectangles only had 927 m2`);
});
