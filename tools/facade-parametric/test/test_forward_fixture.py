"""Task 1, gate G1 (spec §6.2): the synthetic ModelSpec evaluates to 72 shared-unit apertures,
a shared parameter edit moves every one of them, and a degenerate lattice is refused."""
import copy
import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "synthetic_facade_001.json"


def load_spec():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


class ForwardFixture(unittest.TestCase):
    def test_fixture_preserves_count_units_and_curve_loops(self):
        from facade_parametric.contracts import validate_spec
        from facade_parametric.evaluate import evaluate_model
        result = evaluate_model(validate_spec(load_spec()))
        self.assertEqual(result["units"], "m")
        self.assertEqual(len(result["instances"]), 72)
        ids = [a["id"] for a in result["instances"]]
        self.assertEqual(len(set(ids)), len(ids))
        for aperture in result["instances"]:
            self.assertEqual(aperture["unit"], "family_lens_01")
            self.assertEqual(aperture["provenance"], "synthetic_fixture")
            xy = aperture["outline_m"]
            self.assertGreaterEqual(len(xy), 8)
            self.assertAlmostEqual(xy[0][0], xy[-1][0], places=4)
            self.assertAlmostEqual(xy[0][1], xy[-1][1], places=4)
            for x, y in xy:
                self.assertTrue(0 < x < 12 and 0 < y < 6, (aperture["id"], x, y))
        self.assertEqual(result["model_hash"], evaluate_model(validate_spec(load_spec()))["model_hash"],
                         "the same spec twice must hash the same")

    def test_shared_parameter_actually_changes_geometry(self):
        from facade_parametric.contracts import validate_spec
        from facade_parametric.evaluate import evaluate_model
        original = load_spec()
        edited = copy.deepcopy(original)
        edited["families"][0]["fields"]["scale_v"]["value"] = 0.8
        before = evaluate_model(validate_spec(original))
        after = evaluate_model(validate_spec(edited))
        self.assertNotEqual(before["model_hash"], after["model_hash"])
        self.assertEqual(len(before["instances"]), len(after["instances"]))
        after_by_id = {a["id"]: a for a in after["instances"]}
        for old in before["instances"]:
            new = after_by_id[old["id"]]
            self.assertNotEqual(old["outline_m"], new["outline_m"], old["id"])
            self.assertEqual(old["center_m"], new["center_m"], "a scale edit does not move the lattice")
        self.assertEqual(original["host"], edited["host"])

    def test_a_zero_chord_error_is_refused_before_it_can_spin(self):
        # Review 2026-09-16: a chord error of 0 never met the point cap, and the coarsening loop
        # multiplied zero by 1.15 forever with no timeout on the Node side.
        from facade_parametric.contracts import validate_spec
        for value in (0, -0.001, "0.0005"):
            bad = load_spec()
            bad.setdefault("tolerances", {})["export_chord_error_m"] = value
            with self.assertRaisesRegex(ValueError, "export_chord_error_m"):
                validate_spec(bad)

    def test_clipping_at_the_host_edge_keeps_the_point_cap(self):
        # A cell cut by the host edge gains the clip's own corners after the cap was met.
        from facade_parametric.contracts import validate_spec
        from facade_parametric.evaluate import evaluate_model
        spec = load_spec()
        spec["families"][0]["lattice"]["edge_policy"] = "clip"
        spec["families"][0]["lattice"]["columns"] = 13  # the 13th column runs past the 12 m host
        spec.setdefault("tolerances", {})["max_outline_points"] = 8
        result = evaluate_model(validate_spec(spec))
        self.assertGreater(len(result["instances"]), 72, "clip keeps the edge cells omit_partial drops")
        for cell in result["instances"]:
            self.assertLessEqual(len(cell["outline_m"]) - 1, 8, cell["id"])

    def test_degenerate_lattice_is_rejected(self):
        from facade_parametric.contracts import validate_spec
        bad = load_spec()
        bad["families"][0]["lattice"]["basis_b_uv_m"] = [1.8, 0.0]
        with self.assertRaisesRegex(ValueError, "lattice"):
            validate_spec(bad)

    def test_unknown_keys_and_bad_numbers_are_rejected(self):
        from facade_parametric.contracts import validate_spec
        spec = load_spec()
        spec["families"][0]["lattice"]["rows"] = -1
        with self.assertRaises(ValueError):
            validate_spec(spec)
        spec = load_spec()
        spec["families"][0]["fields"]["scale_u"]["value"] = 5.0  # outside declared bounds
        with self.assertRaises(ValueError):
            validate_spec(spec)
        spec = load_spec()
        spec["families"][0]["extra"] = 1
        with self.assertRaises(ValueError):
            validate_spec(spec)


if __name__ == "__main__":
    unittest.main()
