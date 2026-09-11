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

test("how far, not whether: the reach across a crease is e = d sin(theta)", () => {
	const at = (degrees: number) => ({
		...upper,
		outward_normal: [0, Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)],
	});
	const seam = lower.local_z[1];
	const budget = 0.03;

	// Three degrees is a real crease, and a member may still cross it - just not far. The
	// granted rise is exactly the budget divided by the sine, and a member carried that far
	// stands off the course above by exactly the budget.
	const [creased] = coplanarContinuations(lower, context([lower, at(3)]));
	assert.ok(creased, "a crease offers a reach rather than nothing");
	assert.ok(Math.abs(creased.crease_deg - 3) < 1e-6);
	const granted = creased.z_max - seam;
	assert.ok(Math.abs(granted - budget / Math.sin((3 * Math.PI) / 180)) < 1e-6, `granted ${granted}`);
	assert.ok(Math.abs(granted * Math.sin((3 * Math.PI) / 180) - budget) < 1e-9, "the deviation is the budget");

	// Half a degree of extractor noise is still one plane, so the whole course is offered.
	const [noisy] = coplanarContinuations(lower, context([lower, at(0.4)]));
	assert.ok(noisy);
	assert.equal(noisy.z_max, Math.min(upper.local_z[1], seam + budget / Math.sin((0.4 * Math.PI) / 180)));

	// Exactly coplanar: unbounded reach, so the course above is offered whole - which is what
	// every grammar written before this rule became a formula was measured against.
	const [flat] = coplanarContinuations(lower, context([lower, upper]));
	assert.equal(flat.z_max, upper.local_z[1]);
	assert.equal(flat.crease_deg, 0);

	// And past the angle where the reach falls under the floor-band clearance there is nothing
	// worth crossing for, so no continuation is offered at all. asin(0.03 / 0.15) = 11.54 deg.
	assert.deepEqual(coplanarContinuations(lower, context([lower, at(12)])), []);
	assert.equal(coplanarContinuations(lower, context([lower, at(11)])).length, 1);
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
