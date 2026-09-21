import budgets from './lattice-budgets.json' with { type: 'json' };

// Shared with Python. A triangular prism is the cheapest emitted cell (6 vertices,
// 8 triangles); this is an allocation ceiling, NOT permission to spend these many
// expensive modules. The scene's exact vertices, indices, extras and written bytes
// still bind at compile time. Physical caps are the existing 16 MiB / half-buffer caps.
export const LATTICE_BUDGETS = Object.freeze(budgets);
// Evaluation includes the covering grid's margin and facets' clipped-away heights;
// maxDetails is an EMITTED-scene limit, so it must not cap this pre-clip list.
export const MAX_LATTICE_CELLS = Math.min(
  Math.floor(budgets.maxVertices / budgets.minimumPrismVertices),
  Math.floor(budgets.maxIndices / budgets.minimumPrismIndices),
  Math.floor((budgets.maxGlbBytes - budgets.fixedBytes) /
    (budgets.minimumPrismVertices * budgets.vertexBytes + budgets.minimumPrismIndices * budgets.indexBytes + budgets.detailJsonBytes)));

// Geometry contributes p*(4+r) vertices and 6*p*(4+r) indices. Written probe:
// tools/facade-pipeline/measure-module-cost.mjs, 10 -> 100 copies, p=8:
// r=0 2402.27 B/cell; r=3 3181.07 B/cell. JSON varies with coordinates/extras,
// so this function reports exact BUFFER cost under the compiler's uint32 bound.
export function moduleBufferCost(points, rings = 0) {
  const vertices = points * (4 + rings), indices = vertices * 6;
  return { vertices, indices, bytes: vertices * budgets.vertexBytes + indices * budgets.indexBytes };
}
