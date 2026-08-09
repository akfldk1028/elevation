import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";
import { register } from "../plugins/elevation-3d/index.mjs";
import { createFacadeAgentDependencyFactory, executeFacadeAgentCommand, runFacadeAgentTool } from "../plugins/elevation-3d/lib/facade-agent/cli.mjs";
import { createFacadeFixtureTransport } from "../plugins/elevation-3d/lib/facade-agent/fixture-transport.mjs";
import { facadeCandidateHash } from "../plugins/elevation-3d/lib/facade-agent/candidate-authority.mjs";
import { createProductionFacadeAgentDependencies } from "../plugins/elevation-3d/lib/facade-agent/production-dependencies.mjs";
import { cameraContractHash, deriveExpectedCameraContract, presentationCameraPresets, technicalCameraAuthorityFromGlb } from "../plugins/elevation-3d/lib/camera-authority.mjs";
import { deriveDeliveryCameras } from "../plugins/elevation-3d/lib/final-delivery.mjs";

function sha256(value: string | Buffer) {
	return createHash("sha256").update(value).digest("hex");
}

const PRESENTATION_VIEW_NAMES = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];

function localPresentationCandidate() {
	return {
		candidate: { candidate_id: "creative-020" }, identity: { geometry_hash: "fixture-geometry" },
		mesh: { vertices: [[0, 0, 0], [10, 0, 0], [0, 8, 12]] },
		cameras: {
			identity: { source: "fixture" },
			views: {
				front: { projection: "orthographic", projection_axes: { depth: [0, -1, 0], horizontal: [1, 0, 0], vertical: [0, 0, 1] } },
				right: { projection: "orthographic", projection_axes: { depth: [1, 0, 0], horizontal: [0, 1, 0], vertical: [0, 0, 1] } },
				back: { projection: "orthographic", projection_axes: { depth: [0, 1, 0], horizontal: [-1, 0, 0], vertical: [0, 0, 1] } },
				left: { projection: "orthographic", projection_axes: { depth: [-1, 0, 0], horizontal: [0, -1, 0], vertical: [0, 0, 1] } },
				top: { projection: "orthographic", projection_axes: { depth: [0, 0, 1], horizontal: [1, 0, 0], vertical: [0, 1, 0] } },
			},
		},
	};
}

function localPresentationBounds() {
	const vertices = localPresentationCandidate().mesh.vertices;
	const min = [0, 1, 2].map((axis) => Math.min(...vertices.map((point) => point[axis])));
	const max = [0, 1, 2].map((axis) => Math.max(...vertices.map((point) => point[axis])));
	const size = max.map((value, axis) => value - min[axis]);
	return { center: max.map((value, axis) => (value + min[axis]) / 2), radius: Math.max(Math.hypot(...size) * 0.75, 1) };
}

async function localPresentationGlbBytes() {
	const document = new Document(), buffer = document.createBuffer();
	const positions = document.createAccessor("positions", buffer).setType("VEC3")
		.setArray(new Float32Array(localPresentationCandidate().mesh.vertices.flat()));
	const indices = document.createAccessor("indices", buffer).setType("SCALAR").setArray(new Uint16Array([0, 1, 2]));
	const primitive = document.createPrimitive().setAttribute("POSITION", positions).setIndices(indices);
	document.createScene("Scene").addChild(document.createNode("exact-mass").setMesh(document.createMesh("exact-mass").addPrimitive(primitive)));
	return Buffer.from(await new NodeIO().writeBinary(document));
}

async function writeAcceptedTechnicalDelivery(runDir: string, selectedGlbSha256: string, selectedGlbBytes: Buffer, candidate: any) {
	const root = join(runDir, "technical-delivery");
	const views: Record<string, any> = {};
	const memoryViews: Record<string, any> = {};
	const technicalCameras = (await technicalCameraAuthorityFromGlb({
		bytes: selectedGlbBytes, cameras: deriveDeliveryCameras(candidate),
	})).cameras as Record<string, any>;
	await mkdir(root, { recursive: true });
	await writeFile(join(root, "enriched.glb"), selectedGlbBytes);
	for (const [index, name] of PRESENTATION_VIEW_NAMES.entries()) {
		const relativePath = join("views", name, `${name}-manifest.json`);
		const validationRelativePath = join("views", name, `${name}-validation.json`);
		const imageRelativePath = join("views", name, `${name}.png`);
		const path = join(root, relativePath), validationPath = join(root, validationRelativePath), imagePath = join(root, imageRelativePath);
		await mkdir(join(root, "views", name), { recursive: true });
		const type = ["axon", "opposite-axon"].includes(name) ? "perspective" : "orthographic";
		const camera = technicalCameras[name];
		const detail = {
			schema_version: type === "perspective" ? "arr.elevation3d.competition-axon.v1"
				: ["plan", "top"].includes(name) ? "arr.elevation3d.competition-plan-top.v1" : "arr.elevation3d.competition-elevation.v1",
			...(["plan", "top"].includes(name) ? { mode: name } : { view: name }),
			selected_glb_sha256: selectedGlbSha256, camera,
			cut: name === "plan" ? { enabled: true, elevation_m: 1.2, plane_world: [0, 0, 1, -1.2] }
				: { enabled: false, elevation_m: null, plane_world: null },
			content_bounds_px: { min_x: 10, min_y: 10, max_x: 89, max_y: 89 },
		};
		const bytes = Buffer.from(JSON.stringify(detail)), imageBytes = Buffer.from(`technical-view-${index}`);
		const validation = { accepted: true, codes: [], metrics: { content_bounds_px: detail.content_bounds_px } };
		const validationBytes = Buffer.from(JSON.stringify(validation));
		await writeFile(path, bytes); await writeFile(validationPath, validationBytes); await writeFile(imagePath, imageBytes);
		views[name] = {
			path: imageRelativePath, sha256: sha256(imageBytes), width: 100, height: 100, selected_glb_sha256: selectedGlbSha256, camera,
			validation, manifest: { path: relativePath, sha256: sha256(bytes) },
			validation_report: { path: validationRelativePath, sha256: sha256(validationBytes) },
		};
		memoryViews[name] = {
			image: { path: imagePath, sha256: sha256(imageBytes) }, manifest: { path, sha256: sha256(bytes) },
			validation: { path: validationPath, sha256: sha256(validationBytes) }, selected_glb_sha256: selectedGlbSha256,
		};
	}
	const viewer: Record<string, any> = {};
	for (const [key, file, content] of [["html", "index.html", "<html>technical viewer</html>"], ["app", "app.js", "globalThis.technical=true;"], ["config", "config.json", JSON.stringify({ cameras: { views: technicalCameras } })]] as const) {
		const path = join(root, "viewer", file), bytes = Buffer.from(content); await mkdir(join(root, "viewer"), { recursive: true }); await writeFile(path, bytes);
		viewer[key] = { path: join("viewer", file), sha256: sha256(bytes) };
	}
	const screenshots: Record<string, any> = {};
	for (const [key, file, content] of [["initial", "viewer-initial.png", "technical-initial"], ["interacted", "viewer-interacted.png", "technical-interacted"]] as const) {
		const path = join(root, "browser-verification", file), bytes = Buffer.from(content); await mkdir(join(root, "browser-verification"), { recursive: true }); await writeFile(path, bytes);
		screenshots[key] = { path, sha256: sha256(bytes) };
	}
	const browser = { schema_version: "arr.elevation3d.browser-verification.v1", console_errors: [], blocked_external_requests: [], glb_load_count: 1, screenshots };
	const browserPath = join(root, "browser-verification", "browser-verification.json"), browserBytes = Buffer.from(JSON.stringify(browser));
	await writeFile(browserPath, browserBytes);
	const validation = { schema_version: "arr.elevation3d.all-views-validation.v1", accepted: true, codes: [] };
	const validationPath = join(root, "validation.json"), validationBytes = Buffer.from(JSON.stringify(validation));
	await writeFile(validationPath, validationBytes);
	const manifest = {
		schema_version: "arr.elevation3d.all-views.v1", selected_glb: { path: "enriched.glb", sha256: selectedGlbSha256 },
		views, validation, verified_evidence: { viewer }, viewer: { path: "viewer/index.html", config_sha256: viewer.config.sha256 },
	};
	const manifestPath = join(root, "all-views-manifest.json");
	const manifestBytes = Buffer.from(JSON.stringify(manifest));
	await writeFile(manifestPath, manifestBytes);
	return {
		run_dir: root, manifest, validation, views,
		memory_record: {
			schema_version: "arr.elevation3d.final-delivery-memory.v1",
			selected_glb: { path: join(root, "enriched.glb"), sha256: selectedGlbSha256 },
			manifest: { path: manifestPath, sha256: sha256(manifestBytes) }, validation: { path: validationPath, sha256: sha256(validationBytes) },
			viewer: Object.fromEntries(Object.entries(viewer).map(([key, ref]: [string, any]) => [key, { path: join(root, ref.path), sha256: ref.sha256 }])),
			browser_verification: { path: browserPath, sha256: sha256(browserBytes), screenshots }, views: memoryViews,
		},
	};
}

function durablePresentationRenderer(calls: any[]) {
	return async (options: any) => {
		calls.push(options);
		const selectedBytes = await readFile(options.glbPath), selectedGlbSha256 = sha256(selectedBytes);
		const cameras = presentationCameraPresets(options.cameras);
		const buildingBounds = localPresentationBounds();
		await mkdir(options.runDir, { recursive: true });
		const browserGlbPath = join(options.runDir, "textured.glb"); await writeFile(browserGlbPath, selectedBytes);
		const viewer: Record<string, any> = {};
		for (const [key, file, content] of [["html", "index.html", "<html>presentation viewer</html>"], ["app", "app.js", "globalThis.presentation=true;"], ["config", "config.json", JSON.stringify({ cameras: { views: cameras } })]] as const) {
			const path = join(options.runDir, "viewer", file), bytes = Buffer.from(content); await mkdir(join(options.runDir, "viewer"), { recursive: true }); await writeFile(path, bytes);
			viewer[key] = { path, sha256: sha256(bytes) };
		}
		const views: Record<string, any> = {}, artifacts: Record<string, any> = {};
		for (const [index, name] of PRESENTATION_VIEW_NAMES.entries()) {
			const directory = join(options.runDir, "views", name); await mkdir(directory, { recursive: true });
			const image = Buffer.from(`presentation-view-${index}`), mask = Buffer.from(`presentation-mask-${index}`);
			const path = join(directory, `${name}.png`), maskPath = join(directory, `${name}-semantic-roles.png`);
			await writeFile(path, image); await writeFile(maskPath, mask);
			const expected = deriveExpectedCameraContract({ name, preset: cameras[name], buildingBounds });
			views[name] = {
				path, sha256: sha256(image), semanticRoleMaskPath: maskPath, semanticRoleMaskSha256: sha256(mask), selectedGlbSha256,
				cameraEvidence: { building_bounds: buildingBounds, expected, actual: structuredClone(expected), expected_hash: cameraContractHash(expected), actual_hash: cameraContractHash(expected) },
			};
			artifacts[`view_${name}`] = { path, sha256: sha256(image) };
			artifacts[`semantic_role_mask_${name}`] = { path: maskPath, sha256: sha256(mask) };
		}
		for (const [key, file, value] of [
			["render_style", "render-style.json", { id: "competition-daylight-v1" }],
			["presentation_evidence", "presentation-evidence.json", { views: {} }],
			["semantic_role_evidence", "semantic-role-evidence.json", { views: {} }],
			["baseline_comparison", "baseline-comparison.json", { status: "not_compared", views: {} }],
		] as const) {
			const path = join(options.runDir, file), bytes = Buffer.from(JSON.stringify(value)); await writeFile(path, bytes); artifacts[key] = { path, sha256: sha256(bytes) };
		}
		const contactPath = join(options.runDir, "contact-sheet.png"), contactBytes = Buffer.from("presentation-contact-sheet");
		await writeFile(contactPath, contactBytes); artifacts.contact_sheet = { path: contactPath, sha256: sha256(contactBytes) };
		const report = {
			schema_version: "arr.elevation3d.embedded-pbr-render.v2",
			selected_glb: { path: options.glbPath, sha256: selectedGlbSha256 }, browser_loaded_glb: { path: browserGlbPath, sha256: selectedGlbSha256 },
			views, viewer, artifacts, validation: { accepted: true, codes: [] }, provider_calls: 0, credits_consumed: 0,
			material_mode: "embedded-pbr", render_style: { id: "competition-daylight-v1" },
			pbr_evidence: { material_count: 4, base_color_maps: 2, normal_maps: 2, metallic_roughness_maps: 2 },
			canonical_selection: options.canonicalSelection,
			camera_authority: { schema_version: "arr.elevation3d.presentation-camera-authority.v1", views: cameras, sha256: cameraContractHash(cameras) },
		};
		await writeFile(join(options.runDir, "render-validation.json"), JSON.stringify(report, null, 2));
		return report;
	};
}

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
		"brief_id", "candidate_id", "confirm_live", "confirm_total_usd", "dataset_root", "dry_run", "grammar_budget_usd",
		"grammar_model", "grammar_provider", "image_budget_usd", "image_providers", "output_root", "providers", "run_id",
	]);
	assert.deepEqual(tool.inputSchema.properties.candidate_id.enum, ["creative-020"]);
	assert.deepEqual(tool.inputSchema.properties.brief_id.enum, ["brick-punched-window-v1"]);
	assert.deepEqual(tool.inputSchema.properties.providers.items.enum, ["gpt-image-2", "seedream-5-pro", "qwen-image-2", "nano-banana-pro"]);
	assert.deepEqual(tool.inputSchema.properties.image_providers.items.enum, ["gpt-image-2", "seedream-5-pro", "qwen-image-2", "nano-banana-pro"]);
	assert.deepEqual(tool.inputSchema.properties.grammar_provider.enum, ["byteplus-seed-mini", "openai-gpt-5.6"]);
	assert.deepEqual(tool.inputSchema.properties.image_providers.default, ["seedream-5-pro"]);
	assert.equal(tool.inputSchema.properties.grammar_provider.default, "byteplus-seed-mini");
	assert.deepEqual(tool.inputSchema.properties.image_budget_usd.default, { "seedream-5-pro": 0.06 });
	assert.equal(tool.inputSchema.properties.grammar_budget_usd.default, 0.01);
	assert.deepEqual(tool.inputSchema.properties.grammar_model.enum, ["gpt-5.6"]);
	assert.equal(tool.inputSchema.properties.providers.minItems, 1);
	assert.equal(tool.inputSchema.properties.providers.maxItems, 4);
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

test("facade agent tool applies canonical default routes and accepts only exact 0.07 live confirmation", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-plugin-default-router-"));
	try {
		let captured: any;
		const stop = new Error("captured-default-config");
		const factory = createFacadeAgentDependencyFactory(async (config: any) => { captured = config; throw stop; });
		await assert.rejects(() => runFacadeAgentTool({
			run_id: "default-live", dataset_root: root, output_root: join(root, "output"),
			dry_run: false, confirm_live: true, confirm_total_usd: 0.07,
		}, undefined, {}, factory, async () => new Response()), stop);
		assert.deepEqual(captured.imageProviders, ["seedream-5-pro"]);
		assert.equal(captured.grammarProvider, "byteplus-seed-mini");
		assert.deepEqual(captured.imageBudgetMicros, { "seedream-5-pro": 60_000 });
		assert.equal(captured.grammarBudgetMicros, 10_000);
		assert.equal(captured.confirmedTotalMicros, 70_000);

		captured = undefined;
		await assert.rejects(() => runFacadeAgentTool({
			run_id: "default-live-wrong-total", dataset_root: root, output_root: join(root, "output"),
			dry_run: false, confirm_live: true, confirm_total_usd: 0.070001,
		}, undefined, {}, factory, async () => new Response()), (error: any) => error.code === "LIVE_COST_CONFIRMATION_INVALID");
		assert.equal(captured, undefined);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("facade agent tool forwards a safe dry-run into the approved preflight harness", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-plugin-facade-"));
	try {
		const tools: any[] = [];
		let receivedSignal: AbortSignal | undefined;
		const transport = createFacadeFixtureTransport(async () => ({}));
		const facadeAgentDependencyFactory = createFacadeAgentDependencyFactory(async ({ signal }: any) => {
			receivedSignal = signal;
			const provider = createFacadeFixtureTransport({ generate: transport });
			return {
				signal, loadCandidate: async () => ({ candidate: { candidate_id: "creative-020" }, identity: { geometry_hash: "fixture" } }),
				buildEvidence: async ({ runDir }: any) => ({ manifestSha256: "e".repeat(64), manifestPath: join(runDir, "evidence", "manifest.json") }),
				grammarProvider: createFacadeFixtureTransport({ id: "openai-gpt-5.6", model: "gpt-5.6", extract: transport }),
				providers: { "gpt-image-2": provider, "seedream-5-pro": provider, "qwen-image-2": provider, "nano-banana-pro": provider },
				build: async () => ({}), validate: async () => ({}), renderDelivery: async () => ({}), renderPresentation: async () => ({}),
			};
		});
		await register({ config: {}, facadeAgentDependencyFactory, registerTool: (tool: any) => tools.push(tool), addPrompt() {}, registerMemoryLayer() {}, logger: console });
		const tool = tools.find((item) => item.name === "elevation_3d_facade_agent_run");
		const controller = new AbortController();
		await assert.rejects(() => tool.handler({
			run_id: "conflicting-routes", dataset_root: root, output_root: join(root, "output"),
			providers: ["gpt-image-2"], image_providers: ["seedream-5-pro"],
		}), (error: any) => error?.code === "CONFIG_FIELD_CONFLICT");
		await assert.rejects(() => tool.handler({
			run_id: "conflicting-grammar-routes", dataset_root: root, output_root: join(root, "output"),
			grammar_model: "gpt-5.6", grammar_provider: "byteplus-seed-mini",
		}), (error: any) => error?.code === "CONFIG_FIELD_CONFLICT");
		const response = await tool.handler({
			run_id: "dry-preflight", dataset_root: root, output_root: join(root, "output"),
			image_providers: ["gpt-image-2", "seedream-5-pro", "qwen-image-2", "nano-banana-pro"],
			grammar_provider: "openai-gpt-5.6", grammar_model: "gpt-5.6",
		}, controller.signal);
		const result = JSON.parse(response.text);
		assert.equal(result.state, "running");
		assert.equal(result.stage, "preflight");
		assert.equal(receivedSignal, controller.signal);
		assert.doesNotMatch(response.text, new RegExp(root.replaceAll("\\", "\\\\"), "i"));
		const envelope = JSON.parse(await readFile(join(root, "output", "creative-020", "dry-preflight", "facade-agent-config.json"), "utf8"));
		assert.deepEqual(envelope.config.imageProviders, ["gpt-image-2", "seedream-5-pro", "qwen-image-2", "nano-banana-pro"]);
		assert.equal(envelope.config.grammarProvider, "openai-gpt-5.6");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("facade agent tool defaults to production preflight without dependency injection or transport", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-plugin-production-facade-"));
	try {
		const tools: any[] = [];
		await register({ config: {}, registerTool: (tool: any) => tools.push(tool), addPrompt() {}, registerMemoryLayer() {}, logger: console });
		const tool = tools.find((item) => item.name === "elevation_3d_facade_agent_run");
		const response = await tool.handler({ run_id: "production-preflight", dataset_root: "D:/Data/50_ELE/MAAS_ELEVATION_TEST_SET_20260730", output_root: join(root, "output") }, new AbortController().signal);
		assert.equal(JSON.parse(response.text).stage, "preflight");
		const receipt = JSON.parse(await readFile(join(root, "output", "creative-020", "production-preflight", "stages", "preflight-receipt.json"), "utf8"));
		assert.equal(receipt.capabilities["seedream-5-pro"].available, false);
		assert.equal(receipt.capabilities["grammar:byteplus-seed-mini"].available, false);
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
			buildEvidence: async ({ runDir }: any) => ({ manifestSha256: "e".repeat(64), manifestPath: join(runDir, "evidence", "manifest.json") }),
			grammarProvider: createFacadeFixtureTransport({ id: "byteplus-seed-mini", model: "seed-2-0-mini-260428", extract: transport }),
			providers: {
				"gpt-image-2": createFacadeFixtureTransport({ generate: transport }),
				"seedream-5-pro": createFacadeFixtureTransport({ generate: transport }),
				"qwen-image-2": createFacadeFixtureTransport({ generate: transport }),
			},
			build: async () => ({}), validate: async () => ({}), renderDelivery: async () => ({}), renderPresentation: async () => ({}),
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

test("production presentation dependency renders through only the local renderer", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-production-presentation-"));
	try {
		let credentialReads = 0;
		let fetchCalls = 0;
		const env = Object.defineProperty({}, "ARK_API_KEY", {
			enumerable: true,
			get() { credentialReads += 1; return "construction-only-credential"; },
		});
		const providerFactory = () => Object.freeze({
			preflight() { throw new Error("presentation must not access provider preflight"); },
			async generate() { throw new Error("presentation must not access image provider"); },
			async extract() { throw new Error("presentation must not access grammar provider"); },
		});
		const config = {
			outputRoot: root, candidateId: "creative-020", runId: "local-presentation",
			imageProviders: ["seedream-5-pro"], grammarProvider: "byteplus-seed-mini",
			imageBudgetUsd: { "seedream-5-pro": 0.06 }, imageEstimateUsd: { "seedream-5-pro": 0.06 },
		};
		const runDir = join(root, config.candidateId, config.runId);
		const glbBytes = await localPresentationGlbBytes();
		const selectedGlbSha256 = sha256(glbBytes);
		const glbPath = join(runDir, "selected.glb");
		const validation = { accepted: true, codes: [] };
		const validationReceipt = {
			schema_version: "arr.elevation3d.facade-validation-receipt.v1",
			provider: "local-fixture", version_id: "v001", artifact_sha256: selectedGlbSha256, validation,
		};
		const receiptBytes = Buffer.from(JSON.stringify(validationReceipt));
		const receiptPath = join(runDir, "facade-validation.json");
		const localRendererInputs: any[] = [];
		const localRenderer = durablePresentationRenderer(localRendererInputs);
		const deps: any = await createProductionFacadeAgentDependencies(config, {
			env,
			fetchImpl: async () => { fetchCalls += 1; throw new Error("presentation must not fetch"); },
			imageProviderFactories: { "seedream-5-pro": providerFactory },
			grammarProviderFactories: { "byteplus-seed-mini": providerFactory },
			presentationRenderer: localRenderer,
		});
		await writeFile(glbPath, glbBytes);
		await writeFile(receiptPath, receiptBytes);
		const candidate = localPresentationCandidate();
		const technicalDelivery = await writeAcceptedTechnicalDelivery(runDir, selectedGlbSha256, glbBytes, candidate);
		credentialReads = 0;
		fetchCalls = 0;

		assert.equal(typeof deps.renderPresentation, "function");
		const localPresentationInput = {
			runDir, presentationRoot: join(runDir, "final-presentation"), candidateId: config.candidateId,
			provider: "local-fixture", candidateSha256: facadeCandidateHash(candidate), selectedVersion: "v001",
			artifact: { path: glbPath, sha256: selectedGlbSha256 }, validation,
			validationReceipt: { path: receiptPath, sha256: sha256(receiptBytes) },
			technicalDelivery,
			input: candidate,
		};
		const result = await deps.renderPresentation(localPresentationInput);
		assert.equal(result.selected_glb.sha256, selectedGlbSha256);
		assert.equal(localRendererInputs.length, 1);
		const localRendererInput = localRendererInputs[0];
		assert.equal(localRendererInput.glbPath, localPresentationInput.artifact.path);
		assert.equal(localRendererInput.runDir, localPresentationInput.presentationRoot);
		assert.equal(localRendererInput.candidateId, localPresentationInput.candidateId);
		assert.equal(localRendererInput.canonicalSelection.selected_glb_sha256, localPresentationInput.artifact.sha256);
		assert.equal(localRendererInput.proceduralBaseline.manifest.sha256, technicalDelivery.memory_record.manifest.sha256);
		assert.equal(fetchCalls, 0);
		assert.equal(credentialReads, 0);
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
