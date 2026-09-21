"""Polygonal glass backing in canonical wall u / host z coordinates.

This does not evaluate or modify a veil pattern. The supplied wall rings and
storey intervals are authoritative. Mitred inward offsets retain straight wall
edges and conservatively clear re-entrant corners; no outline is resampled.
Holes and outlines over the grammar's 32-vertex limit are refused, because
splitting them into touching apertures would bypass opening-separation gates.
"""
import copy
import math

from shapely.geometry import Polygon, box
from shapely.geometry.polygon import orient


def _finite(value, label):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{label} must be finite")
    return number


def _polygons(geometry):
    if geometry.is_empty:
        return []
    if geometry.geom_type == "Polygon":
        return [geometry]
    if geometry.geom_type in ("MultiPolygon", "GeometryCollection"):
        return [p for part in geometry.geoms for p in _polygons(part)]
    return []


def polygonal_wall_backing(segments, storeys, *, fold_clearance_m,
                          floor_clearance_m, slab_margin_m, attributes=None):
    """Return flat lattice-compatible window instances grouped by segment_id.

    Segments contain id and rings_m (outer ring followed by holes). Storeys are
    [z_min, z_max] pairs or dictionaries with z_min_m, z_max_m and optional storey.
    Every coordinate, including storey bounds, is in the same host frame.
    The slab inset is max(floor_clearance_m, slab_margin_m); the caller passes
    its existing gate and backing margins rather than building-specific values.
    No geometry, input record, or attributes dictionary is mutated.
    """
    margins = [_finite(v, label) for v, label in (
        (fold_clearance_m, "fold_clearance_m"),
        (floor_clearance_m, "floor_clearance_m"), (slab_margin_m, "slab_margin_m"))]
    if any(v < 0 for v in margins):
        raise ValueError("backing clearances must be nonnegative")
    fold, floor, slab = margins
    inset = max(floor, slab)
    bands = []
    for index, storey in enumerate(storeys):
        if isinstance(storey, dict):
            low, high = storey["z_min_m"], storey["z_max_m"]
            number = storey.get("storey", index + 1)
        else:
            low, high = storey
            number = index + 1
        low, high = _finite(low, "storey minimum"), _finite(high, "storey maximum")
        if high <= low:
            raise ValueError("storey intervals must have positive height")
        bands.append((low, high, number))
    bands.sort(key=lambda band: band[0])
    if any(bands[i][0] < bands[i - 1][1] for i in range(1, len(bands))):
        raise ValueError("storey intervals must not overlap")

    instances = []
    seen = set()
    for segment in segments:
        sid = segment["id"]
        if sid in seen:
            raise ValueError(f"duplicate wall segment id: {sid}")
        seen.add(sid)
        rings = segment["rings_m"]
        if not rings:
            raise ValueError(f"wall {sid} requires an outer ring")
        for ring in rings:
            for point in ring:
                if len(point) != 2:
                    raise ValueError(f"wall {sid} ring coordinates must be u/z pairs")
                for value in point:
                    _finite(value, f"wall {sid} coordinate")
        wall = Polygon(rings[0], rings[1:])
        if not wall.is_valid or wall.is_empty or wall.area <= 0:
            raise ValueError(f"wall {sid} requires a valid positive-area polygon")
        safe = wall.buffer(-fold, join_style=2) if fold else wall
        if safe.is_empty:
            continue
        x0, _, x1, _ = safe.bounds
        for band_index, (low, high, number) in enumerate(bands):
            if high - low <= 2 * inset:
                continue
            clipped = safe.intersection(box(x0, low + inset, x1, high - inset))
            pieces = sorted(_polygons(clipped), key=lambda p: (*p.bounds, p.area))
            for part_index, piece in enumerate(pieces):
                if piece.interiors:
                    raise ValueError(f"wall {sid} backing has holes; cannot emit a simple opening")
                # Zero tolerance removes redundant collinear vertices without fitting a curve.
                piece = orient(piece.simplify(0, preserve_topology=True), sign=1)
                outline = [list(p) for p in piece.exterior.coords[:-1]]
                if len(outline) > 32:
                    raise ValueError(f"wall {sid} backing exceeds the 32-vertex opening limit")
                if len(outline) < 3 or piece.area <= 0:
                    continue
                # Canonical start makes identical geometry deterministic across ring winding.
                start = min(range(len(outline)), key=lambda i: tuple(outline[i]))
                outline = outline[start:] + outline[:start]
                a, b, c, d = piece.bounds
                instances.append({
                    "id": f"backing-{sid}-s{band_index}-p{part_index}",
                    "unit": "wall-backing", "segment_id": sid, "storey": number,
                    "lattice_index": [part_index, band_index],
                    "center_m": [piece.centroid.x, piece.centroid.y],
                    "width_m": c - a, "height_m": d - b,
                    "scale_u": 1, "scale_v": 1, "rotation_deg": 0,
                    "offset_m": [0, 0], "attributes": copy.deepcopy(attributes or {}),
                    "outline_m": outline, "outline_chord_error_m": 0,
                    "bounds_m": [a, b, c, d], "area_m2": piece.area,
                    "provenance": "wall_polygon_and_storey_clearances",
                })
    return instances
