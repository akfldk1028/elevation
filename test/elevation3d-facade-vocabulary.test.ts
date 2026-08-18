import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { checkAuthoredGrammar } from "../plugins/elevation-3d/lib/facade-agent/design/authoring-kit.mjs";
import { createFacadeDesignFixture } from "./helpers/facade-design-fixture.ts";

import {
	TERMINAL_KINDS,
	TERMINAL_MATERIALS,
	TERMINAL_PRIMITIVE_KINDS,
	TERMINAL_VOCABULARY,
	TERMINAL_WORDS,
} from "../plugins/elevation-3d/lib/facade-agent/facade-vocabulary.mjs";
import { TERMINALS } from "../plugins/elevation-3d/lib/facade-agent/design/grammar/contract.mjs";
import { PUNCHED_FACADE_MATERIALS } from "../plugins/elevation-3d/lib/facade-grammar.mjs";
import { KIND_ROLES } from "../plugins/elevation-3d/web/embedded-pbr-presentation.mjs";

const ROOT = new URL("../plugins/elevation-3d/lib/", import.meta.url);

test("the grammar terminal list is the vocabulary", () => {
	assert.deepEqual([...TERMINALS], [...TERMINAL_WORDS]);
});

test("every terminal that emits geometry has a material the renderer knows", () => {
	for (const kind of TERMINAL_PRIMITIVE_KINDS) {
		assert.ok(PUNCHED_FACADE_MATERIALS.includes(TERMINAL_MATERIALS[kind]), `${kind} has an unknown material`);
	}
});

test("wall is the only terminal that emits nothing", () => {
	const silent = TERMINAL_VOCABULARY.filter((terminal) => !terminal.kind).map((terminal) => terminal.word);
	assert.deepEqual(silent, ["wall"]);
	assert.equal(TERMINAL_KINDS.wall, undefined);
});

// The four lists that describe a terminal used to be maintained by hand, and they had
// drifted: lintel, sill and cornice reached the renderer and the validator while the
// grammar had no word for them. These two assertions are what makes that impossible.
test("the presentation validator accepts every kind the grammar can derive", async () => {
	const source = await readFile(new URL("elevation-presentation-validation.mjs", ROOT), "utf8");
	const declared = /const DESIGN_FACADE_KINDS = new Set\(\[([^\]]*)\]\)/.exec(source);
	assert.ok(declared, "DESIGN_FACADE_KINDS is no longer declared as a literal set");
	const accepted = new Set([...declared[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]));
	for (const kind of TERMINAL_PRIMITIVE_KINDS) {
		assert.ok(accepted.has(kind), `presentation validation rejects derived kind ${kind}`);
	}
});

test("the geometry builder keys its material table off the vocabulary", async () => {
	const source = await readFile(new URL("facade-agent/punched-facade.mjs", ROOT), "utf8");
	assert.match(source, /const TYPED_MATERIAL = TERMINAL_MATERIALS;/);
});

// The fifth list. A kind with no entry in KIND_ROLES does not throw and does not warn -
// it falls through to the `concrete` fallback and is painted as the mass - which is how
// brick-cladding and the five typed kinds were each found only from a rendered drawing.
test("the presentation palette has a role for every kind the grammar can derive", () => {
	for (const kind of TERMINAL_PRIMITIVE_KINDS) {
		assert.ok(KIND_ROLES[kind], `${kind} has no palette role and would be painted as the mass`);
		assert.ok(["concrete", "glass", "bronze", "opaque"].includes(KIND_ROLES[kind]), `${kind} has an unknown palette role`);
	}
});

// `opaque` is the darkest tint in the palette. Putting a kind that covers a large area on
// it is what took the back view's building luminance P50 to 9.9 and failed
// PBR_PRESENTATION_RANGE_INVALID, and the spandrel is the only large-area member of the
// curtain-wall vocabulary. The thin members carry opaque instead.
test("the large-area curtain-wall panel is kept off the darkest tint", () => {
	assert.notEqual(KIND_ROLES.spandrel, "opaque", "a spandrel field on the darkest tint breaks the PBR luminance floor");
	assert.equal(KIND_ROLES.transom, "opaque", "a facade written only in curtain-wall words still needs a non-empty opaque role");
});

// A curtain wall is glass held in a grid with an opaque panel at the slab: two directions
// of framing and the panel. Fewer words and the skin is unsayable, which is the state the
// grammar was in when nine schemes came out in one architectural language.
test("the vocabulary can say a curtain wall as well as a punched wall", () => {
	for (const word of ["mullion", "transom", "spandrel"]) {
		assert.ok(TERMINAL_WORDS.includes(word), `the grammar cannot write ${word}`);
	}
	assert.equal(TERMINAL_MATERIALS.mullion, TERMINAL_MATERIALS.transom, "the two directions of one grid are one material");
	assert.equal(TERMINAL_KINDS.spandrel, "spandrel");
});

// The fold inset is the derivation's coordinate frame, so it confined the framing as well as
// the openings - a skin stopped 0.3 m short of the corner it exists to turn. The clearance is
// there because a hole cut through a turn breaks the mass, which is an argument about punching
// a solid wall; a skin's corner glass replaces the mass rather than piercing it and its corner
// member is the return. So a segment carrying a skin derives over the whole facet, and the
// requirement there is that the strip be framed rather than bare.
const skinGrammar = (edgeTerminal: string) => ({
	schema_version: "arr.elevation3d.facade-grammar.v3",
	concept_id: `skin-${edgeTerminal}`,
	start: "Facet",
	entrance: {
		segment_selector: "primary_visible_ground_segment", preferred_bay: "central_focus",
		door_family: "portal", width_m: 1.4, height_m: 2.4, recess_m: 0.1,
	},
	rules: [
		{ name: "Facet", alternatives: [{ when: null, split: { axis: "u", parts: [
			{ size: "0.09", symbol: "Edge", arg: null, repeat: null },
			{ size: "~1", symbol: "Pane", arg: null, repeat: null },
			{ size: "0.09", symbol: "Edge", arg: null, repeat: null },
		] }, terminal: null, inset_m: 0, depth_m: 0 }] },
		{ name: "Edge", alternatives: [{ when: null, split: null, terminal: edgeTerminal, inset_m: 0, depth_m: 0.08 }] },
		{ name: "Pane", alternatives: [{ when: null, split: { axis: "z", parts: [
			{ size: "0.2", symbol: "Panel", arg: null, repeat: null },
			{ size: "~1", symbol: "Glass", arg: null, repeat: null },
			{ size: "0.2", symbol: "Panel", arg: null, repeat: null },
		] }, terminal: null, inset_m: 0, depth_m: 0 }] },
		{ name: "Panel", alternatives: [{ when: null, split: null, terminal: "spandrel", inset_m: 0, depth_m: 0.02 }] },
		{ name: "Glass", alternatives: [{ when: null, split: null, terminal: "glass", inset_m: 0, depth_m: 0.02 }] },
	],
	design_rationale: ["one module per facet, framed at its edges"],
});

test("a skin derives over the whole facet and its framing turns the corner", async (t) => {
	const { context } = await createFacadeDesignFixture(t);
	const fold = context.exclusions.fold_clearance_m;
	const report = checkAuthoredGrammar({ context, grammar: skinGrammar("mullion") });
	assert.ok(report.stage !== "parse" && report.stage !== "resolve", report.error ?? report.stage);

	// Read a segment that carries glass. Segment 0 is the entrance face and its pane is
	// displaced by the door, and an empty set made every bound below vacuously true - which is
	// how the previous version of this test passed while asserting nothing at all.
	const glazed = context.facade_segments.find((candidate: any) => report.resolved.primitives
		.some((primitive: any) => primitive.segment_id === candidate.segment_id && primitive.kind === "window"));
	assert.ok(glazed, "no segment carries glass");
	const segment = glazed as any;
	const onSegment = report.resolved.primitives.filter((primitive: any) => primitive.segment_id === segment.segment_id);
	const mullions = onSegment.filter((primitive: any) => primitive.kind === "mullion");
	const panes = onSegment.filter((primitive: any) => primitive.kind === "window");
	assert.ok(mullions.length >= 2, `expected framing, got ${mullions.length}`);

	// The framing stands at the facet itself, not 0.3 m inside it.
	assert.ok(Math.min(...mullions.map((m: any) => m.local_bounds.u_min)) <= 1e-6, "left mullion stops short of the corner");
	assert.ok(Math.max(...mullions.map((m: any) => m.local_bounds.u_max)) >= segment.length_m - 1e-6, "right mullion stops short of the corner");
	// And the glass now reaches it, behind that framing - the whole point of the change.
	const nearest = Math.min(...panes.map((p: any) => p.local_bounds.u_min));
	assert.ok(nearest < fold, `glass is still held off the fold at ${nearest}`);
	assert.ok(!(report.codes ?? []).includes("FOLD_CLEARANCE_INVALID"), "framed glass at the fold was rejected");
});

test("a skin whose corner member cannot be the return is still rejected", async (t) => {
	const { context } = await createFacadeDesignFixture(t);
	// Identical geometry to the passing case; only the edge member's word differs. A transom is
	// horizontal and cannot stand in for the turn, so this leaves glass meeting the fold bare.
	const report = checkAuthoredGrammar({ context, grammar: skinGrammar("transom") });
	assert.ok((report.codes ?? []).includes("FOLD_CLEARANCE_INVALID"),
		`unframed glass at the fold should be rejected, got ${JSON.stringify(report.codes ?? report.stage)}`);
});
