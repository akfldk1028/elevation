import assert from "node:assert/strict";
import test from "node:test";

import {
	FacadeDesignValidationError,
	readVerifiedFacadeDesignValidationAuthority,
	validateResolvedFacadeProgram,
} from "../plugins/elevation-3d/lib/facade-agent/design/validator.mjs";
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
