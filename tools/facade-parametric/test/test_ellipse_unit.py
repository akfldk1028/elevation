"""The fitter names the unit it saw: an oval throat becomes the ellipse it is (four Beziers,
rotated), a pointed lens keeps its mean loop. Nothing is per building; the residual decides."""
import math
import pathlib
import sys
import unittest

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))


def oval(angle_deg, a=0.45, b=0.18, n=48, jitter=0.0, seed=0):
    rng = np.random.default_rng(seed)
    t = np.linspace(0, 2 * math.pi, n, endpoint=False)
    x, y = a * np.cos(t), b * np.sin(t)
    c, s = math.cos(math.radians(angle_deg)), math.sin(math.radians(angle_deg))
    pts = np.column_stack([x * c - y * s, x * s + y * c])
    return pts + rng.normal(0, jitter, pts.shape)


def lens(a=0.45, b=0.18, n=48):
    # two circular arcs meeting at points: a pointed lens, not an ellipse
    t = np.linspace(-1, 1, n // 2)
    top = np.column_stack([a * t, b * (1 - t ** 2)])
    bottom = np.column_stack([a * t[::-1], -b * (1 - t[::-1] ** 2)])
    return np.vstack([top, bottom])


class EllipseUnit(unittest.TestCase):
    def test_a_jittered_rotated_oval_is_read_as_an_ellipse(self):
        from facade_parametric.fit import ellipse_unit
        from facade_parametric.prototypes import sample_loop
        result = ellipse_unit(oval(35, jitter=0.004))
        self.assertIsNotNone(result)
        segments, residual = result
        self.assertEqual(len(segments), 4)
        self.assertLess(residual, 0.03)
        sampled = np.array(sample_loop(segments, 0.002)[:-1])
        lo, hi = sampled.min(axis=0), sampled.max(axis=0)
        self.assertTrue(np.allclose(lo, -0.5, atol=0.01) and np.allclose(hi, 0.5, atol=0.01), "the curve's box is the unit square")
        # every point of the fitted curve lies on the observed oval once both are in the unit box
        # (the fitted curve is sampled coarsely, so the comparison runs from its samples to a
        # dense observed curve, not the other way round)
        dense = oval(35, n=2000)
        lo, hi = dense.min(axis=0), dense.max(axis=0)
        dense = (dense - (lo + hi) / 2) / (hi - lo)
        worst = max(np.min(np.hypot(*(dense - p).T)) for p in sampled)
        self.assertLess(worst, 0.01, f"fitted ellipse leaves the observed oval by {worst}")

    def test_a_pointed_lens_keeps_its_mean_loop(self):
        from facade_parametric.fit import ellipse_unit
        self.assertIsNone(ellipse_unit(lens()), "a parabolic lens (residual 0.055) is not an ellipse")
        t = np.linspace(-1, 1, 24)
        diamond = np.vstack([np.column_stack([0.45 * t, 0.18 * (1 - np.abs(t))]), np.column_stack([0.45 * t[::-1], -0.18 * (1 - np.abs(t[::-1]))])])
        self.assertIsNone(ellipse_unit(diamond), "a diamond (residual 0.11) is not an ellipse")


if __name__ == "__main__":
    unittest.main()
