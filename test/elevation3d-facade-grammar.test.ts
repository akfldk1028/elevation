import assert from "node:assert/strict";
import test from "node:test";

import {
	FacadeGrammarError,
	parseFacadeGrammar,
	predicateHolds,
} from "../plugins/elevation-3d/lib/facade-agent/design/grammar/contract.mjs";
import { deriveFacadePrimitives } from "../plugins/elevation-3d/lib/facade-agent/design/grammar/derive.mjs";

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

test("stops a grammar that recurses without shrinking", () => {
	const parsed = grammar({
		Facade: [{ split: { axis: "u", parts: [{ size: "'1", symbol: "Facade" }] } }],
	});
	assert.throws(
		() => deriveFacadePrimitives({ grammar: parsed, segment: SEGMENT, storeys: STOREYS }),
		(error: unknown) => error instanceof FacadeGrammarError,
	);
});
