export class FacePolygonError extends Error {
	constructor(message) {
		super(message);
		this.name = "FacePolygonError";
		this.code = "FACE_POLYGON_INVALID";
	}
}

function fail(message) {
	throw new FacePolygonError(message);
}

function edgeKey(a, b) {
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function signedArea(loop, points) {
	let total = 0;
	for (let index = 0; index < loop.length; index += 1) {
		const [ax, ay] = points[loop[index]];
		const [bx, by] = points[loop[(index + 1) % loop.length]];
		total += ax * by - bx * ay;
	}
	return total / 2;
}

function dropCollinear(loop, points, tolerance) {
	const kept = [];
	for (let index = 0; index < loop.length; index += 1) {
		const previous = points[loop[(index - 1 + loop.length) % loop.length]];
		const current = points[loop[index]];
		const next = points[loop[(index + 1) % loop.length]];
		const cross = (current[0] - previous[0]) * (next[1] - previous[1])
			- (current[1] - previous[1]) * (next[0] - previous[0]);
		if (Math.abs(cross) > tolerance) kept.push(loop[index]);
	}
	return kept.length >= 3 ? kept : loop;
}

/**
 * Trace the boundary loops of a connected, coplanar triangle patch.
 *
 * Triangles are given as index triples so shared vertices match exactly rather than
 * by float comparison. An edge used once is on the boundary; an edge used twice is
 * interior. The loops are returned outer-first by absolute area, so a patch with a
 * window cut through it yields its outline followed by the hole.
 *
 * Returning the real outline is what lets a facade face be something other than a
 * rectangle without ever guessing at geometry the mass does not have.
 */
export function boundaryPolygons({ triangles, points, tolerance = 1e-9 } = {}) {
	if (!Array.isArray(points) || points.length < 3) fail("a triangle patch needs points");
	if (!Array.isArray(triangles) || !triangles.length) fail("a triangle patch needs triangles");
	const counts = new Map();
	for (const triangle of triangles) {
		if (!Array.isArray(triangle) || triangle.length !== 3) fail("each triangle needs three vertex indexes");
		for (let index = 0; index < 3; index += 1) {
			const a = triangle[index], b = triangle[(index + 1) % 3];
			if (!Number.isInteger(a) || !Number.isInteger(b) || !points[a] || !points[b]) fail("triangle references a missing point");
			if (a === b) fail("triangle has a degenerate edge");
			const key = edgeKey(a, b);
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	const adjacency = new Map();
	for (const [key, count] of counts) {
		if (count !== 1) continue;
		const [a, b] = key.split("|").map(Number);
		if (!adjacency.has(a)) adjacency.set(a, []);
		if (!adjacency.has(b)) adjacency.set(b, []);
		adjacency.get(a).push(b);
		adjacency.get(b).push(a);
	}
	if (!adjacency.size) fail("triangle patch has no boundary");
	for (const [vertex, neighbours] of adjacency) {
		if (neighbours.length !== 2) fail(`boundary vertex ${vertex} joins ${neighbours.length} edges`);
	}

	const visited = new Set();
	const loops = [];
	for (const start of adjacency.keys()) {
		if (visited.has(start)) continue;
		const loop = [];
		let current = start;
		let previous = null;
		while (current !== undefined && !visited.has(current)) {
			visited.add(current);
			loop.push(current);
			const [first, second] = adjacency.get(current);
			const next = first === previous ? second : first;
			previous = current;
			current = next === start ? undefined : next;
		}
		if (loop.length >= 3) loops.push(loop);
	}
	if (!loops.length) fail("triangle patch has no closed boundary loop");

	return loops
		.map((loop) => {
			const simplified = dropCollinear(loop, points, tolerance);
			const area = signedArea(simplified, points);
			const ordered = area < 0 ? [...simplified].reverse() : simplified;
			return { polygon: ordered.map((index) => [points[index][0], points[index][1]]), area_m2: Math.abs(area) };
		})
		.sort((left, right) => right.area_m2 - left.area_m2);
}
