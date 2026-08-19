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
	// MATERIAL_ROLE_MISSING too: bare slits carry no sill, band or transom, so the opaque
	// role has no source and the render gate would reject the elevation anyway.
	assert.deepEqual([...codes].sort(), ["MATERIAL_ROLE_MISSING", "OPENING_RATIO_LOW", "SCALE_HIERARCHY_FLAT", "STOREY_LOCKSTEP", "TOP_TERMINATION_MISSING"]);
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
		// A composed elevation carries its opaque role; without a band the render gate
		// rejects it however well the three composition measures score.
		{ kind: "band", segment_id: "seg-front", local_bounds: { u_min: 0, u_max: 10, z_min: 3.3, z_max: 3.45 } },
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

const TWO_FACE_CONTEXT = {
	...CONTEXT,
	facade_segments: [
		{ segment_id: "seg-front", face_view: "front", length_m: 10, local_z: [0, 16.5] },
		{ segment_id: "seg-back", face_view: "back", length_m: 10, local_z: [0, 16.5] },
	],
};

const onFace = (segment: string, primitives: any[]) => primitives.map((primitive) => ({ ...primitive, segment_id: segment }));
// A cornice terminates every facet in a real grammar. Putting one on a single face would
// make the two walls differ on that alone, which is true but not what these tests are about.
const CORNICES = [{ ...cornice }, { ...cornice, segment_id: "seg-back" }];

// The guidance has always asked the street face and the service face to differ in kind
// rather than in window width, and nothing measured it, so an elevation whose two long
// faces were the same wall passed with no faults at all.
test("two faces built the same way are reported as the same wall", () => {
	const face = Array.from({ length: 10 }, (_, index) => opening(0.6 + (index % 5) * 1.8, 2.0 + (index % 5) * 1.8, 0.6 + Math.floor(index / 5) * 3.3, 2.9 + Math.floor(index / 5) * 3.3));
	const { metrics } = measureComposition({
		context: TWO_FACE_CONTEXT,
		resolved: { primitives: [...onFace("seg-front", face), ...onFace("seg-back", face), ...CORNICES] },
	});
	// Reported rather than gated - see the comment on the measure - so the profiles are the
	// assertion, not a fault code.
	assert.equal(metrics.face_profiles.front, metrics.face_profiles.back);
});

test("a face whose openings sit differently is a different sort of wall", () => {
	const tall = Array.from({ length: 10 }, (_, index) => opening(0.6 + (index % 5) * 1.8, 2.0 + (index % 5) * 1.8, 0.6 + Math.floor(index / 5) * 3.3, 2.9 + Math.floor(index / 5) * 3.3));
	// Same count and much the same area, but laid out wide rather than upright.
	const wide = Array.from({ length: 10 }, (_, index) => opening(0.4 + (index % 5) * 1.9, 2.2 + (index % 5) * 1.9, 1.2 + Math.floor(index / 5) * 3.3, 2.1 + Math.floor(index / 5) * 3.3));
	const { metrics } = measureComposition({
		context: TWO_FACE_CONTEXT,
		resolved: { primitives: [...onFace("seg-front", tall), ...onFace("seg-back", wide), ...CORNICES] },
	});
	assert.notEqual(metrics.face_profiles.front, metrics.face_profiles.back);
});

// The entrance is placed by deterministic code on the most visible ground segment, so it
// lands on one face whatever the grammar wrote. Counting it would make that face different
// by construction and the measure could never fail.
test("the deterministic entrance alone does not make two faces differ", () => {
	const face = Array.from({ length: 10 }, (_, index) => opening(0.6 + (index % 5) * 1.8, 2.0 + (index % 5) * 1.8, 0.6 + Math.floor(index / 5) * 3.3, 2.9 + Math.floor(index / 5) * 3.3));
	const door = { kind: "door", segment_id: "seg-back", local_bounds: { u_min: 4, u_max: 5.8, z_min: 0, z_max: 2.4 } };
	const { metrics } = measureComposition({
		context: TWO_FACE_CONTEXT,
		resolved: { primitives: [...onFace("seg-front", face), ...onFace("seg-back", face), door, ...CORNICES] },
	});
	// The door is now excluded from the aspect and the density too, not only from the
	// terminal set, so the two faces stay identical however the entrance lands.
	assert.equal(metrics.face_profiles.front, metrics.face_profiles.back);
});

// A cornice terminates the face it is on, and only if it sits in the top storey - the test
// used to ask whether the building had one anywhere, and then whether the word appeared on
// the face, neither of which is the same as the building stopping there.
test("a cornice on one face does not terminate the others", () => {
	const face = Array.from({ length: 10 }, (_, index) => opening(0.6 + (index % 5) * 1.8, 2.0 + (index % 5) * 1.8, 0.6 + Math.floor(index / 5) * 3.3, 2.9 + Math.floor(index / 5) * 3.3));
	const { codes, faults, metrics } = measureComposition({
		context: TWO_FACE_CONTEXT,
		resolved: { primitives: [...onFace("seg-front", face), ...onFace("seg-back", face), cornice] },
	});
	assert.ok(codes.includes("TOP_TERMINATION_MISSING"), codes.join(", "));
	assert.deepEqual(metrics.terminated_views, ["front"]);
	// The fault has to say which elevation is missing one, not just that one is missing.
	assert.match(faults.find((entry) => entry.startsWith("TOP_TERMINATION_MISSING")), /back/);
	assert.equal(metrics.has_top_termination, true);
});

// Alexander's failure threshold, not his target: a step of ten between neighbouring size
// levels is a gap, and the largest opening reads as a separate building.
test("a size level that jumps past ten is reported as a broken hierarchy", () => {
	const ordinary = Array.from({ length: 12 }, (_, index) => opening(0.6 + (index % 4) * 2.2, 1.4 + (index % 4) * 2.2, 0.6 + Math.floor(index / 4) * 3.3, 1.6 + Math.floor(index / 4) * 3.3));
	const enormous = opening(0.5, 9.5, 0.5, 15.5);
	const { codes, metrics } = measureComposition({
		context: CONTEXT, resolved: { primitives: [...ordinary, enormous, cornice] },
	});
	assert.ok(codes.includes("SCALE_STEP_BROKEN"), `${codes.join(", ")} | step ${metrics.levels_of_scale.largestStep}`);
	assert.ok(metrics.levels_of_scale.largestStep > COMPOSITION_BOUNDS.maxLevelStep);
});

// Ewing & Handy 2009 put the weight on the *first floor*: their transparency model's largest
// term is the proportion of ground-storey facade carrying windows, and the paper states that
// windows above ground level do not raise perceived transparency once the rest is controlled.
// The whole-face ratio cannot see the difference between a glazed street and a glazed attic.
test("ground transparency reads the street storey, not the whole face", () => {
	const atGround = Array.from({ length: 4 }, (_, index) => opening(0.5 + index * 2.4, 2.3 + index * 2.4, 0.4, 2.9));
	const upHigh = Array.from({ length: 4 }, (_, index) => opening(0.5 + index * 2.4, 2.3 + index * 2.4, 13.4, 15.9));

	const street = measureComposition({ context: CONTEXT, resolved: { primitives: [...atGround, cornice] } });
	const attic = measureComposition({ context: CONTEXT, resolved: { primitives: [...upHigh, cornice] } });

	// The same glass, the same whole-face ratio, and one of them is a shopfront.
	assert.equal(street.metrics.opening_ratio_by_view.front, attic.metrics.opening_ratio_by_view.front);
	assert.ok(street.metrics.worst_ground_transparency > 0.3, `street ${street.metrics.worst_ground_transparency}`);
	assert.equal(attic.metrics.worst_ground_transparency, 0);
});

// An opening that runs past the first slab glazes the street only as far as the slab.
test("a storey-crossing slot counts only the part of it that is at street level", () => {
	const slot = opening(0.5, 2.3, 0.4, 9.5);
	const { metrics } = measureComposition({ context: CONTEXT, resolved: { primitives: [slot, cornice] } });
	const ground = CONTEXT.storeys[0];
	const expected = (2.3 - 0.5) * (ground.z_max - 0.4) / (10 * (ground.z_max - ground.z_min));
	assert.ok(Math.abs(metrics.ground_transparency_by_view.front - expected) < 1e-6,
		`${metrics.ground_transparency_by_view.front} vs ${expected}`);
});

// The gate used to be satisfied by the word rather than by the building: any `cornice`
// primitive on a face terminated it, so a flush strip at pavement level counted.
test("a cornice at grade does not terminate the elevation above it", () => {
	const face = Array.from({ length: 10 }, (_, index) => opening(0.6 + (index % 5) * 1.8, 2.0 + (index % 5) * 1.8, 0.6 + Math.floor(index / 5) * 3.3, 2.9 + Math.floor(index / 5) * 3.3));
	const atGrade = { kind: "cornice", segment_id: "seg-front", local_bounds: { u_min: 0, u_max: 10, z_min: 0.05, z_max: 0.4 } };
	const { codes, metrics } = measureComposition({ context: CONTEXT, resolved: { primitives: [...face, atGrade] } });
	assert.ok(codes.includes("TOP_TERMINATION_MISSING"), codes.join(", "));
	assert.deepEqual(metrics.terminated_views, []);
	// The primitive is there; it is simply not doing the job the gate is named for.
	assert.equal(metrics.has_top_termination, true);
});

const skinBay = (uMin: number, uMax: number, zMin: number, zMax: number, segment = "seg-front") => ([
	{ kind: "mullion", segment_id: segment, local_bounds: { u_min: uMin, u_max: uMin + 0.08, z_min: 0, z_max: 16.5 } },
	{ kind: "transom", segment_id: segment, local_bounds: { u_min: uMin, u_max: uMax, z_min: zMin - 0.1, z_max: zMin } },
	{ kind: "spandrel", segment_id: segment, local_bounds: { u_min: uMin, u_max: uMax, z_min: zMax, z_max: zMax + 0.7 } },
	{ ...opening(uMin + 0.08, uMax, zMin, zMax), segment_id: segment },
]);

// A unitised skin's vision panes are identical because that is what unitised means. The
// largest-against-median question was asked of every opening in the building, so it
// rejected every honest curtain wall - the ratio is 1.0 by construction.
test("a uniform glazed skin is not told its openings are all the same size", () => {
	const skin = [1, 2, 3, 4, 5].flatMap((storey) => [0.4, 2.4, 4.4, 6.4, 8.4]
		.flatMap((u) => skinBay(u, u + 1.8, (storey - 1) * 3.3 + 0.5, (storey - 1) * 3.3 + 2.6)));
	const { codes, metrics } = measureComposition({ context: CONTEXT, resolved: { primitives: [...skin, cornice] } });

	assert.equal(metrics.construction_by_view.front, "skin");
	// Every pane really is the same size - the measure would have fired on the old reading.
	assert.ok(metrics.scale_ratio < 1.5, `scale_ratio ${metrics.scale_ratio}`);
	assert.ok(!codes.includes("SCALE_HIERARCHY_FLAT"), codes.join(", "));
	// And the mullion carries the skin past the floors, so it is not in storey lockstep.
	assert.ok(metrics.max_storey_span >= 2, `span ${metrics.max_storey_span}`);
});

// The question still has to be asked of the faces where an opening is an event cut into a
// wall, or scoping it would have been a way of switching it off.
test("a punched face is still asked for a subject when a skin sits beside it", () => {
	const skin = [1, 2, 3].flatMap((storey) => [0.4, 2.4]
		.flatMap((u) => skinBay(u, u + 1.8, (storey - 1) * 3.3 + 0.5, (storey - 1) * 3.3 + 2.6, "seg-front")));
	const flatPunched = Array.from({ length: 12 }, (_, index) => ({
		...opening(0.6 + (index % 4) * 2.2, 2.0 + (index % 4) * 2.2, 0.6 + Math.floor(index / 4) * 3.3, 2.9 + Math.floor(index / 4) * 3.3),
		segment_id: "seg-back",
	}));
	const { codes, metrics } = measureComposition({
		context: TWO_FACE_CONTEXT,
		resolved: { primitives: [...skin, ...flatPunched, ...CORNICES] },
	});

	assert.equal(metrics.construction_by_view.front, "skin");
	assert.equal(metrics.construction_by_view.back, "punched");
	assert.ok(codes.includes("SCALE_HIERARCHY_FLAT"), codes.join(", "));
	// The skin's panes must not be what the punched face is judged on.
	assert.notEqual(metrics.punched_scale_ratio, metrics.scale_ratio);
});

// How open a skin is, is not the same question as how much of a masonry wall was cut away:
// the skin is measured over the band of the face it actually covers, so a skin hung on the
// upper storeys is not marked down for the masonry below it.
test("skin transparency is read over the band the skin covers", () => {
	// A skin hung on storeys 4 and 5 only, its framing bounded to the band it covers - which
	// is what sets the band the reading is taken over.
	const upperOnly = [
		...[0.4, 2.4, 4.4, 6.4, 8.4].map((u) => ({
			kind: "mullion", segment_id: "seg-front",
			local_bounds: { u_min: u, u_max: u + 0.08, z_min: 9.9, z_max: 16.2 },
		})),
		...[4, 5].flatMap((storey) => [0.4, 2.4, 4.4, 6.4, 8.4]
			.map((u) => opening(u + 0.08, u + 1.8, (storey - 1) * 3.3 + 0.5, (storey - 1) * 3.3 + 2.6))),
	];
	const { metrics } = measureComposition({ context: CONTEXT, resolved: { primitives: [...upperOnly, cornice] } });

	const share = metrics.skin_transparency_by_view.front;
	assert.ok(share > 0 && share < 1, `share ${share}`);
	// Two storeys of skin on a five storey face: the whole-face ratio is dragged down by the
	// three storeys the skin never reaches, and the skin's own reading is not.
	assert.ok(share > metrics.opening_ratio_by_view.front * 1.5,
		`${share} vs whole face ${metrics.opening_ratio_by_view.front}`);
});

// The denominator used to be the summed area of the skin members, which paid an author to
// leave the face uncovered: hold the corner mullion back and the strip it declines to cover
// leaves the denominator, so the reported figure rises while the elevation gains piers.
test("a skin that leaves the face bare cannot report itself as more transparent", () => {
	const glass = [1, 2, 3, 4, 5].map((storey) =>
		opening(2.0, 8.0, (storey - 1) * 3.3 + 0.5, (storey - 1) * 3.3 + 2.6));
	const member = (uMin: number, uMax: number) => ({
		kind: "mullion", segment_id: "seg-front",
		local_bounds: { u_min: uMin, u_max: uMax, z_min: 0.5, z_max: 15.5 },
	});

	// Same glass both times. One skin runs the width of the face; the other stops short and
	// leaves 2 m of bare mass at each end.
	const covering = measureComposition({
		context: CONTEXT,
		resolved: { primitives: [...glass, member(0, 2.0), member(8.0, 10), cornice] },
	});
	const heldBack = measureComposition({
		context: CONTEXT,
		resolved: { primitives: [...glass, member(1.9, 2.0), member(8.0, 8.1), cornice] },
	});

	assert.equal(covering.metrics.construction_by_view.front, "skin");
	assert.equal(heldBack.metrics.construction_by_view.front, "skin");
	// Holding the framing back must not be rewarded.
	assert.ok(heldBack.metrics.skin_transparency_by_view.front <= covering.metrics.skin_transparency_by_view.front + 1e-9,
		`held back ${heldBack.metrics.skin_transparency_by_view.front} vs covering ${covering.metrics.skin_transparency_by_view.front}`);
});
