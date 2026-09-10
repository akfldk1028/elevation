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

test("the schema admits every predicate the engine accepts", () => {
	// Two transcribers hit this independently and both reported the brief and the schema
	// contradicting each other: the brief teaches range comparisons and `face_offset` in a
	// worked example, the contract accepts them, and the schema's `when` pattern refused them -
	// so a provider held to the schema could not emit a documented feature. The second author
	// tested it and wrote down which ones failed. These are those.
	const pattern = new RegExp((FACADE_GRAMMAR_V3_SCHEMA as any).$defs.alternative.properties.when.pattern);
	for (const when of ["storey >= 5", "face_offset < 7", "index > 2", "index <= 3", "storey == 5",
		"face_view == front && face_offset < 7", "face_offset < 7.5", "index % 2 == 0"]) {
		assert.ok(pattern.test(when), `schema must admit ${when}`);
		// And what the schema admits, the contract has to parse - the two travel together.
		assert.doesNotThrow(() => parseFacadeGrammar({
			schema_version: "arr.elevation3d.facade-grammar.v3", concept_id: "predicate-probe", start: "F",
			design_rationale: ["probe"],
			rules: [{ name: "F", alternatives: [
				{ when, split: null, terminal: "band", inset_m: 0, depth_m: 0.1 },
				{ when: null, split: null, terminal: "wall", inset_m: 0, depth_m: 0 },
			] }],
		} as any), when);
	}
	assert.ok(!pattern.test("nonsense == 3"));
});

test("a screen is not refused for being a screen: the level-step gate asks only of punched faces", async () => {
	// A field makes a CONTINUUM of similar sizes. SCALE_STEP_BROKEN wanted distinct size levels
	// with a hierarchy between them, measured over EVERY face - so one entrance door against a
	// field of near-identical panes is a ten-fold jump by construction, and a facade whose whole
	// idea is one unit repeated could never pass. Found by a field-driven grammar clearing every
	// design gate at 416 primitives and then failing here at 10.1x that four insets and a
	// smaller entrance could not move.
	//
	// Its sibling SCALE_HIERARCHY_FLAT already carves out exactly this case in exactly these
	// words - "a skin's vision panes are identical because that is what a unitised system is" -
	// and asks only of the punched faces. This one had no exemption.
	const source = await (await import("node:fs/promises"))
		.readFile("plugins/elevation-3d/lib/facade-agent/design/composition.mjs", "utf8");
	// Both gates read the punched set, and both stand down when there is no punched face.
	assert.match(source, /const punchedLevels = levelsOfScale\(punchedOpeningAreas\)/);
	assert.match(source, /punchedOpeningAreas\.length > 1 && punchedLevels\.largestStep/);
	assert.match(source, /punchedOpeningAreas\.length > 1 && punchedScaleRatio/);
	// And the reported measurement still covers every opening, because it is worth having.
	assert.match(source, /const levels = levelsOfScale\(openingAreas\)/);
});

test("two constructions mix by position, which is how a facade changes kind across an elevation", () => {
	// A field varies a NUMBER, so it can open an aperture but never turn a punched wall into a
	// screen along the way - and that was the gap the parametric tests kept hitting. The
	// photograph that started them runs from near-black closed panel at one end to open glazed
	// bay at the other, which is a change of CONSTRUCTION.
	//
	// The survey of built halftone facades names the mechanism outright and it is not morphing:
	// every one of them keeps two discrete conditions and varies which appears. The District
	// School in Bergedorf does its whole gradient on four discrete shades; the Escinter store
	// simply stops perforating. So an alternative may carry a `mix` instead of a `when`.
	const grammar = parseFacadeGrammar({
		schema_version: "arr.elevation3d.facade-grammar.v3", concept_id: "dither", start: "F",
		fields: [{ id: "open", at: [0, 0, 0] }], design_rationale: ["probe"],
		rules: [
			{ name: "F", alternatives: [{ when: null, split: { axis: "u", parts: [{ size: "~1.0", symbol: "C", repeat: true }] }, terminal: null }] },
			{ name: "C", alternatives: [
				{ mix: { field: "open", range_m: [0, 20] }, split: null, terminal: "spandrel", inset_m: 0, depth_m: 0.08 },
				{ when: null, split: null, terminal: "glass", inset_m: 0.05, depth_m: -0.04 },
			] },
		],
	} as any);
	const solidsAt = (alongM: number) => {
		const derived = deriveFacadePrimitives({
			grammar,
			segment: { segment_id: `s${alongM}`, length_m: 10, local_z: [0, 3.3], face_offset_m: 0, origin_m: [alongM, 0, 0], outward_normal: [0, -1, 0], face_view: "front", face_index: 0, face_total: 1 },
			storeys: [{ storey: 1, z_min: 0, z_max: 3.3 }],
		});
		return derived.filter((primitive: any) => primitive.kind === "spandrel").length;
	};

	// Near the place: mostly the else branch. Far from it: all of the mixed one. In between: both.
	const near = solidsAt(0), middle = solidsAt(8), far = solidsAt(16);
	assert.ok(near < middle, `${near} then ${middle}`);
	assert.ok(middle < far, `${middle} then ${far}`);
	assert.equal(far, 10, "past the range every member takes it");
	assert.ok(middle > 0 && middle < 10, "and in between it is a mix, not a switch");
	// Ordered, not random: the same grammar draws the same building every time.
	assert.equal(solidsAt(8), middle);
});

test("a mix needs a field and a range, and does not share an alternative with a predicate", () => {
	const program = (alternative: Record<string, unknown>) => ({
		schema_version: "arr.elevation3d.facade-grammar.v3", concept_id: "dither", start: "F",
		fields: [{ id: "open", at: [0, 0, 0] }], design_rationale: ["probe"],
		rules: [{ name: "F", alternatives: [
			{ split: null, terminal: "spandrel", inset_m: 0, depth_m: 0.08, ...alternative },
			{ when: null, split: null, terminal: "wall", inset_m: 0, depth_m: 0 },
		] }],
	});
	// `when` answers yes or no; `mix` answers how many. Two answers to one question is a bug
	// the author would not see, because whichever lost would simply never fire.
	assert.throws(() => parseFacadeGrammar(program({ when: "storey == 1", mix: { field: "open", range_m: [0, 20] } }) as any), /use one/);
	assert.throws(() => parseFacadeGrammar(program({ mix: { field: "nowhere", range_m: [0, 20] } }) as any), /no declared field/);
	assert.throws(() => parseFacadeGrammar(program({ mix: { field: "open" } }) as any), /field and range_m|both field and range_m/);
	assert.doesNotThrow(() => parseFacadeGrammar(program({ mix: { field: "open", range_m: [0, 20] } }) as any));
});
