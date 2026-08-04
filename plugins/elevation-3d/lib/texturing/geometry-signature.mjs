import { createHash } from "node:crypto";

function quantizedPoint(point, quantum) {
	if (!Array.isArray(point) || point.length < 3 || point.slice(0, 3).some((value) => !Number.isFinite(value))) {
		throw new TypeError("Surface positions must contain three finite coordinates");
	}
	return point.slice(0, 3).map((value) => Math.round(value / quantum));
}

function pointKey(point) {
	return point.join(",");
}

function countComponents(trianglePointKeys) {
	const adjacency = new Map();
	for (const triangle of trianglePointKeys) {
		for (const key of triangle) if (!adjacency.has(key)) adjacency.set(key, new Set());
		for (let index = 0; index < 3; index += 1) {
			adjacency.get(triangle[index]).add(triangle[(index + 1) % 3]);
			adjacency.get(triangle[(index + 1) % 3]).add(triangle[index]);
		}
	}
	let components = 0;
	const visited = new Set();
	for (const start of adjacency.keys()) {
		if (visited.has(start)) continue;
		components += 1;
		const pending = [start];
		while (pending.length > 0) {
			const current = pending.pop();
			if (visited.has(current)) continue;
			visited.add(current);
			for (const neighbor of adjacency.get(current)) if (!visited.has(neighbor)) pending.push(neighbor);
		}
	}
	return components;
}

export function canonicalSurfaceSignature(geometry, options = {}) {
	const quantum = options.quantizationMeters ?? 0.0001;
	if (!Number.isFinite(quantum) || quantum <= 0) throw new TypeError("quantizationMeters must be positive");
	if (!geometry || !Array.isArray(geometry.vertices) || !Array.isArray(geometry.triangles)) {
		throw new TypeError("Surface geometry must contain vertices and triangles");
	}
	const points = geometry.vertices.map((position) => quantizedPoint(position, quantum));
	const trianglePointKeys = geometry.triangles.map((triangle) => {
		if (!Array.isArray(triangle) || triangle.length !== 3 || triangle.some((index) => !Number.isInteger(index) || !points[index])) {
			throw new TypeError("Surface triangles must contain three valid vertex indices");
		}
		return triangle.map((index) => pointKey(points[index]));
	});
	const triangleKeys = trianglePointKeys.map((triangle) => [...triangle].sort().join("|")).sort();
	const usedPoints = trianglePointKeys.flat().map((key) => key.split(",").map(Number));
	const bounds = usedPoints.length === 0
		? { min: [0, 0, 0], max: [0, 0, 0] }
		: {
			min: [0, 1, 2].map((axis) => Math.min(...usedPoints.map((point) => point[axis])) * quantum),
			max: [0, 1, 2].map((axis) => Math.max(...usedPoints.map((point) => point[axis])) * quantum),
		};
	return {
		surfaceHash: createHash("sha256").update(triangleKeys.join("\n")).digest("hex"),
		triangleCount: triangleKeys.length,
		componentCount: countComponents(trianglePointKeys),
		bounds,
		quantizationMeters: quantum,
	};
}

export function compareCanonicalSurfaces(expected, actual) {
	const reasons = [];
	if (expected.triangleCount !== actual.triangleCount) reasons.push("TRIANGLE_COUNT_MISMATCH");
	if (expected.componentCount !== actual.componentCount) reasons.push("COMPONENT_COUNT_MISMATCH");
	if (JSON.stringify(expected.bounds) !== JSON.stringify(actual.bounds)) reasons.push("BOUNDS_MISMATCH");
	if (expected.surfaceHash !== actual.surfaceHash) reasons.push("SURFACE_HASH_MISMATCH");
	return { accepted: reasons.length === 0, reasons };
}
