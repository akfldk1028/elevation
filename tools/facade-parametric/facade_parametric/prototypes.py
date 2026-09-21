"""A family's base curve: piecewise cubic Bezier in the unit square, shape modes as shared handle
deltas, flattened to a polygon with a chord error the caller states."""


def apply_shape_modes(segments, shape_modes, mode_values):
    """Control points with every active shape mode's deltas added (shared across the family)."""
    out = [[list(p) for p in segment] for segment in segments]
    for mode in shape_modes:
        amount = mode_values.get(mode["name"], 0.0)
        if not amount:
            continue
        for delta in mode["handle_deltas"]:
            point = out[delta["segment"]][delta["control"]]
            point[0] += delta["delta"][0] * amount
            point[1] += delta["delta"][1] * amount
    return out


def _flat_enough(p0, p1, p2, p3, tolerance):
    # Distance of the two inner controls from the chord: the usual flatness test.
    dx, dy = p3[0] - p0[0], p3[1] - p0[1]
    length = (dx * dx + dy * dy) ** 0.5
    if length < 1e-12:
        return max(abs(p1[0] - p0[0]), abs(p1[1] - p0[1]), abs(p2[0] - p0[0]), abs(p2[1] - p0[1])) <= tolerance
    d1 = abs((p1[0] - p0[0]) * dy - (p1[1] - p0[1]) * dx) / length
    d2 = abs((p2[0] - p0[0]) * dy - (p2[1] - p0[1]) * dx) / length
    return max(d1, d2) <= tolerance


def flatten_cubic(p0, p1, p2, p3, tolerance, depth=0):
    """Points strictly after p0 up to and including p3, subdivided until flat within tolerance."""
    if depth >= 12 or _flat_enough(p0, p1, p2, p3, tolerance):
        return [list(p3)]

    def mid(a, b):
        return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]

    p01, p12, p23 = mid(p0, p1), mid(p1, p2), mid(p2, p3)
    p012, p123 = mid(p01, p12), mid(p12, p23)
    p0123 = mid(p012, p123)
    return (flatten_cubic(p0, p01, p012, p0123, tolerance, depth + 1)
            + flatten_cubic(p0123, p123, p23, p3, tolerance, depth + 1))


def sample_loop(segments, tolerance_unitless):
    """Closed polygon (first point repeated last) of a closed piecewise cubic loop."""
    points = [list(segments[0][0])]
    for p0, p1, p2, p3 in segments:
        points.extend(flatten_cubic(p0, p1, p2, p3, tolerance_unitless))
    return points
