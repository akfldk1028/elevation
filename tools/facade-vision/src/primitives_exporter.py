"""
primitives_exporter.py
Translates SAM segmented mask data into structured geometric primitives (polylines, polygons,
centroids, areas, bounding boxes) and exports to JSON and annotated visual overlay image.
Local observation export; not an implementation obtained from IAAC's authors.
"""

import json
import cv2
import numpy as np

def export_geometric_primitives(cells, image, output_json_path, output_overlay_path=None, attractor_field=None):
    """
    Exports structured geometric primitives to JSON and generates an annotated visualization overlay.
    """
    h, w = image.shape[:2]
    primitives_list = []
    
    overlay = image.copy()

    # Color palette for distinct mask visualization
    colors = [
        (40, 180, 250), (250, 120, 40), (50, 220, 120),
        (220, 50, 200), (240, 240, 50), (50, 200, 240)
    ]

    # Pass 1: Alpha blend ONLY mask regions (keep background 100% bright and crisp)
    for idx, cell in enumerate(cells):
        color = colors[idx % len(colors)]
        mask_bool = None
        if cell.get("mask") is not None:
            mask_bool = cell["mask"].astype(bool)
        elif cell.get("contour") is not None:
            c_mask = np.zeros((h, w), dtype=np.uint8)
            cv2.drawContours(c_mask, [cell["contour"]], -1, 255, -1)
            mask_bool = c_mask.astype(bool)

        if mask_bool is not None and np.any(mask_bool):
            # 60% original image + 40% vibrant mask color
            orig_part = overlay[mask_bool].astype(np.float32)
            color_part = np.full_like(orig_part, color, dtype=np.float32)
            overlay[mask_bool] = (orig_part * 0.60 + color_part * 0.40).astype(np.uint8)

    # Pass 2: Draw crisp geometric primitives, contour outlines, centroid pins, and labels
    for idx, cell in enumerate(cells):
        bx, by, bw, bh = cell["bbox"]
        cx, cy = cell["centroid"]
        area = float(cell["area"])
        aspect = round(float(bw / float(bh if bh > 0 else 1)), 3)
        outline_norm = cell.get("outline_norm", [])
        scoop = float(cell.get("scoop_deg", 0.0))
        cnt = cell.get("contour")

        # Raw contour points as polyline
        polyline = cnt.reshape(-1, 2).tolist() if cnt is not None else []

        primitive_record = {
            "id": idx + 1,
            "bbox_px": [int(bx), int(by), int(bw), int(bh)],
            "centroid_px": [round(float(cx), 2), round(float(cy), 2)],
            "centroid_uv": [round(float(cx / w), 4), round(float(1.0 - (cy / h)), 4)],
            "area_px": round(area, 1),
            "aspect_ratio": aspect,
            "scoop_deg": round(scoop, 1),
            "polygon_normalized": outline_norm,
            "polyline_px": polyline,
            "hole_polylines_px": [c.reshape(-1,2).tolist() for c in cell.get('holes', [])],
            "segmentation_source": cell.get('source'),
            "confidence": cell.get('confidence')
        }
        primitives_list.append(primitive_record)

        color = colors[idx % len(colors)]
        # Sharp 1.5px contour outline
        if cnt is not None:
            cv2.drawContours(overlay, [cnt], -1, (255, 255, 255), 2, cv2.LINE_AA)
            cv2.drawContours(overlay, [cnt], -1, color, 1, cv2.LINE_AA)

        # Subtle bounding box
        cv2.rectangle(overlay, (int(bx), int(by)), (int(bx + bw), int(by + bh)), (200, 200, 200), 1)

        # High-visibility centroid pin: white border with red center
        cv2.circle(overlay, (int(cx), int(cy)), 4, (255, 255, 255), -1)
        cv2.circle(overlay, (int(cx), int(cy)), 2, (0, 0, 255), -1)

    # Pass 3: Add attractor focal marker if available
    if attractor_field and "at" in attractor_field:
        fx, fy, fz = attractor_field["at"]
        img_fx = int(w / 2.0 + (fx / 30.0) * w)
        img_fy = int(h - (fz / 16.5) * h)
        if 0 <= img_fx < w and 0 <= img_fy < h:
            cv2.circle(overlay, (img_fx, img_fy), 14, (0, 255, 255), 2, cv2.LINE_AA)
            cv2.drawMarker(overlay, (img_fx, img_fy), (0, 255, 255), cv2.MARKER_CROSS, 24, 2, cv2.LINE_AA)
            cv2.putText(overlay, "Attractor Focus", (img_fx + 16, img_fy + 6),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2, cv2.LINE_AA)

    # Save visualization overlay image
    if output_overlay_path:
        cv2.imwrite(output_overlay_path, overlay)
        print(f"Saved visual segmentation overlay to {output_overlay_path}")

    # Build comprehensive primitives document
    areas = [p["area_px"] for p in primitives_list]
    manifest = {
        "schema_version": "arr.elevation3d.facade-primitives.v1",
        "image_metadata": {
            "width": w,
            "height": h,
            "aspect_ratio": round(w / float(h), 3)
        },
        "primitives_summary": {
            "total_openings_detected": len(primitives_list),
            "total_opening_area_px": round(sum(areas), 1),
            "mean_opening_area_px": round(float(np.mean(areas)), 1) if areas else 0,
            "median_opening_area_px": round(float(np.median(areas)), 1) if areas else 0,
            "area_std_dev": round(float(np.std(areas)), 1) if areas else 0
        },
        "attractor_field": attractor_field,
        "primitives": primitives_list
    }

    with open(output_json_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"Saved geometric primitives to {output_json_path}")

    return manifest
