"""Explicit facade ROI -> observed curves -> editable native CAD.

Neural segmentation and classical contrast extraction are separate choices.
The geometry score measures mask fidelity, not semantic correctness.
"""
import argparse
import hashlib
import json
import pathlib
import shutil
import sys
import tempfile
import cv2
import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from src.observations import select_cells, classical_masks, roi_mask
from src.curve_document import build_curve_document, export_curve_document, measure_curve_fidelity
from src.outline_extractor import extract_normalized_outline
from src.primitives_exporter import export_geometric_primitives


def neural_masks(image, polygon, engine, prompt, tile_size=0):
    from src.tiles import image_windows
    region = roi_mask(image.shape, polygon)
    x, y, w, h = cv2.boundingRect(region)
    cropped = image[y:y+h, x:x+w].copy()
    cropped[region[y:y+h, x:x+w] == 0] = 255
    if engine == 'sam3':
        from src.sam3_segmenter import SAM3FacadeSegmenter
        detector = SAM3FacadeSegmenter(load_from_hf=False)
    elif engine == 'sam2':
        from src.sam2_segmenter import SAM2FacadeSegmenter
        detector = SAM2FacadeSegmenter()
    else:
        raise ValueError('unknown segmentation engine')
    result = []
    windows = image_windows(w, h, tile_size)
    with tempfile.TemporaryDirectory(prefix='facade-roi-') as directory:
        for number, (tx, ty, tw, th) in enumerate(windows):
            tile = cropped[ty:ty+th, tx:tx+tw]
            print(f'[Vision] {engine} tile {number+1}/{len(windows)} at {tx},{ty} ({tw}x{th})', flush=True)
            if engine == 'sam3':
                masks = detector.generate_masks(cv2.cvtColor(tile, cv2.COLOR_BGR2RGB), text_prompt=prompt)
            else:
                path = str(pathlib.Path(directory) / 'roi.png')
                cv2.imwrite(path, tile)
                masks = detector.generate_masks(path, text_prompt=prompt)
            for item in masks:
                mask = np.zeros(image.shape[:2], dtype=bool)
                mask[y+ty:y+ty+th, x+tx:x+tx+tw] = item['segmentation']
                result.append({**item, 'segmentation': mask})
    return result


def run_pipeline(image_path, candidate_id='unassigned', run_name='trace', out_dir=None,
                 roi_path=None, engine='sam3', mask_path=None, prompt='opening . aperture',
                 min_area_ratio=0.00005, tile_size=0):
    source = pathlib.Path(image_path).resolve()
    if not source.is_file():
        raise ValueError(f'SOURCE_IMAGE_MISSING: {source}')
    if not roi_path:
        raise ValueError('FACADE_ROI_REQUIRED: provide --roi with polygon_px, width_m and height_m')
    config = json.loads(pathlib.Path(roi_path).read_text(encoding='utf-8-sig'))
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if config.get('image_sha256') and config['image_sha256'] != digest:
        raise ValueError('ROI_SOURCE_MISMATCH: polygon belongs to another image')
    image = cv2.imread(str(source))
    if image is None:
        raise ValueError('SOURCE_IMAGE_UNREADABLE')
    polygon = config['polygon_px']
    region = roi_mask(image.shape, polygon)
    frame = config.get('frame_px', list(cv2.boundingRect(region)))
    width_m, height_m = float(config['width_m']), float(config['height_m'])
    if mask_path:
        mask = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
        if mask is None:
            raise ValueError('SOURCE_MASK_UNREADABLE')
        masks = [{'segmentation': mask > 0, 'source': 'provided_mask'}]
        engine = 'provided_mask'
    elif engine == 'classical':
        masks = classical_masks(image, polygon)
    else:
        masks = neural_masks(image, polygon, engine, prompt, tile_size)
    cells = select_cells(masks, image.shape, polygon, min_area_ratio=min_area_ratio)
    output = pathlib.Path(out_dir or pathlib.Path(__file__).parent / 'outputs' / run_name).resolve()
    output.mkdir(parents=True, exist_ok=True)
    source_name = f'source-{digest[:16]}{source.suffix.lower()}'
    stored = output / source_name
    if stored != source:
        shutil.copyfile(source, stored)
    (output / 'roi.json').write_text(json.dumps({**config, 'image_sha256': digest}, indent=2), encoding='utf-8')
    observed = np.zeros(image.shape[:2], np.uint8)
    unsupported = 0
    for cell in cells:
        observed |= cell['mask'].astype(np.uint8)
        try:
            cell['outline_norm'] = extract_normalized_outline(cell['contour'], cell['bbox'])
        except ValueError:
            cell['outline_norm'] = []
            unsupported += 1
        cell['scoop_deg'] = 0.0
    cv2.imwrite(str(output / 'observed_mask.png'), observed*255)
    export_geometric_primitives(cells, image, str(output / 'facade_primitives.json'),
                                str(output / 'segmented_overlay.png'))
    model = build_curve_document(cells, image.shape, frame, width_m, height_m, polygon_px=polygon)
    model['source'].update({'file': source_name, 'sha256': digest, 'roi_px': polygon,
                            'engine': engine, 'candidate_id': candidate_id})
    artifacts = export_curve_document(model, output)
    fidelity = measure_curve_fidelity(model, observed, output / 'curve_reprojection.png')
    # IoU is scale-free; the boundary error is a length, so it is judged in METRES (30 mm, a
    # facade tolerance) and falls back to the old 2 px only when the document carries no scale.
    # Written in pixels it refused the same curves at 170 px/m that it accepted at 90.
    p95_m = fidelity.get('boundary_p95_m')
    px_per_m = fidelity.get('px_per_m') or 0
    boundary_ok = (p95_m <= 0.03) if (p95_m is not None and px_per_m >= 33.3) else (fidelity['boundary_p95_px'] <= 2.0)
    vector_ok = fidelity['mask_iou'] >= 0.90 and boundary_ok
    report = {'ok': vector_ok, 'stage': 'vectorized' if vector_ok else 'curve_fidelity_rejected',
              'candidate': candidate_id, **artifacts, 'out_dir': str(output),
              'source_photograph': source_name, 'source_sha256': digest,
              'engine': engine, 'tile_size': tile_size, 'source_fidelity': fidelity,
              'requires_semantic_review': True, 'grammar_generated': False,
              'polygon_adapter_unrepresentable': unsupported,
              'segmented_overlay': str(output / 'segmented_overlay.png')}
    (output / 'trace-report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    return report


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    if args and args[0] in ('cad', 'edit'):
        parser = argparse.ArgumentParser()
        parser.add_argument('command')
        parser.add_argument('model')
        parser.add_argument('output')
        parser.add_argument('--edits')
        options = parser.parse_args(args)
        model = json.loads(pathlib.Path(options.model).read_text(encoding='utf-8'))
        source_file = model.get('source', {}).get('file')
        source = None
        if source_file:
            if pathlib.Path(source_file).name != source_file:
                raise ValueError('source file must be a basename inside the model directory')
            source = pathlib.Path(options.model).resolve().parent / source_file
            if not source.is_file():
                raise ValueError('SOURCE_IMAGE_MISSING: curve model source must travel with the model')
            if hashlib.sha256(source.read_bytes()).hexdigest() != model['source'].get('sha256'):
                raise ValueError('SOURCE_IMAGE_CHANGED: curve model source digest does not match')
        if options.command == 'edit':
            if not options.edits:
                raise ValueError('EDIT_SPEC_REQUIRED: --edits <design-edits.json>')
            from src.parametric import edit_document
            model = edit_document(model, json.loads(pathlib.Path(options.edits).read_text(encoding='utf-8-sig')))
        artifacts = export_curve_document(model, options.output)
        if source is not None:
            target = pathlib.Path(options.output).resolve() / source_file
            if target != source:
                shutil.copyfile(source, target)
        return {'ok': True, 'stage': 'cad_exported', **artifacts}
    parser = argparse.ArgumentParser()
    parser.add_argument('image')
    parser.add_argument('candidate', nargs='?', default='unassigned')
    parser.add_argument('name', nargs='?', default='trace')
    parser.add_argument('output', nargs='?')
    parser.add_argument('--roi')
    parser.add_argument('--engine', choices=['sam3', 'sam2', 'classical'], default='sam3')
    parser.add_argument('--mask')
    parser.add_argument('--prompt', default='opening . aperture')
    parser.add_argument('--min-area-ratio', type=float, default=0.00005)
    parser.add_argument('--tile-size', type=int, default=0)
    options = parser.parse_args(args)
    return run_pipeline(options.image, options.candidate, options.name, options.output,
                        options.roi, options.engine, options.mask, options.prompt, options.min_area_ratio, options.tile_size)
