import importlib.util
import pathlib
import sys
import unittest
import tempfile
import copy
import subprocess
import json

import cv2
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'src' / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class OutlineFidelity(unittest.TestCase):
    def test_rectangle_is_not_replaced_with_a_hexagon(self):
        contour = np.array([[10, 10], [90, 10], [90, 90], [10, 90]], np.int32).reshape(-1, 1, 2)
        points = load('outline_extractor').extract_normalized_outline(contour, (10, 10, 80, 80))
        self.assertEqual(len(points), 4)
        self.assertEqual(set(map(tuple, points)), {(0, 0), (1, 0), (1, 1), (0, 1)})

    def test_concave_opening_keeps_its_indentation(self):
        contour = np.array([[0, 0], [100, 0], [100, 100], [60, 100],
                            [60, 40], [40, 40], [40, 100], [0, 100]], np.int32).reshape(-1, 1, 2)
        points = load('outline_extractor').extract_normalized_outline(contour, (0, 0, 100, 100))
        polygon = np.array(points, np.float32).reshape(-1, 1, 2)
        self.assertLess(cv2.pointPolygonTest(polygon, (0.5, 0.2), False), 0)
        self.assertGreater(cv2.pointPolygonTest(polygon, (0.2, 0.2), False), 0)

    def test_zero_area_is_rejected_not_invented(self):
        contour = np.array([[0, 0], [5, 0], [10, 0]], np.int32).reshape(-1, 1, 2)
        with self.assertRaises(ValueError):
            load('outline_extractor').extract_normalized_outline(contour, (0, 0, 10, 1))


class ObservationFidelity(unittest.TestCase):
    def test_overlapping_tile_duplicates_keep_the_more_confident_mask(self):
        from src.observations import select_cells
        low = np.zeros((100,100), np.uint8)
        high = low.copy()
        low[20:40,20:40] = 1
        high[20:40,23:43] = 1
        cells = select_cells([{'segmentation':low,'predicted_iou':.4},
                              {'segmentation':high,'predicted_iou':.9}], low.shape,
                             [[0,0],[99,0],[99,99],[0,99]])
        self.assertEqual(len(cells), 1)
        self.assertEqual(cells[0]['confidence'], .9)

    def test_roi_excludes_neighbor_and_keeps_hole_in_mask(self):
        from src.observations import select_cells
        mask = np.zeros((100, 200), np.uint8)
        cv2.rectangle(mask, (10, 10), (40, 40), 1, -1)
        cv2.circle(mask, (125, 50), 15, 1, -1)
        cv2.circle(mask, (125, 50), 6, 0, -1)
        cells = select_cells([{'segmentation': mask}], mask.shape,
                             [[100, 0], [199, 0], [199, 99], [100, 99]])
        self.assertEqual(len(cells), 1)
        self.assertEqual(cells[0]['mask'][50, 125], 0)
        self.assertEqual(len(cells[0]['holes']), 1)
        self.assertAlmostEqual(cells[0]['centroid'][0], 125, delta=0.2)

    def test_no_observations_is_an_explicit_failure(self):
        from src.observations import select_cells
        with self.assertRaises(ValueError):
            select_cells([], (100, 100), [[0, 0], [99, 0], [99, 99], [0, 99]])


class CurveCADFidelity(unittest.TestCase):
    def document(self):
        from src.observations import select_cells
        from src.curve_document import build_curve_document
        mask = np.zeros((100, 100), np.uint8)
        cv2.circle(mask, (50, 50), 25, 1, -1)
        cv2.circle(mask, (50, 50), 10, 0, -1)
        cells = select_cells([{'segmentation': mask}], mask.shape,
                             [[0, 0], [99, 0], [99, 99], [0, 99]], max_area_ratio=0.5)
        return build_curve_document(cells, (100, 100), [0, 0, 100, 100], 10, 10)

    def test_curves_holes_and_metric_scale_survive_cad_round_trip(self):
        import ezdxf
        from src.curve_document import export_curve_document
        model = self.document()
        self.assertEqual(len(model['instances']), 1)
        self.assertEqual(len(model['units'][0]['loops']), 2)
        with tempfile.TemporaryDirectory() as directory:
            export_curve_document(model, directory)
            cad = ezdxf.readfile(pathlib.Path(directory) / 'facade.dxf')
            self.assertEqual(cad.units, 4)  # millimetres
            inserts = list(cad.modelspace().query('INSERT'))
            self.assertEqual(len(inserts), 1)
            self.assertAlmostEqual(inserts[0].dxf.insert.x, 5000, delta=100)
            curves = list(inserts[0].virtual_entities())
            self.assertTrue(any(x.dxftype() == 'SPLINE' for x in curves))
            self.assertFalse(cad.audit().has_errors)

    def test_instance_edit_changes_cad_without_retracing(self):
        import ezdxf
        from src.curve_document import export_curve_document
        model = self.document()
        before = copy.deepcopy(model['units'])
        model['instances'][0]['rotation_deg'] = 25
        model['instances'][0]['scale_u'] = 1.2
        with tempfile.TemporaryDirectory() as directory:
            export_curve_document(model, directory)
            insert = list(ezdxf.readfile(pathlib.Path(directory) / 'facade.dxf').modelspace().query('INSERT'))[0]
            self.assertAlmostEqual(insert.dxf.rotation, 25)
            self.assertGreater(insert.dxf.xscale, insert.dxf.yscale)
        self.assertEqual(before, model['units'])

    def test_curve_reprojection_is_measured_against_observed_mask(self):
        from src.curve_document import measure_curve_fidelity
        model = self.document()
        mask = np.zeros((100, 100), np.uint8)
        cv2.circle(mask, (50, 50), 25, 1, -1)
        cv2.circle(mask, (50, 50), 10, 0, -1)
        baseline = measure_curve_fidelity(model, mask)
        self.assertGreater(baseline['mask_iou'], 0.9)
        model['instances'][0]['offset_m'][1] = 3
        changed = measure_curve_fidelity(model, mask)
        self.assertLess(changed['mask_iou'], 0.3)

    def test_tiny_hole_is_preserved_when_spline_vectorization_would_remove_it(self):
        from src.observations import select_cells
        from src.curve_document import build_curve_document
        mask = np.zeros((100, 100), np.uint8)
        cv2.rectangle(mask, (20, 20), (70, 70), 1, -1)
        mask[40, 40] = 0
        cells = select_cells([{'segmentation':mask}], mask.shape,
                             [[0,0],[99,0],[99,99],[0,99]], max_area_ratio=0.5)
        model = build_curve_document(cells, mask.shape, [0,0,100,100], 10, 10)
        self.assertEqual(len(model['units'][0]['loops']), 2)


class TraceCommand(unittest.TestCase):
    def test_missing_image_exits_nonzero(self):
        result = subprocess.run([sys.executable, str(ROOT / 'pipeline.py'), 'missing-source.png'],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)

    def test_trace_preserves_mask_instances_and_writes_cad_without_a_neural_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            image = np.full((120, 200, 3), 210, np.uint8)
            mask = np.zeros((120, 200), np.uint8)
            cv2.ellipse(mask, (70, 60), (18, 28), 25, 0, 360, 255, -1)
            cv2.rectangle(mask, (130, 35), (155, 80), 255, -1)
            cv2.rectangle(mask, (5, 5), (25, 35), 255, -1)  # neighboring object
            cv2.imwrite(str(root / 'source.png'), image)
            cv2.imwrite(str(root / 'mask.png'), mask)
            (root / 'roi.json').write_text(json.dumps({'polygon_px': [[40, 0], [199, 0], [199, 119], [40, 119]],
                                                       'width_m': 16, 'height_m': 12}))
            result = subprocess.run([sys.executable, str(ROOT / 'pipeline.py'), str(root / 'source.png'),
                                     'test', 'test', str(root / 'out'), '--roi', str(root / 'roi.json'),
                                     '--mask', str(root / 'mask.png')], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            report = json.loads((root / 'out' / 'trace-report.json').read_text())
            self.assertEqual(report['instances'], 2)
            self.assertTrue((root / 'out' / 'facade.dxf').exists())
            self.assertTrue((root / 'out' / report['source_photograph']).exists())
            exported = subprocess.run([sys.executable, str(ROOT / 'pipeline.py'), 'cad',
                                       str(root/'out'/'facade_model.json'), str(root/'copy')],
                                      capture_output=True, text=True)
            self.assertEqual(exported.returncode, 0, exported.stdout+exported.stderr)
            self.assertEqual((root/'copy'/report['source_photograph']).read_bytes(),
                             (root/'source.png').read_bytes())


if __name__ == '__main__':
    unittest.main()
