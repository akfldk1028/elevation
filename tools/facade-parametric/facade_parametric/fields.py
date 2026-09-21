"""A field answers one number at a normalized host position (s, t) in [0,1]^2, evaluated at the
UNDEFORMED lattice position so no field feeds back into itself."""
import math


def evaluate_field(field, s, t):
    kind = field["kind"]
    if kind == "constant":
        return field["value"]
    if kind == "linear":
        x = s if field["axis"] == "s" else t
        x = min(1.0, max(0.0, x))
        return field["from"] + (field["to"] - field["from"]) * x
    if kind == "grid":
        rows = field["values"]
        gy = (len(rows) - 1) * min(1.0, max(0.0, t))
        gx = (len(rows[0]) - 1) * min(1.0, max(0.0, s))
        r0, c0 = int(gy), int(gx)
        r1, c1 = min(r0 + 1, len(rows) - 1), min(c0 + 1, len(rows[0]) - 1)
        fy, fx = gy - r0, gx - c0
        top = rows[r0][c0] * (1 - fx) + rows[r0][c1] * fx
        bottom = rows[r1][c0] * (1 - fx) + rows[r1][c1] * fx
        return top * (1 - fy) + bottom * fy
    if kind == "point":
        cx, cy = field["center_st"]
        distance = math.hypot(s - cx, t - cy) / field["range_st"]
        weight = min(1.0, distance) ** field["falloff"]
        return field["from"] + (field["to"] - field["from"]) * weight
    raise ValueError(f"unsupported field kind {kind}")


def cell_values(family, s, t):
    """Every cell attribute and shape mode of a family at (s, t); defaults where nothing is declared."""
    values = {"scale_u": 1.0, "scale_v": 1.0, "rotation_deg": 0.0}
    for mode in family["shape_modes"]:
        values[mode["name"]] = 0.0
    for name, field in family["fields"].items():
        values[name] = evaluate_field(field, s, t)
    return values
