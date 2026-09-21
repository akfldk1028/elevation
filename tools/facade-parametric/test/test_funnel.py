"""The cell as a module: with a `mouth`, every instance carries a mouth (the lattice's own tile
less half a web, clipped to the host) and a throat (the family curve) with one vertex count in one
angular order, the throat inside the mouth, no two mouths overlapping."""
import copy
import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "synthetic_facade_001.json"


class Funnel(unittest.TestCase):
    def evaluate(self, **lattice):
        from facade_parametric.contracts import validate_spec
        from facade_parametric.evaluate import evaluate_model
        spec = json.loads(FIXTURE.read_text(encoding="utf-8"))
        spec["families"][0]["mouth"] = {"kind": "voronoi", "web_m": 0.06, "points": 24}
        spec["families"][0]["lattice"].update(lattice)
        return evaluate_model(validate_spec(copy.deepcopy(spec)))

    def test_every_cell_has_a_partnered_throat_inside_its_mouth(self):
        from shapely.geometry import Polygon
        evaluated = self.evaluate()
        self.assertEqual(len(evaluated["instances"]), 72)
        self.assertEqual(evaluated["overlapping_pairs"], 0)
        for cell in evaluated["instances"]:
            mouth, throat = cell["outline_m"], cell["outline_far_m"]
            self.assertEqual(len(mouth), len(throat), cell["id"])
            self.assertEqual(len(mouth), 25)  # 24 points, closed
            self.assertTrue(Polygon(mouth).contains(Polygon(throat)), cell["id"])
            self.assertEqual(cell["throat_scale"], 1.0)
            tile = cell["tile_m"]
            self.assertEqual(len(tile), len(mouth), "the tile partners the mouth and the throat")
            self.assertTrue(Polygon(tile).buffer(1e-6).contains(Polygon(mouth)), cell["id"])
        # an interior tile is the lattice's own parallelogram less the web strip: |a x b| - web * perimeter/2
        interior = evaluated["instances"][30]
        area = Polygon(interior["outline_m"]).area
        self.assertLess(area, 0.9 * 0.85)
        self.assertGreater(area, 0.8 * 0.9 * 0.85)

    def test_edge_cells_are_clipped_to_the_host_and_stay_partnered(self):
        from shapely.geometry import Polygon
        # a 13th column runs past the 12 m host; its mouths are clipped, its throats decide
        evaluated = self.evaluate(columns=13, edge_policy="clip")
        edge = [c for c in evaluated["instances"] if c["lattice_index"][0] == 12]
        self.assertTrue(edge)
        for cell in edge:
            self.assertTrue(all(0 <= x <= 12 and 0 <= y <= 6 for x, y in cell["outline_m"]), cell["id"])
            if cell.get("outline_far_m"):
                self.assertEqual(len(cell["outline_m"]), len(cell["outline_far_m"]))
                self.assertTrue(Polygon(cell["outline_m"]).contains(Polygon(cell["outline_far_m"])), cell["id"])
            else:
                # cut past its funnel: the solid panel that finishes the edge (test_edge_finish)
                self.assertGreater(Polygon(cell["outline_m"]).area, 0, cell["id"])

    def test_the_profile_rides_on_every_funnel_and_moves_the_hash(self):
        import copy, json
        from facade_parametric.contracts import validate_spec
        from facade_parametric.evaluate import evaluate_model
        spec = json.loads(FIXTURE.read_text(encoding="utf-8"))
        spec["families"][0]["mouth"] = {"kind": "voronoi", "web_m": 0.06, "points": 24}
        plain = evaluate_model(validate_spec(copy.deepcopy(spec)))
        spec["families"][0]["mouth"]["profile"] = {"kind": "quarter_ellipse", "rings": 3}
        coved = evaluate_model(validate_spec(copy.deepcopy(spec)))
        self.assertNotEqual(plain["model_hash"], coved["model_hash"], "the section is geometry; the hash moves")
        for cell in coved["instances"]:
            self.assertEqual(cell.get("profile"), {"kind": "quarter_ellipse", "rings": 3}, cell["id"])
        for cell in plain["instances"]:
            self.assertNotIn("profile", cell)
        bad = copy.deepcopy(spec); bad["families"][0]["mouth"]["profile"] = {"kind": "spline", "rings": 3}
        with self.assertRaises(ValueError):
            validate_spec(bad)

    def test_the_hash_moves_with_the_mouth(self):
        plain = json.loads(FIXTURE.read_text(encoding="utf-8"))
        from facade_parametric.contracts import validate_spec
        from facade_parametric.evaluate import evaluate_model
        self.assertNotEqual(evaluate_model(validate_spec(plain))["model_hash"], self.evaluate()["model_hash"])


if __name__ == "__main__":
    unittest.main()
