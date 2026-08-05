import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { register } from "../plugins/elevation-3d/index.mjs";
import { createFacadeAgentDependencyFactory, executeFacadeAgentCommand, runFacadeAgentTool } from "../plugins/elevation-3d/lib/facade-agent/cli.mjs";
import { createFacadeFixtureTransport } from "../plugins/elevation-3d/lib/facade-agent/fixture-transport.mjs";
import { createProductionFacadeAgentDependencies } from "../plugins/elevation-3d/lib/facade-agent/production-dependencies.mjs";

test("plugin exposes the autonomous production flow before legacy experimental tools", async () => {
	const tools: any[] = [];
	const prompts: string[] = [];
	await register({ config: {}, registerTool: (tool: any) => tools.push(tool), addPrompt: (text: string) => prompts.push(text), registerMemoryLayer() {}, logger: console });
	assert.deepEqual(tools.slice(0, 2).map((tool) => tool.name), [
		"elevation_3d_run",
		"elevation_3d_facade_agent_run",
	]);
	assert.match(tools[0].description, /complete candidate package/);
	assert.deepEqual(tools.slice(2).map((tool) => tool.name), [
		"elevation_3d_prepare",
		"elevation_3d_generate",
		"elevation_3d_resume",
		"elevation_3d_preview",
	]);
	assert.equal(tools.slice(2).every((tool) => /experimental/i.test(tool.description)), true);
	assert.match(prompts.join("\n"), /prefer elevation_3d_run/);
});

test("facade agent tool exposes only bounded safe inputs", async () => {
	const tools: any[] = [];
	await register({ config: {}, registerTool: (tool: any) => tools.push(tool), addPrompt() {}, registerMemoryLayer() {}, logger: console });
	const tool = tools.find((item) => item.name === "elevation_3d_facade_agent_run");
	assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), [
		"brief_id", "candidate_id", "confirm_live", "dataset_root", "dry_run", "grammar_budget_usd",
		"image_budget_usd", "output_root", "providers", "run_id",
	]);
	assert.deepEqual(tool.inputSchema.properties.candidate_id.enum, ["creative-020"]);
	assert.deepEqual(tool.inputSchema.properties.brief_id.enum, ["brick-punched-window-v1"]);
	assert.deepEqual(tool.inputSchema.properties.providers.items.enum, ["gpt-image-2", "nano-banana-pro"]);
	assert.equal(tool.inputSchema.properties.dry_run.type, "boolean");
	assert.equal(tool.inputSchema.properties.confirm_live.type, "boolean");
});

test("facade agent tool rejects unsafe identifiers and an already-aborted signal", async () => {
	const tools: any[] = [];
	await register({ config: {}, registerTool: (tool: any) => tools.push(tool), addPrompt() {}, registerMemoryLayer() {}, logger: console });
	const tool = tools.find((item) => item.name === "elevation_3d_facade_agent_run");
	await assert.rejects(() => tool.handler({ candidate_id: "../outside", run_id: "safe-run" }), /safe path segment/i);
	const controller = new AbortController();
	controller.abort(new DOMException("cancel facade tool", "AbortError"));
	await assert.rejects(() => tool.handler({ candidate_id: "creative-020", run_id: "safe-run" }, controller.signal), { name: "AbortError" });
});

test("facade agent tool cannot confirm live work without explicit provider cost ceilings", async () => {
	const tools: any[] = [];
	await register({ config: {}, registerTool: (tool: any) => tools.push(tool), addPrompt() {}, registerMemoryLayer() {}, logger: console });
	const tool = tools.find((item) => item.name === "elevation_3d_facade_agent_run");
	await assert.rejects(() => tool.handler({
		candidate_id: "creative-020", brief_id: "brick-punched-window-v1", run_id: "live-without-ceilings",
		dry_run: false, confirm_live: true,
	}), /cost ceilings/i);
});

test("facade agent tool forwards a safe dry-run into the approved preflight harness", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-plugin-facade-"));
	try {
		const tools: any[] = [];
		let receivedSignal: AbortSignal | undefined;
		const transport = createFacadeFixtureTransport(async () => ({}));
		const facadeAgentDependencyFactory = createFacadeAgentDependencyFactory(async ({ signal }: any) => {
			receivedSignal = signal;
			return {
				signal, loadCandidate: async () => ({ candidate: { candidate_id: "creative-020" }, identity: { geometry_hash: "fixture" } }),
				buildEvidence: async () => ({}), extractGrammar: transport,
				providers: { "gpt-image-2": transport, "nano-banana-pro": transport },
				build: async () => ({}), validate: async () => ({}), renderDelivery: async () => ({}),
			};
		});
		await register({ config: {}, facadeAgentDependencyFactory, registerTool: (tool: any) => tools.push(tool), addPrompt() {}, registerMemoryLayer() {}, logger: console });
		const tool = tools.find((item) => item.name === "elevation_3d_facade_agent_run");
		const controller = new AbortController();
		const response = await tool.handler({ run_id: "dry-preflight", dataset_root: root, output_root: join(root, "output") }, controller.signal);
		const result = JSON.parse(response.text);
		assert.equal(result.state, "running");
		assert.equal(result.stage, "preflight");
		assert.equal(receivedSignal, controller.signal);
		assert.doesNotMatch(response.text, new RegExp(root.replaceAll("\\", "\\\\"), "i"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("facade agent tool defaults to production preflight without dependency injection or transport", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-plugin-production-facade-"));
	try {
		const { mkdir, writeFile } = await import("node:fs/promises");
		const mass = join(root, "candidates", "creative-020", "mass");
		await mkdir(join(mass, "mesh"), { recursive: true });
		await mkdir(join(mass, "elevation-research"), { recursive: true });
		await writeFile(join(root, "candidates", "creative-020", "candidate.json"), JSON.stringify({ candidate_id: "creative-020" }));
		await writeFile(join(mass, "manifest.json"), JSON.stringify({ identity: { candidate_id: "creative-020", geometry_hash: "fixture" }, artifacts: {} }));
		await writeFile(join(mass, "mesh", "indexed-mesh.json"), JSON.stringify({ identity: { geometry_hash: "fixture" }, vertices: [], triangles: [] }));
		for (const name of ["camera-poses.json", "floor-guides.json", "facade-planes.json", "surface-normals.json"]) await writeFile(join(mass, "elevation-research", name), "{}");
		const tools: any[] = [];
		await register({ config: {}, registerTool: (tool: any) => tools.push(tool), addPrompt() {}, registerMemoryLayer() {}, logger: console });
		const tool = tools.find((item) => item.name === "elevation_3d_facade_agent_run");
		const response = await tool.handler({ run_id: "production-preflight", dataset_root: root, output_root: join(root, "output") }, new AbortController().signal);
		assert.equal(JSON.parse(response.text).stage, "preflight");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("facade agent tool rejects hostile input records before getters, factory, or harness", async () => {
	const tools: any[] = [];
	let factoryCalls = 0;
	const facadeAgentDependencyFactory = createFacadeAgentDependencyFactory(async () => { factoryCalls += 1; throw new Error("factory must not run"); });
	await register({ config: {}, facadeAgentDependencyFactory, registerTool: (tool: any) => tools.push(tool), addPrompt() {}, registerMemoryLayer() {}, logger: console });
	const tool = tools.find((item) => item.name === "elevation_3d_facade_agent_run");
	let getterCalls = 0;
	const secret = "secret=plugin-getter-must-not-run";
	const getterInput = {};
	Object.defineProperty(getterInput, "run_id", { enumerable: true, get() { getterCalls += 1; throw new Error(secret); } });
	const inherited = Object.create({ confirm_live: true, dry_run: false, image_budget_usd: { "gpt-image-2": 99, "nano-banana-pro": 99 }, grammar_budget_usd: 99 });
	inherited.run_id = "inherited-controls";
	const proxy = new Proxy({ run_id: "proxy-input" }, { get() { throw new Error(secret); } });
	const providers = ["gpt-image-2", "nano-banana-pro"];
	Object.defineProperty(providers, "00", { enumerable: true, value: "gpt-image-2" });
	for (const input of [getterInput, inherited, proxy, { run_id: "unknown-field", extra: secret }, { providers }]) {
		await assert.rejects(() => tool.handler(input), (error: any) => {
			assert.doesNotMatch(`${error?.message}\n${error?.stack}`, /plugin-getter-must-not-run/);
			return error?.code === "TOOL_INPUT_INVALID";
		});
	}
	assert.equal(getterCalls, 0);
	assert.equal(factoryCalls, 0);
});

test("plugin-created status verifies its persisted config before returning read-only state", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-plugin-status-"));
	try {
		const tools: any[] = [];
		const transport = createFacadeFixtureTransport(async () => ({}));
		const factory = createFacadeAgentDependencyFactory(async () => ({
			loadCandidate: async () => ({ candidate: { candidate_id: "creative-020" }, identity: { geometry_hash: "fixture" } }),
			buildEvidence: async () => ({}), extractGrammar: transport,
			providers: { "gpt-image-2": transport, "nano-banana-pro": transport },
			build: async () => ({}), validate: async () => ({}), renderDelivery: async () => ({}),
		}));
		await register({ config: {}, facadeAgentDependencyFactory: factory, registerTool: (tool: any) => tools.push(tool), addPrompt() {}, registerMemoryLayer() {}, logger: console });
		const tool = tools.find((item) => item.name === "elevation_3d_facade_agent_run");
		await tool.handler({ run_id: "plugin-status", dataset_root: root, output_root: join(root, "output") });
		const runDir = join(root, "output", "creative-020", "plugin-status");
		const configPath = join(runDir, "facade-agent-config.json");
		const { readFile, writeFile } = await import("node:fs/promises");
		const envelope = JSON.parse(await readFile(configPath, "utf8"));
		envelope.config.grammarBudgetUsd = 7;
		await writeFile(configPath, JSON.stringify(envelope));
		await assert.rejects(() => executeFacadeAgentCommand(["status", "--run-dir", runDir]), (error: any) => error?.code === "FACADE_AGENT_STATE_UNCERTAIN");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("production dependency construction requires an explicit fetch authority before filesystem or harness work", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-production-fetch-authority-"));
	try {
		await assert.rejects(() => createProductionFacadeAgentDependencies({ outputRoot: root, candidateId: "creative-020", runId: "missing-fetch" }), /explicit fetch/i);
		await assert.rejects(() => access(join(root, "creative-020")), /ENOENT/);
		await assert.rejects(() => runFacadeAgentTool({ run_id: "missing-fetch", dataset_root: root, output_root: root }), /explicit fetch/i);
		await assert.rejects(() => access(join(root, "creative-020")), /ENOENT/);
	} finally { await rm(root, { recursive: true, force: true }); }
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
