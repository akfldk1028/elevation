import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { NodeIO } from "@gltf-transform/core";

export function parseObjGeometry(text) {
	const vertices = [];
	const triangles = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith("v ")) vertices.push(line.slice(2).trim().split(/\s+/).slice(0, 3).map(Number));
		if (line.startsWith("f ")) {
			const face = line.slice(2).trim().split(/\s+/).map((part) => Number(part.split("/")[0]) - 1);
			for (let i = 1; i < face.length - 1; i++) triangles.push([face[0], face[i], face[i + 1]]);
		}
	}
	return { vertices, triangles };
}

export async function readGeometry(path) {
	if (extname(path).toLowerCase() === ".obj") return parseObjGeometry(await readFile(path, "utf8"));
	if (extname(path).toLowerCase() !== ".glb") throw new Error(`Unsupported geometry format: ${extname(path)}`);
	const document = await new NodeIO().read(path);
	const vertices = [];
	const triangles = [];
	for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
		const position = primitive.getAttribute("POSITION");
		if (!position) continue;
		const offset = vertices.length;
		for (let i = 0; i < position.getCount(); i++) vertices.push(position.getElement(i, [0, 0, 0]));
		const index = primitive.getIndices();
		const values = index ? Array.from({ length: index.getCount() }, (_, i) => index.getScalar(i)) : Array.from({ length: position.getCount() }, (_, i) => i);
		for (let i = 0; i + 2 < values.length; i += 3) triangles.push([offset + values[i], offset + values[i + 1], offset + values[i + 2]]);
	}
	return { vertices, triangles };
}

/**
 * Tolerance-true vertex matching, not quantization. Rounding each coordinate into a
 * tolerance-sized bucket compares buckets, and two values well inside the tolerance can
 * straddle a bucket boundary: a battered mass's float64 vertex 5e-6 from its float32 copy
 * in the GLB landed in different buckets and the exact-MASS gate called the same geometry
 * different. A grid keyed at the tolerance with a 27-cell probe finds every neighbour
 * within the true euclidean tolerance instead, whatever side of a bucket edge it fell on.
 */
function representativeGrid(tolerance) {
	const cells = new Map();
	const representatives = [];
	const cellKey = (point) => point.map((value) => Math.floor(value / tolerance)).join(",");
	const near = (point) => {
		const base = point.map((value) => Math.floor(value / tolerance));
		for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dz = -1; dz <= 1; dz += 1) {
			for (const id of cells.get(`${base[0] + dx},${base[1] + dy},${base[2] + dz}`) ?? []) {
				const candidate = representatives[id];
				if (Math.hypot(point[0] - candidate[0], point[1] - candidate[1], point[2] - candidate[2]) <= tolerance) return id;
			}
		}
		return null;
	};
	const add = (point) => {
		const found = near(point);
		if (found !== null) return found;
		const id = representatives.length;
		representatives.push(point);
		const key = cellKey(point);
		cells.set(key, [...(cells.get(key) ?? []), id]);
		return id;
	};
	return { near, add, count: () => representatives.length };
}

export function compareGeometry(source, output, tolerance = 1e-5) {
	const grid = representativeGrid(tolerance);
	const sourceIds = source.vertices.map((point) => grid.add(point));
	const matched = new Set();
	let unmatchedOutput = 0;
	const outputIds = output.vertices.map((point) => {
		const id = grid.near(point);
		if (id === null) unmatchedOutput += 1;
		else matched.add(id);
		return id;
	});
	const reasons = [];
	if (unmatchedOutput > 0 || matched.size !== grid.count()) reasons.push("Canonical vertex positions differ");
	const triangleKeys = (triangles, ids) => triangles
		.map((triangle) => triangle.map((index) => ids[index] ?? "missing").sort().join("|")).sort();
	if (JSON.stringify(triangleKeys(source.triangles, sourceIds)) !== JSON.stringify(triangleKeys(output.triangles, outputIds))) {
		reasons.push("Canonical triangle connectivity differs");
	}
	return { accepted: reasons.length === 0, tolerance_m: tolerance, source_vertex_count: source.vertices.length, output_vertex_count: output.vertices.length, canonical_vertex_count: grid.count(), source_triangle_count: source.triangles.length, output_triangle_count: output.triangles.length, reasons };
}
