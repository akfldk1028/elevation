import assert from "node:assert/strict";
import test from "node:test";

import {
	FacadeGrammarError,
	parseFacadeGrammar,
	predicateHolds,
} from "../plugins/elevation-3d/lib/facade-agent/design/grammar/contract.mjs";
import { deriveFacadePrimitives } from "../plugins/elevation-3d/lib/facade-agent/design/grammar/derive.mjs";
import { openingZones } from "../plugins/elevation-3d/lib/facade-agent/design/grammar/prompt.mjs";

const STOREYS = [1, 2, 3, 4, 5].map((storey) => ({ storey, z_min: (storey - 1) * 3.3, z_max: storey * 3.3 }));
const SEGMENT = {
	segment_id: "facade-segment-test", face_view: "front", view: "front",
	length_m: 2.2060695766, local_z: [0, 16.5],
	placeable: { u_min: 0.3, u_max: 1.9060695766 },
};

function grammar(rules: Record<string, unknown>, start = "Facade") {
	return parseFacadeGrammar({
		schema_version: "arr.elevation3d.facade-grammar.v3",
		concept_id: "test-grammar", start, rules,
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
