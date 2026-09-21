"""Observed curves, editable instance transforms, and native spline CAD output.

The document preserves each observed unit. It does not claim to recover a latent
shared family or original construction depth from a single photograph.
"""
import json
import math
import pathlib
import tempfile
import xml.etree.ElementTree as ET

import cv2
import numpy as np
from svgpathtools import Document, Path, Line, CubicBezier, QuadraticBezier

from .vtracer_vectorizer import mask_to_svg
from .parametric import field_transform, validate_parameters


def _segments(path, convert):
    segments = []
    for segment in path:
        if isinstance(segment, Line):
            pts = [segment.start, segment.end]
        elif isinstance(segment, CubicBezier):
            pts = [segment.start, segment.control1, segment.control2, segment.end]
        elif isinstance(segment, QuadraticBezier):
            pts = [segment.start, segment.start + (segment.control-segment.start)*2/3,
                   segment.end + (segment.control-segment.end)*2/3, segment.end]
        else:
            raise ValueError('unsupported vector segment; expected line or Bezier')
        segments.append({'kind': 'line' if len(pts) == 2 else 'cubic',
                         'points': [convert(p) for p in pts]})
    return segments


def _order_quadrilateral(pts):
    """Orders 4 points as: top-left, top-right, bottom-right, bottom-left."""
    pts = np.array(pts, dtype=np.float32)
    s = pts.sum(axis=1)
    top_left = pts[np.argmin(s)]
    bottom_right = pts[np.argmax(s)]
    d = np.diff(pts, axis=1)
    top_right = pts[np.argmin(d)]
    bottom_left = pts[np.argmax(d)]
    return np.array([top_left, top_right, bottom_right, bottom_left], dtype=np.float32)


def build_curve_document(cells, image_shape, frame_px, width_m, height_m, polygon_px=None):
    x, y, width, height = map(float, frame_px)
    if not cells or not all(math.isfinite(v) and v > 0 for v in (width, height, width_m, height_m)):
        raise ValueError('observations and positive metric dimensions are required')
    
    H = None
    projection_name = 'affine_user_scale'
    if polygon_px is not None and len(polygon_px) == 4:
        try:
            src_pts = _order_quadrilateral(polygon_px)
            dst_pts = np.array([[0.0, height_m], [width_m, height_m], [width_m, 0.0], [0.0, 0.0]], dtype=np.float32)
            H = cv2.getPerspectiveTransform(src_pts, dst_pts)
            projection_name = 'homography_rectified'
        except Exception:
            H = None
            projection_name = 'affine_user_scale'

    units, instances = [], []
    with tempfile.TemporaryDirectory(prefix='facade-curves-') as directory:
        svg_path = str(pathlib.Path(directory) / 'unit.svg')
        for i, cell in enumerate(cells):
            bx, by, bw, bh = cell['bbox']
            # Padding keeps boundary-touching openings separate from SVG canvas edges.
            crop = np.pad(cell['mask'][by:by+bh, bx:bx+bw], 2)
            mask_to_svg(crop, svg_path, filter_speckle=0)
            loops = []
            for path in Document(svg_path).paths():
                for loop in path.continuous_subpaths():
                    if not loop.isclosed():
                        raise ValueError('vectorizer emitted an open boundary')
                    loops.append({'segments': _segments(loop, lambda p: [
                        (p.real-2)/bw-0.5, 0.5-(p.imag-2)/bh])})
            expected = 1 + len(cell.get('holes', []))
            method = 'vtracer_spline'
            if len(loops) != expected:
                # Never drop a small hole to obtain smoother output. Preserve the
                # measured polygon for this unit and expose that representation.
                method = 'observed_polyline_topology_fallback'
                loops = []
                for contour in [cell['contour'], *cell.get('holes', [])]:
                    pts = [[(float(px)-bx)/bw-0.5, 0.5-(float(py)-by)/bh]
                           for px, py in contour.reshape(-1, 2)]
                    loops.append({'segments': [{'kind': 'line', 'points': [a, b]}
                                               for a, b in zip(pts, pts[1:]+pts[:1])]})
            unit_id = f'unit-{i+1:04d}'
            units.append({'id': unit_id, 'loops': loops, 'vectorization': method})

            if H is not None:
                c_pt = np.array([[[bx + bw/2.0, by + bh/2.0]]], dtype=np.float32)
                rect_c = cv2.perspectiveTransform(c_pt, H)[0][0]
                center_m = [float(rect_c[0]), float(rect_c[1])]
                
                w_pts = np.array([[[bx, by + bh/2.0]], [[bx + bw, by + bh/2.0]]], dtype=np.float32)
                rect_w = cv2.perspectiveTransform(w_pts, H)
                cell_w_m = float(np.linalg.norm(rect_w[1][0] - rect_w[0][0]))
                
                h_pts = np.array([[[bx + bw/2.0, by]], [[bx + bw/2.0, by + bh]]], dtype=np.float32)
                rect_h = cv2.perspectiveTransform(h_pts, H)
                cell_h_m = float(np.linalg.norm(rect_h[1][0] - rect_h[0][0]))
            else:
                center_m = [(bx+bw/2-x)/width*width_m, (y+height-by-bh/2)/height*height_m]
                cell_w_m = bw/width*width_m
                cell_h_m = bh/height*height_m

            instances.append({'id': f'opening-{i+1:04d}', 'unit': unit_id,
                              'center_m': center_m,
                              'width_m': cell_w_m, 'height_m': cell_h_m,
                              'scale_u': 1.0, 'scale_v': 1.0, 'rotation_deg': 0.0,
                              'offset_m': [0.0, 0.0], 'source_bbox_px': list(cell['bbox'])})
    return {'schema_version': 'arr.elevation3d.facade-curves.v1',
            'width_m': width_m, 'height_m': height_m,
            'source': {'image_shape': list(image_shape[:2]), 'frame_px': list(frame_px),
                       'projection': projection_name, 'depth': 'unobserved'},
            'parameters': {'scale_u': 1.0, 'scale_v': 1.0, 'rotation_deg': 0.0,
                           'spacing_u': 1.0, 'spacing_v': 1.0},
            'units': units, 'instances': instances}


def transformed_loops(model, instance):
    unit = next(u for u in model['units'] if u['id'] == instance['unit'])
    params = model.get('parameters', {})
    field = field_transform(model, instance)
    sx = instance['width_m'] * instance.get('scale_u', 1) * params.get('scale_u', 1) * field['scale_u']
    sy = instance['height_m'] * instance.get('scale_v', 1) * params.get('scale_v', 1) * field['scale_v']
    angle = math.radians(instance.get('rotation_deg', 0) + params.get('rotation_deg', 0) + field['rotation_deg'])
    cx, cy = instance['center_m']
    cx = model['width_m']/2 + (cx-model['width_m']/2)*params.get('spacing_u', 1) + instance.get('offset_m', [0, 0])[0]
    cy = model['height_m']/2 + (cy-model['height_m']/2)*params.get('spacing_v', 1) + instance.get('offset_m', [0, 0])[1]
    def convert(p):
        a, b = p[0]*sx, p[1]*sy
        return [cx+a*math.cos(angle)-b*math.sin(angle), cy+a*math.sin(angle)+b*math.cos(angle)]
    return [[{'kind': s['kind'], 'points': [convert(p) for p in s['points']]}
             for s in loop['segments']] for loop in unit['loops']], (cx, cy, sx, sy, math.degrees(angle))


def _path(segments):
    return Path(*[(Line if s['kind'] == 'line' else CubicBezier)(
        *[complex(*p) for p in s['points']]) for s in segments])


def validate_curve_document(model):
    if model.get('schema_version') != 'arr.elevation3d.facade-curves.v1' or not model.get('instances'):
        raise ValueError('invalid or empty facade curve document')
    for name in ('width_m', 'height_m'):
        if not math.isfinite(model[name]) or model[name] <= 0:
            raise ValueError('invalid model dimensions')
    units = model['units']
    if len({u['id'] for u in units}) != len(units):
        raise ValueError('duplicate unit IDs')
    validate_parameters(model)
    if len({i['id'] for i in model['instances']}) != len(model['instances']):
        raise ValueError('duplicate instance IDs')
    for unit in units:
        if not unit.get('loops'):
            raise ValueError('unit needs closed loops')
        for loop in unit['loops']:
            if not loop.get('segments'):
                raise ValueError('empty curve loop')
            for segment in loop['segments']:
                count = {'line':2, 'cubic':4}.get(segment.get('kind'))
                points = segment.get('points', [])
                if count is None or len(points) != count or any(len(p) != 2 for p in points):
                    raise ValueError('invalid curve segment')
    for instance in model['instances']:
        if instance['unit'] not in {u['id'] for u in units}:
            raise ValueError('instance references unknown unit')
        loops, pose = transformed_loops(model, instance)
        if not all(math.isfinite(v) for v in pose) or pose[2] <= 0 or pose[3] <= 0:
            raise ValueError('invalid instance transform')
        for loop in loops:
            if not all(math.isfinite(v) for s in loop for p in s['points'] for v in p):
                raise ValueError('non-finite curve')
            path = _path(loop)
            if not path.iscontinuous() or not path.isclosed():
                raise ValueError('curve loop is not closed')


def export_curve_document(model, output_dir):
    import ezdxf
    validate_curve_document(model)
    output_dir = pathlib.Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    cad = ezdxf.new('R2010')
    cad.units = 4
    cad.layers.new('FACADE_OPENINGS')
    cad.appids.new('ELEVATION_AGENT')
    svg = ET.Element('svg', xmlns='http://www.w3.org/2000/svg',
                     width=f"{model['width_m']*1000}mm", height=f"{model['height_m']*1000}mm",
                     viewBox=f"0 0 {model['width_m']} {model['height_m']}")
    ET.SubElement(svg, 'rect', x='0', y='0', width=str(model['width_m']),
                  height=str(model['height_m']), fill='white')
    for i, unit in enumerate(model['units']):
        block = cad.blocks.new(f'UNIT_{i:05d}')
        for loop in unit['loops']:
            for segment in loop['segments']:
                points = [(p[0], p[1], 0) for p in segment['points']]
                if segment['kind'] == 'line':
                    block.add_line(*points, dxfattribs={'layer': '0'})
                else:
                    spline = block.add_spline(degree=3, dxfattribs={'layer': '0'})
                    spline.control_points = points
                    spline.knots = [0, 0, 0, 0, 1, 1, 1, 1]
    ids = {u['id']: f'UNIT_{i:05d}' for i, u in enumerate(model['units'])}
    for instance in model['instances']:
        loops, (cx, cy, sx, sy, angle) = transformed_loops(model, instance)
        insert = cad.modelspace().add_blockref(ids[instance['unit']], (cx*1000, cy*1000),
                                     dxfattribs={'xscale': sx*1000, 'yscale': sy*1000,
                                                 'rotation': angle, 'layer': 'FACADE_OPENINGS'})
        insert.set_xdata('ELEVATION_AGENT', [(1000, instance['id']), (1000, instance['unit'])])
        paths = []
        for loop in loops:
            flipped = [{'kind': s['kind'], 'points': [[p[0], model['height_m']-p[1]] for p in s['points']]}
                       for s in loop]
            paths.append(_path(flipped).d())
        ET.SubElement(svg, 'path', id=instance['id'], d=' '.join(paths), fill='black', **{'fill-rule': 'evenodd'})
    cad_path = output_dir / 'facade.dxf'
    cad.saveas(cad_path)
    # Exercise the interchange reader, not just the writer.
    if ezdxf.readfile(cad_path).audit().has_errors:
        raise ValueError('DXF round-trip audit failed')
    ET.ElementTree(svg).write(output_dir / 'facade.svg', encoding='utf-8', xml_declaration=True)
    (output_dir / 'facade_model.json').write_text(json.dumps(model, indent=2), encoding='utf-8')
    return {'svg': str(output_dir / 'facade.svg'), 'dxf': str(cad_path),
            'model': str(output_dir / 'facade_model.json'), 'instances': len(model['instances'])}


def measure_curve_fidelity(model, observed_mask, output_path=None):
    """Reproject exported geometry to the same pixel frame, including hole loops."""
    validate_curve_document(model)
    observed = np.asarray(observed_mask) > 0
    raster = np.zeros(observed.shape, np.uint8)
    x, y, w, h = model['source']['frame_px']
    H_inv = None
    if model['source'].get('projection') == 'homography_rectified' and model['source'].get('roi_px') and len(model['source']['roi_px']) == 4:
        try:
            src_pts = _order_quadrilateral(model['source']['roi_px'])
            dst_pts = np.array([[0.0, float(model['height_m'])], [float(model['width_m']), float(model['height_m'])],
                                [float(model['width_m']), 0.0], [0.0, 0.0]], dtype=np.float32)
            H_inv = cv2.getPerspectiveTransform(dst_pts, src_pts)
        except Exception:
            H_inv = None

    for instance in model['instances']:
        loops, _ = transformed_loops(model, instance)
        rings = []
        for loop in loops:
            points = []
            for segment in _path(loop):
                # Upper bound by control polygon length; at most half a pixel
                # between samples, independent of the source image resolution.
                controls = [segment.start, segment.end] if isinstance(segment, Line) else [
                    segment.start, segment.control1, segment.control2, segment.end]
                length = sum(abs(b-a) for a, b in zip(controls, controls[1:]))
                count = max(2, int(math.ceil(length*max(w/model['width_m'], h/model['height_m'])*2)))
                for t in np.linspace(0, 1, count):
                    p = segment.point(t)
                    if H_inv is not None:
                        pt = np.array([[[p.real, p.imag]]], dtype=np.float32)
                        px_pt = cv2.perspectiveTransform(pt, H_inv)[0][0]
                        points.append([px_pt[0], px_pt[1]])
                    else:
                        points.append([x+p.real/model['width_m']*w, y+h-p.imag/model['height_m']*h])
            rings.append(np.asarray(points))
        # OpenCV applies even-odd fill to multiple rings; union instances only
        # after drawing their own holes, so one unit never erases another.
        # SVG traces pixel boundaries; integer fillPoly treats them as pixel
        # centres and inflates every tiny opening by a border. Integrate pixel
        # coverage in a cropped supersampled raster instead.
        all_points = np.concatenate(rings)
        x0 = max(0, int(math.floor(all_points[:, 0].min()))-1)
        y0 = max(0, int(math.floor(all_points[:, 1].min()))-1)
        x1 = min(observed.shape[1], int(math.ceil(all_points[:, 0].max()))+1)
        y1 = min(observed.shape[0], int(math.ceil(all_points[:, 1].max()))+1)
        if x1 <= x0 or y1 <= y0:
            continue
        factor = 8
        unit = np.zeros(((y1-y0)*factor, (x1-x0)*factor), np.uint8)
        cv2.fillPoly(unit, [np.rint((ring-[x0,y0])*factor).astype(np.int32) for ring in rings], 1)
        coverage = unit.reshape(y1-y0, factor, x1-x0, factor).mean(axis=(1,3))
        raster[y0:y1, x0:x1] |= (coverage > 0.5).astype(np.uint8)
    drawn = raster > 0
    union = int(np.count_nonzero(drawn | observed))
    boundary_a = cv2.morphologyEx(observed.astype(np.uint8), cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)) > 0
    boundary_b = cv2.morphologyEx(raster, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)) > 0
    distances = np.concatenate([
        cv2.distanceTransform((~boundary_a).astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)[boundary_b],
        cv2.distanceTransform((~boundary_b).astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)[boundary_a],
    ])
    if output_path:
        cv2.imwrite(str(output_path), np.where(drawn, 0, 255).astype(np.uint8))
    # The boundary error in METRES as well as pixels. Pixels are not a tolerance: the same curves
    # over the same wall, rastered larger, keep their IoU and grow their pixel error, so a gate
    # written half in one unit and half in the other refuses at one resolution and passes at
    # another for identical geometry. The document carries the scale, so state the error in it.
    px_per_m = None
    try:
        px_per_m = raster.shape[1] / float(model['width_m'])
    except Exception:
        px_per_m = None
    p95_px = round(float(np.percentile(distances, 95)), 3) if len(distances) else None
    return {'mask_iou': round(int(np.count_nonzero(drawn & observed))/max(union, 1), 6),
            'px_per_m': round(px_per_m, 3) if px_per_m else None,
            'boundary_p95_m': round(p95_px / px_per_m, 4) if (p95_px is not None and px_per_m) else None,
            'boundary_p95_px': p95_px,
            'boundary_max_px': round(float(np.max(distances)), 3) if len(distances) else None,
            'compares': 'exported_curves_to_selected_masks',
            'semantic_accuracy': 'requires_reference_annotation_or_human_review'}
