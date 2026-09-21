"""Select source components inside an explicitly identified facade region."""
import cv2
import numpy as np
from shapely.geometry import Polygon


def roi_mask(image_shape, polygon):
    h, w = image_shape[:2]
    points = np.asarray(polygon, dtype=float)
    if (points.ndim != 2 or points.shape[1] != 2 or len(points) < 3
            or not np.isfinite(points).all() or not Polygon(points).is_valid
            or Polygon(points).area <= 0 or (points < 0).any()
            or (points[:, 0] >= w).any() or (points[:, 1] >= h).any()):
        raise ValueError('ROI must be a simple polygon inside the source image')
    result = np.zeros((h, w), np.uint8)
    cv2.fillPoly(result, [np.rint(points).astype(np.int32)], 1)
    return result


def select_cells(masks, image_shape, polygon, min_area_ratio=0.00001, max_area_ratio=0.25):
    region = roi_mask(image_shape, polygon)
    region_area = int(region.sum())
    if not 0 < min_area_ratio < max_area_ratio <= 1:
        raise ValueError('invalid normalized component area bounds')
    selected = []
    for item in sorted(masks, key=lambda m: float(m.get('predicted_iou') or 0), reverse=True):
        raw = np.asarray(item['segmentation'])
        if raw.shape != region.shape or not np.isfinite(raw).all():
            raise ValueError('segmentation dimensions must match the source image')
        clipped = ((raw > 0) & (region > 0)).astype(np.uint8)
        # Diagonally touching pixels are separate regions, not a self-touching
        # CAD loop joined by a zero-width neck.
        count, labels, stats, centroids = cv2.connectedComponentsWithStats(clipped, connectivity=4)
        for label in range(1, count):
            bx, by, bw, bh, area = map(int, stats[label])
            if not min_area_ratio <= area / region_area <= max_area_ratio:
                continue
            component = labels == label
            contours, hierarchy = cv2.findContours(component.astype(np.uint8), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
            if not contours:
                continue
            outer_index = max((i for i in range(len(contours)) if hierarchy[0, i, 3] == -1),
                              key=lambda i: cv2.contourArea(contours[i]))
            outer = contours[outer_index]
            if len(outer) < 3 or cv2.contourArea(outer) <= 0:
                continue
            holes = [contours[i] for i in range(len(contours)) if hierarchy[0, i, 3] == outer_index]
            # Only compare intersecting bounding boxes, then use actual mask IoU.
            duplicate = False
            for kept in selected:
                kx, ky, kw, kh = kept['bbox']
                x0, y0, x1, y1 = max(bx, kx), max(by, ky), min(bx+bw, kx+kw), min(by+bh, ky+kh)
                if x1 <= x0 or y1 <= y0:
                    continue
                inter = int(np.count_nonzero(component[y0:y1, x0:x1] & kept['mask'][y0:y1, x0:x1]))
                if inter / (area + kept['area'] - inter) > 0.6:
                    duplicate = True
                    break
            if not duplicate:
                selected.append({'mask': component, 'contour': outer, 'holes': holes,
                                 'bbox': (bx, by, bw, bh), 'area': area,
                                 'centroid': tuple(map(float, centroids[label])),
                                 'source': item.get('source', 'provided_mask'),
                                 'confidence': item.get('predicted_iou')})
    if not selected:
        raise ValueError('NO_FACADE_OBSERVATIONS: no opening components inside the selected ROI')
    return sorted(selected, key=lambda c: (c['bbox'][1], c['bbox'][0]))


def classical_masks(image, polygon, block_size=41, contrast=7):
    """Explicit edge/contrast baseline, not a semantic segmentation claim."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    # Radius scales with source resolution, preserving the baseline under resize.
    block = max(3, int(round(block_size * image.shape[1] / 2000)) | 1)
    binary = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                   cv2.THRESH_BINARY_INV, block, contrast)
    binary *= roi_mask(gray.shape, polygon)
    return [{'segmentation': binary > 0, 'source': 'classical_contrast'}]
