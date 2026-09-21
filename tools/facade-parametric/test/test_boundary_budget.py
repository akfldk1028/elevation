import copy
import json
import pathlib
import unittest
from unittest.mock import patch

from facade_parametric.boundary_budget import score_boundary_fragments, apply_with_boundary_budget
from facade_parametric.apply import apply_base_model

FIXTURE = pathlib.Path(__file__).parent/'fixtures'/'synthetic_facade_001.json'


class BoundaryBudgetTest(unittest.TestCase):
    def specimen(self):
        spec=json.loads(FIXTURE.read_text(encoding='utf-8'))
        family=spec['families'][0]
        family['mouth']={'kind':'parallelogram','sides':[[1,0],[0,1]],'web_m':.05,'points':8}
        family['lattice'].update(origin_uv_m=[1,1],basis_a_uv_m=[2,0],basis_b_uv_m=[0,2],columns=1,rows=1,active_indices=[[0,0]],edge_policy='clip',stagger_a_fraction=0)
        spec['design_voids']=[]
        spec['host']={'kind':'facet_run','boundary_policy':'preserve_pattern','width_m':2,'height_m':2,
            'segments':[{'id':str(i),'length_m':hi-lo,'u_min_m':lo,'chart_affine':[1,0,0],
                'rings_m':[[[lo,0],[hi,0],[hi,2],[lo,2]]]} for i,(lo,hi) in enumerate([(0,.1),(.5,1.5),(1.9,2)])]}
        return spec

    def test_original_aperture_kept_and_solid_slivers_counted_without_manifold(self):
        spec=self.specimen();before=copy.deepcopy(spec)
        with patch('facade_parametric.patch_modules.clip_module',side_effect=AssertionError('no solid evaluation during score')):
            score=score_boundary_fragments(spec)
        self.assertEqual(score['instances'],3)
        self.assertEqual(score['solid_instances'],2)
        self.assertEqual(score['active_cells'],1)
        self.assertEqual(spec,before)

    def test_explicit_scale_and_legacy_host_do_not_trigger_search(self):
        base=self.specimen();host=base['host'];edits={'scale':.8}
        # A normal call remains byte-for-byte equivalent to the established apply.
        expected=apply_base_model(base,host,edits)
        with patch('facade_parametric.boundary_budget.score_boundary_fragments',side_effect=AssertionError('unexpected search')):
            result,effective,report=apply_with_boundary_budget(base,host,edits)
        self.assertEqual(result,expected);self.assertEqual(effective,edits);self.assertIsNone(report)
        plain={'kind':'plane','locked':True,'width_m':2,'height_m':2,'dimension_provenance':'test'}
        with patch('facade_parametric.boundary_budget.score_boundary_fragments',side_effect=AssertionError('legacy search')):
            result,effective,report=apply_with_boundary_budget(base,plain,{'scale':.8,'auto_boundary_budget':True})
        self.assertIsNone(report)

    def test_nonmonotonic_search_keeps_shape_web_and_selects_first_passing_scale(self):
        base=self.specimen();before=copy.deepcopy(base);host=base['host'];edits={'scale':.9,'auto_boundary_budget':True}
        scores=[{'solid_fraction':p,'instances':100,'solid_instances':round(p*100),'active_cells':20} for p in [.3,.31,.24,.26,.245]]
        with patch('facade_parametric.boundary_budget.score_boundary_fragments',side_effect=scores):
            spec,effective,report=apply_with_boundary_budget(base,host,edits)
        self.assertAlmostEqual(effective['scale'],.7938)
        self.assertEqual(len(report['trials']),5)
        self.assertEqual([t['stage'] for t in report['trials']],['coarse']*3+['refine']*2)
        self.assertEqual(report['target_solid_fraction'],.25)
        self.assertEqual(spec['families'][0]['mouth'],base['families'][0]['mouth'])
        self.assertEqual(spec['families'][0]['base_curve'],base['families'][0]['base_curve'])
        self.assertEqual(base,before);self.assertEqual(edits['scale'],.9)

    def test_uniform_refinement_is_bounded_and_retains_coarse_solution_if_all_samples_fail(self):
        base=self.specimen()
        scores=[{'solid_fraction':p,'instances':100,'solid_instances':round(p*100),'active_cells':20}
                for p in [.3,.24]+[.251]*9]
        with patch('facade_parametric.boundary_budget.score_boundary_fragments',side_effect=scores):
            spec,effective,report=apply_with_boundary_budget(base,base['host'],{'scale':.9,'auto_boundary_budget':True})
        self.assertAlmostEqual(effective['scale'],.81)
        self.assertEqual(len(report['trials']),11)
        refined=[t['scale'] for t in report['trials'] if t['stage']=='refine']
        self.assertEqual(len(refined),report['refinement_max_additional_trials'])
        self.assertTrue(all(a>b for a,b in zip(refined,refined[1:])))

    def test_search_refuses_when_allocation_floor_is_reached(self):
        from facade_parametric.contracts import MAX_CELLS
        base=self.specimen()
        with patch('facade_parametric.boundary_budget.score_boundary_fragments',return_value={
            'solid_fraction':.3,'instances':MAX_CELLS,'solid_instances':int(MAX_CELLS*.3),'active_cells':MAX_CELLS}):
            with self.assertRaisesRegex(ValueError,'allocation floor'):
                apply_with_boundary_budget(base,base['host'],{'scale':.9,'auto_boundary_budget':True})

if __name__=='__main__':unittest.main()
