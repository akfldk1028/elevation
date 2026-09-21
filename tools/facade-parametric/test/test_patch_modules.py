import unittest
import importlib
from shapely.geometry import Polygon


class PatchModulesTest(unittest.TestCase):
    def test_clipping_precision_does_not_depend_on_packed_chart_origin(self):
        from facade_parametric.patch_modules import clip_module
        from shapely.affinity import translate
        ring=[[.1234567,0],[.9876543,0],[.9876543,1],[.1234567,1]]
        far=[[x+1000000,y] for x,y in ring]
        a=clip_module({'outline_m':ring},Polygon(ring))
        b=clip_module({'outline_m':far},Polygon(far))
        self.assertAlmostEqual(min(v[0] for v in a['mesh_uzn']['vertices']),
            min(v[0] for v in b['mesh_uzn']['vertices'])-1000000,places=6)

    def test_affine_course_registration_preserves_one_aperture_across_a_shared_seam(self):
        from facade_parametric.patch_modules import split_by_wall_patches, active_patch_indices
        tile=[[-1,-1],[1,-1],[1,1],[-1,1]]
        cell={'id':'shared','tile_m':tile,'outline_m':[[x*.9,y*.9] for x,y in tile],
              'outline_far_m':[[x*.5,y*.5] for x,y in tile], 'profile':{'kind':'linear','rings':0}}
        # Upper course uses different canonical U origin, with a battered-wall shear.
        segments=[{'id':'lower','length_m':2,'u_min_m':-1,'chart_affine':[1,0,0],
                   'rings_m':[[[-1,-1],[1,-1],[1,0],[-1,0]]]},
                  {'id':'upper','length_m':2.2,'u_min_m':9,'chart_affine':[1,.2,-10],
                   'rings_m':[[[9,0],[11,0],[10.8,1],[8.8,1]]]}]
        parts=split_by_wall_patches([cell],segments)
        indices=active_patch_indices({'basis_a_uv_m':[1,0],'basis_b_uv_m':[0,1],
            'origin_uv_m':[-2,-2],'rows':5,'columns':5},
            {'kind':'parallelogram','sides':[[1,0],[0,1]]},segments)
        self.assertIn([2,2],indices)
        self.assertEqual(len(parts),2)
        self.assertAlmostEqual(sum(p['aperture_area_m2'] for p in parts),1,places=6)
        for p in parts:
            if p['segment_id']=='upper':
                self.assertTrue(all(8.8-1e-5<=v[0]<=11+1e-5 for v in p['mesh_uzn']['vertices']))

    def test_fold_cuts_the_original_aperture_without_moving_or_squeezing_it(self):
        module = importlib.import_module('facade_parametric.patch_modules')
        tile = [[-1,-1],[1,-1],[1,1],[-1,1],[-1,-1]]
        mouth = [[x*.9,y*.9] for x,y in tile]
        throat = [[x*.5,y*.5] for x,y in tile]
        cell = {'tile_m':tile,'outline_m':mouth,'outline_far_m':throat,
                'profile':{'kind':'linear','rings':0}}
        # Seam through the aperture: the two halves retain exactly its original area.
        halves = [Polygon([[-1,-1],[0,-1],[0,1],[-1,1]]),
                  Polygon([[0,-1],[1,-1],[1,1],[0,1]])]
        results = [module.clip_module(cell,p) for p in halves]
        self.assertAlmostEqual(sum(r['aperture_area_m2'] for r in results),1,places=6)
        for result, boundary in zip(results, halves):
            verts=result['mesh_uzn']['vertices']; faces=result['mesh_uzn']['triangles']
            self.assertTrue(all(boundary.buffer(1e-6).covers(Polygon([v[:2] for v in [verts[i] for i in face]])) for face in faces))
            edges={}
            for a,b,c in faces:
                for i,j in [(a,b),(b,c),(c,a)]:
                    key=tuple(sorted((i,j))); edges[key]=edges.get(key,0)+1
            self.assertTrue(all(n==2 for n in edges.values()),'the cut module is closed, including the cut through the funnel')
        # A concave host clips the real module, not the host bounding box.
        notch=Polygon([[-1,-1],[1,-1],[1,0],[0,0],[0,1],[-1,1]])
        result=module.clip_module(cell,notch)
        self.assertAlmostEqual(result['aperture_area_m2'],.75,places=6)
        from facade_parametric.export import to_curve_document
        part={**result,'id':'cut','unit':'family','segment_id':'wall'}
        drawing=to_curve_document({'families':[]},
            {'host':{'kind':'facet_run','width_m':2,'height_m':2,'segments':[{'id':'wall','length_m':2,'u_min_m':-1}]},
             'instances':[part],'model_hash':'a'*64,'generator_version':'test'})
        self.assertEqual(drawing['units'][0]['vectorization'],'evaluated_wall_patch_module')
        self.assertTrue(len(drawing['units'][0]['loops'])>=2,'mouth and throat cuts are drawn from the evaluated mesh')
        self.assertEqual(drawing['instances'][0]['rotation_deg'],0,'the evaluated pose is not applied twice')


if __name__ == '__main__': unittest.main()
