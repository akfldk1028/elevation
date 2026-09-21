"""Gate G3 (2D half): the same evaluation writes instances.json, SVG and DXF under one model hash,
and the DXF reads back with one block reference per instance."""
import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "synthetic_facade_001.json"


class ExportRoundTrip(unittest.TestCase):
    def test_svg_dxf_and_instances_share_the_model_hash(self):
        import ezdxf
        from facade_parametric.contracts import validate_spec
        from facade_parametric.evaluate import evaluate_model
        from facade_parametric.export import export_bundle
        spec = validate_spec(json.loads(FIXTURE.read_text(encoding="utf-8")))
        evaluated = evaluate_model(spec)
        with tempfile.TemporaryDirectory() as out:
            written = export_bundle(spec, evaluated, out)
            self.assertEqual(written["instances"], 72)
            document = json.loads(pathlib.Path(written["model"]).read_text(encoding="utf-8"))
            instances = json.loads(pathlib.Path(written["instances_json"]).read_text(encoding="utf-8"))
            self.assertEqual(document["model_hash"], evaluated["model_hash"])
            self.assertEqual(instances["model_hash"], evaluated["model_hash"])
            self.assertEqual(len(document["units"]), 1, "constant shape mode -> one shared unit")
            cad = ezdxf.readfile(written["dxf"])
            inserts = [e for e in cad.modelspace() if e.dxftype() == "INSERT"]
            self.assertEqual(len(inserts), 72)
            ids = {e.get_xdata("ELEVATION_AGENT")[0].value for e in inserts}
            self.assertEqual(ids, {i["id"] for i in evaluated["instances"]})
            svg = pathlib.Path(written["svg"]).read_text(encoding="utf-8")
            self.assertEqual(svg.count("<path"), 72)


if __name__ == "__main__":
    unittest.main()
