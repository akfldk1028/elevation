import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "../plugins/elevation-3d/index.mjs";

test("plugin registers the four agent-facing tools and prompt guidance", async () => {
	const tools: any[] = [];
	const prompts: string[] = [];
	await register({ config: {}, registerTool: (tool: any) => tools.push(tool), addPrompt: (text: string) => prompts.push(text), registerMemoryLayer() {}, logger: console });
	assert.deepEqual(tools.map((tool) => tool.name), ["elevation_3d_prepare", "elevation_3d_generate", "elevation_3d_resume", "elevation_3d_preview"]);
	assert.match(prompts.join("\n"), /approval_id/);
	assert.match(prompts.join("\n"), /facade_brief/);
});
