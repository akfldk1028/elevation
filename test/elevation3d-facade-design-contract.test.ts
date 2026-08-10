import assert from "node:assert/strict";
import test from "node:test";

import {
	FacadeDesignContractError,
	parseFacadeProgram,
} from "../plugins/elevation-3d/lib/facade-agent/design/contract.mjs";

const sourceAuthority = Object.freeze({
	candidate_id: "creative-020",
	candidate_sha256: "a".repeat(64),
	selected_glb_sha256: "b".repeat(64),
	context_sha256: "c".repeat(64),
});

function proposal(overrides: Record<string, unknown> = {}) {
	return {
		schema_version: "arr.elevation3d.facade-program.v2",
		concept_id: "creative-020-corner-entry-v1",
		entrance: {
			segment_selector: "primary_visible_ground_segment",
			preferred_bay: "central_or_corner_focus",
			door_family: "recessed_glazed_portal",
			width_m: 1.8,
			height_m: 2.4,
			recess_m: 0.15,
		},
		zones: [
			{ id: "base", storeys: [1], treatment: "lobby_and_entrance" },
			{ id: "middle", storeys: [2, 3, 4], treatment: "a_b_a_window_rhythm" },
			{ id: "top", storeys: [5], treatment: "paired_openings_and_cornice" },
		],
		window_families: [
			{ id: "narrow", width_m: 0.9, height_m: 1.8, sill_m: 0.8 },
			{ id: "wide", width_m: 1.5, height_m: 1.8, sill_m: 0.8 },
			{ id: "lobby", width_m: 1.8, height_m: 2.4, sill_m: 0 },
		],
		bay_rules: [{
			id: "middle-aba",
			zone_id: "middle",
			pattern: ["narrow", "wide", "narrow"],
			repeat: 1,
		}],
		articulation: [{
			id: "fold-pilaster",
			kind: "pilaster",
			segment_selector: "all_visible_folds",
			width_m: 0.3,
			depth_m: 0.12,
			storeys: [1, 2, 3, 4, 5],
			material_id: "brick-primary",
		}],
		materials: [{ id: "brick-primary", role: "opaque", color: "#8b3f2f", finish: "matte" }],
		design_rationale: ["Make the entrance legible and vary the middle-storey rhythm."],
		...overrides,
	};
}

function rejects(input: unknown, code = "FACADE_DESIGN_PROGRAM_INVALID") {
	assert.throws(
		() => parseFacadeProgram(input, { sourceAuthority }),
		(error: unknown) => error instanceof FacadeDesignContractError && error.code === code,
	);
}

test("injects verified source authority into a frozen FacadeProgramV2", () => {
	const parsed = parseFacadeProgram(proposal(), { sourceAuthority });

	assert.deepEqual(parsed.source, sourceAuthority);
	assert.equal(parsed.entrance.width_m, 1.8);
	assert.deepEqual(parsed.zones[1].storeys, [2, 3, 4]);
	assert.deepEqual(parsed.bay_rules[0].pattern, ["narrow", "wide", "narrow"]);
	assert.equal(parsed.articulation[0].material_id, "brick-primary");
	assert.equal(Object.isFrozen(parsed), true);
	assert.equal(Object.isFrozen(parsed.window_families), true);
	assert.equal(Object.isFrozen(parsed.window_families[0]), true);
});

test("rejects model-supplied source authority and unknown top-level fields", () => {
	rejects(proposal({ source: sourceAuthority }));
	rejects(proposal({ filesystem_path: "D:/outside.glb" }));
});

test("rejects accessors without invoking them", () => {
	let invoked = false;
	const input = proposal();
	Object.defineProperty(input, "materials", {
		enumerable: true,
		get() {
			invoked = true;
			return [];
		},
	});

	rejects(input);
	assert.equal(invoked, false);
});

test("converts hostile array inspection failures into a typed contract error", () => {
	const hostileZones = new Proxy([], {
		getPrototypeOf() {
			throw new Error("hostile prototype trap");
		},
	});

	rejects(proposal({ zones: hostileZones }));
});

test("rejects duplicate identities and non-finite or unsafe dimensions", () => {
	const duplicateFamilies = proposal({
		window_families: [
			{ id: "same", width_m: 0.9, height_m: 1.8, sill_m: 0.8 },
			{ id: "same", width_m: 1.5, height_m: 1.8, sill_m: 0.8 },
		],
	});
	rejects(duplicateFamilies);
	rejects(proposal({ entrance: { ...proposal().entrance, width_m: Number.NaN } }));
	rejects(proposal({ entrance: { ...proposal().entrance, recess_m: 100 } }));
});

test("rejects unsupported selectors and unbounded arrays", () => {
	rejects(proposal({ entrance: { ...proposal().entrance, segment_selector: "model_decides_path" } }));
	rejects(proposal({ design_rationale: Array.from({ length: 33 }, (_, index) => `reason-${index}`) }));
});
