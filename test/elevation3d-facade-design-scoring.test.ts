import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { compileFacadeDesign } from "../plugins/elevation-3d/lib/facade-agent/design/compiler.mjs";
import { SCORE_LIMITS } from "../plugins/elevation-3d/lib/facade-agent/design/critic.mjs";
import { resolveFacadeProgram } from "../plugins/elevation-3d/lib/facade-agent/design/resolver.mjs";
import {
	createFacadeDesignCritic,
	FacadeDesignScoringError,
	scoreFacadeDesign,
} from "../plugins/elevation-3d/lib/facade-agent/design/scoring.mjs";
import { validateResolvedFacadeProgram } from "../plugins/elevation-3d/lib/facade-agent/design/validator.mjs";
import { createFacadeDesignFixture } from "./helpers/facade-design-fixture.ts";

const ARTIFACTS = {
	technical_views: Object.fromEntries(
		["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"]
			.map((view, index) => [view, { sha256: String(index).repeat(64).slice(0, 64) }]),
	),
	pbr_contact_sheet: { sha256: "a".repeat(64) },
	perspective_hero: { sha256: "b".repeat(64) },
};

function opening(context: any, kind: string, segmentIndex: number, index: number, z: number, options: any = {}) {
	const segment = context.facade_segments[segmentIndex];
	return {
		kind, material: kind === "door" ? "glass" : "glass", segment_id: segment.segment_id,
		design_primitive_index: index, family_id: options.family_id ?? "narrow",
		...(kind === "door" ? { role: "primary_entrance" } : {}),
		local_bounds: { u0: 0.3, u1: 0.3 + (options.width ?? 0.8), v0: z, v1: z + (options.height ?? 1.6), n0: 0, n1: 0.015 },
	};
}

function frameFor(primitive: any, side: number) {
	return {
		kind: "window-frame", material: "window-frame", segment_id: primitive.segment_id,
		design_primitive_index: primitive.design_primitive_index, source_kind: primitive.kind,
		local_bounds: { ...primitive.local_bounds, u1: primitive.local_bounds.u0 + 0.03 + side * 0.001 },
	};
}

function design(context: any, { storeyHeights, framedFraction = 1 }: { storeyHeights: number[]; framedFraction?: number }) {
	const primitives: any[] = [];
	let index = 0;
	const bestGround = context.facade_segments
		.filter((segment: any) => segment.ground_access)
		.sort((left: any, right: any) => right.visibility_score - left.visibility_score
			|| right.length_m - left.length_m || left.segment_id.localeCompare(right.segment_id))[0];
	const doorSegment = context.facade_segments.findIndex((segment: any) => segment.segment_id === bestGround.segment_id);
	primitives.push(opening(context, "door", doorSegment, index++, 0, { width: 1.8, height: 2.4, family_id: "portal" }));
	for (const z of storeyHeights) {
		for (let segmentIndex = 0; segmentIndex < context.facade_segments.length; segmentIndex += 1) {
			primitives.push(opening(context, "window", segmentIndex, index++, z, { family_id: "narrow" }));
			primitives.push(opening(context, "window", segmentIndex, index++, z, { family_id: "wide", width: 1.2 }));
		}
	}
	const openings = primitives.filter((primitive) => primitive.kind === "door" || primitive.kind === "window");
	const framedCount = Math.round(openings.length * framedFraction);
	const frames = openings.slice(0, framedCount).flatMap((primitive) => [frameFor(primitive, 0), frameFor(primitive, 1)]);
	primitives.push(...frames, {
		kind: "pilaster", material: "brick", segment_id: context.facade_segments[0].segment_id,
		design_primitive_index: index, local_bounds: { u0: 0, u1: 0.25, v0: 0, v1: 6.6, n0: 0, n1: 0.12 },
	});
	return primitives;
}

test("accepts a design with openings on every storey and every opening framed", async (t) => {
	const { context } = await createFacadeDesignFixture(t);
	const { scores, metrics } = scoreFacadeDesign({
		context, artifacts: ARTIFACTS, primitives: design(context, { storeyHeights: [0.8, 4.1] }),
	});

	assert.equal(metrics.open_storeys, 2);
	assert.equal(metrics.framed_openings, metrics.openings);
	for (const [name, minimum] of Object.entries(SCORE_LIMITS)) {
		assert.equal(scores[name] >= minimum, true, `${name} scored ${scores[name]} below ${minimum}`);
	}
});

test("rejects a design that leaves the top storey blank", async (t) => {
	const { context } = await createFacadeDesignFixture(t);
	const { scores, metrics } = scoreFacadeDesign({
		context, artifacts: ARTIFACTS, primitives: design(context, { storeyHeights: [0.8] }),
	});

	assert.equal(metrics.open_storeys, 1);
	assert.equal(scores.base_middle_top_hierarchy < SCORE_LIMITS.base_middle_top_hierarchy, true);
});

test("rejects a design that frames only some of its openings", async (t) => {
	const { context } = await createFacadeDesignFixture(t);
	const { scores } = scoreFacadeDesign({
		context, artifacts: ARTIFACTS, primitives: design(context, { storeyHeights: [0.8, 4.1], framedFraction: 0.2 }),
	});

	assert.equal(scores.base_middle_top_hierarchy >= SCORE_LIMITS.base_middle_top_hierarchy, true);
	assert.equal(scores.material_hierarchy < SCORE_LIMITS.material_hierarchy, true);
});

test("scores zero entrance legibility without exactly one primary entrance", async (t) => {
	const { context } = await createFacadeDesignFixture(t);
	const primitives = design(context, { storeyHeights: [0.8, 4.1] })
		.filter((primitive: any) => primitive.kind !== "door");
	const { scores } = scoreFacadeDesign({ context, artifacts: ARTIFACTS, primitives });

	assert.equal(scores.entrance_legibility, 0);
});

test("critic scores the compiled facade and rejects a manifest that lost its GLB", async (t) => {
	const fixture = await createFacadeDesignFixture(t);
	const resolved = resolveFacadeProgram(fixture.program, fixture.context);
	const validation = validateResolvedFacadeProgram({ program: fixture.program, context: fixture.context, resolved });
	const compiled = await compileFacadeDesign({
		outputRoot: join(fixture.runDir, "compiled"), candidate: fixture.candidate,
		context: fixture.context, program: fixture.program, resolved, validation,
	});
	const critic = createFacadeDesignCritic();
	const review: any = await critic({
		sourceSha256: "0".repeat(64), context: fixture.context, compiled, artifacts: ARTIFACTS,
	});

	assert.equal(review.source_sha256, "0".repeat(64));
	assert.deepEqual(Object.keys(review.scores).sort(), Object.keys(SCORE_LIMITS).sort());
	assert.equal(review.accepted, Object.entries(SCORE_LIMITS).every(([name, minimum]) => review.scores[name] >= minimum));
	assert.equal(review.scores.entrance_legibility, 100);
	assert.equal(review.notes.length > 0, true);

	await assert.rejects(
		() => critic({
			sourceSha256: "0".repeat(64), context: fixture.context, artifacts: ARTIFACTS,
			compiled: { ...compiled, output: { ...compiled.output, sha256: "c".repeat(64) } },
		}),
		(error: unknown) => error instanceof FacadeDesignScoringError,
	);
});

// The axis used to read repetition between elevations, as one minus the share of segments
// carrying a distinct rhythm. A street face and a service face that differ in kind - the
// thing the guidance asks for - drove that term to zero and held the axis at 70 however
// well the facade was composed. Repetition belongs inside a face; difference between them.
test("elevations that deliberately differ are not scored down for differing", async (t) => {
	const { context } = await createFacadeDesignFixture(t);
	const primitives = design(context, { storeyHeights: [0.8, 4.1] });
	for (const primitive of primitives) {
		if (primitive.kind !== "window") continue;
		const segmentIndex = context.facade_segments
			.findIndex((segment: any) => segment.segment_id === primitive.segment_id);
		primitive.local_bounds.u1 = primitive.local_bounds.u0 + 0.7 + segmentIndex * 0.12
			+ (primitive.family_id === "wide" ? 0.4 : 0);
	}

	const { scores, metrics } = scoreFacadeDesign({ context, artifacts: ARTIFACTS, primitives });

	// Every segment now carries its own rhythm, which is exactly what used to be punished.
	assert.equal(metrics.distinct_segment_signatures, metrics.segments_with_openings);
	// Each of those rhythms still repeats up its own face, and that is what is measured.
	assert.ok(metrics.segment_opening_repetition > 0.75, `repetition ${metrics.segment_opening_repetition}`);
	assert.ok(scores.repetition_variation_balance >= SCORE_LIMITS.repetition_variation_balance,
		`repetition_variation_balance scored ${scores.repetition_variation_balance}`);
});

// The axis still has to fail something. A face whose every opening is a one-off has no
// rhythm to read, which is the fault the term is actually for.
test("a face where no opening repeats scores its repetition down", async (t) => {
	const { context } = await createFacadeDesignFixture(t);
	const primitives = design(context, { storeyHeights: [0.8, 4.1] });
	let unique = 0;
	for (const primitive of primitives) {
		if (primitive.kind !== "window") continue;
		primitive.local_bounds.u1 = primitive.local_bounds.u0 + 0.6 + (unique += 1) * 0.037;
	}

	const { metrics } = scoreFacadeDesign({ context, artifacts: ARTIFACTS, primitives });

	assert.equal(metrics.segment_opening_repetition, 0);
});
