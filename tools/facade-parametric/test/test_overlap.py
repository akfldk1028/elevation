"""The lattice contract: cells may touch but not overlap unless the spec allows it."""
import copy, json, pathlib, sys, unittest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "synthetic_facade_001.json"


class Overlap(unittest.TestCase):
    def test_overlapping_cells_are_refused_unless_allowed(self):
        from facade_parametric.contracts import validate_spec
        from facade_parametric.evaluate import evaluate_model
        spec = json.loads(FIXTURE.read_text(encoding="utf-8"))
        self.assertEqual(evaluate_model(validate_spec(spec))["overlapping_pairs"], 0)
        dense = copy.deepcopy(spec)
        dense["families"][0]["lattice"]["basis_a_uv_m"] = [0.4, 0.0]  # 0.65 m lenses at 0.4 m pitch
        with self.assertRaisesRegex(ValueError, "overlap"):
            evaluate_model(validate_spec(dense))
        dense["constraints"]["allow_aperture_overlap"] = True
        self.assertGreater(evaluate_model(validate_spec(dense))["overlapping_pairs"], 0)


if __name__ == "__main__":
    unittest.main()
