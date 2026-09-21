"""Instances -> the existing curve document (tools/facade-vision) -> SVG + DXF, stamped with the
model hash. The 2D CAD writer is not duplicated here; the lattice only feeds it units and instances."""
import importlib.util
import json
import pathlib

from .prototypes import apply_shape_modes

VISION_SRC = pathlib.Path(__file__).resolve().parents[2] / "facade-vision" / "src"


def _vision(module):
    """Import a tools/facade-vision module. Both packages are called `src`, so facade-vision is loaded
    as a separately named package and its relative imports resolve inside it."""
    import sys
    name = "facade_vision_src"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, VISION_SRC / "__init__.py",
                                                      submodule_search_locations=[str(VISION_SRC)])
        package = importlib.util.module_from_spec(spec)
        sys.modules[name] = package
        spec.loader.exec_module(package)
    return importlib.import_module(f"{name}.{module}")


def _unit_loops(family, mode_values):
    segments = apply_shape_modes(family["base_curve"]["segments"], family["shape_modes"], mode_values)
    return [{"segments": [{"kind": "cubic", "points": [list(p) for p in segment]} for segment in segments]}]


def to_curve_document(spec, evaluated):
    """facade-curves.v1: one unit per distinct shape-mode state of a family, instances as evaluated."""
    families = {f["id"]: f for f in spec["families"]}
    units, unit_ids, instances = [], {}, []
    # a facet run's instances are in their own facet's u; the unfolded drawing puts them back
    offsets = {};affines={}
    if evaluated["host"].get("kind") == "facet_run":
        u0 = 0.0
        for segment in evaluated["host"]["segments"]:
            offsets[segment["id"]] = u0 - segment.get('u_min_m',0)
            if segment.get('chart_affine'):affines[segment['id']]=segment['chart_affine']
            u0 += segment["length_m"]
    for instance in evaluated["instances"]:
        if instance.get('mesh_uzn'):
            # Draw the evaluated cut module, not another uncut copy of the prototype.
            # The two planar caps expose the tile, mouth and throat boundaries.
            from shapely.geometry import Polygon
            from shapely.ops import unary_union
            mesh=instance['mesh_uzn'];vertices=mesh['vertices']
            affine=affines.get(instance.get('segment_id'))
            if affine:
                a,b,c=affine;vertices=[[a*u+b*z+c,z,n] for u,z,n in vertices]
            rings=[];seen=set()
            for depth in (0,1):
                caps=[Polygon([vertices[i][:2] for i in f]) for f in mesh['triangles']
                      if all(abs(vertices[i][2]-depth)<1e-6 for i in f)]
                region=unary_union(caps)
                polygons=[region] if region.geom_type=='Polygon' else list(getattr(region,'geoms',[]))
                for polygon in polygons:
                    if polygon.geom_type!='Polygon': continue
                    for ring in [polygon.exterior,*polygon.interiors]:
                        points=[(round(x,6),round(y,6)) for x,y in list(ring.coords)[:-1]]
                        key=tuple(sorted(points))
                        if key not in seen: seen.add(key);rings.append(points)
            x0=min(v[0] for v in vertices);x1=max(v[0] for v in vertices)
            y0=min(v[1] for v in vertices);y1=max(v[1] for v in vertices)
            cx,cy=(x0+x1)/2,(y0+y1)/2
            width,height=x1-x0,y1-y0
            uid=instance['id']+'-mesh'
            loops=[]
            for ring in rings:
                points=[[(x-cx)/width,(y-cy)/height] for x,y in ring]
                loops.append({'segments':[{'kind':'line','points':[p,points[(k+1)%len(points)]]} for k,p in enumerate(points)]})
            units.append({'id':uid,'loops':loops,'vectorization':'evaluated_wall_patch_module'})
            instances.append({'id':instance['id'],'unit':uid,'center_m':[cx+(0 if affine else offsets.get(instance.get('segment_id'),0)),cy],
                              'width_m':width,'height_m':height,'scale_u':1,'scale_v':1,'rotation_deg':0,'offset_m':[0,0]})
            continue
        family = families[instance["unit"]]
        modes = tuple(sorted((m["name"], round(instance["attributes"].get(m["name"], 0.0), 6))
                             for m in family["shape_modes"]))
        key = (family["id"], modes)
        if key not in unit_ids:
            unit_ids[key] = f"{family['id']}-u{len(unit_ids):04d}"
            units.append({"id": unit_ids[key], "loops": _unit_loops(family, dict(modes)),
                          "vectorization": "lattice_prototype"})
        centre = instance["center_m"]
        if instance.get("segment_id") in offsets:
            centre = [round(centre[0] + offsets[instance["segment_id"]], 6), centre[1]]
        instances.append({"id": instance["id"], "unit": unit_ids[key], "center_m": centre,
                          "width_m": instance["width_m"], "height_m": instance["height_m"],
                          "scale_u": instance["scale_u"], "scale_v": instance["scale_v"],
                          "rotation_deg": instance["rotation_deg"], "offset_m": instance["offset_m"]})
    host = evaluated["host"]
    return {"schema_version": "arr.elevation3d.facade-curves.v1",
            "width_m": host["width_m"], "height_m": host["height_m"],
            "source": {"kind": "lattice_evaluation", "model_hash": evaluated["model_hash"],
                       "generator_version": evaluated["generator_version"], "depth": "designed"},
            "parameters": {"scale_u": 1.0, "scale_v": 1.0, "rotation_deg": 0.0, "spacing_u": 1.0, "spacing_v": 1.0},
            "units": units, "instances": instances, "model_hash": evaluated["model_hash"]}


def export_bundle(spec, evaluated, output_dir):
    output_dir = pathlib.Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "instances.json").write_text(json.dumps(evaluated, indent=2), encoding="utf-8")
    document = to_curve_document(spec, evaluated)
    written = _vision("curve_document").export_curve_document(document, output_dir)
    written["instances_json"] = str(output_dir / "instances.json")
    written["model_hash"] = evaluated["model_hash"]
    return written
