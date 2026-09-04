import assert from "node:assert/strict";
import test from "node:test";

import {
	FacadeGrammarError,
	parseFacadeGrammar,
	predicateHolds,
} from "../plugins/elevation-3d/lib/facade-agent/design/grammar/contract.mjs";
import { deriveFacadePrimitives } from "../plugins/elevation-3d/lib/facade-agent/design/grammar/derive.mjs";
import { FACADE_GRAMMAR_V3_SCHEMA, openingZones } from "../plugins/elevation-3d/lib/facade-agent/design/grammar/prompt.mjs";
import { DECLARED_MATERIAL_ID_PATTERN } from "../plugins/elevation-3d/lib/facade-agent/declared-material.mjs";
import { TERMINAL_MATERIAL_CHOICES } from "../plugins/elevation-3d/lib/facade-agent/facade-vocabulary.mjs";

const STOREYS = [1, 2, 3, 4, 5].map((storey) => ({ storey, z_min: (storey - 1) * 3.3, z_max: storey * 3.3 }));
const SEGMENT = {
	segment_id: "facade-segment-test", face_view: "front", view: "front",
	length_m: 2.2060695766, local_z: [0, 16.5],
	placeable: { u_min: 0.3, u_max: 1.9060695766 },
};

function grammar(rules: Record<string, unknown>, start = "Facade", extra: Record<string, unknown> = {}) {
	return parseFacadeGrammar({
		schema_version: "arr.elevation3d.facade-grammar.v3",
		concept_id: "test-grammar", start, rules, ...extra,
	});
}

const WALL = [{ terminal: "wall" }];
const GLASS = [{ terminal: "glass", inset_m: 0.04 }];

test("repeats a floating part to fit the scope and adapts its size", () => {
	const parsed = grammar({
		Facade: [{ split: { axis: "z", parts: [{ size: "~3.3", symbol: "Floor", repeat: true }] } }],
		Floor: [{ split: { axis: "u", parts: [{ size: "~1", symbol: "Wall" }, { size: "0.6", symbol: "Glass" }, { size: "~1", symbol: "Wall" }] } }],
		Wall: WALL, Glass: GLASS,
	});
	const out = deriveFacadePrimitives({ grammar: parsed, segment: SEGMENT, storeys: STOREYS });

	assert.equal(out.length, 5, "16.5 m of scope divided by a 3.3 m nominal floor");
	assert.deepEqual(out.map((primitive: any) => primitive.storey), [1, 2, 3, 4, 5]);
	for (const primitive of out as any[]) {
		assert.equal(Math.abs((primitive.local_bounds.u_max - primitive.local_bounds.u_min) - (0.6 - 0.08)) < 1e-6, true);
	}
});

test("branches on the index a repeat gives its children", () => {
	const parsed = grammar({
		Facade: [{ split: { axis: "z", parts: [{ size: "~3.3", symbol: "Floor", repeat: true }] } }],
		Floor: [
			{ when: "index % 2 == 0", split: { axis: "u", parts: [{ size: "~1", symbol: "Wall" }, { size: "0.5", symbol: "Glass" }, { size: "~1", symbol: "Wall" }] } },
			{ split: { axis: "u", parts: [{ size: "~1", symbol: "Wall" }, { size: "1.2", symbol: "Glass" }, { size: "~1", symbol: "Wall" }] } },
		],
		Wall: WALL, Glass: GLASS,
	});
	const widths = deriveFacadePrimitives({ grammar: parsed, segment: SEGMENT, storeys: STOREYS })
		.map((primitive: any) => Number((primitive.local_bounds.u_max - primitive.local_bounds.u_min).toFixed(3)));

	assert.deepEqual(widths, [0.42, 1.12, 0.42, 1.12, 0.42], "even floors narrow, odd floors wide");
});

test("selects an alternative by elevation", () => {
	const parsed = grammar({
		Facade: [
			{ when: "face_view == back", split: { axis: "u", parts: [{ size: "~1", symbol: "Wall" }] } },
			{ split: { axis: "u", parts: [{ size: "~1", symbol: "Wall" }, { size: "0.5", symbol: "Glass" }, { size: "~1", symbol: "Wall" }] } },
		],
		Wall: WALL, Glass: GLASS,
	});

	assert.equal(deriveFacadePrimitives({ grammar: parsed, segment: SEGMENT, storeys: STOREYS }).length, 1);
	assert.equal(
		deriveFacadePrimitives({ grammar: parsed, segment: { ...SEGMENT, face_view: "back" }, storeys: STOREYS }).length,
		0,
	);
});

test("keeps every derived opening inside the placeable rectangle", () => {
	const parsed = grammar({
		Facade: [{ split: { axis: "z", parts: [{ size: "~2", symbol: "Floor", repeat: true }] } }],
		Floor: [{ split: { axis: "u", parts: [{ size: "0.1", symbol: "Wall" }, { size: "~1", symbol: "Glass" }, { size: "0.1", symbol: "Wall" }] } }],
		Wall: WALL, Glass: GLASS,
	});
	for (const primitive of deriveFacadePrimitives({ grammar: parsed, segment: SEGMENT, storeys: STOREYS }) as any[]) {
		assert.equal(primitive.local_bounds.u_min >= SEGMENT.placeable.u_min - 1e-9, true);
		assert.equal(primitive.local_bounds.u_max <= SEGMENT.placeable.u_max + 1e-9, true);
		assert.equal(primitive.local_bounds.z_min >= SEGMENT.local_z[0] - 1e-9, true);
		assert.equal(primitive.local_bounds.z_max <= SEGMENT.local_z[1] + 1e-9, true);
	}
});

test("resolves the three size forms against the scope", () => {
	const parsed = grammar({
		Facade: [{ split: { axis: "u", parts: [
			{ size: "0.4", symbol: "Glass" }, { size: "'0.25", symbol: "Glass" }, { size: "~1", symbol: "Glass" },
		] } }],
		Glass: [{ terminal: "glass" }],
	});
	const [absolute, relative, floating] = deriveFacadePrimitives({ grammar: parsed, segment: SEGMENT, storeys: STOREYS })
		.map((primitive: any) => primitive.local_bounds.u_max - primitive.local_bounds.u_min);
	const span = SEGMENT.placeable.u_max - SEGMENT.placeable.u_min;

	assert.equal(Math.abs(absolute - 0.4) < 1e-6, true);
	assert.equal(Math.abs(relative - span * 0.25) < 1e-6, true);
	assert.equal(Math.abs(floating - (span - 0.4 - span * 0.25)) < 1e-6, true);
});

test("derives a curtain wall bay as a framed grid rather than a punched hole", () => {
	// One storey of a glazed skin: mullion, pane, mullion across the bay, and down the
	// storey a transom, the pane and the spandrel that closes the slab zone.
	const parsed = grammar({
		Facade: [{ split: { axis: "z", parts: [{ size: "~3.3", symbol: "Storey", repeat: true }] } }],
		Storey: [{ split: { axis: "z", parts: [
			{ size: "0.08", symbol: "Transom" },
			{ size: "~1", symbol: "Bay" },
			{ size: "0.9", symbol: "Spandrel" },
		] } }],
		Bay: [{ split: { axis: "u", parts: [
			{ size: "0.06", symbol: "Mullion" },
			{ size: "~1", symbol: "Glass" },
			{ size: "0.06", symbol: "Mullion" },
		] } }],
		Mullion: [{ terminal: "mullion", depth_m: 0.08 }],
		Transom: [{ terminal: "transom", depth_m: 0.06 }],
		Spandrel: [{ terminal: "spandrel" }],
		Glass: GLASS,
	});
	const out = deriveFacadePrimitives({ grammar: parsed, segment: SEGMENT, storeys: STOREYS }) as any[];
	const counts = new Map<string, number>();
	for (const primitive of out) counts.set(primitive.kind, (counts.get(primitive.kind) ?? 0) + 1);

	assert.deepEqual(
		[...counts.entries()].sort(),
		[["mullion", 10], ["spandrel", 5], ["transom", 5], ["window", 5]],
		"five storeys, each with two mullions, one transom, one spandrel and one pane",
	);
	const spandrel = out.find((primitive) => primitive.kind === "spandrel");
	const pane = out.find((primitive) => primitive.kind === "window");
	assert.equal(spandrel.local_bounds.z_min >= pane.local_bounds.z_max - 1e-9, true, "the spandrel closes the slab zone above the pane");
});

test("rejects grammars that reach outside the closed language", () => {
	const rejects = (rules: Record<string, unknown>, start = "Facade") =>
		assert.throws(() => grammar(rules, start), (error: unknown) => error instanceof FacadeGrammarError);

	rejects({ Facade: [{ split: { axis: "y", parts: [{ size: "1", symbol: "Wall" }] } }], Wall: WALL });
	rejects({ Facade: [{ split: { axis: "u", parts: [{ size: "1", symbol: "Missing" }] } }] });
	rejects({ Facade: [{ terminal: "balcony" }] });
	rejects({ Facade: [{ when: "process.exit(1)", terminal: "wall" }] });
	rejects({ Facade: [{ when: "index > 2", terminal: "wall" }] });
	rejects({ Facade: [{ split: { axis: "u", parts: [
		{ size: "~1", symbol: "Wall", repeat: true }, { size: "~1", symbol: "Wall", repeat: true },
	] } }], Wall: WALL });
	rejects({ Facade: [{ split: { axis: "u", parts: [
		{ size: "~1", symbol: "Wall", repeat: true }, { size: "~1", symbol: "Wall" },
	] } }], Wall: WALL });
	rejects({ Facade: [{ split: { axis: "u", parts: [{ size: "1", symbol: "Wall" }] } }] }, "Missing");
});

test("reads a predicate against the scope it is given", () => {
	const parsed = grammar({ Facade: [{ when: "index % 2 == 1 && face_view == front", terminal: "wall" }] });
	const predicate = (parsed.rules as any).Facade[0].when;

	assert.equal(predicateHolds(predicate, { index: 1, face_view: "front", storey: 1, total: 4 }), true);
	assert.equal(predicateHolds(predicate, { index: 2, face_view: "front", storey: 1, total: 4 }), false);
	assert.equal(predicateHolds(predicate, { index: 1, face_view: "back", storey: 1, total: 4 }), false);
	assert.equal(predicateHolds(null, { index: 9, face_view: "left", storey: 3, total: 4 }), true);
});

test("branches one rule on the argument it was called with", () => {
	const parsed = grammar({
		Facade: [{ split: { axis: "z", parts: [
			{ size: "'0.5", symbol: "Floor", arg: "base" },
			{ size: "'0.5", symbol: "Floor", arg: "top" },
		] } }],
		// One Floor rule where the unparameterised grammar needed FloorBase and FloorTop.
		Floor: [
			{ when: "param == top", split: { axis: "u", parts: [{ size: "~1", symbol: "Wall" }, { size: "1.2", symbol: "Glass" }, { size: "~1", symbol: "Wall" }] } },
			{ split: { axis: "u", parts: [{ size: "~1", symbol: "Wall" }, { size: "0.5", symbol: "Glass" }, { size: "~1", symbol: "Wall" }] } },
		],
		Wall: WALL, Glass: GLASS,
	});
	const widths = deriveFacadePrimitives({ grammar: parsed, segment: SEGMENT, storeys: STOREYS })
		.map((primitive: any) => Number((primitive.local_bounds.u_max - primitive.local_bounds.u_min).toFixed(3)));

	assert.deepEqual(widths, [0.42, 1.12], "the lower half took the else branch, the upper half took param == top");
});

test("accepts an integer argument in either json form", () => {
	const build = (arg: unknown) => grammar({
		Facade: [{ split: { axis: "u", parts: [{ size: "'1", symbol: "Bay", arg }] } }],
		Bay: [{ when: "param == 2", terminal: "glass" }, { terminal: "wall" }],
	});
	const count = (arg: unknown) =>
		deriveFacadePrimitives({ grammar: build(arg), segment: SEGMENT, storeys: STOREYS }).length;

	assert.equal(count(2), 1, "Floor(2) as a json number");
	assert.equal(count("2"), 1, "Floor(2) as the string a strict enum has to emit");
	assert.equal(count(3), 0);
});

test("passes an argument to the symbol it names and no further", () => {
	const parsed = grammar({
		Facade: [{ split: { axis: "z", parts: [{ size: "'1", symbol: "Bay", arg: "wide" }] } }],
		Bay: [{ split: { axis: "u", parts: [
			{ size: "'0.5", symbol: "Opening", arg: "wide" },
			{ size: "'0.5", symbol: "Opening" },
		] } }],
		Opening: [{ when: "param == wide", terminal: "glass" }, { terminal: "wall" }],
	});
	const out = deriveFacadePrimitives({ grammar: parsed, segment: SEGMENT, storeys: STOREYS }) as any[];

	assert.equal(out.length, 1, "the part that restated wide got it; the part that passed nothing did not inherit Bay's");
	assert.equal(out[0].family_id, "opening_wide", "two calls of one rule are two families, so scoring still counts them apart");
});

test("rejects arguments and parameter comparisons outside the closed value set", () => {
	const rejects = (rules: Record<string, unknown>) =>
		assert.throws(() => grammar(rules), (error: unknown) => error instanceof FacadeGrammarError);
	const passing = (arg: unknown) => ({
		Facade: [{ split: { axis: "u", parts: [{ size: "'1", symbol: "Bay", arg }] } }], Bay: WALL,
	});

	rejects(passing("16"));
	rejects(passing(16));
	rejects(passing(1.5));
	rejects(passing("mezzanine"));
	rejects(passing(["top"]));
	rejects({ Facade: [{ when: "param == 99", terminal: "wall" }] });
	rejects({ Facade: [{ when: "param == mezzanine", terminal: "wall" }] });
	// A parameter is a value, so there is nothing to compute with it and nothing to
	// compare it against but a literal. Each of these is a step towards an evaluator.
	rejects({ Facade: [{ when: "param % 2 == 0", terminal: "wall" }] });
	rejects({ Facade: [{ when: "param == top + 1", terminal: "wall" }] });
	rejects({ Facade: [{ when: "param == storey", terminal: "wall" }] });
	rejects({ Facade: [{ when: "param == process.env", terminal: "wall" }] });
});

test("stops a parameterised rule that recurses without shrinking", () => {
	// Alternating the argument gives the rule a fresh branch every step, so nothing but
	// the depth counter can end this. Parameters must not buy a way out of that.
	const parsed = grammar({
		Facade: [{ split: { axis: "u", parts: [{ size: "'1", symbol: "Bay", arg: "base" }] } }],
		Bay: [
			{ when: "param == base", split: { axis: "u", parts: [{ size: "'1", symbol: "Bay", arg: "top" }] } },
			{ split: { axis: "u", parts: [{ size: "'1", symbol: "Bay", arg: "base" }] } },
		],
	});
	assert.throws(
		() => deriveFacadePrimitives({ grammar: parsed, segment: SEGMENT, storeys: STOREYS }),
		(error: unknown) => error instanceof FacadeGrammarError && /exceeded depth/.test((error as Error).message),
	);
});

test("stops a grammar that recurses without shrinking", () => {
	const parsed = grammar({
		Facade: [{ split: { axis: "u", parts: [{ size: "'1", symbol: "Facade" }] } }],
	});
	assert.throws(
		() => deriveFacadePrimitives({ grammar: parsed, segment: SEGMENT, storeys: STOREYS }),
		(error: unknown) => error instanceof FacadeGrammarError,
	);
});

// Every live run on the stepped mass died on the same arithmetic: an opening end landing
// inside a slab line's 0.15 m skirt, on one of thirty-seven facets with different bottoms.
// Repo-blind authors solve it by hand before writing; a provider seeing a prompt cannot.
// So the prompt states the answer per facet, and these are the bands it states.
test("each facet is handed the z bands an opening may legally end in", () => {
	const storeys = [1, 2, 3].map((storey) => ({ storey, z_min: (storey - 1) * 3.3, z_max: storey * 3.3 }));

	// A facet running the whole height gets one band per storey, inset by the clearance.
	assert.deepEqual(openingZones({ local_z: [0, 9.9] }, storeys, 0.15),
		[[0.15, 3.15], [3.45, 6.45], [6.75, 9.75]]);

	// A facet that starts partway up - the bridge bar's underside is at 1.861 m - starts its
	// first band at its own bottom, not at the storey's.
	assert.deepEqual(openingZones({ local_z: [1.86, 9.3] }, storeys, 0.15),
		[[1.86, 3.15], [3.45, 6.45], [6.75, 9.3]]);

	// A parapet strip too short to hold anything legal says so with an empty list rather
	// than offering a band a sliver would fit in.
	assert.deepEqual(openingZones({ local_z: [7.26, 7.28] }, storeys, 0.15), []);

	// Degenerate input is not an exception; it is simply no room.
	assert.deepEqual(openingZones({ local_z: [5, 5] }, storeys, 0.15), []);
});

// The whole point of the storey axis: a facet that begins partway up the building still gets
// scopes bounded by the mass's own slab lines. A z repeat cannot do this - it divides the
// facet evenly from its own bottom - which is why every author so far computed slab-relative
// z by hand, per facet, and lost attempts to missing a line by centimetres.
const BRIDGE = { ...SEGMENT, local_z: [1.8609, 9.9], placeable: { u_min: 0.3, u_max: 1.9060695766 } };
const STOREY_LINES = [1, 2, 3].map((storey) => ({ storey, z_min: (storey - 1) * 3.3, z_max: storey * 3.3 }));

test("a storey split cuts at the slab lines, whatever height the facet starts at", () => {
	const parsed = grammar({
		Facade: [{ split: { axis: "storey", parts: [{ size: "~1", symbol: "Floor" }] } }],
		Floor: [{ split: { axis: "z", parts: [{ size: "~1", symbol: "Wall" }, { size: "'0.5", symbol: "Glass" }, { size: "~1", symbol: "Wall" }] } }],
		Wall: WALL, Glass: GLASS,
	});
	const out = deriveFacadePrimitives({ grammar: parsed, segment: BRIDGE, storeys: STOREY_LINES }) as any[];

	assert.equal(out.length, 3, "the facet crosses three storeys");
	assert.deepEqual(out.map((primitive) => primitive.storey), [1, 2, 3]);

	// Every pane sits strictly inside one slab-to-slab band. No fraction the author writes can
	// put one across a line, because the line is the edge of the scope it was derived in.
	const lines = [1.8609, 3.3, 6.6, 9.9];
	for (const primitive of out) {
		const { z_min: low, z_max: high } = primitive.local_bounds;
		const band = lines.findIndex((line, index) => low >= line - 1e-9 && high <= lines[index + 1] + 1e-9);
		assert.notEqual(band, -1, `pane ${low}-${high} straddles a slab line`);
	}

	// The same grammar written as a z repeat straddles, which is the failure this axis removes.
	const repeated = grammar({
		Facade: [{ split: { axis: "z", parts: [{ size: "~3.3", symbol: "Floor", repeat: true }] } }],
		Floor: [{ split: { axis: "z", parts: [{ size: "~1", symbol: "Wall" }, { size: "'0.5", symbol: "Glass" }, { size: "~1", symbol: "Wall" }] } }],
		Wall: WALL, Glass: GLASS,
	});
	const naive = deriveFacadePrimitives({ grammar: repeated, segment: BRIDGE, storeys: STOREY_LINES }) as any[];
	assert.equal(naive.some((primitive) => {
		const { z_min: low, z_max: high } = primitive.local_bounds;
		return lines.some((line) => low < line - 1e-9 && high > line + 1e-9);
	}), true, "the even division of an offset facet is expected to cross a slab line");
});

test("a storey split addresses its bands by ordinal, from the bottom", () => {
	const parsed = grammar({
		Facade: [{ split: { axis: "storey", parts: [{ size: "~1", symbol: "Floor" }] } }],
		Floor: [
			{ when: "index == 0", terminal: "door", inset_m: 0.5 },
			{ when: "index == last", terminal: "cornice" },
			{ terminal: "glass", inset_m: 0.04 },
		],
		Wall: WALL,
	});
	const out = deriveFacadePrimitives({ grammar: parsed, segment: BRIDGE, storeys: STOREY_LINES }) as any[];
	assert.deepEqual(out.map((primitive) => primitive.kind), ["door", "window", "cornice"]);
});

test("a storey split refuses sizes it would only ignore", () => {
	const two = () => grammar({
		Facade: [{ split: { axis: "storey", parts: [{ size: "'0.5", symbol: "Wall" }, { size: "'0.5", symbol: "Wall" }] } }],
		Wall: WALL,
	});
	assert.throws(two, FacadeGrammarError, "two parts would leave one of them unreachable");

	const repeated = () => grammar({
		Facade: [{ split: { axis: "storey", parts: [{ size: "~1", symbol: "Wall", repeat: true }] } }],
		Wall: WALL,
	});
	assert.throws(repeated, FacadeGrammarError, "it is already a repeat over the storeys");
});

// Instant Architecture 5.2: a rule states the size it needs and is not selected below it.
// This candidate has seven facets between 4 mm and 0.32 m; without a guard the only way to
// keep a rule off them is to name each by `index` at the start rule, which is the one place
// `index` is readable and caps at eight alternatives.
test("an alternative declines a scope smaller than the size it declares", () => {
	const parsed = grammar({
		Facade: [
			{ min_u_m: 1.0, min_z_m: 1.2, split: { axis: "u", parts: [{ size: "~1", symbol: "Wall" }, { size: "0.6", symbol: "Glass" }, { size: "~1", symbol: "Wall" }] } },
			{ terminal: "wall" },
		],
		Wall: WALL, Glass: GLASS,
	});
	const wide = { ...SEGMENT, length_m: 4, local_z: [0, 3.3], placeable: { u_min: 0, u_max: 4 } };
	assert.equal(deriveFacadePrimitives({ grammar: parsed, segment: wide, storeys: STOREY_LINES }).length, 1);

	// Too narrow, and too short: each guard turns the alternative down on its own axis, and
	// the fallback alternative - bare wall - draws nothing rather than the derivation failing.
	const narrow = { ...wide, length_m: 0.09, placeable: { u_min: 0, u_max: 0.09 } };
	assert.equal(deriveFacadePrimitives({ grammar: parsed, segment: narrow, storeys: STOREY_LINES }).length, 0);
	const squat = { ...wide, local_z: [0, 0.4] };
	assert.equal(deriveFacadePrimitives({ grammar: parsed, segment: squat, storeys: STOREY_LINES }).length, 0);
});

test("a guard is a dispatch decision, so a later alternative still runs", () => {
	const parsed = grammar({
		Facade: [
			{ min_u_m: 3, split: { axis: "u", parts: [{ size: "~1", symbol: "Glass" }] } },
			{ terminal: "band", depth_m: 0.1 },
		],
		Glass: GLASS,
	});
	const narrow = { ...SEGMENT, length_m: 1.5, local_z: [0, 3.3], placeable: { u_min: 0, u_max: 1.5 } };
	const out = deriveFacadePrimitives({ grammar: parsed, segment: narrow, storeys: STOREY_LINES }) as any[];
	assert.deepEqual(out.map((primitive) => primitive.kind), ["band"], "the guard passes the scope on, it does not stop it");
});

test("a guard out of range is rejected at parse", () => {
	assert.throws(() => grammar({ Facade: [{ min_u_m: -1, terminal: "wall" }] }), FacadeGrammarError);
	assert.throws(() => grammar({ Facade: [{ min_z_m: 100000, terminal: "wall" }] }), FacadeGrammarError);
});

// The one place a member may leave its facet. Everywhere else the clamp holds, which is why
// the top edge of every elevation was the mass's own stepped edge until this existed.
const rise = (rules: Record<string, unknown>, top: number) => deriveFacadePrimitives({
	grammar: grammar(rules),
	segment: { ...SEGMENT, length_m: 4, local_z: [0, top], placeable: { u_min: 0, u_max: 4 } },
	storeys: STOREY_LINES,
}) as any[];

const PARAPET = { Facade: [{ terminal: "cornice", depth_m: 0.2, rise_to: "building_top" }] };

test("a solid carried to the building top stands above its own facet", () => {
	// The facet stops at 7.0 and the building at 9.9, one storey up, so the parapet reaches it.
	const [member] = rise(PARAPET, 7);
	assert.equal(member.local_bounds.z_max, 9.9);
	assert.equal(member.rises_to, "building_top");

	// A facet already at the top has nothing to rise to and is unchanged.
	const [atTop] = rise(PARAPET, 9.9);
	assert.equal(atTop.local_bounds.z_max, 9.9);
});

test("a facet more than one storey below the line does not rise at all", () => {
	// 3.0 m against a 9.9 m building is 6.9 m of rise - a wall standing two storeys above the
	// mass is new massing, not a parapet, and half a rise only moves the ragged edge.
	const [member] = rise(PARAPET, 3);
	assert.equal(member.local_bounds.z_max, 3);
	assert.equal(member.rises_to, undefined);
});

test("an opening cannot be carried past its facet", () => {
	for (const terminal of ["glass", "door", "arch"]) {
		assert.throws(
			() => grammar({ Facade: [{ terminal, rise_to: "building_top" }] }),
			FacadeGrammarError,
			`${terminal} above the mass would be a hole in nothing`,
		);
	}
	assert.throws(() => grammar({ Facade: [{ terminal: "band", rise_to: "the_moon" }] }), FacadeGrammarError);
});

// The sideways twin of rise_to. The fold clearance pre-insets a punched scope, so a course
// written across the full width still paused 0.3 m short of every fold and a cornice
// crossing six facets read as six lintels - the gap its first author named on first use.
test("a solid course with reach runs through the fold clearance to the facet edge", () => {
	const [course] = deriveFacadePrimitives({
		grammar: grammar({ Facade: [{ terminal: "cornice", depth_m: 0.2, reach: "facet_edge" }] }),
		segment: SEGMENT, storeys: STOREYS,
	}) as any[];
	// The carried edge is clamped to the segment the way skin members always were: the
	// rounded value when rounding stays inside the facet, the exact length when it does not.
	const facetEdge = Math.min(SEGMENT.length_m, Number(SEGMENT.length_m.toFixed(8)));
	assert.equal(course.local_bounds.u_min, 0, "flush at the left scope edge, so carried to the facet edge");
	assert.equal(course.local_bounds.u_max, facetEdge, "and to the right one");

	// Without the field the same course keeps the inset scope - nothing already written moves.
	const [held] = deriveFacadePrimitives({
		grammar: grammar({ Facade: [{ terminal: "cornice", depth_m: 0.2 }] }),
		segment: SEGMENT, storeys: STOREYS,
	}) as any[];
	assert.equal(held.local_bounds.u_min, 0.3);
	assert.equal(held.local_bounds.u_max, Number(SEGMENT.placeable.u_max.toFixed(8)));
});

test("reach carries only the side that stands flush with its scope", () => {
	// A 0.5 m pier holds the course off the left edge; only the right side is flush, so only
	// the right side is carried. A member the grammar deliberately held back stays put.
	const out = deriveFacadePrimitives({
		grammar: grammar({
			Facade: [{ split: { axis: "u", parts: [{ size: "0.5", symbol: "Pier" }, { size: "~1", symbol: "Course" }] } }],
			Pier: [{ terminal: "pilaster", depth_m: 0.2 }],
			Course: [{ terminal: "band", depth_m: 0.1, reach: "facet_edge" }],
		}),
		segment: SEGMENT, storeys: STOREYS,
	}) as any[];
	const course = out.find((primitive) => primitive.kind === "band");
	assert.equal(course.local_bounds.u_min, 0.8, "held back by the pier, not carried left");
	assert.equal(course.local_bounds.u_max, Math.min(SEGMENT.length_m, Number(SEGMENT.length_m.toFixed(8))), "carried right");
});

// The field-sampled attribute of the parametric literature, in its smallest form: a value
// interpolated along the run a split laid out, bounded exactly like the plain field.
test("a graded depth deepens along the run", () => {
	const out = deriveFacadePrimitives({
		grammar: grammar({
			Facade: [{ split: { axis: "u", parts: [{ size: "~0.3212", symbol: "Fin", repeat: true }] } }],
			Fin: [{ terminal: "pilaster", depth_m: 0.1, grade: { attr: "depth_m", from: 0.1, to: 0.5 } }],
		}),
		segment: SEGMENT, storeys: STOREYS,
	}) as any[];
	assert.equal(out.length, 5, "five fins tile the 1.606 m placeable run");
	assert.deepEqual(out.map((p) => p.depth_m), [0.1, 0.2, 0.3, 0.4, 0.5], "from at the first, to at the last, linear between");
});

test("a graded inset resizes instances and a lone member reads from", () => {
	const out = deriveFacadePrimitives({
		grammar: grammar({
			Facade: [{ split: { axis: "z", parts: [{ size: "~3.3", symbol: "Level", repeat: true }] } }],
			Level: [{ terminal: "band", depth_m: 0.1, grade: { attr: "inset_m", from: 0, to: 0.4 } }],
		}),
		segment: { ...SEGMENT, local_z: [0, 9.9] }, storeys: STOREYS,
	}) as any[];
	assert.equal(out.length, 3);
	const heights = out.map((p) => Number((p.local_bounds.z_max - p.local_bounds.z_min).toFixed(4)));
	assert.deepEqual(heights, [3.3, 2.9, 2.5], "inset 0 / 0.2 / 0.4 tightens each instance");

	const [lone] = deriveFacadePrimitives({
		grammar: grammar({ Facade: [{ terminal: "band", depth_m: 0.1, grade: { attr: "depth_m", from: 0.15, to: 0.5 } }] }),
		segment: SEGMENT, storeys: STOREYS,
	}) as any[];
	assert.equal(lone.depth_m, 0.15, "one member alone is the start of its own run");
});

test("a grade is bounded and belongs to a terminal", () => {
	// A transom may stand 0.25 m out of the wall; a grade cannot buy it more.
	assert.throws(() => grammar({ Facade: [{ terminal: "transom", depth_m: 0.1, grade: { attr: "depth_m", from: 0.1, to: 0.5 } }] }), FacadeGrammarError);
	assert.throws(() => grammar({ Facade: [{ terminal: "band", depth_m: 0.1, grade: { attr: "width_m", from: 0.1, to: 0.2 } }] }), FacadeGrammarError);
	assert.throws(
		() => grammar({
			Facade: [{ grade: { attr: "depth_m", from: 0.1, to: 0.2 }, split: { axis: "u", parts: [{ size: "~1", symbol: "Wall" }] } }],
			Wall: WALL,
		}),
		FacadeGrammarError,
	);
});

test("reach refuses openings and unknown edges", () => {
	for (const terminal of ["glass", "door", "arch"]) {
		assert.throws(
			() => grammar({ Facade: [{ terminal, reach: "facet_edge" }] }),
			FacadeGrammarError,
			`carrying a ${terminal} into the fold is what the clearance exists to prevent`,
		);
	}
	assert.throws(() => grammar({ Facade: [{ terminal: "band", reach: "next_facet" }] }), FacadeGrammarError);
	// wall emits no geometry, and a split has nothing to carry: both would be requests the
	// engine silently ignores, which is the silent-wrong-answer class this grammar keeps
	// paying for - so both are refused loudly at parse instead.
	assert.throws(() => grammar({ Facade: [{ terminal: "wall", reach: "facet_edge" }] }), FacadeGrammarError);
	assert.throws(
		() => grammar({
			Facade: [{ reach: "facet_edge", split: { axis: "u", parts: [{ size: "~1", symbol: "Wall" }] } }],
			Wall: WALL,
		}),
		FacadeGrammarError,
	);
});

// Every member measures from the edges of its own scope, and on a stepped mass one of those
// edges is the step rather than a slab. `band` is how a rule tells the two apart.
test("a storey band knows whether the mass gave it whole or the facet ended inside it", () => {
	const parsed = grammar({
		Facade: [{ split: { axis: "storey", parts: [{ size: "~1", symbol: "Level" }] } }],
		Level: [
			// A slice under a step is not a storey; drawing in it draws a shelf.
			{ when: "band == cut", terminal: "wall" },
			{ terminal: "glass", inset_m: 0.04 },
		],
		Wall: WALL,
	});

	// A facet running slab to slab across two whole floors: both bands are full.
	const whole = { ...SEGMENT, local_z: [0, 6.6], placeable: { u_min: 0, u_max: 2 }, length_m: 2 };
	assert.equal(deriveFacadePrimitives({ grammar: parsed, segment: whole, storeys: STOREY_LINES }).length, 2);

	// A facet ending 0.6 m into its top floor: the lower band is whole and draws, the slice
	// above it is cut and stays bare.
	const stepped = { ...whole, local_z: [0, 3.9] };
	const out = deriveFacadePrimitives({ grammar: parsed, segment: stepped, storeys: STOREY_LINES }) as any[];
	assert.equal(out.length, 1, "only the full band draws");
	assert.equal(out[0].local_bounds.z_max <= 3.3 + 1e-9, true, "and it is the one below the step");

	// A facet that starts partway up is cut at its bottom, and that counts too.
	const raised = { ...whole, local_z: [1.2, 3.3] };
	assert.equal(deriveFacadePrimitives({ grammar: parsed, segment: raised, storeys: STOREY_LINES }).length, 0);
});

test("band is unreadable outside a storey split, so a rule cannot fire on a whole facet by accident", () => {
	const parsed = grammar({
		Facade: [{ when: "band == full", terminal: "glass", inset_m: 0.04 }, { terminal: "wall" }],
	});
	const whole = { ...SEGMENT, local_z: [0, 3.3], placeable: { u_min: 0, u_max: 2 }, length_m: 2 };
	assert.equal(deriveFacadePrimitives({ grammar: parsed, segment: whole, storeys: STOREY_LINES }).length, 0);
});

// The parapet's mirror. A lifted mass steps at its base far more than at its head, and a
// level bottom edge is what makes it read as a beam rather than a stack of shelves.
const SOFFIT = { Facade: [{ terminal: "band", depth_m: 0.2, rise_to: "building_underside" }] };
const drop = (top: number, bottom: number, underside: number | null) => deriveFacadePrimitives({
	grammar: grammar(SOFFIT),
	segment: { ...SEGMENT, length_m: 4, local_z: [bottom, top], placeable: { u_min: 0, u_max: 4 } },
	storeys: STOREY_LINES,
	buildingUnderside: underside,
}) as any[];

test("a solid carried to the underside stands below its own facet", () => {
	// The facet starts at 4.48 and the building flies at 1.86, one storey below, so it reaches.
	const [member] = drop(9.9, 4.48, 1.86);
	assert.equal(member.local_bounds.z_min, 1.86);
	assert.equal(member.rises_to, "building_underside");

	// A facet already on the line has nothing to drop to.
	const [onLine] = drop(9.9, 1.86, 1.86);
	assert.equal(onLine.local_bounds.z_min, 1.86);
	assert.equal(onLine.rises_to, undefined);
});

test("the drop stops at one storey, and does not exist on a mass that sits on the ground", () => {
	// 7.28 down to 1.86 is 5.4 m - two storeys of blind wall hung under the building.
	const [tooFar] = drop(9.9, 7.28, 1.86);
	assert.equal(tooFar.local_bounds.z_min, 7.28);
	assert.equal(tooFar.rises_to, undefined);

	// No facet above grade means no underside, which is what stops this filling in beneath a
	// bridge: the datum is absent rather than equal to the ground.
	const [grounded] = drop(9.9, 4.48, null);
	assert.equal(grounded.local_bounds.z_min, 4.48);
	assert.equal(grounded.rises_to, undefined);
});

test("an opening cannot be carried below its facet either", () => {
	for (const terminal of ["glass", "door", "arch"]) {
		assert.throws(() => grammar({ Facade: [{ terminal, rise_to: "building_underside" }] }), FacadeGrammarError);
	}
});

// The axis that does not divide: every part of a layer split receives the whole scope,
// stacked in depth - the operator that lets a composition (screen over glazing, slab plus
// rail) be said without an engineer plumbing a new terminal for it.
test("a layer split hands every part the whole scope, tagged", () => {
	const out = deriveFacadePrimitives({
		grammar: grammar({
			Facade: [{ split: { axis: "layer", parts: [{ size: "~1", symbol: "Glazing" }, { size: "~1", symbol: "Screen" }] } }],
			Glazing: [{ terminal: "glass", inset_m: 0.04 }],
			Screen: [{ split: { axis: "u", parts: [{ size: "~0.3", symbol: "Fin", repeat: true }] } }],
			Fin: [{ terminal: "louvre", depth_m: 0.3 }],
		}),
		segment: SEGMENT, storeys: STOREYS,
	}) as any[];
	const glass = out.filter((p) => p.kind === "window");
	const fins = out.filter((p) => p.kind === "louvre");
	assert.equal(glass.length, 1);
	assert.ok(fins.length >= 4, "the screen tiles the same width the glass occupies");
	// Both layers span the same placeable field - the glass was not narrowed by the screen.
	assert.ok(Math.abs(glass[0].local_bounds.u_min - 0.34) < 1e-6, "glass inset from the shared scope, not from a half");
	assert.equal(glass[0].layer, 1);
	assert.ok(fins.every((p) => p.layer === 2), "each layer part carries its own tag");

	// A grammar with no layer split emits primitives with NO layer field at all, so every
	// retained resolution digest stays byte-identical.
	const [plain] = deriveFacadePrimitives({
		grammar: grammar({ Facade: [{ terminal: "band", depth_m: 0.1 }] }),
		segment: SEGMENT, storeys: STOREYS,
	}) as any[];
	assert.equal("layer" in plain, false);
});

test("a layer split refuses sized or repeated layers", () => {
	assert.throws(() => grammar({
		Facade: [{ split: { axis: "layer", parts: [{ size: "1.0", symbol: "Wall" }] } }], Wall: WALL,
	}), FacadeGrammarError, "an absolute size on a layer is a number the engine ignores");
	assert.throws(() => grammar({
		Facade: [{ split: { axis: "layer", parts: [{ size: "~1", symbol: "Wall", repeat: true }] } }], Wall: WALL,
	}), FacadeGrammarError);
});

// A grade at the start rule runs across the FACE, which is the one place a rule sees more
// than its own facet. It read position 0 everywhere until the segment carried the length of
// the run: an author asked for a pier swell along a street and got a flat one, silently.
test("a grade at the start rule interpolates across the face's facets", () => {
	const parsed = grammar({ Facade: [{ terminal: "pilaster", depth_m: 0.2, grade: { attr: "depth_m", from: 0.2, to: 0.6 } }] });
	const depths = [0, 1, 2, 3, 4].map((face_index) => {
		const [member] = deriveFacadePrimitives({
			grammar: parsed,
			segment: { ...SEGMENT, face_index, face_total: 5 },
			storeys: STOREYS,
		}) as any[];
		return member.depth_m;
	});
	assert.deepEqual(depths, [0.2, 0.3, 0.4, 0.5, 0.6], "first facet reads from, last reads to");

	// A face of one facet has no run to travel, and a segment that never learned its face
	// total behaves as it always did: the start of its own grade.
	const [alone] = deriveFacadePrimitives({
		grammar: parsed, segment: { ...SEGMENT, face_index: 0, face_total: 1 }, storeys: STOREYS,
	}) as any[];
	assert.equal(alone.depth_m, 0.2);
	const [untotalled] = deriveFacadePrimitives({ grammar: parsed, segment: SEGMENT, storeys: STOREYS }) as any[];
	assert.equal(untotalled.depth_m, 0.2);
});

// The material list was four words an author could only choose among, and one copying a
// bronze rainscreen wrote `brick` to borrow its hue - "a lie on a construction document",
// in its own words. A grammar declares its materials now, in an architect's terms, and the
// engine derives every number from them.
test("a grammar declares its own materials and the engine derives their numbers", () => {
	const parsed = grammar({ Fin: [{ terminal: "pilaster", depth_m: 0.3, material: "oxide-metal-panel" }] }, "Fin", {
		materials: [
			{ id: "oxide-metal-panel", substance: "metal", lightness: "mid-dark", hue: "warm", finish: "satin", joint_m: 1.1 },
			{ id: "pale-cast-blade", substance: "cast", lightness: "pale", hue: "cool-neutral", finish: "matte", joint_m: null },
		],
	});
	const [metal, cast] = parsed.materials as any[];
	assert.equal(metal.id, "oxide-metal-panel");
	assert.equal(metal.role, "bronze", "substance carries the gate role and nothing else in the declaration moves it");
	assert.equal(metal.metalness > 0.5 && cast.metalness === 0, true);
	assert.equal(metal.roughness < cast.roughness, true, "satin takes light differently from matte");
	assert.match(metal.elevation_fill, /^#[0-9a-f]{6}$/);
	assert.deepEqual(metal.joint, { pitch_m: 1.1 });
	assert.equal(cast.joint, null, "a monolithic material draws no module");
	// Value, not hue, is what a greyscale print keeps: a pale material must read lighter.
	const luminance = (fill: string) => [1, 3, 5].reduce((sum, i) => sum + parseInt(fill.slice(i, i + 2), 16), 0);
	assert.equal(luminance(cast.elevation_fill) > luminance(metal.elevation_fill), true);

	// A grammar that declares nothing is the object it always was.
	assert.equal("materials" in grammar({ Fin: [{ terminal: "wall" }] }, "Fin"), false);
});

test("a declared material is refused unless its axes are the ones a specification has", () => {
	const withMaterials = (materials: unknown) => grammar({ Fin: [{ terminal: "wall" }] }, "Fin", { materials });
	assert.throws(() => withMaterials([{ id: "x", substance: "unobtanium", lightness: "mid", hue: "warm", finish: "matte" }]), FacadeGrammarError);
	assert.throws(() => withMaterials([{ id: "x", substance: "metal", lightness: "glowing", hue: "warm", finish: "matte" }]), FacadeGrammarError);
	assert.throws(() => withMaterials([{ id: "Oxide Panel", substance: "metal", lightness: "mid", hue: "warm", finish: "matte" }]), FacadeGrammarError);
	// A member may not name a material the grammar never declared.
	assert.throws(() => grammar({ Fin: [{ terminal: "pilaster", depth_m: 0.2, material: "invented-here" }] }, "Fin"), FacadeGrammarError);
});

// The schema and the parser drift apart, repeatedly and silently: `band` was once absent
// from the prose list while the schema admitted it, and the alternative's `required` list
// lost five of its ten keys for two days. This is the same failure on `material`. The
// description was updated to tell an author to name a declared id and the enum beside it
// was not, so the schema forbade the one thing it asked for - and because a declared id is
// the author's own word, no enum can ever hold it. Under strict structured output that made
// a declared material unreachable for a live provider call; nothing caught it because no
// live call ran, and a blind author found it by reading the schema.
test("the schema lets a terminal name a declared material, not just the legacy four", () => {
	const material = FACADE_GRAMMAR_V3_SCHEMA.$defs.alternative.properties.material as Record<string, unknown>;
	assert.equal(material.enum, undefined, "an enum cannot hold a name the author invents");
	assert.equal(material.pattern, DECLARED_MATERIAL_ID_PATTERN, "the schema must state the rule the parser applies, not a copy of it");
	assert.deepEqual(material.type, ["string", "null"]);

	// The one pattern has to admit both, because both are legal in that field.
	const admits = new RegExp(material.pattern as string);
	for (const id of ["ink-panel", "warm-vision-glass", "blackened-bronze"]) {
		assert.ok(admits.test(id), `a declared id must satisfy the schema: ${id}`);
	}
	for (const legacy of TERMINAL_MATERIAL_CHOICES) {
		assert.ok(admits.test(legacy), `a legacy word must still satisfy the schema: ${legacy}`);
	}
});

// The diagonal parsed, the deriver carried it, and the geometry builder had the code to draw
// it - and 312 spandrels still came out as boxes, because the detail builder's property list
// is a WHITELIST and nothing named the new field. No error, no warning, every gate green,
// 799 primitives accepted, and the drawing simply had no triangles in it. That is the silent
// wrong answer this repository keeps paying for, so the contract is pinned here.
test("a terminal may be cut on a diagonal, and only a terminal", () => {
	const parsed = grammar({ Facet: [{ terminal: "spandrel", depth_m: 0.1, diagonal: "rising" }] }, "Facet");
	assert.equal(parsed.rules.Facet[0].diagonal, "rising");

	// Absent stays absent, so every grammar written before this field draws exactly the box
	// it always drew.
	const plain = grammar({ Facet: [{ terminal: "spandrel", depth_m: 0.1 }] }, "Facet");
	assert.equal(plain.rules.Facet[0].diagonal, null);

	// A diagonal on a split would be a request the engine silently ignores - the same class
	// of fault as the drop that prompted this test.
	assert.throws(() => grammar({
		Facet: [{ diagonal: "rising", split: { axis: "u", parts: [{ size: "~1", symbol: "Wall" }] } }],
		Wall: WALL,
	}, "Facet"), /diagonal belongs to a terminal/);

	// `wall` emits nothing, so there is nothing to cut.
	assert.throws(() => grammar({ Facet: [{ terminal: "wall", diagonal: "falling" }] }, "Facet"), /cuts nothing/);

	// An arch already draws its own curve inside its rectangle; cutting that frame in half
	// would leave a half-arch, which is not a thing anyone builds.
	assert.throws(() => grammar({ Facet: [{ terminal: "arch", depth_m: 0.2, diagonal: "rising" }] }, "Facet"), /cannot cut an arch/);

	assert.throws(() => grammar({ Facet: [{ terminal: "spandrel", depth_m: 0.1, diagonal: "sideways" }] }, "Facet"), /must be one of/);
});

// The brief claimed for a day that `rising` and `falling` tile a scope between them. They do
// not: both keep the bottom edge whole, so they overlap over the lower-middle triangle and
// leave the upper-middle bare. Their AREAS sum to the rectangle, which is exactly what hid
// it - an author followed the sentence, drew bowties with a gap at the top of every cell,
// and read the geometry to find out why. A pair tiles when it shares only the cut, so that
// is what this asserts rather than an area sum.
test("a diagonal and its complement tile the scope; the two lower halves do not", () => {
	const corner = (name: string) => ({
		rising: [[0, 0], [1, 0], [1, 1]],
		rising_upper: [[0, 0], [1, 1], [0, 1]],
		falling: [[0, 0], [1, 0], [0, 1]],
		falling_upper: [[1, 0], [1, 1], [0, 1]],
	} as Record<string, number[][]>)[name];
	const area = (t: number[][]) =>
		Math.abs((t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[2][0] - t[0][0]) * (t[1][1] - t[0][1])) / 2;
	// Shared points: a tiling pair meets on the cut, which is exactly two corners.
	const shared = (a: number[][], b: number[][]) =>
		a.filter((p) => b.some((q) => q[0] === p[0] && q[1] === p[1])).length;

	for (const [low, high] of [["rising", "rising_upper"], ["falling", "falling_upper"]]) {
		assert.equal(area(corner(low)) + area(corner(high)), 1, `${low}+${high} must cover the scope`);
		assert.equal(shared(corner(low), corner(high)), 2, `${low}+${high} must meet only on the cut`);
	}
	// The pair that does not tile: areas still sum to 1, and that is the trap.
	assert.equal(area(corner("rising")) + area(corner("falling")), 1);
	assert.equal(shared(corner("rising"), corner("falling")), 2 + 0, "rising and falling share the whole bottom edge");
	// Both contain the bottom-right corner, which no tiling pair does on top of sharing a cut.
	assert.ok(corner("rising").some((p) => p[0] === 1 && p[1] === 0));
	assert.ok(corner("falling").some((p) => p[0] === 1 && p[1] === 0));

	// And every one of the four is reachable from the grammar.
	for (const value of ["rising", "rising_upper", "falling", "falling_upper"]) {
		const parsed = grammar({ Facet: [{ terminal: "spandrel", depth_m: 0.1, diagonal: value }] }, "Facet");
		assert.equal(parsed.rules.Facet[0].diagonal, value);
	}
});
