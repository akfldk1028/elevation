"""Backing glass follows the wall domain without changing the veil or the mass."""
import copy
import math
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from shapely.geometry import Polygon, box
from shapely.ops import unary_union
from facade_parametric.wall_backing import polygonal_wall_backing


class WallBacking(unittest.TestCase):
    def generate(self, rings, storeys=((0, 10),)):
        return polygonal_wall_backing(
            [{"id": "wall", "rings_m": rings}], storeys,
            fold_clearance_m=0.3, floor_clearance_m=0.15, slab_margin_m=0.2)

    def test_triangle_keeps_glass_above_inscribed_rectangle(self):
        wall = Polygon([(0, 0), (10, 0), (0, 10)])
        cells = self.generate([list(wall.exterior.coords)])
        glass = unary_union([Polygon(c["outline_m"]) for c in cells])
        self.assertGreater(glass.bounds[3], 9)
        self.assertGreater(glass.intersection(box(0, 5, 10, 10)).area, 5)
        expected = wall.buffer(-0.3, join_style=2).intersection(box(0, .2, 10, 9.8))
        self.assertLess(glass.symmetric_difference(expected).area, 1e-10)
        self.assertGreaterEqual(glass.distance(wall.boundary), .3 - 1e-10)

    def test_holes_are_refused_instead_of_filled_or_split_into_touching_openings(self):
        rings = [[(0, 0), (12, 0), (12, 10), (0, 10)],
                 [(4, 1), (8, 1), (8, 4), (4, 4)]]
        with self.assertRaisesRegex(ValueError, "holes"):
            self.generate(rings, ((0, 5), (5, 10)))

    def test_storeys_stay_clear(self):
        wall = box(0, 0, 12, 10)
        cells = self.generate([list(wall.exterior.coords)], ((0, 5), (5, 10)))
        glass = unary_union([Polygon(c["outline_m"]) for c in cells])
        expected = wall.buffer(-.3, join_style=2).intersection(
            unary_union([box(0, .2, 12, 4.8), box(0, 5.2, 12, 9.8)]))
        self.assertLess(glass.symmetric_difference(expected).area, 1e-9)
        self.assertEqual(glass.intersection(box(0, 4.8, 12, 5.2)).area, 0)
        self.assertAlmostEqual(sum(Polygon(c["outline_m"]).area for c in cells), glass.area)
        for cell in cells:
            self.assertLessEqual(len(cell["outline_m"]), 32)
            self.assertTrue(Polygon(cell["outline_m"]).is_valid)
            self.assertGreaterEqual(Polygon(cell["outline_m"]).distance(wall.boundary), .3 - 1e-10)

    def test_many_vertices_are_refused_without_resampling(self):
        ring = [(5 + 4 * math.cos(t * math.tau / 60),
                 5 + 4 * math.sin(t * math.tau / 60)) for t in range(60)]
        with self.assertRaisesRegex(ValueError, "32"):
            self.generate([ring])

    def test_inputs_not_mutated_and_host_coordinates_not_rebased(self):
        segments = [{"id": "offset", "rings_m": [[(20, 3), (25, 3), (25, 8), (20, 8)]]}]
        original = copy.deepcopy(segments)
        cells = polygonal_wall_backing(segments, [{"storey": 7, "z_min_m": 3, "z_max_m": 8}],
            fold_clearance_m=.3, floor_clearance_m=.15, slab_margin_m=.2,
            attributes={"depth_m": -.05})
        self.assertEqual(segments, original)
        self.assertEqual(cells[0]["storey"], 7)
        self.assertEqual(cells[0]["attributes"], {"depth_m": -.05})
        self.assertGreater(min(p[0] for p in cells[0]["outline_m"]), 20)

    def test_invalid_geometry_and_clearances_are_refused(self):
        with self.assertRaises(ValueError):
            self.generate([[(0, 0), (5, 5), (0, 5), (5, 0)]])
        for margin in (-1, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                polygonal_wall_backing([], [], fold_clearance_m=margin,
                    floor_clearance_m=.15, slab_margin_m=.2)
        self.assertEqual(self.generate([[(0, 0), (.1, 0), (.1, .1), (0, .1)]]), [])


if __name__ == "__main__":
    unittest.main()
