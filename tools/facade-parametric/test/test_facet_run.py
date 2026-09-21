"""Task 2b, gate G3c: a lattice over a run of facets, unfolded. Every cell lands on its facet in
that facet's own u; a cell across a seam becomes one part per facet with its rings still
partnered and nested; the unfolded drawing puts the parts back where the run has them."""
import copy
import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "synthetic_facade_001.json"


class FacetRun(unittest.TestCase):
    def spec(self):
        spec = json.loads(FIXTURE.read_text(encoding="utf-8"))
        spec["families"][0]["mouth"] = {"kind": "voronoi", "web_m": 0.06, "points": 24}
        spec["host"] = {"kind": "facet_run", "locked": True, "candidate": "test", "height_m": 6.0,
                        "segments": [{"id": "A", "length_m": 5.5}, {"id": "B", "length_m": 6.5}], "dimension_provenance": "test"}
        return spec

    def test_cells_land_on_their_facets_and_seam_cells_split_partnered(self):
        from shapely.geometry import Polygon
        from facade_parametric.contracts import validate_spec
        from facade_parametric.evaluate import evaluate_model
        evaluated = evaluate_model(validate_spec(copy.deepcopy(self.spec())))
        self.assertEqual(evaluated["host"]["width_m"], 12.0)
        parts = evaluated["instances"]
        by = {}
        for part in parts:
            by.setdefault(part["segment_id"], []).append(part)
        self.assertEqual(set(by), {"A", "B"})
        for sid, length in (("A", 5.5), ("B", 6.5)):
            xs = [p[0] for part in by[sid] for p in part["outline_m"]]
            self.assertGreaterEqual(min(xs), -1e-6, sid)
            self.assertLessEqual(max(xs), length + 1e-6, sid)
        split = [p for p in parts if "-p" in p["id"]]
        self.assertGreater(len(split), 0, "cells straddle the seam at 5.5")
        for part in parts:
            if part.get("outline_far_m"):
                self.assertEqual(len(part["outline_far_m"]), len(part["outline_m"]), part["id"])
                self.assertTrue(Polygon(part["outline_m"]).buffer(1e-6).contains(Polygon(part["outline_far_m"])), part["id"])
            if part.get("tile_m"):
                self.assertEqual(len(part["tile_m"]), len(part["outline_m"]), part["id"])
                self.assertTrue(Polygon(part["tile_m"]).buffer(1e-6).contains(Polygon(part["outline_m"])), part["id"])
        # no two parts overlap on one facet (the seam split keeps the lattice's own spacing)
        self.assertEqual(evaluated["overlapping_pairs"], 0)

    def test_a_seam_through_a_throat_squeezes_the_lens_into_its_part(self):
        # a funnel lives in one plane: a part of a cell whose throat the seam cuts carries a lens
        # scaled to sit inside it (never a half-lens with an edge on the seam), a part too thin
        # for one is solid, and a whole cell beside the seam keeps its throat and tile
        from facade_parametric.contracts import validate_spec
        from facade_parametric.evaluate import evaluate_model
        evaluated = evaluate_model(validate_spec(copy.deepcopy(self.spec())))
        parts = evaluated["instances"]
        split = [p for p in parts if "-p" in p["id"]]
        self.assertGreater(len(split), 0)
        whole_ids = {p["id"] for p in parts if "-p" not in p["id"]}
        self.assertTrue(any(p.get("outline_far_m") for p in parts if p["id"] in whole_ids), "whole cells keep their throat")
        self.assertTrue(any(not p.get("outline_far_m") for p in split), "some seam cells are closed")
        # no open part's throat touches the seam: a throat the seam cut would have a vertex ON it
        length = {"A": 5.5, "B": 6.5}
        for p in split:
            if p.get("outline_far_m"):
                xs = [q[0] for q in p["outline_far_m"]]
                self.assertGreater(min(xs), 1e-6, p["id"])
                self.assertLess(max(xs), length[p["segment_id"]] - 1e-6, p["id"])
            else:
                self.assertNotIn("tile_m", p, p["id"])

    def test_the_profile_travels_to_open_parts_and_not_to_solid_pieces(self):
        from facade_parametric.contracts import validate_spec
        from facade_parametric.evaluate import evaluate_model
        spec = self.spec()
        spec["families"][0]["mouth"]["profile"] = {"kind": "quarter_ellipse", "rings": 2}
        parts = evaluate_model(validate_spec(copy.deepcopy(spec)))["instances"]
        for p in parts:
            if p.get("outline_far_m"):
                self.assertEqual(p.get("profile"), {"kind": "quarter_ellipse", "rings": 2}, p["id"])
            else:
                self.assertNotIn("profile", p, p["id"])

    def test_the_unfolded_drawing_offsets_facet_b(self):
        from facade_parametric.contracts import validate_spec
        from facade_parametric.evaluate import evaluate_model
        from facade_parametric.export import to_curve_document
        spec = validate_spec(copy.deepcopy(self.spec()))
        evaluated = evaluate_model(spec)
        document = to_curve_document(spec, evaluated)
        self.assertEqual(document["width_m"], 12.0)
        b = [i for i, part in zip(document["instances"], evaluated["instances"]) if part["segment_id"] == "B"]
        self.assertTrue(all(i["center_m"][0] >= 5.5 - 1e-6 for i in b), "facet B's cells sit past the seam in the unfolded drawing")


if __name__ == "__main__":
    unittest.main()
