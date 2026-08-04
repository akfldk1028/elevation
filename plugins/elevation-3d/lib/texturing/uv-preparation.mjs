import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { unwrap } from "@gltf-transform/functions";
import * as watlas from "watlas";
import { canonicalSurfaceSignature, compareCanonicalSurfaces } from "./geometry-signature.mjs";

function throwIfAborted(signal) {
	if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function transformPoint(position, matrix) {
	const [x, y, z] = position;
	return [
		matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
		matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
		matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
	];
}

function primitiveIndices(primitive, count) {
	const accessor = primitive.getIndices();
	return accessor
		? Array.from({ length: accessor.getCount() }, (_, index) => accessor.getScalar(index))
		: Array.from({ length: count }, (_, index) => index);
}

function documentSurface(document) {
	const vertices = [];
	const triangles = [];
	for (const node of document.getRoot().listNodes()) {
		const mesh = node.getMesh();
		if (!mesh) continue;
		const matrix = node.getWorldMatrix();
		for (const primitive of mesh.listPrimitives()) {
			const position = primitive.getAttribute("POSITION");
			if (!position) continue;
			const offset = vertices.length;
			for (let index = 0; index < position.getCount(); index += 1) {
				vertices.push(transformPoint(position.getElement(index, [0, 0, 0]), matrix));
			}
			const indices = primitiveIndices(primitive, position.getCount());
			for (let index = 0; index + 2 < indices.length; index += 3) {
				triangles.push(indices.slice(index, index + 3).map((value) => value + offset));
			}
		}
	}
	return { vertices, triangles };
}

function triangleArea3d(a, b, c) {
	const ab = b.map((value, axis) => value - a[axis]);
	const ac = c.map((value, axis) => value - a[axis]);
	const cross = [
		ab[1] * ac[2] - ab[2] * ac[1],
		ab[2] * ac[0] - ab[0] * ac[2],
		ab[0] * ac[1] - ab[1] * ac[0],
	];
	return Math.hypot(...cross) / 2;
}

function triangleArea2d(a, b, c) {
	return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
}

export function measureUvCoverage(document) {
	let totalArea = 0;
	let coveredArea = 0;
	for (const node of document.getRoot().listNodes()) {
		const mesh = node.getMesh();
		if (!mesh) continue;
		const matrix = node.getWorldMatrix();
		for (const primitive of mesh.listPrimitives()) {
			const position = primitive.getAttribute("POSITION");
			if (!position) continue;
			const uv = primitive.getAttribute("TEXCOORD_0");
			const indices = primitiveIndices(primitive, position.getCount());
			for (let index = 0; index + 2 < indices.length; index += 3) {
				const triangle = indices.slice(index, index + 3);
				const points = triangle.map((value) => transformPoint(position.getElement(value, [0, 0, 0]), matrix));
				const surfaceArea = triangleArea3d(...points);
				totalArea += surfaceArea;
				if (uv && uv.getCount() === position.getCount()) {
					const uvPoints = triangle.map((value) => uv.getElement(value, [0, 0]));
					if (uvPoints.flat().every(Number.isFinite) && triangleArea2d(...uvPoints) > 1e-12) coveredArea += surfaceArea;
				}
			}
		}
	}
	return totalArea > 0 ? coveredArea / totalArea : 0;
}

export async function prepareProviderUv({ inputGlb, outputGlb, signal }) {
	throwIfAborted(signal);
	const inputPath = resolve(inputGlb);
	const outputPath = resolve(outputGlb);
	const io = new NodeIO();
	const document = await io.read(inputPath);
	const inputSignature = canonicalSurfaceSignature(documentSurface(document));
	const initialCoverage = measureUvCoverage(document);
	const unwrapped = initialCoverage < 0.98;
	if (unwrapped) {
		await document.transform(unwrap({ watlas, texcoord: 0, overwrite: true, groupBy: "scene" }));
	}
	throwIfAborted(signal);
	const outputSignature = canonicalSurfaceSignature(documentSurface(document));
	const surfaceComparison = compareCanonicalSurfaces(inputSignature, outputSignature);
	if (!surfaceComparison.accepted) throw new Error(`UV preparation changed authoritative geometry: ${surfaceComparison.reasons.join(", ")}`);
	const uvCoverage = measureUvCoverage(document);
	if (uvCoverage < 0.98) throw new Error(`UV coverage ${uvCoverage.toFixed(6)} is below 0.98`);
	document.getRoot().setExtras({
		...document.getRoot().getExtras(),
		elevation3d_uv_preparation: {
			version: 1,
			method: unwrapped ? "watlas-scene" : "retained",
			input_surface_sha256: inputSignature.surfaceHash,
			uv_coverage: uvCoverage,
		},
	});
	await mkdir(dirname(outputPath), { recursive: true });
	const temporaryPath = `${outputPath}.tmp-${process.pid}.glb`;
	try {
		await io.write(temporaryPath, document);
		throwIfAborted(signal);
		await rename(temporaryPath, outputPath);
	} finally {
		await rm(temporaryPath, { force: true });
	}
	const bytes = await readFile(outputPath);
	return {
		inputGlb: inputPath,
		outputGlb: outputPath,
		unwrapped,
		initialUvCoverage: initialCoverage,
		uvCoverage,
		surfaceSignature: outputSignature,
		surfaceComparison,
		outputSha256: createHash("sha256").update(bytes).digest("hex"),
		outputBytes: bytes.length,
	};
}
