import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { register } from "../plugins/elevation-3d/index.mjs";

test("plugin exposes the autonomous production flow before legacy experimental tools", async () => {
	const tools: any[] = [];
	const prompts: string[] = [];
	await register({ config: {}, registerTool: (tool: any) => tools.push(tool), addPrompt: (text: string) => prompts.push(text), registerMemoryLayer() {}, logger: console });
	assert.equal(tools[0].name, "elevation_3d_run");
	assert.match(tools[0].description, /complete candidate package/);
	assert.deepEqual(tools.slice(1).map((tool) => tool.name), [
		"elevation_3d_prepare",
		"elevation_3d_generate",
		"elevation_3d_resume",
		"elevation_3d_preview",
	]);
	assert.equal(tools.slice(1).every((tool) => /experimental/i.test(tool.description)), true);
	assert.match(prompts.join("\n"), /prefer elevation_3d_run/);
});

test("unified tool rejects unsafe identifiers before writing outside its output root", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-plugin-boundary-"));
	try {
		const tools: any[] = [];
		await register({ config: {}, registerTool: (tool: any) => tools.push(tool), addPrompt() {}, registerMemoryLayer() {}, logger: console });
		await assert.rejects(
			() => tools[0].handler({
				candidate_id: "../outside",
				run_id: "safe-run",
				dataset_root: join(root, "missing-dataset"),
				output_root: join(root, "output"),
			}),
			/safe path segment/i,
		);
		await assert.rejects(() => access(join(root, "output")), /ENOENT/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("unified tool forwards its AbortSignal to the production flow", async () => {
	const tools: any[] = [];
	await register({ config: {}, registerTool: (tool: any) => tools.push(tool), addPrompt() {}, registerMemoryLayer() {}, logger: console });
	const controller = new AbortController();
	controller.abort(new DOMException("cancel tool", "AbortError"));
	await assert.rejects(() => tools[0].handler({ candidate_id: "../would-fail-first-without-signal" }, controller.signal), {
		name: "AbortError",
	});
});
