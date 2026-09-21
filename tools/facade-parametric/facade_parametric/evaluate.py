"""ModelSpec -> instances. Deterministic: the same spec gives the same ids, coordinates and hash."""
import copy
import hashlib
import json
import math

from . import GENERATOR_VERSION
from .fields import cell_values
from .funnel import funnel_loops, wigner_seitz
from .lattice import cell_centres, clip_polygon, inside_rect, inside_void
from .prototypes import apply_shape_modes, sample_loop

INSTANCES_SCHEMA = "arr.elevation3d.facade-instances.v1"
POSE_KEYS = ("scale_u", "scale_v", "rotation_deg")


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def model_hash(spec):
    payload = {"spec": spec, "generator_version": GENERATOR_VERSION}
    return hashlib.sha256(canonical_json(payload).encode()).hexdigest()


MAX_OUTLINE_POINTS = 32  # the 3D engine's polygon-prism cap; the DXF keeps the exact curve


def _outline(family, values, chord_error_m, max_points=MAX_OUTLINE_POINTS):
    segments = apply_shape_modes(family["base_curve"]["segments"], family["shape_modes"], values)
    sx = family["prototype_scale_m"][0] * values["scale_u"]
    sy = family["prototype_scale_m"][1] * values["scale_v"]
    # The 3D outline is a polygon with a stated chord error. Coarsen only until it fits the
    # engine's point cap, and report the tolerance actually used rather than the one asked for.
    tolerance = chord_error_m / max(sx, sy)
    unit_points = sample_loop(segments, tolerance)
    guard = 0
    while len(unit_points) - 1 > max_points:
        tolerance = max(tolerance, 1e-6) * 1.15  # small steps: the first tolerance under the cap
        unit_points = sample_loop(segments, tolerance)
        guard += 1
        if guard > 200:
            raise ValueError("outline cannot be coarsened to the point cap")
    values["_chord_error_m"] = tolerance * max(sx, sy)
    angle = math.radians(values["rotation_deg"])
    cos, sin = math.cos(angle), math.sin(angle)
    return [[x * sx * cos - y * sy * sin, x * sx * sin + y * sy * cos] for x, y in unit_points]


def evaluate_model(spec):
    host = spec["host"]
    width, height = host["width_m"], host["height_m"]
    preserve = host.get('boundary_policy') == 'preserve_pattern'
    chord = spec.get("tolerances", {}).get("export_chord_error_m", 0.0005)
    max_points = int(spec.get("tolerances", {}).get("max_outline_points", MAX_OUTLINE_POINTS))
    instances = []
    for family in spec["families"]:
        lattice = family["lattice"]
        centres = cell_centres(lattice)
        mouth = family.get("mouth")
        tiles = None
        if mouth and mouth["kind"] == "voronoi":
            tiles = _tiles(centres, lattice)
        elif mouth:
            tiles = _parallelogram_tiles(centres, lattice, mouth)
        for i, j, u, v in centres:
            if any(inside_void((u, v), void) for void in spec.get("design_voids", [])):
                continue
            values = cell_values(family, u / width, v / height)
            local = _outline(family, values, chord, max_points)
            outline = [[round(u + x, 6), round(v + y, 6)] for x, y in local]
            policy = lattice["edge_policy"]
            if policy == "omit_partial" and not inside_rect(outline, width, height):
                continue
            far = None
            if mouth:
                # The throat decides whether the cell is partial; the mouth is always clipped to
                # the host, because a tile at the edge is the wall's edge and not a missing cell.
                loops = funnel_loops((u, v), tiles[(i, j)], outline, width, height, mouth["web_m"], min(mouth["points"], max_points), clip_host=not preserve)
                if loops is None:
                    # The host's edge cuts this cell so deeply that no funnel is left in it. Under
                    # `omit_partial` (a photograph whose veil stops inside its own frame) it goes.
                    # Otherwise the cell is the SOLID piece its clipped tile leaves, exactly as at a
                    # fold seam: a veil that reaches an edge is finished by panels, not by a row of
                    # missing cells - which is what left the top of every facet notched and the ends
                    # of the rows a staircase ("어떤 mass든 입면이 마무리가 깔끔하게 되어야 하는 거 아님?").
                    if policy == "omit_partial":
                        continue
                    piece = clip_polygon([list(p) for p in tiles[(i, j)]], width, height)
                    if len(piece) < 4:
                        continue
                    instances.append(_instance(family, values, i, j, u, v, fit_points(piece, max_points)))
                    continue
                outline, far, throat_scale, tile = loops
                values["_throat_scale"] = throat_scale
            elif policy == "clip":
                outline = clip_polygon(outline, width, height)
                if len(outline) < 4:
                    continue
                outline = fit_points(outline, max_points)
            instances.append(_instance(family, values, i, j, u, v, outline,
                                       far=far, tile=tile if far else None,
                                       throat_scale=throat_scale if far else None,
                                       profile=mouth.get("profile") if (far and mouth) else None))
    if host["kind"] == "facet_run":
        if preserve:
            from .patch_modules import split_by_wall_patches
            instances = split_by_wall_patches(instances,host['segments'])
        else:
            instances = split_by_facets(instances, host["segments"], height)
        # parts are in their own facet's u, so two facets' parts share coordinates without touching
        overlaps = []
        for segment in host["segments"]:
            overlaps += overlapping_pairs([c for c in instances if c["segment_id"] == segment["id"]])
    else:
        overlaps = overlapping_pairs(instances)
    if overlaps and not spec.get("constraints", {}).get("allow_aperture_overlap", False):
        raise ValueError(f"{len(overlaps)} cell pairs overlap (first: {overlaps[0]}); the spec forbids aperture overlap")
    return {
        "schema_version": INSTANCES_SCHEMA,
        "overlapping_pairs": len(overlaps),
        "model_id": spec["model_id"],
        "model_hash": model_hash(spec),
        "generator_version": GENERATOR_VERSION,
        "units": "m",
        "host": copy.deepcopy(host),
        "skin": copy.deepcopy(spec["skin"]),
        "instances": instances,
    }


def overlapping_pairs(instances, limit=50):
    """Cell outlines that intersect in area (touching edges do not count). Uses shapely when it is
    installed (tools/facade-vision requires it); otherwise a bounding-box screen plus a coarse
    polygon test, which over-reports rather than under-reports."""
    boxes = []
    for inst in instances:
        xs = [p[0] for p in inst["outline_m"]]; ys = [p[1] for p in inst["outline_m"]]
        boxes.append((min(xs), min(ys), max(xs), max(ys)))
    try:
        from shapely.geometry import Polygon
        polys = [Polygon(inst["outline_m"]) for inst in instances]
        def hits(a, b):
            inter = polys[a].intersection(polys[b])
            return inter.area > 1e-6
    except Exception:  # pragma: no cover - shapely absent
        def hits(a, b):
            return True
    found = []
    order = sorted(range(len(instances)), key=lambda k: boxes[k][0])
    for i_pos, a in enumerate(order):
        ax0, ay0, ax1, ay1 = boxes[a]
        for b in order[i_pos + 1:]:
            bx0, by0, bx1, by1 = boxes[b]
            if bx0 > ax1:
                break
            if by0 > ay1 or by1 < ay0:
                continue
            if hits(a, b):
                found.append((instances[a]["id"], instances[b]["id"]))
                if len(found) >= limit:
                    return found
    return found


def _parallelogram_tiles(centres, lattice, mouth):
    """Every cell's tile as the parallelogram of two lattice vectors (m a + n b, p a + q b), centred
    on the cell plus an offset in units of those sides: the crests are then the two families of
    lines the tiling shares, which is what a photograph of The Broad shows - one strong family of
    ribs along a + b and a weaker one along b, not the six edges of a Voronoi cell."""
    ax, ay = lattice["basis_a_uv_m"]; bx, by = lattice["basis_b_uv_m"]
    (m, n), (p, q) = mouth["sides"]
    L = (m * ax + n * bx, m * ay + n * by)
    S = (p * ax + q * bx, p * ay + q * by)
    ou, ov = mouth.get("offset", [0.0, 0.0])
    tiles = {}
    for i, j, u, v in centres:
        cx = u + ou * L[0] + ov * S[0]
        cy = v + ou * L[1] + ov * S[1]
        corners = [(-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)]
        tiles[(i, j)] = [[cx + s * L[0] + t * S[0], cy + s * L[1] + t * S[1]] for s, t in corners]
    return tiles


def _instance(family, values, i, j, u, v, outline, far=None, tile=None, throat_scale=None, profile=None):
    """One cell's record. A funnel carries its throat, tile and section; a SOLID piece (a cell a
    host edge or a fold seam cut past its funnel) carries its outline alone and draws as a panel."""
    return {
        **({"outline_far_m": far, "tile_m": tile, "throat_scale": round(throat_scale, 4)} if far else {}),
        **({"profile": dict(profile)} if far and profile else {}),
        "id": f"{family['id']}-r{j:03d}-c{i:03d}",
        "unit": family["id"],
        "lattice_index": [i, j],
        "center_m": [round(u, 6), round(v, 6)],
        "width_m": family["prototype_scale_m"][0],
        "height_m": family["prototype_scale_m"][1],
        "scale_u": values["scale_u"],
        "scale_v": values["scale_v"],
        "rotation_deg": values["rotation_deg"],
        "offset_m": [0.0, 0.0],
        "attributes": {k: values[k] for k in values if k not in POSE_KEYS and not k.startswith("_")},
        "outline_m": outline,
        "outline_chord_error_m": round(values["_chord_error_m"], 6),
        "provenance": family["instance_provenance"],
    }


def _tiles(centres, lattice):
    """Every cell's Wigner-Seitz tile against its neighbours (the cells within 2.2 pitches), in
    host metres, keyed by (i, j). Edge cells' tiles run out to the host; the evaluator clips."""
    ax, ay = lattice["basis_a_uv_m"]; bx, by = lattice["basis_b_uv_m"]
    pitch = max((ax * ax + ay * ay) ** 0.5, (bx * bx + by * by) ** 0.5)
    radius = 2.2 * pitch
    # bucket the centres so a 4,096-cell lattice does not pair every cell with every other
    buckets = {}
    for i, j, u, v in centres:
        buckets.setdefault((int(u // radius), int(v // radius)), []).append((u, v))
    tiles = {}
    for i, j, u, v in centres:
        near = []
        bu, bv = int(u // radius), int(v // radius)
        for du in (-1, 0, 1):
            for dv in (-1, 0, 1):
                for (nu, nv) in buckets.get((bu + du, bv + dv), ()):
                    d2 = (nu - u) ** 2 + (nv - v) ** 2
                    if 1e-12 < d2 <= radius * radius:
                        near.append((nu, nv))
        tiles[(i, j)] = wigner_seitz((u, v), near, radius)
    return tiles


def fit_points(closed, max_points):
    """A clipped ring may exceed the point cap by the clip's own corners; merge the shortest
    edge until it fits. `closed` repeats its first point last and comes back the same way."""
    ring = closed[:-1]
    while len(ring) > max_points:
        shortest, length = 0, float("inf")
        for i in range(len(ring)):
            a, b = ring[i], ring[(i + 1) % len(ring)]
            d = ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
            if d < length:
                shortest, length = i, d
        del ring[(shortest + 1) % len(ring)]
    return ring + [ring[0]]


def _centroid(ring):
    pts = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
    return [sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)]


def _squeeze_throat(throat, mouth_part, web_m=0.02, min_scale=0.35):
    """The cell's whole throat scaled about the mouth part's centroid until it fits inside the
    part less a web; None when it would have to shrink below `min_scale` (then the part is solid).
    Both polygons are convex, so the centroid lies inside every ring the part carries."""
    try:
        from shapely.affinity import scale as shapely_scale
        from shapely.geometry import Polygon
    except Exception:  # pragma: no cover - shapely absent
        return None
    room = Polygon(mouth_part).buffer(-web_m)
    if room.is_empty or room.geom_type != "Polygon":
        return None
    cx, cy = _centroid(mouth_part)
    whole = Polygon(throat)
    if whole.is_empty or not whole.is_valid:
        return None
    lo, hi = 0.0, 1.0
    for _ in range(12):
        mid = (lo + hi) / 2
        if room.contains(shapely_scale(whole, mid, mid, origin=(cx, cy))):
            lo = mid
        else:
            hi = mid
    if lo < min_scale:
        return None
    fitted = shapely_scale(whole, lo, lo, origin=(cx, cy))
    ring = [[x, y] for x, y in fitted.exterior.coords]
    return ring


def split_by_facets(instances, segments, height):
    """A facet run, unfolded: each cell lands on the facet(s) whose strip it covers, in that
    facet's own u (the strip's start subtracted). A cell across a seam becomes one part per
    facet, ids suffixed -pK; a part's rings are resampled by angle about the part's own centre so
    mouth, throat and tile stay partnered. A funnel lives in ONE plane: a seam through its throat
    cannot leave two half-lenses on two planes (from any oblique view the far half reads as a
    glass triangle at the fold), so each part gets the throat SQUEEZED into it - scaled about the
    part's own centre until it sits inside the mouth part with a web to spare - and a part too
    thin to hold a lens is a solid piece (the mouth part alone). A part whose throat fell entirely
    on the other facet is a solid piece too."""
    from .funnel import angle_set, resample_at
    out = []
    u0 = 0.0
    strips = []
    for segment in segments:
        strips.append((segment["id"], u0, u0 + segment["length_m"]))
        u0 += segment["length_m"]
    for cell in instances:
        xs = [p[0] for p in cell["outline_m"]]
        lo, hi = min(xs), max(xs)
        hits = [(sid, a, b) for sid, a, b in strips if hi > a + 1e-9 and lo < b - 1e-9]
        throat_xs = [p[0] for p in cell["outline_far_m"]] if cell.get("outline_far_m") else None
        for k, (sid, a, b) in enumerate(hits):
            whole = lo >= a - 1e-9 and hi <= b + 1e-9
            throat_cut = throat_xs is not None and not whole and (min(throat_xs) < a - 1e-9 or max(throat_xs) > b + 1e-9)
            count = len(cell["outline_m"]) - 1
            def local(ring):
                shifted = [[x - a, y] for x, y in ring]
                if whole:
                    return shifted
                clipped = clip_polygon(shifted, b - a, height)
                return fit_points(clipped, count) if len(clipped) >= 4 else clipped
            mouth = local(cell["outline_m"])
            if len(mouth) < 4:
                continue
            part = dict(cell)
            part["segment_id"] = sid
            part["center_m"] = [round(v, 6) for v in ([cell["center_m"][0] - a, cell["center_m"][1]] if whole else _centroid(mouth))]
            if not whole:
                part["id"] = f"{cell['id']}-p{k}"
            rings = {"outline_m": mouth}
            for key in ("outline_far_m", "tile_m"):
                if cell.get(key):
                    ring = local(cell[key])
                    if len(ring) >= 4:
                        rings[key] = ring
                    elif key == "tile_m":
                        rings = None
                        break
            if rings is None:
                continue
            if not whole:
                if "outline_far_m" in rings and throat_cut:
                    squeezed = _squeeze_throat([[x - a, y] for x, y in cell["outline_far_m"]], mouth)
                    if squeezed is None:
                        rings = {"outline_m": mouth}
                    else:
                        rings["outline_far_m"] = squeezed
                # The centre the rings are resampled about must lie inside ALL of them: the
                # throat part's own centroid does (the throat sits inside the mouth inside the
                # tile, and every part is convex), the mouth part's centroid need not.
                if "outline_far_m" in rings:
                    centre = _centroid(rings["outline_far_m"])
                    part["center_m"] = [round(v, 6) for v in centre]
                    ordered = [rings["outline_m"]] + [rings[k] for k in ("outline_far_m", "tile_m") if k in rings]
                    angles = angle_set(ordered, centre, count)
                    for key, ring in list(rings.items()):
                        pts = resample_at(ring, centre, angles)
                        rings[key] = pts + [pts[0]]
                else:
                    # a solid piece: the mouth part is the whole outline, the tile stands aside
                    rings = {"outline_m": fit_points(mouth, count)}
            for key in ("outline_far_m", "tile_m", "throat_scale", "profile"):
                part.pop(key, None)
            part.update({key: [[round(x, 6), round(y, 6)] for x, y in ring] for key, ring in rings.items()})
            if cell.get("throat_scale") is not None and "outline_far_m" in rings:
                part["throat_scale"] = cell["throat_scale"]
            if cell.get("profile") and "outline_far_m" in rings:
                part["profile"] = dict(cell["profile"])
            out.append(part)
    return out
