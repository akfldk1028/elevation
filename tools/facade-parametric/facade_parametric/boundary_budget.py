"""Score original tile/throat intersections before expensive solid compilation.

Only a whole-design scale is searched. No throat is moved, squeezed or invented
for a fragment. The 25% default is the task's solid-fragment acceptance bound;
exact compiled geometry/byte limits remain independent downstream gates.
"""
import copy
import math

from shapely.geometry import Polygon
from shapely.affinity import affine_transform, translate
from shapely.strtree import STRtree

from .apply import apply_base_model
from .contracts import MAX_CELLS
from .evaluate import _outline, _parallelogram_tiles, canonical_json
from .fields import cell_values
from .funnel import funnel_loops
from .lattice import cell_centres, inside_void, inside_rect, clip_polygon


def score_boundary_fragments(spec):
    """2D tile/throat counterpart of split_by_wall_patches; no solid construction.

    A wholly empty 3D intersection can disappear during compilation, so this is
    a search score, not a replacement for the final solid-fragment acceptance.
    """
    host = spec['host']
    if host.get('boundary_policy') != 'preserve_pattern':
        raise ValueError('boundary score requires preserve_pattern')
    patches, jacobians, offset = [], [], 0
    for segment in host['segments']:
        patch = Polygon(segment['rings_m'][0], segment['rings_m'][1:])
        if segment.get('chart_affine'):
            a, b, c = segment['chart_affine']
            patch = affine_transform(patch, [a, b, 0, 1, c, 0])
        else:
            a = 1
            patch = translate(patch, xoff=offset-segment['u_min_m'])
        patches.append(patch)
        jacobians.append(a)
        offset += segment['length_m']
    tree = STRtree(patches)
    parts, solid, active = 0, 0, 0
    chord = spec.get('tolerances', {}).get('export_chord_error_m', .0005)
    max_points = spec.get('tolerances', {}).get('max_outline_points', 32)
    for family in spec['families']:
        mouth = family.get('mouth')
        if not mouth or mouth['kind'] != 'parallelogram':
            raise ValueError('boundary budget requires parallelogram modules')
        centres = cell_centres(family['lattice'])
        active += len(centres)
        tiles = _parallelogram_tiles(centres, family['lattice'], mouth)
        outlines = {}
        for i, j, u, v in centres:
            if any(inside_void((u, v), void) for void in spec.get('design_voids', [])):
                continue
            values = cell_values(family, u/host['width_m'], v/host['height_m'])
            key = canonical_json(values)
            if key not in outlines:
                outlines[key] = _outline(family, values, chord, max_points)
            outline = [[round(u+x, 6), round(v+y, 6)] for x, y in outlines[key]]
            if family['lattice']['edge_policy'] == 'omit_partial' and not inside_rect(outline, host['width_m'], host['height_m']):
                continue
            loops = funnel_loops((u, v), tiles[(i, j)], outline, host['width_m'], host['height_m'],
                                 mouth['web_m'], min(mouth['points'], max_points), clip_host=False)
            # An unbuildable complete funnel is solid, never a fabricated hole.
            if loops:
                tile = Polygon(loops[3])
            else:
                if family['lattice']['edge_policy'] == 'omit_partial':
                    continue
                clipped = clip_polygon(tiles[(i, j)], host['width_m'], host['height_m'])
                if len(clipped) < 4:
                    continue
                tile = Polygon(clipped)
            throat = Polygon(loops[1]) if loops else None
            for patch_index in tree.query(tile, predicate='intersects'):
                intersection = tile.intersection(patches[patch_index])
                pieces = [intersection] if intersection.geom_type == 'Polygon' else getattr(intersection, 'geoms', [])
                for piece in pieces:
                    if piece.geom_type != 'Polygon' or piece.area < 1e-8:
                        continue
                    parts += 1
                    aperture = throat.intersection(piece).area/jacobians[patch_index] if throat else 0
                    solid += aperture <= 1e-8
    if not parts:
        raise ValueError('boundary budget has no wall fragments')
    return {'instances': parts, 'solid_instances': solid, 'solid_fraction': solid/parts,
            'active_cells': active}


def apply_with_boundary_budget(base, host, edits=None, keep_voids=False):
    """Bounded 10% descending search, then refine its final passing bracket.

    Fragment fractions are not monotonic in scale, so this is deliberately not
    bisection and does not claim the largest possible passing scale. The search
    floor is the active-cell area-budget estimate; exact allocation limits can
    refuse earlier. One uniform ten-way subdivision of the final bracket avoids
    spending the mesh budget on an unnecessarily small coarse sample. At most
    nine extra scores are taken, in descending order; no monotonicity is assumed.
    """
    edits = copy.deepcopy(edits or {})
    if not (edits.get('auto_boundary_budget') is True and host.get('boundary_policy') == 'preserve_pattern'):
        return apply_base_model(base, host, edits, keep_voids=keep_voids), edits, None
    target = .25  # Fixed acceptance requirement, not a tunable gate threshold.
    start = float(edits.get('scale', 1))
    if not math.isfinite(start) or start <= 0:
        raise ValueError('boundary budget requires positive finite scale')
    trials = []
    scale = start
    floor = None
    while True:
        trial_edits = {**edits, 'scale': scale}
        spec = apply_base_model(base, host, trial_edits, keep_voids=keep_voids)
        score = score_boundary_fragments(spec)
        trials.append({'scale': scale, 'stage': 'coarse', **score})
        if score['instances'] > MAX_CELLS:
            raise ValueError(f'boundary budget exceeds {MAX_CELLS} emitted fragments at scale {scale}')
        if floor is None:
            floor = start*math.sqrt(score['active_cells']/MAX_CELLS)
        if score['solid_fraction'] < target:
            refinement_bracket = None
            if len(trials) > 1:
                upper, lower = trials[-2]['scale'], scale
                refinement_bracket = [lower, upper]
                for index in range(1, 10):
                    refined_scale = upper - (upper-lower)*index/10
                    refined_edits = {**edits, 'scale': refined_scale}
                    refined_spec = apply_base_model(base, host, refined_edits, keep_voids=keep_voids)
                    refined_score = score_boundary_fragments(refined_spec)
                    trials.append({'scale': refined_scale, 'stage': 'refine', **refined_score})
                    if refined_score['instances'] <= MAX_CELLS and refined_score['solid_fraction'] < target:
                        spec, trial_edits, scale = refined_spec, refined_edits, refined_scale
                        break
            report = {'target_solid_fraction': target, 'initial_scale': start, 'chosen_scale': scale,
                      'search_step_ratio': .9, 'budget_scale_floor': floor, 'trials': trials,
                      'refinement_bracket': refinement_bracket, 'refinement_subdivisions': 10,
                      'refinement_max_additional_trials': 9,
                      'selection': 'largest passing tested scale in final bracket; not a global optimum',
                      'mesh_budget': 'exact compiled vertex/index/GLB gates still required'}
            spec.setdefault('metadata', {})['boundary_budget'] = report
            return spec, trial_edits, report
        scale *= .9
        if scale < floor:
            raise ValueError(f'no boundary budget solution before active-cell allocation floor {floor}: {trials}')
