"""A design void is where the lattice does not go: cells whose centre falls inside are omitted."""
import copy, json, pathlib, sys, unittest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "synthetic_facade_001.json"


class DesignVoids(unittest.TestCase):
    def test_an_ellipse_void_removes_the_cells_it_covers_and_nothing_else(self):
        from facade_parametric.contracts import validate_spec
        from facade_parametric.evaluate import evaluate_model
        spec = json.loads(FIXTURE.read_text(encoding="utf-8"))
        before = evaluate_model(validate_spec(spec))
        voided = copy.deepcopy(spec)
        voided["design_voids"] = [{"id": "oculus", "kind": "ellipse", "center_uv_m": [6.0, 3.0], "radii_m": [1.4, 0.9]}]
        after = evaluate_model(validate_spec(voided))
        gone = {i["id"] for i in before["instances"]} - {i["id"] for i in after["instances"]}
        self.assertTrue(0 < len(gone) < 12, gone)
        for cell in before["instances"]:
            x, y = cell["center_m"]
            inside = ((x - 6.0) / 1.4) ** 2 + ((y - 3.0) / 0.9) ** 2 <= 1
            self.assertEqual(cell["id"] in gone, inside, cell["id"])
        self.assertNotEqual(before["model_hash"], after["model_hash"])
        bad = copy.deepcopy(voided); bad["design_voids"][0]["radii_m"] = [0, 1]
        with self.assertRaises(ValueError):
            validate_spec(bad)


if __name__ == "__main__":
    unittest.main()
