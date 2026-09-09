import assert from "node:assert/strict";
import test from "node:test";

import { localPoint } from "../plugins/elevation-3d/lib/facade-agent/member-geometry.mjs";
import {
	MAX_OUTLINE_POINTS,
	isSimplePolygon,
	polygonArea,
	polygonPrismGeometry,
	shoelace,
	triangulate,
	verifyPrism,
} from "../plugins/elevation-3d/lib/facade-agent/polygon-prism.mjs";

/**
 * The primitive was the ceiling, not the vocabulary.
 *
 * Three shapes could be drawn - a box, an arch, half a rectangle on a diagonal - and every
 * facade this project failed to transcribe failed on that list: a hexagon cost five members
 * and un-hexed as its inset grew, a circle was a rectangle, a scooped cell was a lump. These
 * tests are the claims that make the new builder trustworthy, each measured rather than
 * asserted, because a wrong winding renders cleanly and draws the wrong building.
 */
const plane = { origin: [0, 0, 0], normal: [0, -1, 0] } as any;
const tangent = [1, 0, 0];
const grammar = { brick_module_m: [0.215, 0.065] } as any;
const bounds = { u0: 0, u1: 2, v0: 0, v1: 2, n0: 0, n1: 0.5 };
const build = (outline: number[][]) => polygonPrismGeometry(plane, tangent, grammar, bounds, outline, localPoint);
const ring = (count: number, radius = 0.5) => Array.from({ length: count }, (_, index) => {
	const angle = (Math.PI * 2 * index) / count;
	return [0.5 + radius * Math.cos(angle), 0.5 + radius * Math.sin(angle)];
});

const SQUARE = [[0, 0], [1, 0], [1, 1], [0, 1]];
const L_SHAPE = [[0, 0], [1, 0], [1, 0.4], [0.4, 0.4], [0.4, 1], [0, 1]];
const STAR = Array.from({ length: 10 }, (_, index) => {
	const angle = (Math.PI / 5) * index - Math.PI / 2;
	const radius = index % 2 ? 0.2 : 0.5;
	return [0.5 + radius * Math.cos(angle), 0.5 + radius * Math.sin(angle)];
});

test("the shoelace sum gives the area and the winding", () => {
	assert.equal(polygonArea(SQUARE), 1);
	assert.ok(shoelace(SQUARE) > 0, "counter-clockwise is positive");
	assert.ok(shoelace(SQUARE.slice().reverse()) < 0);
	// A concave outline's area is its true area, not its hull's.
	assert.ok(Math.abs(polygonArea(L_SHAPE) - 0.64) < 1e-12, `${polygonArea(L_SHAPE)}`);
});

test("ear clipping triangulates concave outlines exactly, which a fan does not", () => {
	for (const outline of [SQUARE, L_SHAPE, STAR, ring(24)]) {
		const triangles = triangulate(outline);
		assert.equal(triangles.length, outline.length - 2, "a simple polygon has n-2 triangles");
		// The triangles tile the polygon: their areas sum to its own.
		const summed = triangles.reduce((total, [a, b, c]) =>
			total + polygonArea([outline[a], outline[b], outline[c]]), 0);
		assert.ok(Math.abs(summed - polygonArea(outline)) < 1e-9, `${summed} vs ${polygonArea(outline)}`);
	}
});

test("the extruded solid is closed, wound outward, and has the volume the area says", () => {
	const depth = Math.abs(bounds.n1 - bounds.n0);
	const scale = (bounds.u1 - bounds.u0) * (bounds.v1 - bounds.v0);
	for (const outline of [SQUARE, L_SHAPE, STAR, ring(6), ring(24), SQUARE.slice().reverse()]) {
		const count = outline.length;
		const verified = verifyPrism(build(outline), polygonArea(outline) * scale * depth);

		// An n-gon prism: 2n vertices, 4n-4 triangles, 6n-6 edges.
		assert.equal(verified.vertices, 2 * count);
		assert.equal(verified.faces, 4 * count - 4);
		assert.equal(verified.edges, 6 * count - 6);
		// Euler's formula for a solid of genus zero.
		assert.equal(verified.euler, 2, `V-E+F for n=${count}`);
		// Every edge shared by exactly two triangles: watertight.
		assert.equal(verified.closed, true);
		// Positive signed volume: no face is inside out, whichever way the outline was written.
		assert.equal(verified.outward, true);
		// Divergence theorem against area x depth, to machine precision.
		assert.ok((verified.volume_error ?? 1) < 1e-9, `n=${count} volume error ${verified.volume_error}`);
	}
});

test("an outline that has no inside is refused rather than drawn", () => {
	const refuses = (outline: unknown, why: string) =>
		assert.throws(() => build(outline as number[][]), TypeError, why);
	// A bow-tie crosses itself, so "which side is out" has no answer - and it renders as two
	// plausible triangles if nobody asks.
	refuses([[0, 0], [1, 1], [1, 0], [0, 1]], "self-intersecting");
	refuses([[0, 0], [1, 0], [1, 0], [1, 1], [0, 1]], "a repeated point");
	refuses([[0, 0], [0.5, 0], [1, 0]], "collinear, zero area");
	refuses([[0, 0], [1, 1]], "two points");
	refuses([[0, 0], [Number.NaN, 0], [1, 1]], "not finite");
	refuses(ring(MAX_OUTLINE_POINTS + 1), "over the point budget");
	refuses(null, "not an array");
	assert.equal(isSimplePolygon([[0, 0], [1, 1], [1, 0], [0, 1]]), false);
});

test("an outline stays inside the member's own square", () => {
	// The validator rests on a member living strictly inside its facet: SEGMENT_BOUNDS_INVALID,
	// the fold clearance, the opening ratios and the collision test all read `local_bounds` and
	// trust them. A point at -0.5 puts geometry where nothing checked it. This was found by
	// feeding the builder a square at [-0.5, 1.5], which it drew without complaint.
	assert.throws(() => build([[-0.5, -0.5], [1.5, -0.5], [1.5, 1.5], [-0.5, 1.5]]), /own square/);
	assert.throws(() => build([[0, 0], [1.0000001, 0], [1, 1], [0, 1]]), /own square/);
	assert.doesNotThrow(() => build(SQUARE), "the exact boundary is inside");
});

test("a degenerate placement is refused the way every other builder refuses one", () => {
	for (const bad of [
		{ ...bounds, u1: bounds.u0 },
		{ ...bounds, v1: bounds.v0 },
		{ ...bounds, n1: bounds.n0 },
		{ ...bounds, u0: Number.NaN },
	]) {
		assert.throws(() => polygonPrismGeometry(plane, tangent, grammar, bad, SQUARE, localPoint), /non-positive dimensions/);
	}
});

test("the outline is a shape, not a size: one hexagon serves any member", () => {
	const hexagon = ring(6);
	const small = polygonPrismGeometry(plane, tangent, grammar, { u0: 0, u1: 0.4, v0: 0, v1: 0.4, n0: 0, n1: 0.05 }, hexagon, localPoint);
	const large = polygonPrismGeometry(plane, tangent, grammar, { u0: 0, u1: 4, v0: 0, v1: 4, n0: 0, n1: 0.5 }, hexagon, localPoint);
	assert.equal(small.positions.length, large.positions.length);
	assert.deepEqual(small.indices, large.indices, "the same shape triangulates the same way at any size");
	const area = polygonArea(hexagon);
	assert.ok((verifyPrism(small, area * 0.4 * 0.4 * 0.05).volume_error ?? 1) < 1e-12);
	assert.ok((verifyPrism(large, area * 4 * 4 * 0.5).volume_error ?? 1) < 1e-9);
});
