export class InscribedRectError extends Error {
	constructor(message) {
		super(message);
		this.name = "InscribedRectError";
		this.code = "INSCRIBED_RECT_INVALID";
	}
}

function fail(message) {
	throw new InscribedRectError(message);
}

function round(value) {
	return Number(value.toFixed(8));
}

/** Half-open x spans where the horizontal line at `y` lies inside the polygon. */
function insideSpans(points, y) {
	const crossings = [];
	for (let index = 0; index < points.length; index += 1) {
		const [ax, ay] = points[index];
		const [bx, by] = points[(index + 1) % points.length];
		if (ay === by) continue;
		const low = Math.min(ay, by), high = Math.max(ay, by);
		if (y < low || y >= high) continue;
		crossings.push(ax + ((bx - ax) * (y - ay)) / (by - ay));
	}
	crossings.sort((left, right) => left - right);
	const spans = [];
	for (let index = 0; index + 1 < crossings.length; index += 2) {
		spans.push([crossings[index], crossings[index + 1]]);
	}
	return spans;
}

function intersectSpans(left, right) {
	const result = [];
	for (const [a0, a1] of left) {
		for (const [b0, b1] of right) {
			const low = Math.max(a0, b0), high = Math.min(a1, b1);
			if (high > low) result.push([low, high]);
		}
	}
	return result;
}

/**
 * Largest axis-aligned rectangle found inside a simple polygon.
 *
 * The inside-width is piecewise linear in height with breakpoints at vertex heights,
 * so a slab's widest usable span is the intersection of the inside spans sampled just
 * inside every breakpoint it spans. Vertex heights alone are not enough: against a
 * diagonal edge the optimum sits between them (a right triangle's best rectangle is
 * half its height), so the height grid is subdivided between vertices. The result is
 * therefore the best rectangle on that grid — always strictly inside the polygon, and
 * a lower bound on the true optimum rather than a claim to be it.
 *
 * Openings placed inside the result are inside the polygon, so mass backing holds by
 * construction instead of being re-checked afterwards.
 */
export function largestInscribedRectangle(polygon, { tolerance = 1e-9, subdivisions = 8 } = {}) {
	if (!Array.isArray(polygon) || polygon.length < 3) fail("a simple polygon needs at least three points");
	if (!Number.isSafeInteger(subdivisions) || subdivisions < 1 || subdivisions > 64) fail("subdivisions are out of range");
	const points = polygon.map((point, index) => {
		if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) {
			fail(`polygon point ${index} is not a finite pair`);
		}
		return [point[0], point[1]];
	});
	const vertexHeights = [...new Set(points.map((point) => point[1]))].sort((left, right) => left - right);
	if (vertexHeights.length < 2) fail("polygon is degenerate");
	const heights = [];
	for (let index = 0; index < vertexHeights.length; index += 1) {
		heights.push(vertexHeights[index]);
		const next = vertexHeights[index + 1];
		if (next === undefined) continue;
		for (let step = 1; step < subdivisions; step += 1) {
			heights.push(vertexHeights[index] + ((next - vertexHeights[index]) * step) / subdivisions);
		}
	}
	const widest = Math.max(...points.map((point) => point[0])) - Math.min(...points.map((point) => point[0]));
	// Sampling exactly on a vertex height makes the even-odd test ambiguous, so each
	// grid height is probed just inside the slab it bounds from either side.
	const above = heights.map((height) => insideSpans(points, height + tolerance));
	const below = heights.map((height) => insideSpans(points, height - tolerance));

	let best = null;
	for (let low = 0; low < heights.length - 1; low += 1) {
		for (let high = heights.length - 1; high > low; high -= 1) {
			const height = heights[high] - heights[low];
			if (!(height > tolerance)) continue;
			if (best && height * widest <= best.area) break;
			let spans = intersectSpans(above[low], below[high]);
			for (let index = low + 1; index < high && spans.length; index += 1) {
				spans = intersectSpans(intersectSpans(spans, below[index]), above[index]);
			}
			for (const [x0, x1] of spans) {
				const area = (x1 - x0) * height;
				if (!best || area > best.area) best = { x0, x1, y0: heights[low], y1: heights[high], area };
			}
		}
	}
	if (!best || !(best.area > tolerance)) return null;
	// Edges are returned exactly as measured. Rounding them would shift the rectangle
	// off the vertex coordinates it was derived from, and a face that is already a
	// rectangle would stop matching its own extent.
	return Object.freeze({
		u_min: best.x0, u_max: best.x1,
		z_min: best.y0, z_max: best.y1,
		area_m2: round(best.area),
	});
}
