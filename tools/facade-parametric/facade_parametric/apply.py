"""A BASE MODEL applied to a building: a spec read once (from a photograph, or by hand) is laid over
another host with edits - size, pitch, thickness, web, lean - so one parametric design becomes
an elevation of ours (the user: "파라메트릭 base model 가져와서 우리 거에 맞는 입면으로 맞춘다,
조금씩 변형하는 것도 맞춰서").

What travels from the base: the family (unit curve, shape modes, prototype scale, mouth), the
lattice basis and stagger, the fields. What does not: the host, the design voids (an oculus is
the source building's) and the source record - the new spec names the base it came from.
"""
import copy
import math


def _cover(lattice, width, height):
    """origin / columns / rows so the lattice covers the host rectangle with a margin of one cell."""
    ax, ay = lattice["basis_a_uv_m"]
    bx, by = lattice["basis_b_uv_m"]
    det = ax * by - ay * bx
    if abs(det) < 1e-9:
        raise ValueError("the base lattice has a degenerate basis")
    corners = [(0, 0), (width, 0), (0, height), (width, height)]
    ij = [((by * x - bx * y) / det, (-ay * x + ax * y) / det) for x, y in corners]
    i0, i1 = math.floor(min(i for i, _ in ij)) - 1, math.ceil(max(i for i, _ in ij)) + 1
    j0, j1 = math.floor(min(j for _, j in ij)) - 1, math.ceil(max(j for _, j in ij)) + 1
    return {**lattice,
            "origin_uv_m": [round(i0 * ax + j0 * bx, 4), round(i0 * ay + j0 * by, 4)],
            "columns": i1 - i0 + 1, "rows": j1 - j0 + 1, "edge_policy": "clip"}


def _move_voids_to_face(spec, host, face=None):
    """A void is a place on a FACE. The base read it on one wall, in that wall's own metres; an
    unfolded run measures u from wherever its chain starts, so carried over unchanged the oculus and
    the lift land on whatever facets happen to share those metres - the Broad's veil lifted off the
    back of the building. Shift every void to where that face begins in the run."""
    if host.get("kind") != "facet_run":
        return
    wanted = face or "front"
    offset, found = 0.0, None
    for segment in host["segments"]:
        if segment.get("view") == wanted:
            found = offset
            break
        offset += segment["length_m"]
    if found is None or found == 0:
        return
    for void in spec.get("design_voids", []):
        if void.get("kind") == "ellipse":
            void["center_uv_m"] = [round(void["center_uv_m"][0] + found, 6), void["center_uv_m"][1]]
        elif void.get("kind") == "polygon":
            void["polygon_uv_m"] = [[round(u + found, 6), z] for u, z in void["polygon_uv_m"]]


def apply_base_model(base, host, edits=None, keep_voids=False):
    """base spec + host (plane or facet_run, already in contract shape) + edits -> a new spec."""
    edits = edits or {}
    spec = copy.deepcopy(base)
    spec["host"] = copy.deepcopy(host)
    if host.get("kind") == "facet_run" and "width_m" not in spec["host"]:
        spec["host"]["width_m"] = round(sum(s["length_m"] for s in host["segments"]), 6)
    host = spec["host"]
    spec["model_id"] = edits.get("model_id") or f"{base.get('model_id', 'base')}-on-{host.get('candidate', 'host')}"
    spec["status"] = "base_model_applied"
    spec["source"] = {"kind": "base_model", "base_model_id": base.get("model_id"), "base_source": base.get("source"),
                      "edits": {k: v for k, v in edits.items() if k != "model_id"}}
    if not keep_voids:
        spec["design_voids"] = []
        spec["uncertain_regions"] = []
    else:
        _move_voids_to_face(spec, host, edits.get("face"))
    scale = float(edits.get("scale", 1.0))      # the cell and its pitch together
    pitch = float(edits.get("pitch", 1.0))      # the pitch alone (a denser or sparser veil)
    for family in spec["families"]:
        family["prototype_scale_m"] = [round(v * scale, 4) for v in family["prototype_scale_m"]]
        lattice = family["lattice"]
        for key in ("basis_a_uv_m", "basis_b_uv_m"):
            lattice[key] = [round(v * scale * pitch, 4) for v in lattice[key]]
        family["lattice"] = _cover(lattice, host["width_m"], host["height_m"])
        if host.get('boundary_policy') == 'preserve_pattern':
            from .patch_modules import active_patch_indices
            family['lattice']['active_indices']=active_patch_indices(family['lattice'],family.get('mouth'),host['segments'])
        fields = family["fields"]
        if "thickness" in edits:
            fields["depth_m"] = {"kind": "constant", "value": float(edits["thickness"]), "bounds": [0, 1.5]}
        if "web" in edits and family.get("mouth"):
            family["mouth"]["web_m"] = float(edits["web"])
        if "points" in edits and family.get("mouth"):
            # fewer points a ring: a veil over sixteen facets is two thousand modules of four rings
            family["mouth"]["points"] = int(edits["points"])
        if "profile" in edits and family.get("mouth"):
            family["mouth"]["profile"] = copy.deepcopy(edits["profile"])
        if "rotate" in edits:
            rotation = fields.get("rotation_deg", {"kind": "constant", "value": 0.0, "bounds": [-90, 90]})
            if rotation["kind"] != "constant":
                raise ValueError("--rotate needs a constant rotation field in the base")
            fields["rotation_deg"] = {**rotation, "value": rotation["value"] + float(edits["rotate"]), "bounds": [-180, 180]}
        # a size field read off one building's photograph is that building's; a base carried
        # elsewhere keeps its unit at 1 unless told otherwise
        # A size field read off one building's photograph is that building's - flattened when the
        # base travels to another mass, KEPT when it is laid back on the building it came from.
        if edits.get("flat_fields", True):
            for name in ("scale_u", "scale_v"):
                if name in fields and fields[name]["kind"] != "constant":
                    fields[name] = {"kind": "constant", "value": 1.0, "bounds": fields[name].get("bounds", [0.5, 2.0])}
    spec["metadata"] = {**spec.get("metadata", {}), "purpose": "design_review_not_construction", "requires_human_review": True,
                        "applied": {"base_model_id": base.get("model_id"), "host_kind": host.get("kind"), "edits": spec["source"]["edits"]}}
    return spec
