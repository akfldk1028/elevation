"""Evaluate a ModelSpec and write instances.json + SVG + DXF under one model hash; or fit one
to observed cells.

    python tools/facade-parametric/cli.py evaluate <spec.json> <out-dir>
    python tools/facade-parametric/cli.py fit <curves.json> <spec-out.json> [depth_m] [scoop_deg]
    python tools/facade-parametric/cli.py apply <base-spec.json> <host.json> <spec-out.json> [edits.json]

`fit` reads a facade-curves.v1 document (the vision lane's trace: instances with centre, size and
unit loop in host metres, an optional ROI) and writes a ModelSpec with the fit's numbers in its
metadata; depth and scoop are not observable in a photograph and default to -0.36 / 25.

Prints one JSON object; exits non-zero on failure, like every other step of the pipeline."""
import json
import pathlib
import sys
import hashlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from facade_parametric.contracts import validate_spec  # noqa: E402
from facade_parametric.evaluate import evaluate_model  # noqa: E402
from facade_parametric.export import export_bundle  # noqa: E402
from facade_parametric.fit import fit_spec, observations_from_curves, recovery, voids_from_roi  # noqa: E402
from facade_parametric.apply import apply_base_model  # noqa: E402
from facade_parametric.boundary_budget import apply_with_boundary_budget  # noqa: E402


def main(argv):
    if len(argv)==3 and argv[0]=='backing':
        from facade_parametric.wall_backing import polygonal_wall_backing
        try:
            request=json.loads(pathlib.Path(argv[1]).read_text(encoding='utf-8'))
            cells=polygonal_wall_backing(request['segments'],request['storeys'],
                fold_clearance_m=request['fold_clearance_m'],floor_clearance_m=request['floor_clearance_m'],
                slab_margin_m=request['slab_margin_m'])
            digest=hashlib.sha256(json.dumps(request,sort_keys=True,separators=(',',':')).encode()).hexdigest()
            for cell in cells:cell['unit']='wall-backing'
            result={'schema_version':'arr.elevation3d.facade-instances.v1','model_hash':digest,'instances':cells}
            pathlib.Path(argv[2]).write_text(json.dumps(result),encoding='utf-8')
            print(json.dumps({'ok':True,'model_hash':digest,'instances':len(cells)}));return 0
        except (ValueError,KeyError,OSError) as error:
            print(json.dumps({'ok':False,'error':str(error)}));return 1
    if len(argv) >= 3 and argv[0] == "fit":
        return fit_command(argv[1:])
    if len(argv) >= 4 and argv[0] == "apply":
        return apply_command(argv[1:])
    if len(argv) != 3 or argv[0] != "evaluate":
        print(json.dumps({"ok": False, "error": "usage: cli.py evaluate <spec.json> <out-dir> | fit <curves.json> <spec-out.json> [depth_m] [scoop_deg]"}))
        return 2
    try:
        spec = validate_spec(json.loads(pathlib.Path(argv[1]).read_text(encoding="utf-8")))
        evaluated = evaluate_model(spec)
        written = export_bundle(spec, evaluated, argv[2])
        families = sorted({i["unit"] for i in evaluated["instances"]})
        print(json.dumps({"ok": True, "model_hash": evaluated["model_hash"], "instances": len(evaluated["instances"]),
                          "families": families, **written}))
        return 0
    except (ValueError, NotImplementedError, OSError, KeyError) as error:
        print(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"}))
        return 1


def apply_command(argv):
    """base spec + host + edits -> spec, validated and evaluated once so a bad edit fails here."""
    try:
        base = json.loads(pathlib.Path(argv[0]).read_text(encoding="utf-8"))
        host = json.loads(pathlib.Path(argv[1]).read_text(encoding="utf-8"))
        edits = json.loads(pathlib.Path(argv[3]).read_text(encoding="utf-8")) if len(argv) > 3 else {}
        spec, edits, boundary_budget = apply_with_boundary_budget(base, host, edits, keep_voids=bool(edits.get("keep_voids")))
        evaluated = evaluate_model(validate_spec(json.loads(json.dumps(spec))))
        solid = sum(p.get('aperture_area_m2', 1 if p.get('outline_far_m') else 0) <= 1e-8 for p in evaluated['instances'])
        if boundary_budget and solid / len(evaluated['instances']) >= boundary_budget['target_solid_fraction']:
            raise ValueError('compiled boundary fragments do not meet the fixed solid-fraction requirement')
        out = pathlib.Path(argv[2])
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(spec, indent=1), encoding="utf-8")
        print(json.dumps({"ok": True, "spec": str(out), "instances": len(evaluated["instances"]),
                          "solid_instances": solid,
                          **({'chosen_scale': edits['scale'], 'boundary_budget': boundary_budget} if boundary_budget else {}),
                          "model_hash": evaluated["model_hash"],
                          "host": {"kind": spec["host"]["kind"], "width_m": spec["host"]["width_m"], "height_m": spec["host"]["height_m"]},
                          "lattice": spec["families"][0]["lattice"], "edits": edits}))
        return 0
    except (ValueError, NotImplementedError, OSError, KeyError) as error:
        print(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"}))
        return 1


def fit_command(argv):
    try:
        curves = pathlib.Path(argv[0])
        document = json.loads(curves.read_text(encoding="utf-8"))
        options = {"model_id": curves.parent.name + "-fitted",
                   "source": {"kind": "photograph", "asset_path": (document.get("source") or {}).get("file"),
                              "sha256": (document.get("source") or {}).get("sha256"), "observations": str(curves),
                              "engine": (document.get("source") or {}).get("engine")},
                   "voids": voids_from_roi(document)}
        if len(argv) > 2:
            options["depth_m"] = float(argv[2])
        if len(argv) > 3:
            options["scoop_deg"] = float(argv[3])
        observations = observations_from_curves(document)
        spec, report = fit_spec(observations, document["width_m"], document["height_m"], options)
        evaluated = evaluate_model(validate_spec(json.loads(json.dumps(spec))))
        recovered = recovery(evaluated, observations, tolerance_m=0.3)
        out = pathlib.Path(argv[1])
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(spec, indent=1), encoding="utf-8")
        print(json.dumps({"ok": True, "spec": str(out), "instances": len(evaluated["instances"]), "fit": report, "recovery": recovered}, default=str))
        return 0
    except (ValueError, NotImplementedError, OSError, KeyError) as error:
        print(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
