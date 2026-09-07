import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { buildConceptSubject, massFacts } from "../tools/facade-presentation/photo/concept-subject.mjs";

const projectRoot = resolve(import.meta.dirname, "..");

const context = {
	storeys: [1, 2, 3, 4, 5].map((storey) => ({ storey, z_min: (storey - 1) * 3.3, z_max: storey * 3.3 })),
	facade_segments: Array.from({ length: 16 }, (_, index) => ({ segment_id: `s${index}`, ground_access: true })),
};

test("concept subject states the mass as facts read from the context, and the idea verbatim", () => {
	const idea = "a screen whose opening varies with the sun - what does the closed side look like?";
	const subject = buildConceptSubject({ context, idea });
	assert.match(subject, /16-facet/);
	assert.match(subject, /EXACTLY 16\.5 METRES TALL/);
	assert.match(subject, /EXACTLY 5 STOREYS/);
	assert.match(subject, /3\.3 m each/);
	assert.match(subject, /standing on the ground along its whole perimeter/);
	assert.ok(subject.endsWith(`The facade: ${idea}`), "the idea is the last thing said and is not rewritten");
});

test("a bridge mass says which facets touch the ground", () => {
	const bridge = {
		storeys: context.storeys.slice(0, 3),
		facade_segments: context.facade_segments.map((segment, index) => ({ ...segment, ground_access: index < 3 })),
	};
	assert.deepEqual(massFacts(bridge), { storeys: 3, height_m: 9.9, storey_height_m: 3.3, facets: 16, facets_on_ground: 3 });
	assert.match(buildConceptSubject({ context: bridge, idea: "x" }), /only 3 of its 16 facets/);
});

test("a concept without an idea is refused - the brief is the commissioner's, never defaulted", () => {
	assert.throws(() => buildConceptSubject({ context, idea: "  " }), /needs an idea/);
	assert.throws(() => massFacts({ storeys: [], facade_segments: [] }), /prepared context/);
});

// A transcriber playing the role file could not find where the mass's material is said,
// because the brief never said it - the compiler read it off `wall` and no author could
// know. A field no author can read about does not exist (AGENTS.md), so the brief and
// the role file must both say it.
test("the brief and the transcriber role both say the wall material is the mass's", async () => {
	const brief = await readFile(join(projectRoot, "plugins/elevation-3d/lib/facade-agent/design/grammar/prompt.mjs"), "utf8");
	assert.match(brief, /material on a \\`wall\\` terminal[\s\S]{0,200}what the\s+building is MADE of/);
	const role = await readFile(join(projectRoot, ".claude/agents/facade-transcriber.md"), "utf8");
	assert.match(role, /material you put on a `wall` terminal is what the mass/);
});

test("every role under .claude/agents is a named, repo-blind markdown file", async () => {
	const dir = join(projectRoot, ".claude", "agents");
	const files = (await readdir(dir)).filter((name) => name.endsWith(".md")).sort();
	assert.deepEqual(files, ["facade-author.md", "facade-reviewer.md", "facade-transcriber.md"]);
	for (const file of files) {
		const text = await readFile(join(dir, file), "utf8");
		const name = text.match(/^---\r?\nname: (\S+)/)?.[1];
		assert.equal(name, file.replace(/\.md$/, ""), `${file} frontmatter name matches its filename`);
		assert.match(text, /do \*\*not\*\* read|do not read any code/i, `${file} states the blind rule`);
	}
	const agents = await readFile(join(projectRoot, "AGENTS.md"), "utf8");
	for (const file of files) assert.match(agents, new RegExp(file.replace(".", "\\.")), `AGENTS.md points Codex at ${file}`);
});
