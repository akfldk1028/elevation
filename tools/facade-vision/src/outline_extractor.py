"""
outline_extractor.py
Normalizes raw contours or vector curves into 0..1 bounding box coordinates
conforming strictly to ElevationAgent facade grammar v3 requirements.
"""

import numpy as np
import cv2

def extract_normalized_outline(contour, bbox, num_points=32, max_error_px=1.0):
    """
    Normalizes a contour into an ordered, non-self-intersecting closed polygon
    with coordinates [u, v] in [0..1].
    u is horizontal (0..1), v is vertical (0 at bottom, 1 at top).
    """
    x, y, cw, ch = bbox
    if cw <= 0 or ch <= 0 or not 0 < max_error_px or not 3 <= num_points <= 32:
        raise ValueError('invalid outline bounds or approximation budget')
    points = np.asarray(contour, dtype=np.float32).reshape(-1, 1, 2)
    if not np.isfinite(points).all() or len(points) < 3 or cv2.contourArea(points) <= 0:
        raise ValueError('outline has no finite enclosed area')
    # Simplify the observed loop, never its convex hull. Too much detail is an
    # explicit limitation of the polygon grammar; the curve document retains it.
    approx = cv2.approxPolyDP(points, float(max_error_px), True)
    if len(approx) > num_points:
        raise ValueError('outline exceeds grammar vertex budget at the requested pixel tolerance')
    from shapely.geometry import Polygon
    if len(approx) < 3 or not Polygon(approx.reshape(-1, 2)).is_valid:
        raise ValueError('outline is not a simple closed loop')

    outline = []
    for pt in approx:
        px, py = pt[0]
        u = round(float((px - x) / float(cw)), 6)
        v = round(float(1.0 - (py - y) / float(ch)), 6)
        if not 0 <= u <= 1 or not 0 <= v <= 1:
            raise ValueError('outline lies outside its bounding box')
        outline.append([u, v])
    return outline

def estimate_scoop_degree(cell_gray_roi):
    """
    Estimates the aperture cut angle (scoop_deg) from asymmetric inner illumination.
    """
    ch, cw = cell_gray_roi.shape[:2]
    if ch < 4 or cw < 4:
        return 0.0

    top_half = cell_gray_roi[:ch//2, :]
    bot_half = cell_gray_roi[ch//2:, :]
    ratio = (np.mean(bot_half) + 1e-5) / (np.mean(top_half) + 1e-5)

    if ratio > 1.25:
        return 26.0
    elif ratio > 1.10:
        return 20.0
    elif ratio < 0.85:
        return -20.0
    return 0.0
