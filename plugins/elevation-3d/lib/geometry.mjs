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

function canonical(geometry, tolerance) {
	const pointKeys = geometry.vertices.map((point) => point.map((value) => Math.round(value / tolerance)).join(","));
	const positions = [...new Set(pointKeys)].sort();
	const triangles = geometry.triangles.map((triangle) => triangle.map((index) => pointKeys[index]).sort().join("|")).sort();
	return { positions, triangles };
}

export function compareGeometry(source, output, tolerance = 1e-5) {
	const a = canonical(source, tolerance);
	const b = canonical(output, tolerance);
	const reasons = [];
	if (JSON.stringify(a.positions) !== JSON.stringify(b.positions)) reasons.push("Canonical vertex positions differ");
	if (JSON.stringify(a.triangles) !== JSON.stringify(b.triangles)) reasons.push("Canonical triangle connectivity differs");
	return { accepted: reasons.length === 0, tolerance_m: tolerance, source_vertex_count: source.vertices.length, output_vertex_count: output.vertices.length, canonical_vertex_count: b.positions.length, source_triangle_count: source.triangles.length, output_triangle_count: output.triangles.length, reasons };
}
