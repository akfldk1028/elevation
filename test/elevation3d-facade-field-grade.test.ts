import assert from "node:assert/strict";
import test from "node:test";

import { FACADE_GRAMMAR_V3_SCHEMA } from "../plugins/elevation-3d/lib/facade-agent/design/grammar/prompt.mjs";
import { parseFacadeGrammar } from "../plugins/elevation-3d/lib/facade-agent/design/grammar/contract.mjs";
import { rotateOutline } from "../plugins/elevation-3d/lib/facade-agent/polygon-prism.mjs";
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
	// Five kinds now, each a formula, and every one of them reachable from the schema alone.
	assert.deepEqual(Object.keys(fields.items.properties).sort(),
		["at", "direction", "falloff", "id", "kind", "normal", "of", "op", "range_m", "to"]);
	assert.deepEqual(fields.items.properties.kind.enum, ["point", "line", "plane", "sun", "mix", null]);
	assert.deepEqual(fields.items.properties.op.enum, ["product", "min", "max", "mean", null]);
	assert.deepEqual(fields.items.required.sort(),
		["at", "direction", "falloff", "id", "kind", "normal", "of", "op", "range_m", "to"]);
	assert.match(fields.description, /distance/i);
	assert.match(fields.description, /Lambert/);
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

/**
 * A field must be able to drive every number a member has, not two of them.
 *
 * The practice this operator comes from feeds each panel a value from an attractor and the
 * panel answers by changing size, depth, ROTATION or which module it is. The grammar had the
 * first two; `mix` covers the last. This is the turn and the angle of the cut.
 */
test("a field drives rotation and the angle of the cut, under the literal's own rules", () => {
	const LENS = Array.from({ length: 8 }, (_, index) => {
		const angle = (Math.PI / 4) * index;
		return [0.5 + 0.44 * Math.cos(angle), 0.5 + 0.22 * Math.sin(angle)];
	});
	const program = (grade: unknown, extra: object = {}) => ({
		schema_version: "arr.elevation3d.facade-grammar.v3", concept_id: "field-attr-probe", start: "F",
		design_rationale: ["probe"],
		fields: [{ id: "corner", at: [0, 0, 0] }],
		rules: [{
			name: "F",
			alternatives: [{
				when: null, split: null, terminal: "glass", inset_m: 0.05, depth_m: -0.3,
				outline: LENS, grade, ...extra,
			}],
		}],
	});
	const field = { field: "corner", range_m: [0, 20] };
	for (const [attr, from, to] of [["rotate_deg", 0, 40], ["scoop_deg", -20, 20], ["inset_m", 0.05, 0.4]] as const) {
		const parsed = parseFacadeGrammar(program({ attr, from, to, ...field }) as any);
		assert.equal(parsed.rules.F[0].grade.attr, attr);
	}
	// A grade obeys the bound its written literal obeys, and the refusals too - otherwise the
	// operator is a way round every rule the number could not break.
	assert.throws(() => parseFacadeGrammar(program({ attr: "scoop_deg", from: 0, to: 80, ...field }) as any), /out of range/);
	assert.throws(() => parseFacadeGrammar(program({ attr: "standoff_m", from: 0, to: 0.4, ...field }) as any), /hole cannot float/);
	assert.throws(() => parseFacadeGrammar(program({ attr: "joint_m", from: 0, to: 1, ...field }) as any), /must be one of/);
	// scoop needs a recess to cut; rotate needs a shape to turn.
	assert.throws(() => parseFacadeGrammar({
		...program({ attr: "scoop_deg", from: 0, to: 20, ...field }),
		rules: [{ name: "F", alternatives: [{ when: null, split: null, terminal: "glass", inset_m: 0.05, depth_m: 0.1, outline: LENS, grade: { attr: "scoop_deg", from: 0, to: 20, ...field } }] }],
	} as any), /recess to cut/);
	assert.throws(() => parseFacadeGrammar({
		...program(null),
		rules: [{ name: "F", alternatives: [{ when: null, split: null, terminal: "glass", inset_m: 0.05, depth_m: -0.3, grade: { attr: "rotate_deg", from: 0, to: 40, ...field } }] }],
	} as any), /needs an outline/);

	const alternative = (FACADE_GRAMMAR_V3_SCHEMA as any).$defs.alternative;
	assert.deepEqual(alternative.properties.grade.properties.attr.enum,
		["depth_m", "inset_m", "standoff_m", "scoop_deg", "rotate_deg"]);
	assert.ok(alternative.properties.rotate_deg && alternative.required.includes("rotate_deg"));
});

test("a turn is a turn, not a shear, and it never leaves the box", () => {
	// 0.6 m square inside a 2 m x 1 m bay: 0.3 of the width, 0.6 of the height.
	const square = [[0.35, 0.2], [0.65, 0.2], [0.65, 0.8], [0.35, 0.8]];
	// In a bay twice as wide as it is tall, turning inside the 0..1 square would stretch the
	// shape by two; in metres it stays similar to itself.
	const turned = rotateOutline(square, 45, 2, 1);
	const metres = turned.map(([u, v]) => [(u - 0.5) * 2, (v - 0.5) * 1]);
	const side = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
	const lengths = metres.map((point, index) => side(point, metres[(index + 1) % metres.length]));
	for (const length of lengths) assert.ok(Math.abs(length - lengths[0]) < 1e-9, `sides equal: ${lengths}`);
	// And every point is still inside the member's own square.
	for (const [u, v] of turned) assert.ok(u >= -1e-9 && u <= 1 + 1e-9 && v >= -1e-9 && v <= 1 + 1e-9);
	// Turning by nothing changes nothing, to the reference.
	assert.equal(rotateOutline(square, 0, 2, 1), square);
});

/**
 * The five field formulas, each checked against the identity it is.
 *
 * A field was one shape - the distance to a place - and the parametric facades this project
 * is asked to transcribe use four more: a curve attractor, a horizon, solar incidence, and
 * two fields answering at once. Each is a formula the panelization practice writes down, so
 * each is asserted as that formula rather than as a number someone measured off a render.
 */
test("five fields, five formulas", () => {
	const segment = {
		segment_id: "s", length_m: 8, local_z: [0, 3.3], face_offset_m: 0,
		origin_m: [0, 0, 0], outward_normal: [0, -1, 0],
		face_view: "front", face_index: 0, face_total: 1,
	};
	const storeys = [{ storey: 1, z_min: 0, z_max: 3.3 }];
	// One member per bay, so each reads the field at its own place along the facet.
	const run = (fields: unknown, grade: object) => deriveFacadePrimitives({
		grammar: parseFacadeGrammar({
			schema_version: "arr.elevation3d.facade-grammar.v3", concept_id: "formula-probe", start: "F",
			design_rationale: ["probe"], fields,
			rules: [
				{ name: "F", alternatives: [{ when: null, split: { axis: "u", parts: [{ size: "~1.0", symbol: "C", arg: null, repeat: true, grade: null }] }, terminal: null }] },
				{ name: "C", alternatives: [{ when: null, split: null, terminal: "spandrel", inset_m: 0, depth_m: 0.1, grade }] },
			],
		} as any),
		segment, storeys,
	}).map((primitive: any) => primitive.depth_m);

	// The member centres run 0.5, 1.5 ... 7.5 along +x, at z = 1.65.
	const centre = (index: number) => [index + 0.5, 0, 1.65];
	const ramp = (t: number) => Number((0.05 + 0.25 * t).toFixed(6));

	// POINT: d = |p - a|, normalised over range.
	const point = run([{ id: "a", at: [0, 0, 1.65] }], { attr: "depth_m", from: 0.05, to: 0.3, field: "a", range_m: [0, 8] });
	for (const [index, value] of point.entries()) {
		const d = Math.hypot(...centre(index).map((v, axis) => v - [0, 0, 1.65][axis]));
		assert.ok(Math.abs(value - ramp(d / 8)) < 1e-6, `point ${index}: ${value}`);
	}

	// LINE: distance to a SEGMENT, so beyond either end it is the distance to that end. The
	// segment here runs x = 2..4 at the wall, and the members at x = 0.5 and 7.5 measure 1.5
	// and 3.5 - not the perpendicular distance an infinite line would give, which is 0.
	const line = run([{ id: "a", kind: "line", at: [2, 0, 1.65], to: [4, 0, 1.65] }],
		{ attr: "depth_m", from: 0.05, to: 0.3, field: "a", range_m: [0, 8] });
	assert.ok(Math.abs(line[0] - ramp(1.5 / 8)) < 1e-6, `line near end: ${line[0]}`);
	assert.ok(Math.abs(line[2] - ramp(0)) < 1e-6, "inside the segment it is zero");
	assert.ok(Math.abs(line[3] - ramp(0)) < 1e-6, "and along its whole length");
	assert.ok(Math.abs(line[7] - ramp(3.5 / 8)) < 1e-6, `line far end: ${line[7]}`);

	// PLANE: SIGNED, so everything behind it clamps to `from` and the field reads as a horizon.
	const plane = run([{ id: "a", kind: "plane", at: [4, 0, 0], normal: [1, 0, 0] }],
		{ attr: "depth_m", from: 0.05, to: 0.3, field: "a", range_m: [0, 4] });
	assert.equal(plane[0], ramp(0), "behind the plane, clamped");
	assert.equal(plane[3], ramp(0), "and right up to it");
	assert.ok(Math.abs(plane[6] - ramp(2.5 / 4)) < 1e-6, `in front: ${plane[6]}`);

	// SUN: Lambert. This facet's normal is [0,-1,0]; a source in -y is straight on, so
	// (1 - n.s)/2 = 0 everywhere on it, and a source in +y gives 1. No range_m at all.
	const facing = run([{ id: "a", kind: "sun", direction: [0, -1, 0] }], { attr: "depth_m", from: 0.05, to: 0.3, field: "a", range_m: null });
	const away = run([{ id: "a", kind: "sun", direction: [0, 1, 0] }], { attr: "depth_m", from: 0.05, to: 0.3, field: "a", range_m: null });
	assert.deepEqual(new Set(facing), new Set([ramp(0)]));
	assert.deepEqual(new Set(away), new Set([ramp(1)]));
	// A grazing source: n.s = cos(60) so the value is (1 - 0.5)/2 = 0.25 on every member.
	const grazing = run([{ id: "a", kind: "sun", direction: [Math.sin(Math.PI / 3), -Math.cos(Math.PI / 3), 0] }],
		{ attr: "depth_m", from: 0.05, to: 0.3, field: "a", range_m: null });
	assert.ok(Math.abs(grazing[0] - ramp(0.25)) < 1e-6, `grazing ${grazing[0]}`);

	// MIX: two normalised fields combined. product is an AND, max an OR.
	const both = (op: string) => run([
		{ id: "a", at: [0, 0, 1.65], range_m: [0, 8] },
		{ id: "b", kind: "sun", direction: [0, 1, 0] },
		{ id: "m", kind: "mix", of: ["a", "b"], op },
	], { attr: "depth_m", from: 0.05, to: 0.3, field: "m", range_m: null });
	// `b` answers 1 on this facet, so the product is `a` alone and the max is 1 everywhere.
	const alone = run([{ id: "a", at: [0, 0, 1.65] }], { attr: "depth_m", from: 0.05, to: 0.3, field: "a", range_m: [0, 8] });
	assert.deepEqual(both("product"), alone, "product with 1 is the other field itself");
	assert.deepEqual(new Set(both("max")), new Set([ramp(1)]));
	// And a distance field with no range of its own cannot go inside a mix at all.
	assert.throws(() => run([
		{ id: "a", at: [0, 0, 1.65] },
		{ id: "b", kind: "sun", direction: [0, 1, 0] },
		{ id: "m", kind: "mix", of: ["a", "b"], op: "product" },
	], { attr: "depth_m", from: 0.05, to: 0.3, field: "m", range_m: null }), /answers in metres/);

	// FALLOFF: the response curve, applied to the normalised value. Squared is the
	// inverse-square shape the attractor practice reaches for.
	const square = run([{ id: "a", at: [0, 0, 1.65], falloff: 2 }],
		{ attr: "depth_m", from: 0.05, to: 0.3, field: "a", range_m: [0, 8] });
	for (const [index, value] of square.entries()) {
		assert.ok(Math.abs(value - ramp(((index + 0.5) / 8) ** 2)) < 1e-6, `falloff ${index}: ${value}`);
	}

	// And the refusals: a dimensionless field with a range, a distance field without one, a
	// mix naming a field that is not declared above it.
	const bad = (fields: unknown, grade: object) => parseFacadeGrammar({
		schema_version: "arr.elevation3d.facade-grammar.v3", concept_id: "p", start: "F", design_rationale: ["p"], fields,
		rules: [{ name: "F", alternatives: [{ when: null, split: null, terminal: "spandrel", inset_m: 0, depth_m: 0.1, grade }] }],
	} as any);
	assert.throws(() => bad([{ id: "a", kind: "sun", direction: [0, 1, 0] }],
		{ attr: "depth_m", from: 0.05, to: 0.3, field: "a", range_m: [0, 8] }), /no metres to travel over/);
	assert.throws(() => bad([{ id: "a", at: [0, 0, 0] }],
		{ attr: "depth_m", from: 0.05, to: 0.3, field: "a", range_m: null }), /needs both field and range_m/);
	assert.throws(() => bad([{ id: "m", kind: "mix", of: ["a", "b"] }, { id: "a", at: [0, 0, 0], range_m: [0, 8] }],
		{ attr: "depth_m", from: 0.05, to: 0.3, field: "m", range_m: null }), /not declared above it/);
	assert.throws(() => bad([{ id: "a", kind: "sun", direction: [0, 0, 0] }],
		{ attr: "depth_m", from: 0.05, to: 0.3, field: "a", range_m: null }), /no direction/);
});
