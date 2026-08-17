import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
