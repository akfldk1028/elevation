"""validate_spec: refuse what the evaluator must never see. Every refusal names the path."""
import copy
import math
import json
from pathlib import Path

SCHEMA = "arr.elevation3d.facade-model.v1"
TOP = {"schema_version", "model_id", "status", "generator_version", "units", "source", "host", "skin",
       "families", "design_voids", "exceptions", "uncertain_regions", "constraints", "tolerances", "metadata"}
FAMILY = {"id", "role", "base_curve", "prototype_scale_m", "shape_modes", "lattice", "fields", "instance_provenance", "mouth"}
LATTICE = {"active_indices","origin_uv_m", "basis_a_uv_m", "basis_b_uv_m", "columns", "rows", "stagger_a_fraction", "edge_policy"}
EDGE_POLICIES = {"omit_partial", "clip", "keep"}
# The attributes a cell can answer with, in the grammar's own names (grade.attr), plus shape modes.
# inset_m is not here: the 3D reads depth_m / scoop_deg / standoff_m off a cell and nothing else.
CELL_ATTRIBUTES = {"scale_u", "scale_v", "rotation_deg", "depth_m", "scoop_deg", "standoff_m"}
FIELD_KINDS = {"constant", "linear", "grid", "point"}
# One budget record for both languages. This bounds allocation by the cheapest
# possible emitted cell; exact scene geometry/extras/GLB bytes remain gated in JS.
_BUDGETS = json.loads((Path(__file__).resolve().parents[3] /
    'plugins/elevation-3d/lib/facade-agent/lattice-budgets.json').read_text())
MAX_CELLS = min(
    _BUDGETS['maxVertices'] // _BUDGETS['minimumPrismVertices'],
    _BUDGETS['maxIndices'] // _BUDGETS['minimumPrismIndices'],
    (_BUDGETS['maxGlbBytes'] - _BUDGETS['fixedBytes']) //
    (_BUDGETS['minimumPrismVertices'] * _BUDGETS['vertexBytes'] +
     _BUDGETS['minimumPrismIndices'] * _BUDGETS['indexBytes'] + _BUDGETS['detailJsonBytes']))


def fail(path, message):
    raise ValueError(f"{path}: {message}")


def number(value, path, minimum=None, maximum=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        fail(path, "must be a finite number")
    if minimum is not None and value < minimum:
        fail(path, f"must be >= {minimum}")
    if maximum is not None and value > maximum:
        fail(path, f"must be <= {maximum}")
    return float(value)


def vector2(value, path):
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        fail(path, "must be a two-element vector")
    return [number(value[0], f"{path}[0]"), number(value[1], f"{path}[1]")]


def record(value, path, allowed):
    if not isinstance(value, dict):
        fail(path, "must be an object")
    unknown = set(value) - allowed
    if unknown:
        fail(path, f"unknown keys {sorted(unknown)}")
    return value


def _base_curve(value, path):
    curve = record(value, path, {"kind", "coordinate_space", "closed", "joint_continuity", "segments"})
    if curve.get("kind") != "piecewise_cubic_bezier":
        fail(f"{path}.kind", "only piecewise_cubic_bezier is supported")
    if curve.get("closed") is not True:
        fail(f"{path}.closed", "an aperture outline must be closed")
    segments = curve.get("segments")
    if not isinstance(segments, list) or not segments:
        fail(f"{path}.segments", "needs at least one cubic segment")
    out = []
    for i, segment in enumerate(segments):
        if not isinstance(segment, list) or len(segment) != 4:
            fail(f"{path}.segments[{i}]", "a cubic segment has four control points")
        out.append([vector2(p, f"{path}.segments[{i}][{k}]") for k, p in enumerate(segment)])
    for i in range(len(out)):
        end, start = out[i][3], out[(i + 1) % len(out)][0]
        if abs(end[0] - start[0]) > 1e-9 or abs(end[1] - start[1]) > 1e-9:
            fail(f"{path}.segments[{i}]", "segment end does not meet the next start; the loop is open")
    curve["segments"] = out
    return curve


def _shape_modes(value, path, segment_count):
    if not isinstance(value, list):
        fail(path, "must be a list")
    names = set()
    for i, mode in enumerate(value):
        mode = record(mode, f"{path}[{i}]", {"name", "handle_deltas"})
        name = mode.get("name")
        if not isinstance(name, str) or not name or name in names or name in CELL_ATTRIBUTES:
            fail(f"{path}[{i}].name", "must be a unique name that is not a cell attribute")
        names.add(name)
        deltas = mode.get("handle_deltas")
        if not isinstance(deltas, list) or not deltas:
            fail(f"{path}[{i}].handle_deltas", "must list at least one control-point delta")
        for k, delta in enumerate(deltas):
            delta = record(delta, f"{path}[{i}].handle_deltas[{k}]", {"segment", "control", "delta"})
            if not isinstance(delta.get("segment"), int) or not 0 <= delta["segment"] < segment_count:
                fail(f"{path}[{i}].handle_deltas[{k}].segment", "names no segment of the base curve")
            if not isinstance(delta.get("control"), int) or not 0 <= delta["control"] <= 3:
                fail(f"{path}[{i}].handle_deltas[{k}].control", "must be 0..3")
            delta["delta"] = vector2(delta.get("delta"), f"{path}[{i}].handle_deltas[{k}].delta")
    return names


def _lattice(value, path):
    lattice = record(value, path, LATTICE)
    for key in ("origin_uv_m", "basis_a_uv_m", "basis_b_uv_m"):
        lattice[key] = vector2(lattice.get(key), f"{path}.{key}")
    for key in ("columns", "rows"):
        count = lattice.get(key)
        if isinstance(count, bool) or not isinstance(count, int) or count < 1:
            fail(f"{path}.{key}", "must be a positive integer")
    allocated=lattice['columns']*lattice['rows']
    if 'active_indices' in lattice:
        indices=lattice['active_indices']
        if not isinstance(indices,list) or not indices: fail(path,'active_indices must be a nonempty list')
        seen=set()
        for pair in indices:
            if not isinstance(pair,list) or len(pair)!=2 or any(isinstance(v,bool) or not isinstance(v,int) for v in pair): fail(path,'active index must be an integer pair')
            i,j=pair
            if not 0<=i<lattice['columns'] or not 0<=j<lattice['rows']: fail(path,'active index outside lattice range')
            if (i,j) in seen: fail(path,'duplicate active index')
            seen.add((i,j))
        allocated=len(indices)
    if allocated > MAX_CELLS:
        fail(path, f"more than {MAX_CELLS} cells: {allocated} requested; "
             f"allocation ceiling from {_BUDGETS['maxGlbBytes']} GLB bytes, "
             f"{_BUDGETS['maxVertices']} vertices, {_BUDGETS['maxIndices']} indices, {_BUDGETS['maxDetails']} details")
    a, b = lattice["basis_a_uv_m"], lattice["basis_b_uv_m"]
    cross = a[0] * b[1] - a[1] * b[0]
    if abs(cross) <= 1e-9 * max(1e-12, math.hypot(*a) * math.hypot(*b)):
        fail(path, "lattice basis vectors are linearly dependent")
    lattice["stagger_a_fraction"] = number(lattice.get("stagger_a_fraction", 0.0), f"{path}.stagger_a_fraction", -1, 1)
    if lattice.get("edge_policy", "clip") not in EDGE_POLICIES:
        fail(f"{path}.edge_policy", f"must be one of {sorted(EDGE_POLICIES)}")
    lattice.setdefault("edge_policy", "clip")
    return lattice


def _field(value, path):
    field = record(value, path, {"kind", "value", "bounds", "from", "to", "axis", "values", "center_st",
                                 "range_st", "falloff"})
    kind = field.get("kind")
    if kind not in FIELD_KINDS:
        fail(f"{path}.kind", f"must be one of {sorted(FIELD_KINDS)}")
    bounds = field.get("bounds")
    if bounds is not None:
        bounds = vector2(bounds, f"{path}.bounds")
        if bounds[0] >= bounds[1]:
            fail(f"{path}.bounds", "must be [low, high] with low < high")
        field["bounds"] = bounds

    def inside(v, p):
        return number(v, p, bounds[0], bounds[1]) if bounds else number(v, p)

    if kind == "constant":
        field["value"] = inside(field.get("value"), f"{path}.value")
    elif kind == "linear":
        field["from"] = inside(field.get("from"), f"{path}.from")
        field["to"] = inside(field.get("to"), f"{path}.to")
        if field.get("axis", "s") not in ("s", "t"):
            fail(f"{path}.axis", "must be s (along u) or t (along v)")
        field.setdefault("axis", "s")
    elif kind == "grid":
        values = field.get("values")
        if not isinstance(values, list) or len(values) < 2 or any(not isinstance(r, list) or len(r) < 2 for r in values):
            fail(f"{path}.values", "must be a grid of at least 2x2 values")
        width = len(values[0])
        if any(len(r) != width for r in values):
            fail(f"{path}.values", "rows must be the same length")
        field["values"] = [[inside(v, f"{path}.values[{r}][{c}]") for c, v in enumerate(row)]
                           for r, row in enumerate(values)]
    elif kind == "point":
        # A radial attractor in normalized host coordinates: from at the centre, to at range and beyond.
        field["center_st"] = vector2(field.get("center_st"), f"{path}.center_st")
        field["range_st"] = number(field.get("range_st"), f"{path}.range_st", 1e-6)
        field["from"] = inside(field.get("from"), f"{path}.from")
        field["to"] = inside(field.get("to"), f"{path}.to")
        field["falloff"] = number(field.get("falloff", 1.0), f"{path}.falloff", 0.25, 4)
    return field


def _family(value, path):
    family = record(value, path, FAMILY)
    if not isinstance(family.get("id"), str) or not family["id"]:
        fail(f"{path}.id", "required")
    family["base_curve"] = _base_curve(family.get("base_curve"), f"{path}.base_curve")
    scale = vector2(family.get("prototype_scale_m"), f"{path}.prototype_scale_m")
    if min(scale) <= 0:
        fail(f"{path}.prototype_scale_m", "must be positive")
    family["prototype_scale_m"] = scale
    modes = _shape_modes(family.get("shape_modes", []), f"{path}.shape_modes", len(family["base_curve"]["segments"]))
    family.setdefault("shape_modes", [])
    family["lattice"] = _lattice(family.get("lattice"), f"{path}.lattice")
    # The cell as a funnel: its MOUTH is the lattice's own tile less half a web, its throat the
    # base curve. Absent, the cell is the curve alone - a hole - as before.
    mouth = family.get("mouth")
    if mouth is not None:
        mouth = record(mouth, f"{path}.mouth", {"kind", "web_m", "points", "sides", "offset", "profile"})
        if mouth.get("kind") not in ("voronoi", "parallelogram"):
            fail(f"{path}.mouth.kind", "must be voronoi (the lattice's Wigner-Seitz tile) or parallelogram (two lattice vectors)")
        if mouth["kind"] == "parallelogram":
            # The tile's two sides as integer combinations of the basis, [[m, n], [p, q]] meaning
            # m*a + n*b and p*a + q*b; |mq - np| must be 1 so the tiles cover the plane one to a cell.
            # The Broad's cell is (a + b, b): long side along the ribs, short side up the row.
            sides = mouth.get("sides", [[1, 0], [0, 1]])
            ok = isinstance(sides, list) and len(sides) == 2 and all(isinstance(v, list) and len(v) == 2 and all(isinstance(k, int) and not isinstance(k, bool) for k in v) for v in sides)
            if not ok or abs(sides[0][0] * sides[1][1] - sides[0][1] * sides[1][0]) != 1:
                fail(f"{path}.mouth.sides", "must be two integer pairs [[m, n], [p, q]] with |mq - np| = 1")
            mouth["sides"] = sides
            offset = mouth.get("offset", [0.0, 0.0])
            offset = vector2(offset, f"{path}.mouth.offset")
            if not all(-0.5 <= v <= 0.5 for v in offset):
                fail(f"{path}.mouth.offset", "the tile's centre may sit at most half a side from the cell")
            mouth["offset"] = offset
        mouth["web_m"] = number(mouth.get("web_m", 0.05), f"{path}.mouth.web_m", 0.0, 1.0)
        points = mouth.get("points", 24)
        if isinstance(points, bool) or not isinstance(points, int) or not 8 <= points <= 32:
            fail(f"{path}.mouth.points", "must be an integer 8..32 (the 3D engine's outline cap)")
        mouth["points"] = points
        if mouth.get("profile") is not None:
            # The funnel's SECTION from the rim to the throat: `linear` is one straight loft (a
            # faceted cone); `quarter_ellipse` is a cove tangent to the face at the rim and diving
            # into the throat, built through `rings` intermediate sections - the streamlined scoop
            # of a cast veil (the component-in-a-box morphed per cell of the panelization
            # literature: sections along a profile, not one ruled surface).
            profile = record(mouth["profile"], f"{path}.mouth.profile", {"kind", "rings"})
            if profile.get("kind") not in ("linear", "quarter_ellipse"):
                fail(f"{path}.mouth.profile.kind", "must be linear or quarter_ellipse")
            rings = profile.get("rings", 3)
            if isinstance(rings, bool) or not isinstance(rings, int) or not 0 <= rings <= 6:
                fail(f"{path}.mouth.profile.rings", "must be an integer 0..6 (intermediate sections)")
            profile["rings"] = rings
            mouth["profile"] = profile
        family["mouth"] = mouth
    fields = family.get("fields", {})
    if not isinstance(fields, dict):
        fail(f"{path}.fields", "must be an object keyed by cell attribute or shape mode")
    for name, field in fields.items():
        if name not in CELL_ATTRIBUTES and name not in modes:
            fail(f"{path}.fields.{name}", "is neither a cell attribute nor a declared shape mode")
        fields[name] = _field(field, f"{path}.fields.{name}")
    family["fields"] = fields
    family.setdefault("instance_provenance", "designed")
    return family


def _host(value, path):
    host = record(value, path, {"kind", "locked", "width_m", "height_m", "dimension_provenance", "candidate", "segments", "boundary_policy"})
    if host.get('boundary_policy') not in (None,'preserve_pattern'):
        fail(path+'.boundary_policy','must be preserve_pattern when specified')
    kind = host.get("kind", "plane")
    if kind == "plane":
        for key in ("width_m", "height_m"):
            host[key] = number(host.get(key), f"{path}.{key}", 1e-6)
    elif kind == "facet_run":
        # The facets of one run, in order along the wall, unfolded: the lattice is laid over
        # width = the sum of their lengths, and every cell is handed back in its own facet's
        # coordinates (a cell across a seam becomes one part per facet).
        if not isinstance(host.get("candidate"), str) or not isinstance(host.get("segments"), list) or not host["segments"]:
            fail(path, "a facet_run host names a candidate and a non-empty list of segments")
        segments = []
        for k, segment in enumerate(host["segments"]):
            segment = record(segment, f"{path}.segments[{k}]", {"id", "length_m", "view", "u_min_m", "rings_m", "chart_affine"})
            if not isinstance(segment.get("id"), str) or not segment["id"]:
                fail(f"{path}.segments[{k}].id", "must be a segment id")
            segment["length_m"] = number(segment.get("length_m"), f"{path}.segments[{k}].length_m", 1e-6)
            if host.get('boundary_policy') == 'preserve_pattern':
                from shapely.geometry import Polygon
                rings=segment.get('rings_m')
                if not isinstance(rings,list) or not rings:
                    fail(path,'preserve_pattern requires each verified wall boundary')
                rings=[[vector2(p,path+'.rings_m') for p in ring] for ring in rings]
                polygon=Polygon(rings[0],rings[1:])
                if not polygon.is_valid or polygon.is_empty: fail(path,'invalid wall boundary')
                segment['rings_m']=rings
                segment['u_min_m']=number(segment.get('u_min_m'),path+'.u_min_m')
                if 'chart_affine' in segment:
                    affine=segment['chart_affine']
                    if not isinstance(affine,list) or len(affine)!=3:fail(path,'chart_affine needs [a,b,c]')
                    segment['chart_affine']=[number(v,path+'.chart_affine') for v in affine]
                    if affine[0]<=0:fail(path,'chart_affine must preserve orientation and have positive U scale')
            # Which elevation this facet belongs to. A design read on ONE face - a void, above all -
            # lands on that face and not on whatever stretch of the unfolded run shares its metres.
            if segment.get("view") is not None and not isinstance(segment["view"], str):
                fail(f"{path}.segments[{k}].view", "must be the elevation the facet belongs to")
            segments.append(segment)
        host["segments"] = segments
        host["height_m"] = number(host.get("height_m"), f"{path}.height_m", 1e-6)
        if any('chart_affine' in s for s in segments):
            if not all('chart_affine' in s for s in segments):fail(path,'all chart segments need their affine map')
            mapped=[s['chart_affine'][0]*u+s['chart_affine'][1]*z+s['chart_affine'][2] for s in segments for r in s['rings_m'] for u,z in r]
            if min(mapped)<-1e-5:fail(path,'chart U must be packed into the positive host domain')
            host['width_m']=max(mapped)
        else:host["width_m"] = round(sum(s["length_m"] for s in segments), 6)
    else:
        fail(f"{path}.kind", "must be plane or facet_run")
    host["kind"] = kind
    return host


def validate_spec(value):
    spec = copy.deepcopy(record(value, "spec", TOP))
    if spec.get("schema_version") != SCHEMA:
        fail("spec.schema_version", f"must be {SCHEMA}")
    if spec.get("units", "m") != "m":
        fail("spec.units", "the repo works in metres")
    spec["units"] = "m"
    if not isinstance(spec.get("model_id"), str) or not spec["model_id"]:
        fail("spec.model_id", "required")
    spec["host"] = _host(spec.get("host"), "spec.host")
    skin = record(spec.get("skin", {}), "spec.skin", {"stand_off_m", "thickness_m", "depth_provenance"})
    skin["stand_off_m"] = number(skin.get("stand_off_m", 0.0), "spec.skin.stand_off_m", 0)
    skin["thickness_m"] = number(skin.get("thickness_m", 0.05), "spec.skin.thickness_m", 1e-3)
    spec["skin"] = skin
    families = spec.get("families")
    if not isinstance(families, list) or not families:
        fail("spec.families", "needs at least one family")
    ids = set()
    for i, family in enumerate(families):
        family = _family(family, f"spec.families[{i}]")
        if family["id"] in ids:
            fail(f"spec.families[{i}].id", "duplicate")
        ids.add(family["id"])
    tolerances = spec.get("tolerances") or {}
    if "export_chord_error_m" in tolerances:
        number(tolerances["export_chord_error_m"], "spec.tolerances.export_chord_error_m", 1e-5, 0.05)
    if "geometry_m" in tolerances:
        number(tolerances["geometry_m"], "spec.tolerances.geometry_m", 1e-7, 0.01)
    if "max_outline_points" in tolerances:
        points = tolerances["max_outline_points"]
        if isinstance(points, bool) or not isinstance(points, int) or not 8 <= points <= 32:
            fail("spec.tolerances.max_outline_points", "must be an integer 8..32 (the 3D engine's outline cap)")
    for key in ("design_voids", "exceptions", "uncertain_regions"):
        if not isinstance(spec.get(key, []), list):
            fail(f"spec.{key}", "must be a list")
        spec.setdefault(key, [])
    # A design void is a place the lattice does not go: The Broad's oculus, an entrance, a
    # signage panel. Cells whose centre falls inside are omitted; what fills the void is the
    # grammar's business (a glazed opening, bare wall), not the lattice's.
    for i, void in enumerate(spec["design_voids"]):
        void = record(void, f"spec.design_voids[{i}]", {"id", "kind", "center_uv_m", "radii_m", "polygon_uv_m"})
        if void.get("kind") not in ("ellipse", "polygon"):
            fail(f"spec.design_voids[{i}].kind", "must be ellipse or polygon")
        if void["kind"] == "ellipse":
            void["center_uv_m"] = vector2(void.get("center_uv_m"), f"spec.design_voids[{i}].center_uv_m")
            radii = vector2(void.get("radii_m"), f"spec.design_voids[{i}].radii_m")
            if min(radii) <= 0:
                fail(f"spec.design_voids[{i}].radii_m", "must be positive")
            void["radii_m"] = radii
        else:
            points = void.get("polygon_uv_m")
            if not isinstance(points, list) or len(points) < 3:
                fail(f"spec.design_voids[{i}].polygon_uv_m", "needs at least three points")
            void["polygon_uv_m"] = [vector2(p, f"spec.design_voids[{i}].polygon_uv_m[{k}]") for k, p in enumerate(points)]
    return spec
