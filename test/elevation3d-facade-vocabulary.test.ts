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
