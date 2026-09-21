"""
field_fitter.py
Fits 2D parametric field parameters (attractor coordinates, range, falloff)
from the spatial distribution of detected facade openings.
"""

import numpy as np

def fit_2d_field(centroids, areas, image_shape, world_bounds=(30.0, 16.5)):
    """
    Fits a 2D radial or directional field.
    world_bounds: estimated (width_m, height_m) of the facade face.
    """
    h, w = image_shape[:2]
    w_scale = world_bounds[0] / float(max(w, 1))
    h_scale = world_bounds[1] / float(max(h, 1))

    if len(centroids) == 0:
        return {
            "id": "facade_attractor",
            "kind": "point",
            "at": [0.0, 0.0, float(world_bounds[1] / 2.0)],
            "range_m": [2.0, float(world_bounds[0] * 0.7)],
            "falloff": 1.5
        }

    centroids_np = np.array(centroids)
    areas_np = np.array(areas)

    # Convert to approximate world coordinate offsets [x, y, z]
    # For a building centered at origin: x in [-W/2, W/2], z in [0, H]
    world_x = (centroids_np[:, 0] - (w / 2.0)) * w_scale
    world_z = (h - centroids_np[:, 1]) * h_scale

    # If openings vary noticeably in area, find the extrema (attractor focal point)
    if np.std(areas_np) > np.mean(areas_np) * 0.15:
        # Attractor is near the largest opening (e.g. The Broad oculus)
        idx = np.argmax(areas_np)
        cx = float(round(world_x[idx], 2))
        cz = float(round(world_z[idx], 2))
    else:
        # Centroid median
        cx = float(round(np.median(world_x), 2))
        cz = float(round(np.median(world_z), 2))

    max_dist = float(round(np.max(np.sqrt((world_x - cx)**2 + (world_z - cz)**2)), 2))
    near_m = 2.0
    far_m = max(float(round(max_dist, 2)), 12.0)

    return {
        "id": "facade_attractor",
        "kind": "point",
        "at": [cx, 0.0, cz],
        "range_m": [near_m, far_m],
        "falloff": 1.5
    }
