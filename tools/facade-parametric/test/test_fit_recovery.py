"""Task 3, gate G4 (L2, known-rule recovery): evaluate the synthetic spec, perturb its cells the
way a segmenter would (jitter, 10% missed, 5% spurious), fit a spec back and compare - the
lattice must come back as the same lattice, the unit as the same shape, the count within a few."""
import copy
import json
import pathlib
import random
import sys
import unittest

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "synthetic_facade_001.json"


def observe(evaluated, seed=7):
    """instances -> observations as the vision lane would see them."""
    rng = random.Random(seed)
    out = []
    for cell in evaluated["instances"]:
        if rng.random() < 0.10:
            continue
        xs = [p[0] for p in cell["outline_m"]]; ys = [p[1] for p in cell["outline_m"]]
        cx, cy = cell["center_m"]
        w, h = max(xs) - min(xs), max(ys) - min(ys)
        unit = [[(x - cx) / w, (y - cy) / h] for x, y in cell["outline_m"][:-1]]
        out.append({"center_m": [cx + rng.gauss(0, 0.02), cy + rng.gauss(0, 0.02)],
                    "width_m": w * (1 + rng.gauss(0, 0.03)), "height_m": h * (1 + rng.gauss(0, 0.03)), "outline_unit": unit})
    for _ in range(int(0.05 * len(out))):
        out.append({"center_m": [rng.uniform(0, 12), rng.uniform(0, 6)], "width_m": 0.6, "height_m": 0.4, "outline_unit": out[0]["outline_unit"]})
    return out


class FitRecovery(unittest.TestCase):
    def test_the_synthetic_lattice_and_unit_come_back(self):
        # Review 2026-09-16: one seed passed and 25 of 40 did not (a half-cell origin seed and
        # an index-two sublattice). Every seed here must pass, on the oblique fixture and on a
        # rectangular basis, which is where the sublattice appeared.
        truth = json.loads(FIXTURE.read_text(encoding="utf-8"))
        rectangular = copy.deepcopy(truth)
        rectangular["families"][0]["lattice"]["basis_b_uv_m"] = [0.0, 0.85]
        for base in (truth, rectangular):
            for seed in (0, 3, 6, 7, 9, 10):
                with self.subTest(basis=base["families"][0]["lattice"]["basis_b_uv_m"], seed=seed):
                    self.recover(base, seed)

    def recover(self, truth, seed):
        from facade_parametric.contracts import validate_spec
        from facade_parametric.evaluate import evaluate_model
        from facade_parametric.fit import fit_spec, recovery, reduce_basis
        evaluated = evaluate_model(validate_spec(copy.deepcopy(truth)))
        observations = observe(evaluated, seed)
        spec, report = fit_spec(observations, 12.0, 6.0, {"model_id": "recovered"})
        fitted = validate_spec(spec)
        # the lattice: same reduced basis to 3 cm (up to sign), most cells on their node
        ta, tb = reduce_basis(truth["families"][0]["lattice"]["basis_a_uv_m"], truth["families"][0]["lattice"]["basis_b_uv_m"])
        fa, fb = reduce_basis(fitted["families"][0]["lattice"]["basis_a_uv_m"], fitted["families"][0]["lattice"]["basis_b_uv_m"])
        def same(u, v): return min(np.hypot(*(u - v)), np.hypot(*(u + v))) < 0.03
        self.assertTrue((same(ta, fa) and same(tb, fb)) or (same(ta, fb) and same(tb, fa)), (ta, tb, fa, fb))
        self.assertGreater(report["inlier_fraction"], 0.9, report)
        self.assertLess(report["lattice_rms_m"], 0.04, report)
        # the count: the fitted lattice re-evaluated lands on the observed cells
        back = evaluate_model(fitted)
        rec = recovery(back, observations, tolerance_m=0.15)
        self.assertGreaterEqual(rec["matched"], 0.9 * rec["observed"], rec)
        self.assertLessEqual(rec["missing"], 12, rec)  # the 10% the segmenter missed, at most
        # the unit: the fitted outline's box-normalized area matches the lens (a lens fills ~0.65 of its box)
        # the fit emits a module (tile + throat); the throat is the unit, the tile is the lattice's
        cell = back["instances"][len(back["instances"]) // 2]
        ring = cell.get("outline_far_m") or cell["outline_m"]
        xs = [p[0] for p in ring]; ys = [p[1] for p in ring]
        area = 0.5 * abs(sum(xs[i] * ys[i + 1] - xs[i + 1] * ys[i] for i in range(len(xs) - 1)))
        fill = area / ((max(xs) - min(xs)) * (max(ys) - min(ys)))
        truth_cell = evaluated["instances"][len(evaluated["instances"]) // 2]
        txs = [p[0] for p in truth_cell["outline_m"]]; tys = [p[1] for p in truth_cell["outline_m"]]
        tarea = 0.5 * abs(sum(txs[i] * tys[i + 1] - txs[i + 1] * tys[i] for i in range(len(txs) - 1)))
        tfill = tarea / ((max(txs) - min(txs)) * (max(tys) - min(tys)))
        self.assertAlmostEqual(fill, tfill, delta=0.06, msg=(fill, tfill))
        # and an evaluated spec hashes and exports like any other
        self.assertEqual(len(back["model_hash"]), 64)


if __name__ == "__main__":
    unittest.main()
