import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";
import {
	canonicalSurfaceSignature,
	compareCanonicalSurfaces,
} from "../plugins/elevation-3d/lib/texturing/geometry-signature.mjs";
import { prepareProviderUv } from "../plugins/elevation-3d/lib/texturing/uv-preparation.mjs";
import { discoverElevation3dAssetRoot } from "./helpers/elevation3d-assets.ts";

const square = {
	vertices: [
		[0, 0, 0],
		[1, 0, 0],
		[1, 1, 0],
		[0, 1, 0],
	],
	triangles: [[0, 1, 2], [0, 2, 3]],
};

test("canonical surface ignores triangle order, winding, and UV-seam vertex duplication", () => {
	const seamDuplicated = {
		vertices: [
			[0, 0, 0], [1, 0, 0], [1, 1, 0],
			[0, 0, 0], [1, 1, 0], [0, 1, 0],
		],
		triangles: [[5, 4, 3], [2, 1, 0]],
	};
	const expected = canonicalSurfaceSignature(square);
	const actual = canonicalSurfaceSignature(seamDuplicated);
	assert.equal(expected.surfaceHash, actual.surfaceHash);
	assert.equal(expected.triangleCount, 2);
	assert.equal(actual.componentCount, 1);
	assert.deepEqual(compareCanonicalSurfaces(expected, actual), { accepted: true, reasons: [] });
});

test("canonical surface rejects a source position moved by 0.2 millimetres", () => {
	const moved = structuredClone(square);
	moved.vertices[2][0] += 0.0002;
	const result = compareCanonicalSurfaces(
		canonicalSurfaceSignature(square),
		canonicalSurfaceSignature(moved),
	);
	assert.equal(result.accepted, false);
	assert.equal(result.reasons.includes("SURFACE_HASH_MISMATCH"), true);
});

test("canonical surface rejects a missing triangle and changed component topology", () => {
	const result = compareCanonicalSurfaces(
		canonicalSurfaceSignature(square),
		canonicalSurfaceSignature({ vertices: square.vertices, triangles: [[0, 1, 2]] }),
	);
	assert.equal(result.accepted, false);
	assert.equal(result.reasons.includes("TRIANGLE_COUNT_MISMATCH"), true);
});

test("canonical surface reports quantized bounds independently of vertex ordering", () => {
	const signature = canonicalSurfaceSignature(square);
	assert.deepEqual(signature.bounds, { min: [0, 0, 0], max: [1, 1, 0] });
	assert.equal(signature.quantizationMeters, 0.0001);
});

async function writeSquareGlb(path: string, uvs?: number[]) {
	const document = new Document();
	const buffer = document.createBuffer("fixture");
	const position = document.createAccessor("position", buffer)
		.setType("VEC3")
		.setArray(new Float32Array(square.vertices.flat()));
	const indices = document.createAccessor("indices", buffer)
		.setType("SCALAR")
		.setArray(new Uint16Array(square.triangles.flat()));
	const primitive = document.createPrimitive().setAttribute("POSITION", position).setIndices(indices);
	if (uvs) {
		primitive.setAttribute("TEXCOORD_0", document.createAccessor("uv", buffer)
			.setType("VEC2")
			.setArray(new Float32Array(uvs)));
	}
	const mesh = document.createMesh("square").addPrimitive(primitive);
	const scene = document.createScene("scene").addChild(document.createNode("square").setMesh(mesh));
	document.getRoot().setDefaultScene(scene);
	await new NodeIO().write(path, document);
}

async function readUv(path: string) {
	const document = await new NodeIO().read(path);
	const uv = document.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute("TEXCOORD_0");
	return uv ? Array.from(uv.getArray()!) : null;
}

test("UV preparation retains an existing usable TEXCOORD_0", async () => {
	const directory = await mkdtemp(join(tmpdir(), "elevation3d-uv-valid-"));
	try {
		const input = join(directory, "input.glb");
		const output = join(directory, "output.glb");
		const expectedUv = [0, 0, 1, 0, 1, 1, 0, 1];
		await writeSquareGlb(input, expectedUv);
		const report = await prepareProviderUv({ inputGlb: input, outputGlb: output });
		assert.equal(report.unwrapped, false);
		assert.equal((await readFile(output)).subarray(0, 4).toString("ascii"), "glTF");
		assert.deepEqual(await readUv(output), expectedUv);
		assert.equal(report.uvCoverage, 1);
		assert.equal(report.surfaceComparison.accepted, true);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("UV preparation deterministically unwraps a GLB without texture coordinates", async () => {
	const directory = await mkdtemp(join(tmpdir(), "elevation3d-uv-missing-"));
	try {
		const input = join(directory, "input.glb");
		const first = join(directory, "first.glb");
		const second = join(directory, "second.glb");
		await writeSquareGlb(input);
		const firstReport = await prepareProviderUv({ inputGlb: input, outputGlb: first });
		const secondReport = await prepareProviderUv({ inputGlb: input, outputGlb: second });
		assert.equal(firstReport.unwrapped, true);
		assert.equal(firstReport.uvCoverage, 1);
		assert.deepEqual(await readUv(first), await readUv(second));
		assert.equal(firstReport.outputSha256, secondReport.outputSha256);
		assert.equal(firstReport.surfaceSignature.surfaceHash, secondReport.surfaceSignature.surfaceHash);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("UV preparation preserves the accepted creative-013 surface under the provider size cap", async () => {
	const sharedRoot = discoverElevation3dAssetRoot(process.cwd());
	const input = join(sharedRoot, "elevation-3d-e2e-results", "autonomous", "creative-013", "automatic-allviews-flicker-v2-20260804", "delivery", "enriched.glb");
	await readFile(input);
	const directory = await mkdtemp(join(tmpdir(), "elevation3d-uv-real-"));
	try {
		const output = join(directory, "prepared.glb");
		const report = await prepareProviderUv({ inputGlb: input, outputGlb: output });
		assert.equal(report.surfaceComparison.accepted, true);
		assert.equal(report.uvCoverage >= 0.98, true);
		assert.equal((await stat(output)).size < 150 * 1024 * 1024, true);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
