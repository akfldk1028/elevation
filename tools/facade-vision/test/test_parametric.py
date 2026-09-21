import copy
import pathlib
import sys
import unittest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))


class ParametricEditing(unittest.TestCase):
    def model(self):
        points = [[-.5,-.5],[.5,-.5],[.5,.5],[-.5,.5]]
        return {'schema_version':'arr.elevation3d.facade-curves.v1', 'width_m':10, 'height_m':10,
                'units':[{'id':'square','loops':[{'segments':[
                    {'kind':'line','points':[a,b]} for a,b in zip(points,points[1:]+points[:1])]}]}],
                'instances':[{'id':str(x),'unit':'square','center_m':[x,5],
                              'width_m':1,'height_m':1} for x in [1,5,9]]}

    def test_radial_field_actually_changes_cad_instances(self):
        from src.parametric import edit_document
        from src.curve_document import transformed_loops, export_curve_document
        import tempfile, ezdxf
        original = self.model()
        edited = edit_document(original, {'fields':[{'id':'focus','kind':'radial','center_m':[5,5],
            'radius_m':4,'falloff':1}], 'grades':[{'field':'focus','attribute':'scale_u','from':1,'to':2}]})
        widths = [transformed_loops(edited, i)[1][2] for i in edited['instances']]
        self.assertEqual(widths, [1,2,1])
        self.assertEqual(original['units'], edited['units'])
        self.assertNotIn('fields', original)
        with tempfile.TemporaryDirectory() as directory:
            export_curve_document(edited, directory)
            inserts = list(ezdxf.readfile(pathlib.Path(directory)/'facade.dxf').modelspace().query('INSERT'))
            self.assertEqual([i.dxf.xscale for i in inserts], [1000,2000,1000])

    def test_spacing_and_selected_rotation_are_composable(self):
        from src.parametric import edit_document
        from src.curve_document import transformed_loops
        edited = edit_document(self.model(), {'parameters':{'spacing_u':.5},
            'instances':{'5':{'rotation_deg':30,'offset_m':[0,1]}}})
        poses = [transformed_loops(edited,i)[1] for i in edited['instances']]
        self.assertEqual([p[0] for p in poses], [3,5,7])
        self.assertEqual(poses[1][1],6)
        self.assertAlmostEqual(poses[1][4],30)

    def test_invalid_edits_fail_instead_of_being_ignored(self):
        from src.parametric import edit_document
        for edit in [{'parameters':{'spcing_u':2}}, {'instances':{'missing':{'scale_u':2}}},
                     {'parameters':{'spacing_u':-1}},
                     {'grades':[{'field':'missing','attribute':'scale_u','from':1,'to':2}]},
                     {'fields':[{'id':'bad','kind':'radial','center_m':[0,0],'radius_m':0}]}]:
            with self.subTest(edit=edit), self.assertRaises(ValueError):
                edit_document(self.model(), edit)

    def test_invalid_disconnected_loop_is_rejected(self):
        from src.curve_document import validate_curve_document
        model = self.model()
        model['units'][0]['loops'][0]['segments'][1]['points'][0] = [0,0]
        with self.assertRaises(ValueError):
            validate_curve_document(model)

    def test_pixel_boundary_coordinates_do_not_inflate_small_openings(self):
        import numpy as np
        from src.curve_document import measure_curve_fidelity
        model = self.model()
        model['instances'] = [{'id':'one','unit':'square','center_m':[1.5,8.5],
                               'width_m':1,'height_m':1}]
        model['source'] = {'frame_px':[0,0,100,100]}
        mask = np.zeros((100,100),np.uint8)
        mask[10:20,10:20] = 1
        self.assertEqual(measure_curve_fidelity(model, mask)['mask_iou'], 1)

    def test_linear_field_clamps_and_varies_rotation(self):
        from src.parametric import edit_document
        from src.curve_document import transformed_loops
        model = edit_document(self.model(), {'fields':[{'id':'ramp','kind':'linear',
            'start_m':[2,5],'end_m':[8,5]}],
            'grades':[{'field':'ramp','attribute':'rotation_deg','from':-20,'to':20}]})
        self.assertEqual([round(transformed_loops(model,i)[1][4]) for i in model['instances']], [-20,0,20])

    def test_tiling_covers_every_pixel_without_leaving_the_roi_frame(self):
        import numpy as np
        from src.tiles import image_windows
        cover = np.zeros((734,1801),np.uint8)
        for x,y,w,h in image_windows(1801,734,512):
            self.assertLessEqual(x+w,1801)
            self.assertLessEqual(y+h,734)
            cover[y:y+h,x:x+w] += 1
        self.assertTrue((cover > 0).all())
        self.assertTrue((cover > 1).any())
