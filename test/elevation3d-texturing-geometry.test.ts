import assert from "node:assert/strict";
import { test } from "node:test";
import {
	canonicalSurfaceSignature,
	compareCanonicalSurfaces,
} from "../plugins/elevation-3d/lib/texturing/geometry-signature.mjs";

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
