"""
facade_classifier.py
Architectural Typology & Macro-Syntax Classifier.
Analyzes detected opening cells and source image to automatically classify:
1. Grid Rhythm: 'diagrid_staggered' (honeycomb/running bond) vs 'orthogonal_stacked' (aligned grid).
2. Aperture Geometry: 'diamond' | 'organic_lens' | 'arch' | 'ribbon' | 'slot' | 'rectangle'.
3. Macro Features: Detects large singular voids / indentations (e.g. The Oculus).
4. Base / Ground Typology: 'lifted_arcade' | 'glazed_lobby' | 'continuous_veil' | 'solid_plinth'.
5. Material Palette: Dominant wall luminance, warmth, hue, and architectural substance.
"""

import cv2
import numpy as np

def classify_facade(image, cells):
    h, w = image.shape[:2]
    
    # Default classification
    typology = {
        "grid_type": "orthogonal_stacked",
        "aperture_shape": "rectangle",
        "has_macro_void": False,
        "macro_void": None,
        "base_condition": "continuous_veil",
        "palette": {
            "wall_lightness": "pale",
            "wall_hue": "neutral",
            "wall_substance": "cast",
            "glass_lightness": "dark",
            "accent_substance": "extrusion"
        },
        "metrics": {
            "cell_count": len(cells),
            "median_area": 0,
            "median_aspect": 1.0,
            "mean_scoop": 0.0
        }
    }

    if not cells:
        return typology

    areas = np.array([float(c["area"]) for c in cells])
    aspects = np.array([float(c["bbox"][2] / max(c["bbox"][3], 1)) for c in cells])
    scoops = np.array([float(c.get("scoop_deg", 0.0)) for c in cells])
    centroids = np.array([c["centroid"] for c in cells])

    median_area = float(np.median(areas))
    median_aspect = float(np.median(aspects))
    mean_scoop = float(np.mean(scoops))

    typology["metrics"]["median_area"] = median_area
    typology["metrics"]["median_aspect"] = median_aspect
    typology["metrics"]["mean_scoop"] = mean_scoop

    # 1. Palette & Material Detection
    # Mask out all detected openings to sample pure wall color
    wall_mask = np.ones((h, w), dtype=np.uint8) * 255
    for c in cells:
        bx, by, bw, bh = c["bbox"]
        # Dilate cell bbox slightly to exclude window frames
        pad = int(max(bw, bh) * 0.15)
        x0 = max(0, bx - pad)
        y0 = max(0, by - pad)
        x1 = min(w, bx + bw + pad)
        y1 = min(h, by + bh + pad)
        wall_mask[y0:y1, x0:x1] = 0

    # Avoid sky (top 8%) and ground/pavement (bottom 5%)
    wall_mask[:int(h * 0.08), :] = 0
    wall_mask[int(h * 0.95):, :] = 0

    wall_pixels = image[wall_mask > 0]
    if len(wall_pixels) > 100:
        b_mean = float(np.mean(wall_pixels[:, 0]))
        g_mean = float(np.mean(wall_pixels[:, 1]))
        r_mean = float(np.mean(wall_pixels[:, 2]))
        lum = 0.2126 * r_mean + 0.7152 * g_mean + 0.0722 * b_mean

        if lum > 170:
            typology["palette"]["wall_lightness"] = "pale"
        elif lum > 85:
            typology["palette"]["wall_lightness"] = "mid"
        else:
            typology["palette"]["wall_lightness"] = "dark"

        warmth = r_mean - b_mean
        if warmth > 16:
            typology["palette"]["wall_hue"] = "warm"
            typology["palette"]["wall_substance"] = "masonry"  # Brick, terracotta
        elif warmth < -10:
            typology["palette"]["wall_hue"] = "cool"
            typology["palette"]["wall_substance"] = "sheet"    # Zinc, metal
        else:
            typology["palette"]["wall_hue"] = "neutral"
            typology["palette"]["wall_substance"] = "cast"     # GFRC, precast concrete

    # 2. Macro Void / Oculus Detection
    max_area_idx = int(np.argmax(areas))
    max_area = areas[max_area_idx]
    if max_area > 2.2 * median_area and max_area > 1500:
        void_cell = cells[max_area_idx]
        vcx, vcy = void_cell["centroid"]
        typology["has_macro_void"] = True
        typology["macro_void"] = {
            "center_u_norm": float(round(vcx / float(w), 3)),
            "center_z_norm": float(round(1.0 - (vcy / float(h)), 3)),
            "area_ratio": float(round(max_area / max(median_area, 1), 2)),
            "bbox": void_cell["bbox"]
        }

    # 3. Aperture Shape Classification
    cells_sorted = sorted(cells, key=lambda item: item["area"])
    rep_cell = cells_sorted[len(cells_sorted) // 2]
    outline = rep_cell.get("outline_norm", [])

    if len(outline) >= 6:
        u_vals = [p[0] for p in outline]
        v_vals = [p[1] for p in outline]
        top_idx = int(np.argmax(v_vals))
        bot_idx = int(np.argmin(v_vals))
        u_at_top = u_vals[top_idx]
        u_at_bot = u_vals[bot_idx]

        # Diamond condition: top and bottom vertices near u=0.5
        if 0.35 <= u_at_top <= 0.65 and 0.35 <= u_at_bot <= 0.65 and len(outline) <= 12:
            typology["aperture_shape"] = "diamond"
        elif len(outline) >= 14 or abs(mean_scoop) > 15:
            typology["aperture_shape"] = "organic_lens"
        else:
            typology["aperture_shape"] = "diamond"
    else:
        if median_aspect > 2.0:
            typology["aperture_shape"] = "ribbon"
        elif median_aspect < 0.45:
            typology["aperture_shape"] = "slot"
        else:
            typology["aperture_shape"] = "rectangle"

    # 4. Grid Rhythm Analysis: Staggered (Diagrid) vs Stacked (Orthogonal)
    # Cluster y-centroids into rows
    y_coords = centroids[:, 1]
    sorted_indices = np.argsort(y_coords)
    
    rows = []
    current_row = [cells[sorted_indices[0]]]
    y_threshold = h * 0.045

    for idx in sorted_indices[1:]:
        c = cells[idx]
        cy = c["centroid"][1]
        mean_y = np.mean([item["centroid"][1] for item in current_row])
        if abs(cy - mean_y) < y_threshold:
            current_row.append(c)
        else:
            if len(current_row) >= 2:
                current_row.sort(key=lambda item: item["centroid"][0])
                rows.append(current_row)
            current_row = [c]
    if len(current_row) >= 2:
        current_row.sort(key=lambda item: item["centroid"][0])
        rows.append(current_row)

    stagger_evidence = 0
    total_checks = 0

    for r_idx in range(len(rows) - 1):
        r1 = rows[r_idx]
        r2 = rows[r_idx + 1]
        
        if len(r1) >= 2:
            x_diffs = [r1[i+1]["centroid"][0] - r1[i]["centroid"][0] for i in range(len(r1)-1)]
            pitch = float(np.median(x_diffs)) if x_diffs else (w / float(len(r1)))
        else:
            continue

        if pitch < 10:
            continue

        for c2 in r2:
            x2 = c2["centroid"][0]
            dists = [abs(x2 - c1["centroid"][0]) for c1 in r1]
            min_dist = min(dists)
            phase = min_dist / pitch

            if 0.22 <= phase <= 0.78:
                stagger_evidence += 1
            total_checks += 1

    is_staggered = (total_checks > 5 and (stagger_evidence / float(total_checks)) > 0.35) or typology["aperture_shape"] in ["diamond", "organic_lens"]
    if is_staggered:
        typology["grid_type"] = "diagrid_staggered"
    else:
        typology["grid_type"] = "orthogonal_stacked"

    # 5. Base / Ground Condition Analysis
    # Openings in bottom 22% of image
    bottom_cells = [c for c in cells if c["centroid"][1] > h * 0.78]
    if bottom_cells:
        bottom_heights = [c["bbox"][3] for c in bottom_cells]
        upper_heights = [c["bbox"][3] for c in cells if c["centroid"][1] <= h * 0.78]
        if upper_heights:
            med_bot_h = np.median(bottom_heights)
            med_up_h = np.median(upper_heights)
            if med_bot_h > 1.35 * med_up_h:
                typology["base_condition"] = "lifted_arcade"
            elif med_bot_h < 0.6 * med_up_h:
                typology["base_condition"] = "solid_plinth"
            else:
                typology["base_condition"] = "continuous_veil"

    return typology
