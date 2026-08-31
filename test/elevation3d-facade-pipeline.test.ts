import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import test from "node:test";

import { REPO_ROOT, resolveRoots, runDirFor } from "../tools/facade-pipeline/config.mjs";
import * as pipeline from "../tools/facade-pipeline/index.mjs";

test("the repository root is found from the module, not from cwd", () => {
	// Every runner used to resolve against wherever it was launched, which is why they were
	// all invoked with an explicit cd and broke when the checkout moved.
	assert.equal(isAbsolute(REPO_ROOT), true);
	assert.equal(existsSync(join(REPO_ROOT, "plugins", "elevation-3d")), true);
	assert.equal(existsSync(join(REPO_ROOT, "elevation-agent.json")), true);
});

test("roots come from the config file, and say where they came from", () => {
	const roots = resolveRoots();
	assert.equal(isAbsolute(roots.datasetRoot), true);
	assert.equal(isAbsolute(roots.outputRoot), true);
	// The tracked config file is the answer, not a hardcode buried in a runner.
	assert.equal(roots.source.datasetRoot, "elevation-agent.json");
	assert.equal(roots.source.outputRoot, "elevation-agent.json");
});

test("an explicit argument beats the environment, which beats the file", () => {
	const named = resolveRoots({ datasetRoot: "C:/somewhere/masses" });
	assert.equal(named.datasetRoot, "C:/somewhere/masses");
	assert.equal(named.source.datasetRoot, "argument");
	// The output root is untouched by an override of the other one.
	assert.equal(named.source.outputRoot, "elevation-agent.json");

	const before = process.env.ELEVATION_AGENT_OUTPUT_ROOT;
	process.env.ELEVATION_AGENT_OUTPUT_ROOT = "C:/somewhere/drawings";
	try {
		assert.equal(resolveRoots().outputRoot, "C:/somewhere/drawings");
		assert.equal(resolveRoots().source.outputRoot, "environment");
		assert.equal(resolveRoots({ outputRoot: "C:/argument" }).outputRoot, "C:/argument");
	} finally {
		if (before === undefined) delete process.env.ELEVATION_AGENT_OUTPUT_ROOT;
		else process.env.ELEVATION_AGENT_OUTPUT_ROOT = before;
	}
});

test("a root written relative to the repository is anchored to it", () => {
	const roots = resolveRoots({ outputRoot: "out/drawings" });
	assert.equal(roots.outputRoot, join(REPO_ROOT, "out", "drawings"));
});

test("a run directory is derived from the output root", () => {
	assert.equal(
		runDirFor("creative-013", { outputRoot: "C:/drawings" }),
		join("C:/drawings", "creative-013", "llm-facade-subagent-creative-013"),
	);
});

test("the agent's four steps are all reachable from one module", () => {
	// The point of the module: prepare, brief, check and render named together in one tracked
	// place. They were four untracked scripts, each with the data locations typed into it, so
	// the agent could not be invoked as the one thing it is.
	for (const step of ["prepareFacadeContext", "writeFacadeBrief", "checkFacadeGrammar", "renderFacadeScheme"]) {
		assert.equal(typeof (pipeline as Record<string, unknown>)[step], "function", `${step} is missing`);
	}
});
