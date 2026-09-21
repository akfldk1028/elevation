"""A base model applied to another host: the family, lattice basis and fields travel; the host,
the voids and the source do not; the lattice is re-laid to cover the new host; edits scale the
cell and its pitch together, set the thickness, the web and the lean."""
import copy
import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "synthetic_facade_001.json"


class ApplyBaseModel(unittest.TestCase):
    def test_sparse_grid_budgets_only_explicit_allocations_and_refuses_duplicate_indices(self):
        from facade_parametric.contracts import validate_spec
        from facade_parametric.lattice import cell_centres
        base=self.base()
        lattice=base['families'][0]['lattice']
        lattice.update(columns=500,rows=50,active_indices=[[0,0],[499,49]])
        checked=validate_spec(copy.deepcopy(base))
        self.assertEqual(len(cell_centres(checked['families'][0]['lattice'])),2)
        lattice['active_indices']=[[0,0],[0,0]]
        with self.assertRaisesRegex(ValueError,'duplicate'):
            validate_spec(base)

    def test_cover_grid_budget_accepts_5000_and_refuses_unbounded_counts(self):
        from facade_parametric.contracts import validate_spec
        base = self.base()
        base['families'][0]['lattice'].update(columns=100, rows=50)
        validate_spec(copy.deepcopy(base))
        base['families'][0]['lattice'].update(columns=500, rows=50)
        with self.assertRaisesRegex(ValueError, '25000 requested.*GLB bytes'):
            validate_spec(base)

    def test_section_edit_reaches_evaluated_modules_without_mutating_base(self):
        from facade_parametric.apply import apply_base_model
        from facade_parametric.contracts import validate_spec
        from facade_parametric.evaluate import evaluate_model
        base = self.base()
        base['families'][0]['mouth']['profile'] = {'kind': 'quarter_ellipse', 'rings': 3}
        spec = apply_base_model(base, {'kind':'plane', 'locked':True, 'width_m':4, 'height_m':4,
                                     'dimension_provenance':'test'}, {'profile':{'kind':'linear','rings':0}})
        parts = evaluate_model(validate_spec(spec))['instances']
        self.assertTrue(any(p.get('outline_far_m') for p in parts))
        for part in parts:
            if part.get('outline_far_m'):
                self.assertEqual(part['profile'], {'kind':'linear','rings':0})
        self.assertEqual(base['families'][0]['mouth']['profile']['rings'], 3)

    def base(self):
        base = json.loads(FIXTURE.read_text(encoding="utf-8"))
        base["families"][0]["mouth"] = {"kind": "voronoi", "web_m": 0.06, "points": 24}
        base["design_voids"] = [{"id": "hole", "kind": "ellipse", "center_uv_m": [6, 3], "radii_m": [1, 1]}]
        return base

    def test_the_base_covers_a_new_host_with_its_own_lattice_and_edits(self):
        from facade_parametric.apply import apply_base_model
        from facade_parametric.contracts import validate_spec
        from facade_parametric.evaluate import evaluate_model
        host = {"kind": "facet_run", "locked": True, "candidate": "box", "height_m": 9.0,
                "segments": [{"id": "A", "length_m": 4.0}, {"id": "B", "length_m": 4.0}, {"id": "C", "length_m": 4.0}], "dimension_provenance": "test"}
        spec = apply_base_model(self.base(), host, {"scale": 0.5, "thickness": 0.3, "web": 0.04, "rotate": 10})
        self.assertEqual(spec["design_voids"], [], "the source building's voids do not travel")
        self.assertEqual(spec["source"]["kind"], "base_model")
        family = spec["families"][0]
        self.assertEqual(family["prototype_scale_m"], [0.325, 0.2])
        self.assertEqual(family["lattice"]["basis_a_uv_m"], [0.45, 0.0])
        self.assertEqual(family["lattice"]["edge_policy"], "clip")
        self.assertEqual(family["fields"]["depth_m"]["value"], 0.3)
        self.assertEqual(family["mouth"]["web_m"], 0.04)
        self.assertEqual(family["fields"]["rotation_deg"]["value"], 40.0)
        evaluated = evaluate_model(validate_spec(copy.deepcopy(spec)))
        self.assertEqual(evaluated["host"]["width_m"], 12.0)
        segments = {part["segment_id"] for part in evaluated["instances"]}
        self.assertEqual(segments, {"A", "B", "C"}, "every facet of the run received cells")
        # the lattice covers the whole run: cells reach both ends and the top
        xs = [p[0] for part in evaluated["instances"] if part["segment_id"] == "C" for p in part["outline_m"]]
        ys = [p[1] for part in evaluated["instances"] for p in part["outline_m"]]
        self.assertGreater(max(xs), 3.5)
        self.assertGreater(max(ys), 8.5)
        self.assertLess(min(ys), 0.5)

    def test_a_degenerate_base_lattice_is_refused(self):
        from facade_parametric.apply import apply_base_model
        base = self.base()
        base["families"][0]["lattice"]["basis_b_uv_m"] = [1.8, 0.0]
        with self.assertRaisesRegex(ValueError, "degenerate"):
            apply_base_model(base, {"kind": "plane", "width_m": 10, "height_m": 5, "candidate": "p"})


if __name__ == "__main__":
    unittest.main()
