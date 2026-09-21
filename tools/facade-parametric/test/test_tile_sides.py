"""The tile is a rule, not a per-building choice: its long side is the lattice vector nearest the
unit's own long axis, its short side the shortest vector completing a unimodular pair. A lens
leaning along a + b gets the (a + b, b) tile; a lens along a gets (a, b). Voronoi was the wrong
default (it drew The Broad as a honeycomb)."""
import math
import pathlib
import sys
import unittest

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))


def lens(angle_deg, long=0.8, short=0.3, n=32):
    t = np.linspace(0, 2 * math.pi, n, endpoint=False)
    x, y = long / 2 * np.cos(t), short / 2 * np.sin(t)
    c, s = math.cos(math.radians(angle_deg)), math.sin(math.radians(angle_deg))
    return np.column_stack([x * c - y * s, x * s + y * c])


class TileSidesRule(unittest.TestCase):
    def check(self, a, b, angle, expect_long):
        from facade_parametric.fit import tile_sides_for
        a, b = np.array(a, float), np.array(b, float)
        sides = tile_sides_for(a, b, lens(angle))
        (m, n), (p, q) = sides
        self.assertEqual(abs(m * q - n * p), 1, sides)
        long = m * a + n * b
        self.assertTrue(np.allclose(np.abs(long), np.abs(expect_long), atol=1e-6) or np.allclose(long, -np.array(expect_long), atol=1e-6), (sides, long))

    def test_a_lens_along_a_plus_b_takes_that_side(self):
        a, b = [0.77, 0.0], [0.39, 0.71]
        self.check(a, b, math.degrees(math.atan2(0.71, 1.16)), [1.16, 0.71])

    def test_a_lens_along_a_takes_a(self):
        self.check([0.9, 0.0], [0.12, 0.85], 0.0, [0.9, 0.0])

    def test_a_lens_along_b_takes_b(self):
        self.check([0.9, 0.0], [0.12, 0.85], math.degrees(math.atan2(0.85, 0.12)), [0.12, 0.85])

    def test_parallelogram_tiles_cover_the_plane_once(self):
        # the evaluator's parallelogram tiles neither overlap nor leave gaps: their areas sum to the host's
        import copy, json
        from shapely.geometry import Polygon
        from shapely.ops import unary_union
        from facade_parametric.contracts import validate_spec
        from facade_parametric.evaluate import evaluate_model
        spec = json.loads((pathlib.Path(__file__).parent / "fixtures" / "synthetic_facade_001.json").read_text(encoding="utf-8"))
        spec["families"][0]["mouth"] = {"kind": "parallelogram", "sides": [[1, 1], [0, 1]], "web_m": 0.0, "points": 24}
        spec["families"][0]["lattice"]["edge_policy"] = "clip"
        evaluated = evaluate_model(validate_spec(copy.deepcopy(spec)))
        tiles = [Polygon(c["tile_m"]) for c in evaluated["instances"]]
        union = unary_union(tiles)
        self.assertAlmostEqual(sum(t.area for t in tiles), union.area, delta=0.05, msg="tiles do not overlap")
        # the tiles keep their corners: the interior of the host is covered with no triangles between rows
        from shapely.geometry import box
        interior = box(1.5, 1.5, 10.5, 4.5)
        self.assertGreater(union.intersection(interior).area, 0.995 * interior.area, "corners cut off leave gaps between modules")




if __name__ == "__main__":
    unittest.main()
