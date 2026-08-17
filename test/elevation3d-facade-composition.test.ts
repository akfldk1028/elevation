import assert from "node:assert/strict";
import test from "node:test";

import { COMPOSITION_BOUNDS, measureComposition } from "../plugins/elevation-3d/lib/facade-agent/design/composition.mjs";

const CONTEXT = {
	facade_segments: [{ segment_id: "seg-front", face_view: "front", length_m: 10, local_z: [0, 16.5] }],
	storeys: [1, 2, 3, 4, 5].map((storey) => ({ storey, z_min: (storey - 1) * 3.3, z_max: storey * 3.3 })),
};

const opening = (uMin: number, uMax: number, zMin: number, zMax: number) => ({
	kind: "window", segment_id: "seg-front",
	local_bounds: { u_min: uMin, u_max: uMax, z_min: zMin, z_max: zMax },
});

const cornice = { kind: "cornice", segment_id: "seg-front", local_bounds: { u_min: 0, u_max: 10, z_min: 16.2, z_max: 16.5 } };

// The v6 live facade in miniature: many identical slits, no top, 5 percent of the wall.
const WAREHOUSE = Array.from({ length: 30 }, (_, index) => {
	const column = index % 6;
	const row = Math.floor(index / 6);
	return opening(0.5 + column * 1.6, 0.9 + column * 1.6, 1.0 + row * 3.3, 2.2 + row * 3.3);
});

test("a wall of identical slits with no top fails every check", () => {
	const { metrics, codes } = measureComposition({ context: CONTEXT, resolved: { primitives: WAREHOUSE } });
	assert.deepEqual([...codes].sort(), ["OPENING_RATIO_LOW", "SCALE_HIERARCHY_FLAT", "STOREY_LOCKSTEP", "TOP_TERMINATION_MISSING"]);
	assert.ok(metrics.worst_opening_ratio < COMPOSITION_BOUNDS.minOpeningRatio);
	assert.equal(metrics.scale_ratio, 1);
	assert.equal(metrics.has_top_termination, false);
	// Every slit was cut to sit inside one floor, which is the shape of the problem.
	assert.equal(metrics.max_storey_span, 1);
});

// A pier is not glazed and still breaks the lockstep, so it has to count.
test("a pier carried through three storeys satisfies the storey span on its own", () => {
	const primitives = [
		...WAREHOUSE,
		{ kind: "pilaster", segment_id: "seg-front", local_bounds: { u_min: 4.8, u_max: 5.4, z_min: 0, z_max: 9.9 } },
	];
	const { metrics, codes } = measureComposition({ context: CONTEXT, resolved: { primitives } });
	assert.equal(metrics.max_storey_span, 3);
	assert.ok(!codes.includes("STOREY_LOCKSTEP"));
});

test("a composed elevation clears all three at once", () => {
	const primitives = [
		...Array.from({ length: 20 }, (_, index) => {
			const column = index % 4;
			const row = Math.floor(index / 4);
			return opening(0.6 + column * 2.4, 2.2 + column * 2.4, 0.6 + row * 3.3, 2.9 + row * 3.3);
		}),
		// The subject: one bay carried up two storeys against many ordinary ones.
		opening(4.0, 6.4, 0.4, 6.2),
		cornice,
	];
	const { metrics, codes } = measureComposition({ context: CONTEXT, resolved: { primitives } });
	assert.deepEqual(codes, []);
	assert.ok(metrics.worst_opening_ratio >= COMPOSITION_BOUNDS.minOpeningRatio, `ratio ${metrics.worst_opening_ratio}`);
	assert.ok(metrics.scale_ratio >= COMPOSITION_BOUNDS.minScaleRatio, `scale ${metrics.scale_ratio}`);
	assert.equal(metrics.has_top_termination, true);
});

// One generous street face must not average out three blank ones, so the worst
// elevation is the one the ratio is taken from.
test("the worst elevation sets the opening ratio", () => {
	const context = {
		...CONTEXT,
		facade_segments: [
			{ segment_id: "seg-front", face_view: "front", length_m: 10, local_z: [0, 16.5] },
			{ segment_id: "seg-back", face_view: "back", length_m: 10, local_z: [0, 16.5] },
		],
	};
	const primitives = [
		...Array.from({ length: 10 }, (_, index) => opening(0.5, 9.5, 0.5 + index * 1.6, 1.9 + index * 1.6)),
		{ ...opening(1, 2, 1, 2), segment_id: "seg-back" },
		cornice,
	];
	const { metrics, codes } = measureComposition({ context, resolved: { primitives } });
	assert.ok(codes.includes("OPENING_RATIO_LOW"));
	assert.ok(metrics.opening_ratio_by_view.front > metrics.opening_ratio_by_view.back);
	assert.equal(metrics.worst_opening_ratio, metrics.opening_ratio_by_view.back);
});

// v12 answered the bare lockstep fault by deleting windows until the elevation was a
// blank wall - a worse building than the stacked cells it replaced. The fault has to
// carry its own guard, because the model acts on the fault text and not on this comment.
test("the lockstep fault names the openings it must not trade away", () => {
	const { faults } = measureComposition({ context: CONTEXT, resolved: { primitives: WAREHOUSE } });
	const lockstep = faults.find((fault) => fault.startsWith("STOREY_LOCKSTEP:"));
	assert.ok(lockstep, "expected a STOREY_LOCKSTEP fault");
	assert.match(lockstep, new RegExp(`keep all ${WAREHOUSE.length} openings`));
	assert.match(lockstep, /opening ratio/);
});
