import assert from "node:assert/strict";
import test from "node:test";

import {
	FacadeDesignValidationError,
	readVerifiedFacadeDesignValidationAuthority,
	validateResolvedFacadeProgram,
} from "../plugins/elevation-3d/lib/facade-agent/design/validator.mjs";
import { parseFacadeDesign } from "../plugins/elevation-3d/lib/facade-agent/design/contract.mjs";
import { resolveFacadeProgram } from "../plugins/elevation-3d/lib/facade-agent/design/resolver.mjs";
import {
	createFacadeDesignFixture,
	createFacadeProgramForContext,
} from "./helpers/facade-design-fixture.ts";

function typedRejection(error: unknown) {
	return error instanceof FacadeDesignValidationError && error.code === "FACADE_DESIGN_VALIDATION_INVALID";
}

test("accepts the bounded entrance, window rhythm, hierarchy, and articulation fixture", async (t) => {
	const { context, program } = await createFacadeDesignFixture(t);
	const resolved = resolveFacadeProgram(program, context);
	const receipt = validateResolvedFacadeProgram({ program, context, resolved });

	assert.equal(receipt.accepted, true);
	assert.deepEqual(receipt.codes, []);
	assert.deepEqual(receipt.measurements, []);
	assert.equal(receipt.resolution_sha256, resolved.resolution_sha256);
	assert.equal(Object.isFrozen(receipt), true);
	assert.deepEqual(readVerifiedFacadeDesignValidationAuthority(receipt), {
		...receipt.source,
		resolution_sha256: receipt.resolution_sha256,
		validation_sha256: receipt.validation_sha256,
		accepted: true,
	});
	assert.equal(readVerifiedFacadeDesignValidationAuthority(structuredClone(receipt)), null);
});

test("reports floor-band and projection violations with bounded measurements", async (t) => {
	const { context } = await createFacadeDesignFixture(t);
	const program = createFacadeProgramForContext(context, {
		entrance: { height_m: 3.2, recess_m: 0.8 },
	});
	const resolved = resolveFacadeProgram(program, context);
	const receipt = validateResolvedFacadeProgram({ program, context, resolved });

	assert.equal(receipt.accepted, false);
	assert.deepEqual(receipt.codes, ["FLOOR_BAND_INTRUSION", "PROJECTION_LIMIT_EXCEEDED"]);
	assert.equal(receipt.measurements.length <= 64, true);
	assert.equal(receipt.measurements.every((item: any) => Number.isFinite(item.actual) && Number.isFinite(item.limit)), true);
});

test("reports overlapping solid articulation and a corner-focused entrance", async (t) => {
	const { context } = await createFacadeDesignFixture(t);
	const program = createFacadeProgramForContext(context, {
		entrance: { preferred_bay: "corner_focus" },
		articulation: [{
			id: "entry-pilaster", kind: "pilaster", segment_selector: "primary_visible_segment",
			width_m: 3, depth_m: 0.12, storeys: [1], material_id: "brick-primary",
		}],
	});
	const resolved = resolveFacadeProgram(program, context);
	const receipt = validateResolvedFacadeProgram({ program, context, resolved });
	assert.equal(receipt.accepted, false);
	assert.deepEqual(receipt.codes, ["PRIMITIVE_OVERLAP"]);
});

test("accepts a base-zone rhythm that shares the primary entrance segment", async (t) => {
	const { context } = await createFacadeDesignFixture(t);
	const program = createFacadeProgramForContext(context, {
		bay_rules: [
			{ id: "middle-aba", zone_id: "middle", pattern: ["narrow", "wide", "narrow"], repeat: 1 },
			{ id: "base-ab", zone_id: "base", pattern: ["narrow", "wide"], repeat: 1 },
		],
	});
	const resolved = resolveFacadeProgram(program, context);
	const receipt = validateResolvedFacadeProgram({ program, context, resolved });

	assert.equal(receipt.accepted, true);
	assert.deepEqual(receipt.codes, []);
	assert.equal(resolved.primitives.some((primitive: any) => primitive.kind === "window" && primitive.storey === 1), true);
});

test("rejects a program without the required base-middle-top hierarchy", async (t) => {
	const { context } = await createFacadeDesignFixture(t);
	const program = createFacadeProgramForContext(context, {
		zones: [
			{ id: "lower", storeys: [1], treatment: "lobby_and_entrance" },
			{ id: "repeat", storeys: [2], treatment: "a_b_a_window_rhythm" },
			{ id: "cap", storeys: [2], treatment: "paired_openings_and_cornice" },
		],
		bay_rules: [{ id: "repeat-aba", zone_id: "repeat", pattern: ["narrow", "wide", "narrow"], repeat: 1 }],
	});
	const resolved = resolveFacadeProgram(program, context);
	const receipt = validateResolvedFacadeProgram({ program, context, resolved });
	assert.equal(receipt.accepted, false);
	assert.deepEqual(receipt.codes, ["HIERARCHY_MISSING"]);
});

test("rejects cloned program, context, or resolved capabilities", async (t) => {
	const { context, program } = await createFacadeDesignFixture(t);
	const resolved = resolveFacadeProgram(program, context);
	assert.throws(() => validateResolvedFacadeProgram({ program: structuredClone(program), context, resolved }), typedRejection);
	assert.throws(() => validateResolvedFacadeProgram({ program, context: structuredClone(context), resolved }), typedRejection);
	assert.throws(() => validateResolvedFacadeProgram({ program, context, resolved: structuredClone(resolved) }), typedRejection);
});

function spanningGrammar(context: any, overrides: Record<string, unknown> = {}) {
	return parseFacadeDesign({
		schema_version: "arr.elevation3d.facade-grammar.v3",
		concept_id: "spanning-test",
		start: "Facet",
		entrance: {
			segment_selector: "primary_visible_ground_segment", preferred_bay: "central_focus",
			door_family: "portal", width_m: 1.2, height_m: 2.4, recess_m: 0.1,
		},
		rules: {
			Facet: [{ split: { axis: "u", parts: [
				{ size: "~1", symbol: "Wall" }, { size: "0.8", symbol: "Shaft" }, { size: "~1", symbol: "Wall" },
			] } }],
			Shaft: [{ split: { axis: "z", parts: [
				{ size: "0.5", symbol: "Wall" }, { size: "~1", symbol: "Pane" }, { size: "0.6", symbol: "Wall" },
			] } }],
			Pane: [{ terminal: "glass" }],
			Wall: [{ terminal: "wall" }],
		},
		...overrides,
	}, { sourceAuthority: context.source });
}

test("accepts an opening that passes a slab on its way between two clear ends", async (t) => {
	const { context } = await createFacadeDesignFixture(t);
	const program = spanningGrammar(context);
	const resolved = resolveFacadeProgram(program, context);
	const receipt = validateResolvedFacadeProgram({ program, context, resolved });
	const spanning = resolved.primitives.filter((primitive: any) => primitive.kind === "window"
		&& primitive.local_bounds.z_min < context.storeys[0].z_max
		&& primitive.local_bounds.z_max > context.storeys[0].z_max);

	assert.equal(spanning.length > 0, true, "the grammar must actually produce a spanning opening");
	assert.deepEqual(receipt.codes, []);
	assert.equal(receipt.accepted, true);
});

test("still rejects an opening that stops inside a floor band", async (t) => {
	const { context } = await createFacadeDesignFixture(t);
	const slab = context.storeys[0].z_max;
	const program = spanningGrammar(context, {
		rules: {
			Facet: [{ split: { axis: "u", parts: [
				{ size: "~1", symbol: "Wall" }, { size: "0.8", symbol: "Shaft" }, { size: "~1", symbol: "Wall" },
			] } }],
			Shaft: [{ split: { axis: "z", parts: [
				{ size: "0.5", symbol: "Wall" },
				{ size: String(slab - 0.5), symbol: "Pane" },
				{ size: "~1", symbol: "Wall" },
			] } }],
			Pane: [{ terminal: "glass" }],
			Wall: [{ terminal: "wall" }],
		},
	});
	const resolved = resolveFacadeProgram(program, context);
	const receipt = validateResolvedFacadeProgram({ program, context, resolved });

	assert.equal(receipt.accepted, false);
	assert.equal(receipt.codes.includes("FLOOR_BAND_INTRUSION"), true);
});

test("still rejects an opening that leaves the building", async (t) => {
	const { context } = await createFacadeDesignFixture(t);
	const top = context.storeys[context.storeys.length - 1].z_max;
	const program = spanningGrammar(context, {
		rules: {
			Facet: [{ split: { axis: "u", parts: [
				{ size: "~1", symbol: "Wall" }, { size: "0.8", symbol: "Shaft" }, { size: "~1", symbol: "Wall" },
			] } }],
			Shaft: [{ split: { axis: "z", parts: [{ size: "'1", symbol: "Pane" }] } }],
			Pane: [{ terminal: "glass" }],
			Wall: [{ terminal: "wall" }],
		},
	});
	const resolved = resolveFacadeProgram(program, context);
	const receipt = validateResolvedFacadeProgram({ program, context, resolved });

	assert.equal(resolved.primitives.some((p: any) => p.kind === "window" && p.local_bounds.z_max >= top - 1e-9), true);
	assert.equal(receipt.codes.includes("FLOOR_BAND_INTRUSION"), true);
});
