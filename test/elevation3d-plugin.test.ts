import assert from "node:assert/strict";
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
