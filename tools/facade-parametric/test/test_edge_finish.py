"""A veil that reaches an edge is finished by panels, not by missing cells: under any policy but
`omit_partial`, the cells' footprints cover the host to its boundary, and a cell the edge cut past
its funnel is a solid piece (outline only). The user, looking at the drawing: "어떤 mass든 입면이
마무리가 깔끔하게 되어야 하는 거 아님?" - the notched facet tops and staircase row ends were cells
the evaluator had dropped."""
import copy
import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "synthetic_facade_001.json"


class EdgeFinish(unittest.TestCase):
    def spec(self, policy="clip"):
        # the lattice is laid over the whole host the way `apply` lays a base model on a new mass
        from facade_parametric.apply import _cover
        spec = json.loads(FIXTURE.read_text(encoding="utf-8"))
        spec["families"][0]["mouth"] = {"kind": "parallelogram", "sides": [[1, 1], [0, 1]], "web_m": 0.05, "points": 24}
        host = spec["host"]
        spec["families"][0]["lattice"] = {**_cover(spec["families"][0]["lattice"], host["width_m"], host["height_m"]), "edge_policy": policy}
        spec["design_voids"] = []
        return spec

    def evaluate(self, policy="clip"):
        from facade_parametric.contracts import validate_spec
        from facade_parametric.evaluate import evaluate_model
        return evaluate_model(validate_spec(copy.deepcopy(self.spec(policy))))

    def test_the_veil_covers_its_host_to_the_boundary(self):
        from shapely.geometry import box
        from shapely.ops import unary_union
        from shapely.geometry import Polygon
        evaluated = self.evaluate("clip")
        host = evaluated["host"]
        w, h = host["width_m"], host["height_m"]
        covered = unary_union([Polygon(c.get("tile_m") or c["outline_m"]) for c in evaluated["instances"]])
        self.assertGreater(covered.area, 0.98 * w * h, "the veil leaves the host bare somewhere")
        # and it reaches every edge: a 5 cm strip inside each boundary is covered
        for strip in (box(0, 0, w, 0.05), box(0, h - 0.05, w, h), box(0, 0, 0.05, h), box(w - 0.05, 0, w, h)):
            self.assertGreater(covered.intersection(strip).area, 0.95 * strip.area, "an edge of the host is unfinished")

    def test_an_edge_cell_past_its_funnel_is_a_solid_piece(self):
        evaluated = self.evaluate("clip")
        solid = [c for c in evaluated["instances"] if not c.get("outline_far_m")]
        self.assertGreater(len(solid), 0, "the boundary cuts some cells past their funnel")
        for cell in solid:
            self.assertNotIn("tile_m", cell, cell["id"])
            self.assertNotIn("profile", cell, cell["id"])

    def test_omit_partial_still_stops_inside_the_frame(self):
        # the fitted policy of a photograph whose veil does not reach its own frame
        clipped = self.evaluate("clip")
        omitted = self.evaluate("omit_partial")
        self.assertLess(len(omitted["instances"]), len(clipped["instances"]))
        for cell in omitted["instances"]:
            self.assertTrue(cell.get("outline_far_m"), "every kept cell is a whole funnel")


if __name__ == "__main__":
    unittest.main()
