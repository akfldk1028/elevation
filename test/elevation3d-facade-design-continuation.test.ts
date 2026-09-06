import assert from "node:assert/strict";
import test from "node:test";

import { continuationHolding, coplanarContinuations } from "../plugins/elevation-3d/lib/facade-agent/design/geometry/continuation.mjs";

// A face drawn on the front sheet: outward +y, so the sheet's horizontal axis is -x and a
// facet whose tangent [-n1, n0] = [-1, 0] runs WITH the axis. Two courses of that wall,
// cut at z 4.4 by the extractor, the upper one shifted 1 m sideways and 1 m shorter.
const FACE = { face_id: "front-face", view: "front", axis: [-1, 0] };
const lower = {
	segment_id: "lower", face_id: "front-face", face_view: "front",
	outward_normal: [0, 1, 0], local_z: [2, 4.4], length_m: 6, projected_length_m: 6, face_offset_m: 0,
};
const upper = {
	segment_id: "upper", face_id: "front-face", face_view: "front",
	outward_normal: [0, 1, 0], local_z: [4.4, 7.2], length_m: 5, projected_length_m: 5, face_offset_m: 1,
};
const context = (segments: unknown[], fold = 0.3) => ({
	facade_segments: segments, facade_faces: [FACE], exclusions: { fold_clearance_m: fold },
});

test("a coplanar course above continues the facet where the two overlap, inset by the fold", () => {
	const [found] = coplanarContinuations(lower, context([lower, upper]));
	assert.equal(found.segment_id, "upper");
	// The upper course covers face 1..6, i.e. lower u 1..6; 0.3 off each side.
	assert.equal(found.u_min, 1.3);
	assert.equal(found.u_max, 5.7);
	assert.equal(found.z_max, 7.2);
	// A u on the lower course is a u on the upper one, shifted by where the upper starts.
	assert.equal(found.u_shift_m, 1);

	// And it is one-directional: the upper course has nothing coplanar on its top.
	assert.deepEqual(coplanarContinuations(upper, context([lower, upper])), []);
});

test("a crease is a fold: three degrees between courses and nothing continues", () => {
	const creased = { ...upper, outward_normal: [0, Math.cos(3 * Math.PI / 180), Math.sin(3 * Math.PI / 180)] };
	assert.deepEqual(coplanarContinuations(lower, context([lower, creased])), []);
	// Half a degree of extractor noise is still one plane.
	const noisy = { ...upper, outward_normal: [0, Math.cos(0.4 * Math.PI / 180), Math.sin(0.4 * Math.PI / 180)] };
	assert.equal(coplanarContinuations(lower, context([lower, noisy])).length, 1);
});

test("a course that does not sit on the seam, or on another face, is not a continuation", () => {
	const floating = { ...upper, local_z: [4.5, 7.2] };
	assert.deepEqual(coplanarContinuations(lower, context([lower, floating])), []);
	const elsewhere = { ...upper, face_id: "back-face" };
	assert.deepEqual(coplanarContinuations(lower, context([lower, elsewhere])), []);
});

test("an oblique facet's projected offsets are turned back into its own metres", () => {
	// The same two courses turned 30 degrees to the sheet: faces.mjs records their offsets
	// and lengths projected onto the sheet's axis, cos(30) short of the metres the facet's
	// own u counts in. The continuation must come back in those metres, not in sheet metres.
	const cos = Math.cos(Math.PI / 6);
	const low = { ...lower, outward_normal: [0.5, cos, 0], projected_length_m: 6 * cos };
	const up = { ...upper, outward_normal: [0.5, cos, 0], projected_length_m: 5 * cos, face_offset_m: 1 * cos };
	const [found] = coplanarContinuations(low, context([low, up]));
	assert.ok(Math.abs(found.u_min - 1.3) < 1e-6, `u_min ${found.u_min}`);
	assert.ok(Math.abs(found.u_max - 5.7) < 1e-6, `u_max ${found.u_max}`);
	assert.ok(Math.abs(found.u_shift_m - 1) < 1e-6, `u_shift ${found.u_shift_m}`);
});

test("continuationHolding wants the whole width and the whole height", () => {
	const items = [{ segment_id: "upper", u_min: 1.3, u_max: 5.7, z_max: 7.2, u_shift_m: 1 }];
	assert.ok(continuationHolding(items, 2, 5, 6.45));
	assert.equal(continuationHolding(items, 1, 5, 6.45), null, "starts before the continuation");
	assert.equal(continuationHolding(items, 2, 5.8, 6.45), null, "ends after it");
	assert.equal(continuationHolding(items, 2, 5, 7.3), null, "rises past it");
});
