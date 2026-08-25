import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
	checkAuthoredGrammar,
	REVEAL_FACADE_PRESENTATION_STYLE,
	writeGrammarBrief,
} from "../plugins/elevation-3d/lib/facade-agent/design/authoring-kit.mjs";
import { resolvePbrRenderStyle } from "../plugins/elevation-3d/lib/texturing/render-style.mjs";
import { createFacadeDesignFixture } from "./helpers/facade-design-fixture.ts";

test("the brief writes the prompt, the schema and the geometry an author needs", async (t) => {
	const { context, runDir } = await createFacadeDesignFixture(t);
	const brief = await writeGrammarBrief({ runDir, context });

	assert.match(brief.promptSha256, /^[a-f0-9]{64}$/);
	// The prompt has to carry the guidance, not just the operators - an author given only
	// the grammar language writes a warehouse that parses.
	assert.ok(brief.prompt.includes("Compose an elevation"), "guidance is missing from the brief");
	const schema = JSON.parse(await readFile(brief.paths.schema, "utf8"));
	assert.equal(schema.properties.schema_version.const, "arr.elevation3d.facade-grammar.v3");
	const summary = JSON.parse(await readFile(brief.paths.context, "utf8"));
	assert.equal(summary.storeys.length, context.storeys.length);
	assert.equal(summary.facade_segments.length, context.facade_segments.length);
});

test("the gate reports the stage that stopped a grammar, in that gate's own language", async (t) => {
	const { context } = await createFacadeDesignFixture(t);

	const notAnObject = checkAuthoredGrammar({ context, grammar: { schema_version: "nope" } });
	assert.equal(notAnObject.ok, false);
	assert.equal(notAnObject.stage, "parse");
	assert.ok(notAnObject.error.length > 0, "a parse rejection has to say what was wrong");
});

test("a context without its authority is refused rather than silently passed", async (t) => {
	const { context } = await createFacadeDesignFixture(t);
	// A structural clone loses the authority the context was verified under. The director
	// refuses one and so must this, or the gates could be run against invented geometry.
	assert.throws(() => checkAuthoredGrammar({ context: structuredClone(context), grammar: {} }), TypeError);
});

// The override exists because the preset cannot answer both a reveal-heavy facade and the
// retained baselines. If it ever stops being a valid override the renders fail far downstream,
// so it is resolved here where the failure is legible.
test("the reveal-facade presentation override resolves against the competition preset", () => {
	const style = resolvePbrRenderStyle({ ...REVEAL_FACADE_PRESENTATION_STYLE, id: "competition-daylight-v1" });
	assert.equal(style.exposure, 0.86);
	assert.equal(style.environment.intensity, 1.7);
	assert.equal(style.hemisphere.intensity, 2.2);
	// The lifted ambient must not have quietly dropped the rest of the preset.
	assert.equal(style.sun.intensity, 1.9);
	assert.equal(style.materialResponse.bronze.tintMultiplier, "#8a5a32");
});

// A bare code leaves an author correcting blind - the defect the paid loop has now been
// fixed for twice. The library was still handing out bare codes while the repo-blind
// checker beside it located them, so an author using the kit got the worse feedback.
test("a validate rejection carries its measurement and its locus", async (t) => {
	const { context } = await createFacadeDesignFixture(t);
	// A door recessed past max_recess_m: buildable shape, one measurable violation.
	const grammar = {
		schema_version: "arr.elevation3d.facade-grammar.v3",
		concept_id: "located-fault-probe",
		start: "Facet",
		entrance: {
			segment_selector: "primary_visible_ground_segment", preferred_bay: "central_focus",
			door_family: "portal", width_m: 1.6, height_m: 2.6, recess_m: 1.2,
		},
		rules: [{
			name: "Facet",
			alternatives: [{ when: null, split: null, terminal: "wall", inset_m: 0, depth_m: 0 }],
		}],
		design_rationale: ["probe"],
	};
	const rejected = checkAuthoredGrammar({ context, grammar });
	assert.equal(rejected.ok, false);
	assert.equal(rejected.stage, "validate");
	assert.ok(rejected.codes.includes("PROJECTION_LIMIT_EXCEEDED"), rejected.codes.join(","));
	const located = rejected.faults.find((fault: string) => fault.startsWith("PROJECTION_LIMIT_EXCEEDED"));
	assert.ok(located, "the rejection must carry located faults, not only bare codes");
	assert.match(located, /measured [\d.]+ against [\d.]+/, located);
});
