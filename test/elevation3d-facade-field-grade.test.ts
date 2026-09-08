import assert from "node:assert/strict";
import test from "node:test";

import { FACADE_GRAMMAR_V3_SCHEMA } from "../plugins/elevation-3d/lib/facade-agent/design/grammar/prompt.mjs";
import { parseFacadeGrammar } from "../plugins/elevation-3d/lib/facade-agent/design/grammar/contract.mjs";
import { deriveFacadePrimitives } from "../plugins/elevation-3d/lib/facade-agent/design/grammar/derive.mjs";

/**
 * The parametric operator: a parameter that varies with WHERE a member sits.
 *
 * Every parametric facade in the literature is one unit repeated with one parameter driven by
 * position - Al Bahar's 1,049 mashrabiyas by solar incidence, the attractor screens by
 * distance to a point. `grade` could only ramp along a run, which is the scalar case, and two
 * authors asked for this and got zones of linear ramps instead.
 */
const program = (grade: Record<string, unknown>, fields: unknown = [{ id: "sun", at: [0, 0, 0] }]) => ({
	schema_version: "arr.elevation3d.facade-grammar.v3",
	concept_id: "field-probe",
	start: "Facet",
	fields,
	design_rationale: ["probe"],
	rules: [
		{ name: "Facet", alternatives: [{ when: null, split: { axis: "u", parts: [{ size: "~1.0", symbol: "Cell", repeat: true }] }, terminal: null }] },
		{ name: "Cell", alternatives: [{ when: null, split: null, terminal: "louvre", inset_m: 0, depth_m: 0.1, grade }] },
	],
});

const storeys = [{ storey: 1, z_min: 0, z_max: 3.3 }];
// A facet standing `alongM` metres along the x axis, facing -y, so its members run from
// (alongM, 0) outward. The attractor sits at the origin at ground level.
const segment = (alongM: number, lengthM = 10) => ({
	segment_id: `s-${alongM}`, length_m: lengthM, local_z: [0, 3.3],
	face_offset_m: 0, origin_m: [alongM, 0, 0], outward_normal: [0, -1, 0],
	face_view: "front", face_index: 0, face_total: 1,
});
const depths = (faceOffsetM: number, grade: Record<string, unknown>, lengthM?: number) =>
	deriveFacadePrimitives({ grammar: parseFacadeGrammar(program(grade)), segment: segment(faceOffsetM, lengthM), storeys })
		.map((primitive: any) => primitive.depth_m);

const toTheSun = { attr: "depth_m", from: 0, to: 0.4, field: "sun", range_m: [0, 20] };

test("a field drives a terminal's depth by distance, not by position along the run", () => {
	const run = depths(0, toTheSun);
	assert.equal(run.length, 10);
	// Monotonic away from an attractor at the left end at ground level.
	for (let index = 1; index < run.length; index++) assert.ok(run[index] > run[index - 1], `${run[index - 1]} -> ${run[index]}`);
	// And it is a real 2D distance: the first tile's centre is 0.5 m along and 1.65 m up, so
	// 1.72 m from the point, which over a 0..20 m range is 0.086 of the way from 0 to 0.4 m.
	assert.ok(Math.abs(run[0] - 0.034) < 0.002, `${run[0]}`);
});

test("a field spans the building: the same rule reads a far facet differently", () => {
	// The distinction the operator exists for, and the reason `at` is a place in SPACE rather
	// than a position on a sheet. The first author to use it proved the sheet coordinate wrong
	// from the outside: `face_offset_m` restarts at 0 on every FACE, so one declared place made
	// four identical ramps on a four-faced mass, and two corners of a star plan demand
	// incompatible origins. A graded RUN restarts at every facet; a field does not.
	assert.deepEqual(depths(20, toTheSun, 3), [0.4, 0.4, 0.4]);
	assert.ok(depths(0, toTheSun, 3).every((depth: number) => depth < 0.1));
});

test("the range is clamped at both ends, so a field never extrapolates past its endpoints", () => {
	const tight = { attr: "depth_m", from: 0.1, to: 0.3, field: "sun", range_m: [2, 4] };
	for (const depth of depths(0, tight)) assert.ok(depth >= 0.1 - 1e-9 && depth <= 0.3 + 1e-9, `${depth}`);
	assert.equal(depths(40, tight, 2).every((depth: number) => depth === 0.3), true);
});

test("a field and its range come together, are declared, and stay inside their bounds", () => {
	const rejects = (grade: Record<string, unknown>, fields?: unknown) =>
		assert.throws(() => parseFacadeGrammar(program(grade, fields) as any), /FACADE_GRAMMAR_INVALID|field|range/i);
	// A field with no range would normalise over whatever scope it landed in - a per-facet
	// gradient wearing a field's name, which is the thing the operator exists to replace.
	rejects({ attr: "depth_m", from: 0, to: 0.4, field: "sun" });
	rejects({ attr: "depth_m", from: 0, to: 0.4, range_m: [0, 20] });
	rejects({ attr: "depth_m", from: 0, to: 0.4, field: "nowhere", range_m: [0, 20] });
	rejects({ ...toTheSun, range_m: [20, 4] }, [{ id: "sun", at: [0, 0, 0] }]);
	rejects({ ...toTheSun, range_m: [0, 400] }, [{ id: "sun", at: [0, 0, 0] }]);
	// Two places cannot share a name, and a place is two finite metres.
	rejects(toTheSun, [{ id: "sun", at: [0, 0, 0] }, { id: "sun", at: [4, 4, 4] }]);
	rejects(toTheSun, [{ id: "sun", at: [0, 0] }]);
});

test("a field is refused on a repeat's tile size rather than accepted and dropped", () => {
	// `layout` is handed a run length and no origin, so it cannot know where on the building a
	// tile lands. A field there would be a word the engine reads and discards, which is how a
	// grammar field has silently failed to travel before.
	const sized = {
		...program({ attr: "depth_m", from: 0, to: 0.4 }),
		rules: [
			{ name: "Facet", alternatives: [{ when: null, split: { axis: "u", parts: [{ size: "~1.0", symbol: "Cell", repeat: true, grade: { from: 0.5, to: 1.5, field: "sun", range_m: [0, 20] } }] }, terminal: null }] },
			{ name: "Cell", alternatives: [{ when: null, split: null, terminal: "louvre", inset_m: 0, depth_m: 0.1 }] },
		],
	};
	assert.throws(() => parseFacadeGrammar(sized as any), /cannot drive tile size/);
});

test("the brief and the schema both carry it, or no author can reach it", () => {
	// The fourth link. A field the deriver honours and the brief never mentions does not
	// exist: every operator this grammar has gained was found by an author reading for it.
	const grade = (FACADE_GRAMMAR_V3_SCHEMA as any).$defs.alternative.properties.grade;
	assert.deepEqual(Object.keys(grade.properties).sort(), ["attr", "field", "from", "range_m", "to"]);
	assert.ok(grade.required.includes("field") && grade.required.includes("range_m"));
	const fields = (FACADE_GRAMMAR_V3_SCHEMA as any).properties.fields;
	assert.deepEqual(Object.keys(fields.items.properties).sort(), ["at", "id"]);
	assert.match(fields.description, /distance/i);
	assert.ok((FACADE_GRAMMAR_V3_SCHEMA as any).required.includes("fields"));
});

test("a run directory's brief is checked against what the engine would write now", async () => {
	// `brief` writes a file per candidate and nothing regenerates it when the prompt changes.
	// A transcriber read one a day behind the engine: it told them a set-back opening "is not
	// yet a drawing move - do not spend a render on it", while the schema beside it described
	// the hole the engine had been cutting since the day before. They followed the brief, filed
	// the photograph's most visible feature as a missing capability, and reported that the two
	// documents could not both be current. Nothing had told them, so `check` and `draw` do.
	const { grammarBriefIsStale, writeGrammarBrief } = await import("../plugins/elevation-3d/lib/facade-agent/design/authoring-kit.mjs");
	const { createFacadeDesignFixture } = await import("./helpers/facade-design-fixture.ts");
	const { readFile } = await import("node:fs/promises");
	const fixture = await createFacadeDesignFixture({ after: () => {} } as any);
	const written = await writeGrammarBrief({ runDir: fixture.runDir, context: fixture.context });
	const onDisk = await readFile(written.paths.prompt, "utf8");

	assert.equal(grammarBriefIsStale({ context: fixture.context, onDisk }), false, "a brief just written is current");
	assert.equal(grammarBriefIsStale({ context: fixture.context, onDisk: `${onDisk}\nstale` }), true);
	// A missing or unreadable brief is not a staleness claim - the caller decides what to do
	// with an absent one, and a false positive here would cry wolf on every fresh run.
	assert.equal(grammarBriefIsStale({ context: fixture.context, onDisk: undefined as any }), false);
	assert.equal(grammarBriefIsStale({ onDisk } as any), false);
});

test("a place in space leaves the far side of a building alone", () => {
	// The fault the first outside author found and proved. Two facets with the SAME
	// `face_offset_m` on opposite sides of a building read identically under a sheet
	// coordinate - four open quadrants on a four-faced mass where the photograph has one open
	// side - and they showed it was not tuning: making the values agree at one corner of a
	// star plan and at the next demands two different origins, and that mass has eight corners.
	const grade = { attr: "depth_m", from: 0, to: 0.4, field: "sun", range_m: [10, 30] };
	const grammar = parseFacadeGrammar(program(grade, [{ id: "sun", at: [0, -20, 8] }]) as any);
	const facet = (originM: number[], normal: number[]) => ({
		segment_id: `s-${originM.join("_")}`, length_m: 3, local_z: [0, 3.3],
		face_offset_m: 0, origin_m: originM, outward_normal: normal,
		face_view: "front", face_index: 0, face_total: 1,
	});
	const depthsAt = (originM: number[], normal: number[]) =>
		deriveFacadePrimitives({ grammar, segment: facet(originM, normal), storeys }).map((p: any) => p.depth_m);

	const near = depthsAt([-1.5, -6, 0], [0, -1, 0]);
	const far = depthsAt([1.5, 6, 0], [0, 1, 0]);
	assert.equal(near.length, far.length);
	assert.ok(near.every((depth: number) => depth < 0.15), `near ${near}`);
	assert.ok(far.every((depth: number) => depth > 0.3), `far ${far}`);
	// A facet with no place of its own cannot be measured, and reads the near end rather than
	// inventing a distance - the field is inert, not wrong, on a context without origins.
	const placeless = { ...facet([0, 0, 0], [0, -1, 0]), origin_m: undefined, outward_normal: undefined };
	assert.ok(deriveFacadePrimitives({ grammar, segment: placeless, storeys }).every((p: any) => p.depth_m === 0));
});
