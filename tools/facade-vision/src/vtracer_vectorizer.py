"""
vtracer_vectorizer.py
Converts segmented raster masks into smooth Bezier curve SVGs using VTracer.
"""

import os
import tempfile
import cv2
import numpy as np
import vtracer

def mask_to_svg(mask_np, output_svg_path=None, colormode="binary", filter_speckle=4):
    """
    Convert a boolean or uint8 binary mask to SVG using VTracer.
    """
    # VTracer binary mode traces black ink. A segmentation's True pixels are
    # foreground, not a black background with white holes.
    mask_img = np.where(mask_np > 0, 0, 255).astype(np.uint8)

    # Write temporary PNG for VTracer input
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as temp_in:
        temp_png_path = temp_in.name
    
    cv2.imwrite(temp_png_path, mask_img)

    if output_svg_path is None:
        with tempfile.NamedTemporaryFile(suffix=".svg", delete=False) as temp_out:
            output_svg_path = temp_out.name

    try:
        vtracer.convert_image_to_svg_py(
            temp_png_path,
            output_svg_path,
            colormode=colormode,
            hierarchical="stacked",
            mode="spline",
            filter_speckle=filter_speckle,
            color_precision=6,
            layer_difference=16,
            corner_threshold=60,
            length_threshold=4.0,
            max_iterations=10,
            splice_threshold=45,
            path_precision=3
        )
        with open(output_svg_path, "r", encoding="utf-8") as f:
            svg_content = f.read()
    finally:
        if os.path.exists(temp_png_path):
            os.remove(temp_png_path)

    return svg_content, output_svg_path

def masks_to_full_svg(masks, image_shape, output_svg_path, filter_speckle=4):
    """
    Combines all opening masks into a single binary image and vectorizes
    the complete facade openings layout into an SVG document.
    """
    h, w = image_shape[:2]
    combined = np.zeros((h, w), dtype=np.uint8)
    for m in masks:
        if m is not None:
            combined = np.maximum(combined, (m > 0).astype(np.uint8) * 255)

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as temp_in:
        temp_png = temp_in.name

    cv2.imwrite(temp_png, 255 - combined)
    try:
        vtracer.convert_image_to_svg_py(
            temp_png,
            output_svg_path,
            colormode="binary",
            hierarchical="stacked",
            mode="spline",
            filter_speckle=filter_speckle,
            color_precision=6,
            layer_difference=16,
            corner_threshold=60,
            length_threshold=4.0,
            max_iterations=10,
            splice_threshold=45,
            path_precision=3
        )
        with open(output_svg_path, "r", encoding="utf-8") as f:
            content = f.read()
    finally:
        if os.path.exists(temp_png):
            os.remove(temp_png)

    return content, output_svg_path
