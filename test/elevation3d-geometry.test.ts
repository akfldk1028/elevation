import assert from "node:assert/strict";
import { test } from "node:test";
import { compareGeometry, parseObjGeometry } from "../plugins/elevation-3d/lib/geometry.mjs";

const source = { vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], triangles: [[0, 1, 2]] };

test("geometry gate accepts vertex reordering and UV-seam duplicates", () => {
	const output = parseObjGeometry("v 0 1 0\nv 0 0 0\nv 1 0 0\nv 0 0 0\nf 2 3 1\n");
	const result = compareGeometry(source, output, 1e-5);
	assert.equal(result.accepted, true);
	assert.equal(result.canonical_vertex_count, 3);
});

test("geometry gate rejects displaced vertices", () => {
	const output = parseObjGeometry("v 0 0 0\nv 1.01 0 0\nv 0 1 0\nf 1 2 3\n");
	const result = compareGeometry(source, output, 1e-5);
	assert.equal(result.accepted, false);
	assert.match(result.reasons.join(" "), /position/i);
});

test("geometry gate rejects topology changes", () => {
	const output = parseObjGeometry("v 0 0 0\nv 1 0 0\nv 0 1 0\n");
	const result = compareGeometry(source, output, 1e-5);
	assert.equal(result.accepted, false);
	assert.match(result.reasons.join(" "), /triangle/i);
});
