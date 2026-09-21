"""Fit a ModelSpec to OBSERVED cells (Task 3): the reverse of evaluate.py.

The observations are what the vision lane hands over - a facade-curves.v1 document whose
instances carry a centre, a size and a unit loop each, in host metres - or any list of
{center_m, width_m, height_m, outline_unit}. Nothing here reads pixels. The fit answers, in
order: which two vectors the cells repeat on (the lattice), what one cell looks like (the shared
unit, the mean of the observed loops), how the cell size varies over the host (a field), and
where the lattice has a hole in it (a design void). Depth and scoop are not observable in a
photograph and are taken from `options`, stated as such in the spec's metadata.

Every step reports what it measured (inlier fraction, residual, matched / missing / extra) so a
fit is a claim with numbers attached, never a spec that merely validates.
"""
import json
import math

import numpy as np

from .contracts import validate_spec
from .evaluate import evaluate_model
from .prototypes import sample_loop

GENERATOR = "facade-parametric-fit-v0.1"


# ---- observations ------------------------------------------------------------------------------

def observations_from_curves(document):
    """facade-curves.v1 -> observations. Unit loops are flattened to a polygon in the unit's own
    centred coordinates (x, y in about [-0.5, 0.5], y up), which is the evaluator's convention."""
    units = {unit["id"]: unit for unit in document["units"]}
    out = []
    for instance in document["instances"]:
        unit = units.get(instance["unit"])
        polygon = None
        if unit and unit.get("loops"):
            segments = []
            for segment in unit["loops"][0]["segments"]:
                points = segment["points"]
                if segment.get("kind") == "cubic":
                    segments.append(points)
                elif segment.get("kind") == "line" and len(points) == 2:
                    segments.append([points[0], points[0], points[1], points[1]])
            if segments:
                polygon = sample_loop(segments, 0.01)[:-1]
        out.append({"center_m": list(instance["center_m"]), "width_m": instance["width_m"], "height_m": instance["height_m"],
                    "outline_unit": polygon, "id": instance.get("id")})
    return out


def _select(observations):
    """Cells of the repeating family: widths within [0.5, 2.5] x the median. Wider ones are void
    evidence (the oculus is segmented as one huge opening), narrower ones are fragments."""
    widths = np.array([o["width_m"] for o in observations], dtype=float)
    median = float(np.median(widths))
    keep = [o for o, w in zip(observations, widths) if 0.5 * median <= w <= 2.5 * median]
    giants = [o for o, w in zip(observations, widths) if w > 2.5 * median]
    return keep, giants, median


# ---- lattice -----------------------------------------------------------------------------------

def reduce_basis(a, b):
    """Lagrange (Gauss) reduction: the shortest pair spanning the same lattice."""
    a, b = np.array(a, float), np.array(b, float)
    for _ in range(50):
        if a @ a > b @ b:
            a, b = b, a
        m = round(float(b @ a) / float(a @ a))
        if m == 0:
            break
        b = b - m * a
    return a, b


def estimate_basis(centres, bin_m=0.06, neighbours=8, max_m=3.0):
    """Peaks of the nearest-neighbour displacement histogram: the most frequent displacement is
    one lattice vector, the most frequent one independent of it is the other."""
    p = np.asarray(centres, float)
    d = p[None, :, :] - p[:, None, :]
    dist = np.hypot(d[..., 0], d[..., 1])
    np.fill_diagonal(dist, np.inf)
    vectors = []
    for i in range(len(p)):
        for k in np.argsort(dist[i])[:neighbours]:
            if dist[i, k] < max_m:
                v = d[i, k]
                if v[1] < 0 or (v[1] == 0 and v[0] < 0):
                    v = -v
                vectors.append(v)
    vectors = np.array(vectors)
    if len(vectors) < 8:
        raise ValueError("too few cells to estimate a lattice")
    n = int(math.ceil(2 * max_m / bin_m))
    hist, xe, ye = np.histogram2d(vectors[:, 0], vectors[:, 1], bins=[n, n // 2], range=[[-max_m, max_m], [0, max_m]])

    # The strong peaks: every bin holding at least a fifth of the strongest, as the mean of
    # the vectors within a bin of it. Among them the SHORTEST is a lattice vector, and the
    # shortest one independent of it is the other: a and b are never longer than their sums.
    strongest = hist.max()
    peaks = []
    for flat in np.argsort(hist, axis=None)[::-1]:
        if hist.flat[flat] < 0.2 * strongest or len(peaks) >= 12:
            break
        ix, iy = np.unravel_index(flat, hist.shape)
        centre = np.array([(xe[ix] + xe[ix + 1]) / 2, (ye[iy] + ye[iy + 1]) / 2])
        if np.hypot(*centre) < 0.15:
            continue
        if any(np.hypot(*(centre - p)) <= 1.5 * bin_m for p in peaks):
            continue
        near = vectors[(np.abs(vectors[:, 0] - centre[0]) <= bin_m) & (np.abs(vectors[:, 1] - centre[1]) <= bin_m)]
        peaks.append(near.mean(axis=0) if len(near) else centre)
    peaks.sort(key=lambda p: float(np.hypot(*p)))
    if not peaks:
        raise ValueError("no lattice peak")
    a = peaks[0]
    b = None
    for candidate in peaks[1:]:
        cross = abs(candidate[0] * a[1] - candidate[1] * a[0]) / (np.hypot(*candidate) * np.hypot(*a))
        if cross >= 0.35:
            b = candidate
            break
    if b is None:
        raise ValueError("the cells repeat along one direction only; a lattice needs two")
    return reduce_basis(a, b)


def refine_lattice(centres, a, b, iterations=4):
    """Least squares on p = o + i a + j b with integer (i, j) re-assigned each round; a cell more
    than 0.25 |a| from its node is an outlier for the next round (at 0.35 a spurious cell landed
    inside the disc 39% of the time and pulled the fit; at 0.25 it is 20%)."""
    p = np.asarray(centres, float)
    a, b = np.array(a, float), np.array(b, float)
    # Seeded ON a cell - the one nearest the cloud's centre - so the first assignment is right
    # for that cell and its neighbours, and never half a cell off for everyone.
    o = p[int(np.argmin(np.hypot(*(p - p.mean(axis=0)).T)))].copy()
    inlier = np.ones(len(p), bool)

    def circular_mean(fraction):
        # the mean of an offset that wraps at +-0.5, per lattice axis
        angles = 2 * np.pi * fraction
        return np.arctan2(np.sin(angles).mean(axis=0), np.cos(angles).mean(axis=0)) / (2 * np.pi)

    for _ in range(iterations):
        M = np.column_stack([a, b])
        q = np.linalg.solve(M, (p - o).T).T
        ij = np.round(q)
        o = o + (M @ circular_mean((q - ij)[inlier]))
        q = np.linalg.solve(M, (p - o).T).T
        ij = np.round(q)
        residual = p - (o + ij @ M.T)
        r = np.hypot(residual[:, 0], residual[:, 1])
        inlier = r < 0.25 * np.hypot(*a)
        if inlier.sum() < 6:
            raise ValueError("lattice refinement lost its inliers")
        # solve o, a, b jointly on the inliers: p = [1 i j] [o; a; b]
        A = np.column_stack([np.ones(inlier.sum()), ij[inlier]])
        if np.linalg.matrix_rank(A) < 3:
            raise ValueError("the inlier cells lie on one line; a lattice needs two directions")
        sol, *_ = np.linalg.lstsq(A, p[inlier], rcond=None)
        o, a, b = sol[0], sol[1], sol[2]
        if abs(a[0] * b[1] - a[1] * b[0]) < 1e-9:
            raise ValueError("lattice refinement collapsed the basis")
    M = np.column_stack([a, b])
    q = np.linalg.solve(M, (p - o).T).T
    ij = np.round(q)
    residual = p - (o + ij @ M.T)
    r = np.hypot(residual[:, 0], residual[:, 1])
    inlier = r < 0.25 * np.hypot(*a)
    return {"origin": o, "a": a, "b": b, "ij": ij.astype(int), "inlier": inlier, "residual_m": r,
            "rms_m": float(np.sqrt((r[inlier] ** 2).mean())), "inlier_fraction": float(inlier.mean())}


def lattice_over_host(fit, width, height):
    """origin / columns / rows over the OBSERVED index range: the cells the segmenter saw, and no
    column the designer stopped short of (the host having room for one more is not evidence).
    A row or column is kept only where at least three observations sit on it."""
    ij = fit["ij"][fit["inlier"]]
    def span(k):
        values, counts = np.unique(ij[:, k], return_counts=True)
        held = values[counts >= 3]
        if not len(held):
            raise ValueError("no row or column holds three observed cells; the lattice has no extent")
        return int(held.min()), int(held.max())
    i0, i1 = span(0)
    j0, j1 = span(1)
    origin = fit["origin"] + i0 * fit["a"] + j0 * fit["b"]
    return {"origin_uv_m": [round(float(origin[0]), 4), round(float(origin[1]), 4)],
            "basis_a_uv_m": [round(float(fit["a"][0]), 4), round(float(fit["a"][1]), 4)],
            "basis_b_uv_m": [round(float(fit["b"][0]), 4), round(float(fit["b"][1]), 4)],
            "columns": i1 - i0 + 1, "rows": j1 - j0 + 1, "stagger_a_fraction": 0.0, "edge_policy": "clip"}


def edge_policy(observations, width, height):
    """`clip` when the observed cells run to the host edge (a veil cut by the frame), `omit_partial`
    when none does (a pattern that stops inside it); the fitted lattice covers the host either way."""
    crossing = 0
    for o in observations:
        (cx, cy), w, h = o["center_m"], o["width_m"], o["height_m"]
        if cx - w / 2 < 0 or cx + w / 2 > width or cy - h / 2 < 0 or cy + h / 2 > height:
            crossing += 1
    return "clip" if crossing > 0.02 * len(observations) else "omit_partial"


# ---- the shared unit ---------------------------------------------------------------------------

def _resample(polygon, n):
    """n points by arc length around a closed polygon, starting at the point of largest x + y so
    every cell starts at the same corner of the unit, going counter-clockwise."""
    pts = np.asarray(polygon, float)
    area = 0.5 * np.sum(pts[:, 0] * np.roll(pts[:, 1], -1) - np.roll(pts[:, 0], -1) * pts[:, 1])
    if area < 0:
        pts = pts[::-1]
    start = int(np.argmax(pts[:, 0] + pts[:, 1]))
    pts = np.roll(pts, -start, axis=0)
    closed = np.vstack([pts, pts[:1]])
    seg = np.hypot(*(np.diff(closed, axis=0).T))
    cum = np.concatenate([[0], np.cumsum(seg)])
    total = cum[-1]
    if total <= 0:
        raise ValueError("degenerate outline")
    targets = np.linspace(0, total, n, endpoint=False)
    out = []
    for t in targets:
        k = min(int(np.searchsorted(cum, t, side="right")) - 1, len(seg) - 1)
        f = (t - cum[k]) / seg[k] if seg[k] > 0 else 0.0
        out.append(closed[k] * (1 - f) + closed[k + 1] * f)
    return np.array(out)


KAPPA = 0.5522847498  # cubic Bezier quarter-circle control distance


def ellipse_unit(mean, max_residual=0.04):
    """A rotated ellipse fitted to the mean loop (points about the origin): semi-axes and turn by
    least squares on the radial function r(theta) = ab / sqrt((b cos(t-phi))^2 + (a sin(t-phi))^2).
    Returns (segments, residual) as four cubic Beziers when the RMS radial residual over the mean
    radius is under `max_residual`, else None - a pointed lens or a rounded rhombus keeps its mean
    loop; an oval throat becomes the oval it is."""
    from scipy.optimize import least_squares
    pts = np.asarray(mean, float)
    pts = pts - pts.mean(axis=0)
    theta = np.arctan2(pts[:, 1], pts[:, 0])
    radius = np.hypot(pts[:, 0], pts[:, 1])
    # Measured to set the threshold (2026-09-17): the Broad's mean loop 0.028, the fixture's lens
    # 0.032, a jittered oval 0.013; a pointed two-arc lens 0.050, a parabolic lens 0.055, a
    # diamond 0.11. 0.04 sits in the gap.
    cov = np.cov(pts.T)
    values, vectors = np.linalg.eigh(cov)
    phi0 = float(np.arctan2(vectors[1, -1], vectors[0, -1]))
    a0, b0 = float(radius.max()), float(radius.min())

    def model(params, t):
        a, b, phi = params
        return a * b / np.sqrt((b * np.cos(t - phi)) ** 2 + (a * np.sin(t - phi)) ** 2)

    sol = least_squares(lambda p: model(p, theta) - radius, [a0, b0, phi0], bounds=([1e-3, 1e-3, -np.pi], [10, 10, np.pi]))
    a, b, phi = [float(v) for v in sol.x]
    residual = float(np.sqrt(np.mean((model(sol.x, theta) - radius) ** 2)) / radius.mean())
    if residual > max_residual:
        return None
    c, s = np.cos(phi), np.sin(phi)
    R = np.array([[c, -s], [s, c]])
    k = KAPPA
    quarters = [[[1, 0], [1, k], [k, 1], [0, 1]], [[0, 1], [-k, 1], [-1, k], [-1, 0]],
                [[-1, 0], [-1, -k], [-k, -1], [0, -1]], [[0, -1], [k, -1], [1, -k], [1, 0]]]
    segments = [[list(R @ np.array([x * a, y * b])) for x, y in seg] for seg in quarters]
    # the curve's box must be [-0.5, 0.5]^2 (what prototype_scale_m multiplies), as for the loop
    sampled = np.array(sample_loop([[list(p) for p in seg] for seg in segments], 0.002)[:-1])
    lo, hi = sampled.min(axis=0), sampled.max(axis=0)
    segments = [[[round(float(v), 5) for v in (np.array(p) - (lo + hi) / 2) / (hi - lo)] for p in seg] for seg in segments]
    return segments, residual


def mean_unit(observations, n=12):
    """The shared unit: the mean of the observed unit loops, as a closed Catmull-Rom spline in
    cubic Bezier segments, normalized so its box is exactly [-0.5, 0.5]^2."""
    loops = [o["outline_unit"] for o in observations if o.get("outline_unit") and len(o["outline_unit"]) >= 4]
    if len(loops) < 3:
        raise ValueError("too few outlines for a shared unit")
    mean = np.mean([_resample(loop, 48) for loop in loops], axis=0)
    lo, hi = mean.min(axis=0), mean.max(axis=0)
    mean = (mean - (lo + hi) / 2) / (hi - lo)
    P = _resample(mean, n)

    def spline(points):
        out = []
        for i in range(n):
            p0, p1, p2, p3 = points[i - 1], points[i], points[(i + 1) % n], points[(i + 2) % n]
            out.append([p1, p1 + (p2 - p0) / 6, p2 - (p3 - p1) / 6, p2])
        return out

    # The spline overshoots the control polygon on a boxy shape and falls short of it on a
    # pointed one; sample the curve and rescale the control points so the CURVE's box is
    # [-0.5, 0.5]^2, which is what prototype_scale_m multiplies.
    sampled = np.array(sample_loop([[list(p) for p in seg] for seg in spline(P)], 0.002)[:-1])
    lo, hi = sampled.min(axis=0), sampled.max(axis=0)
    P = (P - (lo + hi) / 2) / (hi - lo)
    segments = [[[round(float(v), 5) for v in p] for p in seg] for seg in spline(P)]
    return segments, mean


# ---- fields and voids --------------------------------------------------------------------------

def _point_field(values, s, t, centre, bounds):
    """The field that explains a per-cell value: a ramp along s or t, or a radial one about
    `centre` (`from` at the centre, `to` at range and beyond) over a grid of range / falloff.
    The best is kept when it explains at least 15% more than a constant; else the constant."""
    values = np.asarray(values, float)
    constant = float(np.median(values))
    base = float(np.sqrt(((values - constant) ** 2).mean()))
    clamp = lambda v: round(float(min(bounds[1], max(bounds[0], v))), 4)
    clamped = lambda sol: np.array([min(bounds[1], max(bounds[0], float(v))) for v in sol])
    linear = None
    for axis, x in (("s", s), ("t", t)):
        A = np.column_stack([1 - x, x])
        sol, *_ = np.linalg.lstsq(A, values, rcond=None)
        sol = clamped(sol)
        rms = float(np.sqrt(((A @ sol - values) ** 2).mean()))
        if linear is None or rms < linear[0]:
            linear = (rms, axis, float(sol[0]), float(sol[1]))
    best = None
    for range_st in (0.1, 0.15, 0.2, 0.3, 0.4):
        for falloff in (0.8, 1.0, 1.5, 2.0):
            w = np.minimum(1.0, np.hypot(s - centre[0], t - centre[1]) / range_st) ** falloff
            A = np.column_stack([1 - w, w])
            sol, *_ = np.linalg.lstsq(A, values, rcond=None)
            sol = clamped(sol)
            rms = float(np.sqrt(((A @ sol - values) ** 2).mean()))
            if best is None or rms < best[0]:
                best = (rms, range_st, falloff, float(sol[0]), float(sol[1]))
    if linear[0] <= min(best[0], 0.85 * base):
        rms, axis, frm, to = linear
        return ({"kind": "linear", "axis": axis, "from": clamp(frm), "to": clamp(to), "bounds": bounds},
                {"rms": rms, "rms_constant": base, "kind": "linear", "axis": axis})
    if best is None or best[0] > 0.85 * base:
        return {"kind": "constant", "value": round(constant, 4), "bounds": bounds}, {"rms": base, "kind": "constant"}
    rms, range_st, falloff, frm, to = best
    return ({"kind": "point", "center_st": [round(float(centre[0]), 4), round(float(centre[1]), 4)], "range_st": range_st,
             "from": clamp(frm), "to": clamp(to), "falloff": falloff, "bounds": bounds},
            {"rms": rms, "rms_constant": base, "kind": "point"})


def void_from_giants(giants, keep, width, height):
    """Openings far wider than the family are the lattice's hole (The Broad's oculus): one ellipse
    around them, grown by half a cell so the neighbours it displaces are omitted too."""
    # A giant standing on the host's bottom edge is the ground floor's own glass (The Broad's
    # lobby), not a hole in the lattice; the oculus floats.
    giants = [g for g in giants if g["center_m"][1] - g["height_m"] / 2 > 0.1 * height]
    if not giants:
        return None
    median_w = float(np.median([o["width_m"] for o in keep]))
    # single-link clusters: giants within two cell widths of each other are one hole
    clusters = []
    for g in giants:
        home = None
        for cluster in clusters:
            if any(np.hypot(g["center_m"][0] - m["center_m"][0], g["center_m"][1] - m["center_m"][1]) <= 2 * median_w for m in cluster):
                home = cluster
                break
        (home if home is not None else clusters.append([]) or clusters[-1]).append(g)
    voids = []
    for k, cluster in enumerate(clusters):
        c = np.array([g["center_m"] for g in cluster], float)
        w = np.array([g["width_m"] for g in cluster], float)
        h = np.array([g["height_m"] for g in cluster], float)
        lo = (c - np.column_stack([w, h]) / 2).min(axis=0)
        hi = (c + np.column_stack([w, h]) / 2).max(axis=0)
        centre = (lo + hi) / 2
        radii = (hi - lo) / 2 + median_w / 4
        if centre[0] < 0 or centre[0] > width or centre[1] < 0 or centre[1] > height:
            continue
        voids.append({"id": f"void-{k + 1}", "kind": "ellipse", "center_uv_m": [round(float(centre[0]), 3), round(float(centre[1]), 3)],
                      "radii_m": [round(float(radii[0]), 3), round(float(radii[1]), 3)]})
    return voids or None


def voids_from_roi(document):
    """The host rectangle less the trace's ROI polygon (source.roi_px inside source.frame_px), as
    polygon voids in host metres: where the segmenter was never asked to look, the lattice does
    not go. Empty when the document names no ROI."""
    source = document.get("source") or {}
    roi, frame = source.get("roi_px"), source.get("frame_px")
    if not roi or not frame:
        return []
    from shapely.geometry import Polygon, box
    fx, fy, fw, fh = frame
    width, height = document["width_m"], document["height_m"]
    to_m = lambda x, y: ((x - fx) * width / fw, (fy + fh - y) * height / fh)
    region = Polygon([to_m(x, y) for x, y in roi]).buffer(0)
    outside = box(0, 0, width, height).difference(region)
    parts = list(outside.geoms) if hasattr(outside, "geoms") else [outside]
    # A ROI strictly inside the frame leaves the host with a HOLE in it, and a polygon void has
    # no holes: the exterior alone would void every cell. Cut such a part along vertical lines
    # through its holes' sides; the strips are hole-free.
    from shapely.geometry import LineString
    from shapely.ops import split as shapely_split
    flat = []
    for part in parts:
        pending = [part]
        for _ in range(8):
            still = [p for p in pending if p.interiors]
            if not still:
                break
            pending = [p for p in pending if not p.interiors]
            for p in still:
                xs = sorted({round(x, 6) for ring in p.interiors for x in ring.bounds[0::2]})
                pieces = [p]
                for x in xs:
                    cut = LineString([(x, -1), (x, height + 1)])
                    pieces = [q for piece in pieces for q in (shapely_split(piece, cut).geoms if piece.intersects(cut) else [piece])]
                pending.extend(pieces)
        flat.extend(pending)
    voids = []
    for k, part in enumerate(flat):
        if part.is_empty or part.area < 0.05 or part.interiors:
            continue
        ring = [[round(float(x), 3), round(float(y), 3)] for x, y in part.exterior.coords[:-1]]
        voids.append({"id": f"outside-roi-{k + 1}", "kind": "polygon", "polygon_uv_m": ring})
    return voids


# ---- the fit -----------------------------------------------------------------------------------

def fit_spec(observations, width_m, height_m, options=None):
    """observations + host -> (ModelSpec, report). `options`: depth_m, scoop_deg, model_id, source."""
    options = {**{"depth_m": -0.36, "scoop_deg": 25.0, "model_id": "fitted", "source": {"kind": "photograph"}, "voids": [],
                  "profile": {"kind": "quarter_ellipse", "rings": 3}}, **(options or {})}
    keep, giants, median_w = _select(observations)
    if len(keep) < 12:
        raise ValueError(f"only {len(keep)} cells of the repeating family; a lattice needs more")
    centres = [o["center_m"] for o in keep]
    a0, b0 = estimate_basis(centres)
    fit = refine_lattice(centres, a0, b0)
    lattice = lattice_over_host(fit, width_m, height_m)
    lattice["edge_policy"] = edge_policy(keep, width_m, height_m)
    inliers = [o for o, ok in zip(keep, fit["inlier"]) if ok]
    segments, mean_loop = mean_unit(inliers)
    unit_kind, unit_residual = "mean_loop", None
    ellipse = ellipse_unit(mean_loop)
    if ellipse is not None:
        segments, unit_residual = ellipse
        unit_kind = "ellipse"
    tile_sides = tile_sides_for(np.array(lattice["basis_a_uv_m"]), np.array(lattice["basis_b_uv_m"]), mean_loop)
    proto_w = float(np.median([o["width_m"] for o in inliers]))
    proto_h = float(np.median([o["height_m"] for o in inliers]))
    s = np.array([o["center_m"][0] / width_m for o in inliers])
    t = np.array([o["center_m"][1] / height_m for o in inliers])
    voids = void_from_giants(giants, keep, width_m, height_m)
    void = voids[0] if voids else None
    centre_st = ([void["center_uv_m"][0] / width_m, void["center_uv_m"][1] / height_m] if void
                 else [float(s[np.argmax([o["width_m"] for o in inliers])]), float(t[np.argmax([o["width_m"] for o in inliers])])])
    scale_u, report_u = _point_field([o["width_m"] / proto_w for o in inliers], s, t, centre_st, [0.5, 2.0])
    scale_v, report_v = _point_field([o["height_m"] / proto_h for o in inliers], s, t, centre_st, [0.5, 2.0])
    spec = {
        "schema_version": "arr.elevation3d.facade-model.v1",
        "model_id": options["model_id"],
        "status": "fitted_from_observations",
        "generator_version": "facade-parametric-v0.1",
        "units": "m",
        "source": options["source"],
        "host": {"kind": "plane", "locked": True, "width_m": width_m, "height_m": height_m,
                 "dimension_provenance": options.get("dimension_provenance", "from the observation document")},
        "skin": {"stand_off_m": 0.0, "thickness_m": abs(options["depth_m"]), "depth_provenance": "not observable in a photograph; option"},
        "families": [{
            "id": "fitted-cell", "role": "skin_aperture",
            "base_curve": {"kind": "piecewise_cubic_bezier", "coordinate_space": "prototype_unitless", "closed": True, "segments": segments},
            "prototype_scale_m": [round(proto_w, 4), round(proto_h, 4)],
            "shape_modes": [],
            # the cell as a module: a parallelogram tile whose long side follows the unit's own
            # lean (the ribs of the photograph), less half a web; the throat is the unit
            "mouth": {"kind": "parallelogram", "sides": tile_sides, "web_m": 0.05, "points": 24, "offset": [0.0, 0.0],
                      # the section from rim to throat is not observable in an elevation photograph:
                      # an option, named below as unobserved, defaulting to the cast veil's cove
                      **({"profile": dict(options["profile"])} if options.get("profile") else {})},
            "lattice": lattice,
            "fields": {
                "rotation_deg": {"kind": "constant", "value": 0.0, "bounds": [-90, 90]},
                "scale_u": scale_u, "scale_v": scale_v,
                "scoop_deg": {"kind": "constant", "value": options["scoop_deg"], "bounds": [0, 60]},
                "depth_m": {"kind": "constant", "value": options["depth_m"], "bounds": [-1.0, 0]},
            },
            "instance_provenance": "fitted",
        }],
        "design_voids": (voids or []) + list(options["voids"]),
        "exceptions": [], "uncertain_regions": [],
        "constraints": {"host_boundary_locked": True, "allow_aperture_overlap": False, "minimum_web_m": 0.03},
        "tolerances": {"geometry_m": 0.0001, "export_chord_error_m": 0.0005, "max_outline_points": 24},
        "metadata": {"purpose": "design_review_not_construction", "requires_human_review": True,
                     "fit": {"generator": GENERATOR, "observed": len(observations), "family": len(keep), "giants": len(giants),
                             "inliers": int(fit["inlier"].sum()), "inlier_fraction": round(fit["inlier_fraction"], 4),
                             "lattice_rms_m": round(fit["rms_m"], 4), "unobserved": ["depth_m", "scoop_deg", "mouth.profile"],
                             "unit_kind": unit_kind, **({"unit_ellipse_residual": round(unit_residual, 4)} if unit_residual is not None else {})}},
    }
    # A fitted size field can push neighbouring cells into each other where the segmenter's boxes
    # already overlapped (leaning lenses interleave; their boxes do not). The spec forbids
    # aperture overlap, so the field's swing about 1 is reduced until the evaluation holds, and
    # the reduction is recorded - a smaller field, said aloud, over a spec that cannot evaluate.
    reduction = 1.0
    for _ in range(8):
        try:
            evaluate_model(validate_spec(json.loads(json.dumps(spec))))
            break
        except ValueError as error:
            if "overlap" not in str(error):
                raise
            reduction *= 0.8
            for name in ("scale_u", "scale_v"):
                field = spec["families"][0]["fields"][name]
                for key in ("from", "to", "value"):
                    if key in field:
                        field[key] = round(1.0 + (field[key] - 1.0) * 0.8, 4)
    else:
        raise ValueError("the fitted cells overlap even with the size field reduced to a constant")
    spec["metadata"]["fit"]["field_swing_kept"] = round(reduction, 3)
    report = {"family_cells": len(keep), "giants": len(giants), "median_width_m": round(median_w, 4), "field_swing_kept": round(reduction, 3), "tile_sides": tile_sides,
              "basis_a": lattice["basis_a_uv_m"], "basis_b": lattice["basis_b_uv_m"],
              "inlier_fraction": round(fit["inlier_fraction"], 4), "lattice_rms_m": round(fit["rms_m"], 4),
              "scale_u": report_u, "scale_v": report_v, "void": void, "voids": voids}
    return spec, report


def tile_sides_for(a, b, unit_loop):
    """The parallelogram tile's two sides as integer pairs over (a, b): the long side is the
    lattice vector nearest the unit's own long axis (the direction the cells and the ribs lean),
    the short side the shortest vector that completes a unimodular pair with it."""
    pts = np.asarray(unit_loop, float)
    centred = pts - pts.mean(axis=0)
    _, vectors = np.linalg.eigh(np.cov(centred.T))
    axis = vectors[:, -1]
    det = abs(a[0] * b[1] - a[1] * b[0])
    # the six shortest lattice vectors (a, b, a+b, a-b and their negatives): a longer one would
    # make a sliver of a tile, one cell's area stretched over two rows
    candidates = [((m, n), m * a + n * b) for m in (-1, 0, 1) for n in (-1, 0, 1) if (m, n) != (0, 0)]
    def alignment(v):
        return abs(v @ axis) / (np.hypot(*v) + 1e-12)
    long_side = max(candidates, key=lambda c: (alignment(c[1]), -np.hypot(*c[1])))
    partners = [c for c in candidates if abs(abs(long_side[1][0] * c[1][1] - long_side[1][1] * c[1][0]) - det) < 1e-3 * det]
    short_side = min(partners, key=lambda c: np.hypot(*c[1]))
    return [list(long_side[0]), list(short_side[0])]


def recovery(evaluated, observations, tolerance_m):
    """Predicted cells against observed centres: matched within `tolerance_m`, missing (predicted,
    no observation), extra (observed, no prediction), RMS of the matched offsets."""
    keep, _, _ = _select(observations)
    obs = np.array([o["center_m"] for o in keep], float)
    pred = np.array([i["center_m"] for i in evaluated["instances"]], float)
    if not len(pred) or not len(obs):
        return {"predicted": len(pred), "observed": len(obs), "matched": 0}
    d = np.hypot(*(pred[:, None, :] - obs[None, :, :]).transpose(2, 0, 1))
    # one-to-one, nearest pairs first: a lattice twice too dense cannot count one observation twice
    pairs = np.argwhere(d < tolerance_m)
    order = np.argsort(d[pairs[:, 0], pairs[:, 1]])
    used_pred, used_obs, offsets = set(), set(), []
    for k in order:
        i, j = pairs[k]
        if i in used_pred or j in used_obs:
            continue
        used_pred.add(int(i)); used_obs.add(int(j)); offsets.append(d[i, j])
    return {"predicted": int(len(pred)), "observed": int(len(obs)), "matched": len(offsets),
            "missing": int(len(pred) - len(offsets)), "extra": int(len(obs) - len(offsets)),
            "matched_rms_m": round(float(np.sqrt((np.array(offsets) ** 2).mean())), 4) if offsets else None,
            "tolerance_m": tolerance_m}
