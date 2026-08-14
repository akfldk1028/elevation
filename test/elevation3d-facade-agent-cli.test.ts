import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";
import { sha256, stableJson } from "../plugins/elevation-3d/lib/core.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const script = join(projectRoot, "scripts", "elevation-3d-facade.mjs");
const roots: string[] = [];
let preload = "";

before(async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-cli-entry-"));
	roots.push(root);
	const document = new Document(), buffer = document.createBuffer();
	const positions = document.createAccessor("positions", buffer).setType("VEC3")
		.setArray(new Float32Array([[0, 0, 0], [10, 0, 0], [0, 8, 12]].flat()));
	const indices = document.createAccessor("indices", buffer).setType("SCALAR").setArray(new Uint16Array([0, 1, 2]));
	const primitive = document.createPrimitive().setAttribute("POSITION", positions).setIndices(indices);
	document.createScene("Scene").addChild(document.createNode("exact-mass").setMesh(document.createMesh("exact-mass").addPrimitive(primitive)));
	const glb = Buffer.from(await new NodeIO().writeBinary(document)).toString("base64");
	const moduleUrl = (path: string) => pathToFileURL(join(projectRoot, path)).href;
	preload = join(root, "facade-cli-entry.mjs");
	const shim = join(root, "facade-cli-shim.mjs");
	const cliUrl = moduleUrl("plugins/elevation-3d/lib/facade-agent/cli.mjs");
	const scriptUrl = moduleUrl("scripts/elevation-3d-facade.mjs");
	const preloadUrl = pathToFileURL(preload).href;
	const shimUrl = pathToFileURL(shim).href;
	await writeFile(shim, `
import { runFacadeAgentCli as runFacadeAgentCliOriginal } from ${JSON.stringify(cliUrl)};
import { fixtureFactory } from ${JSON.stringify(preloadUrl)};
export async function runFacadeAgentCli(argv, io = {}) { return runFacadeAgentCliOriginal(argv, { ...io, dependencyFactory: fixtureFactory }); }
`);
	await writeFile(preload, `
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { sha256, stableJson } from ${JSON.stringify(moduleUrl("plugins/elevation-3d/lib/core.mjs"))};
import { createFacadeAgentDependencyFactory } from ${JSON.stringify(cliUrl)};
import { createFacadeFixtureTransport } from ${JSON.stringify(moduleUrl("plugins/elevation-3d/lib/facade-agent/fixture-transport.mjs"))};
import { FacadeProviderError } from ${JSON.stringify(moduleUrl("plugins/elevation-3d/lib/facade-agent/provider.mjs"))};
import { createPaidOperationLedger, consumePaidOperationSubmissionCapability } from ${JSON.stringify(moduleUrl("plugins/elevation-3d/lib/facade-agent/paid-operation-ledger.mjs"))};
import { deliverFacadeFinalPresentation } from ${JSON.stringify(moduleUrl("plugins/elevation-3d/lib/facade-agent/final-presentation.mjs"))};
import { cameraContractHash, deriveExpectedCameraContract, presentationCameraPresets, technicalCameraAuthorityFromGlb } from ${JSON.stringify(moduleUrl("plugins/elevation-3d/lib/camera-authority.mjs"))};
import { deriveDeliveryCameras } from ${JSON.stringify(moduleUrl("plugins/elevation-3d/lib/final-delivery.mjs"))};
const GLB = Buffer.from(${JSON.stringify(glb)}, "base64");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const grammar = { system: "brick-punched-window-v1", surfaces: ["front", "right", "back", "left"], materials: ["brick", "precast", "window-frame", "glass"], corner_datum_m: 0, bay_width_m: 2.4, window_width_m: 1.4, window_height_m: 1.8, sill_height_m: 0.8, reveal_depth_m: 0.2, frame_width_m: 0.06, lintel_height_m: 0.15, sill_depth_m: 0.1, cladding_depth_m: 0.1, brick_module_m: [0.22, 0.07], confidence: 0.92, unresolved_surfaces: [], floor_elevations_m: [0, 3, 6], facade_lengths_m: { front: 8, right: 6, back: 8, left: 6 } };
const VIEW_NAMES = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];
const candidate = {
  candidate_id: "creative-020", mesh: { vertices: [[0, 0, 0], [10, 0, 0], [0, 8, 12]] },
  cameras: { identity: { source: "fixture" }, views: {
    front: { projection: "orthographic", projected_bounds_m: [[0, 0], [10, 12]], projection_axes: { depth: [0, -1, 0], horizontal: [1, 0, 0], vertical: [0, 0, 1] } },
    right: { projection: "orthographic", projected_bounds_m: [[0, 0], [8, 12]], projection_axes: { depth: [1, 0, 0], horizontal: [0, 1, 0], vertical: [0, 0, 1] } },
    back: { projection: "orthographic", projected_bounds_m: [[-10, 0], [0, 12]], projection_axes: { depth: [0, 1, 0], horizontal: [-1, 0, 0], vertical: [0, 0, 1] } },
    left: { projection: "orthographic", projected_bounds_m: [[-8, 0], [0, 12]], projection_axes: { depth: [-1, 0, 0], horizontal: [0, -1, 0], vertical: [0, 0, 1] } },
    top: { projection: "orthographic", projected_bounds_m: [[0, 0], [10, 8]], projection_axes: { depth: [0, 0, 1], horizontal: [1, 0, 0], vertical: [0, 1, 0] } },
  } },
};
const loadedCandidate = { ...candidate, candidate, identity: { geometry_hash: "fixture" } };
const note = async (value) => { if (process.env.FACADE_TEST_CALL_LOG) await appendFile(process.env.FACADE_TEST_CALL_LOG, value + "\\n"); };
async function writeAcceptedTechnicalDelivery(deliveryRoot, selectedGlbSha256) {
  const views = {}, memoryViews = {};
  await mkdir(deliveryRoot, { recursive: true });
  const selectedPath = join(deliveryRoot, "enriched.glb");
  await writeFile(selectedPath, GLB);
  const authority = await technicalCameraAuthorityFromGlb({ bytes: GLB, cameras: deriveDeliveryCameras(loadedCandidate) });
  const technicalCameras = authority.cameras;
  for (const [index, name] of VIEW_NAMES.entries()) {
    const directory = join(deliveryRoot, "views", name);
    const relativePath = join("views", name, "view.json");
    const validationRelativePath = join("views", name, "validation.json");
    const imageRelativePath = join("views", name, name + ".png");
    const path = join(deliveryRoot, relativePath);
    const validationPath = join(deliveryRoot, validationRelativePath);
    const imagePath = join(deliveryRoot, imageRelativePath);
    await mkdir(directory, { recursive: true });
    const type = ["axon", "opposite-axon"].includes(name) ? "perspective" : "orthographic";
    const camera = technicalCameras[name];
    const cut = name === "plan"
      ? { enabled: true, elevation_m: 1.2, plane_world: [0, 0, 1, -1.2] }
      : { enabled: false, elevation_m: null, plane_world: null };
    const contentBounds = { min_x: 10, min_y: 10, max_x: 89, max_y: 89 };
    const detail = {
      schema_version: type === "perspective" ? "arr.elevation3d.competition-axon.v1"
        : ["plan", "top"].includes(name) ? "arr.elevation3d.competition-plan-top.v1" : "arr.elevation3d.competition-elevation.v1",
      ...(["plan", "top"].includes(name) ? { mode: name } : { view: name }),
      selected_glb_sha256: selectedGlbSha256, camera, cut, content_bounds_px: contentBounds,
    };
    const bytes = Buffer.from(JSON.stringify(detail));
    const validation = { accepted: true, codes: [], metrics: { content_bounds_px: contentBounds } };
    const validationBytes = Buffer.from(JSON.stringify(validation));
    const imageBytes = Buffer.from("technical-view-" + index);
    await writeFile(path, bytes);
    await writeFile(validationPath, validationBytes);
    await writeFile(imagePath, imageBytes);
    views[name] = {
      path: imageRelativePath, sha256: sha256(imageBytes), width: 100, height: 100,
      selected_glb_sha256: selectedGlbSha256, camera, validation,
      manifest: { path: relativePath, sha256: sha256(bytes) },
      validation_report: { path: validationRelativePath, sha256: sha256(validationBytes) },
    };
    memoryViews[name] = {
      image: { path: imagePath, sha256: sha256(imageBytes) },
      manifest: { path, sha256: sha256(bytes) }, validation: { path: validationPath, sha256: sha256(validationBytes) },
      selected_glb_sha256: selectedGlbSha256,
    };
  }
  const viewer = {};
  for (const [key, file, content] of [["html", "index.html", "<html>technical viewer</html>"], ["app", "app.js", "globalThis.technical=true;"], ["config", "config.json", JSON.stringify({ cameras: { views: technicalCameras } })]]) {
    const path = join(deliveryRoot, "viewer", file), bytes = Buffer.from(content);
    await mkdir(join(deliveryRoot, "viewer"), { recursive: true }); await writeFile(path, bytes);
    viewer[key] = { path: join("viewer", file), sha256: sha256(bytes) };
  }
  const screenshots = {};
  for (const [key, file] of [["initial", "viewer-initial.png"], ["interacted", "viewer-interacted.png"]]) {
    const path = join(deliveryRoot, "browser-verification", file), bytes = Buffer.from("technical-browser-" + key);
    await mkdir(join(deliveryRoot, "browser-verification"), { recursive: true }); await writeFile(path, bytes);
    screenshots[key] = { path, sha256: sha256(bytes) };
  }
  const browserCameras = presentationCameraPresets(technicalCameras);
  const browser = {
    schema_version: "arr.elevation3d.browser-verification.v1", page_loaded: true, activated_views: VIEW_NAMES,
    camera_presets: Object.fromEntries(VIEW_NAMES.map((name) => [name, deriveExpectedCameraContract({ name, preset: browserCameras[name], buildingBounds: authority.building_bounds })])),
    camera_building_bounds: Object.fromEntries(VIEW_NAMES.map((name) => [name, authority.building_bounds])),
    console_errors: [], blocked_external_requests: [], glb_load_count: 1, screenshots,
    material_stability: { transparent_depth_writers: 0, facade_detail_meshes: 1, polygon_offset_facade_details: 1, deterministic_render_order: true },
    settled_frames_identical: true, settled_frame_hashes: ["a".repeat(64), "a".repeat(64), "a".repeat(64)],
  };
  const browserPath = join(deliveryRoot, "browser-verification", "browser-verification.json"), browserBytes = Buffer.from(JSON.stringify(browser));
  await writeFile(browserPath, browserBytes);
  const validation = { schema_version: "arr.elevation3d.all-views-validation.v1", accepted: true, codes: [] };
  const validationPath = join(deliveryRoot, "validation.json"), validationBytes = Buffer.from(JSON.stringify(validation));
  await writeFile(validationPath, validationBytes);
  const manifest = {
    schema_version: "arr.elevation3d.all-views.v1", selected_glb: { path: "enriched.glb", sha256: selectedGlbSha256 },
    views, validation, verified_evidence: { viewer }, viewer: { path: "viewer/index.html", config_sha256: viewer.config.sha256 },
  };
  const manifestPath = join(deliveryRoot, "all-views-manifest.json"), manifestBytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(manifestPath, manifestBytes);
  return {
    run_dir: deliveryRoot, manifest, validation, views,
    memory_record: {
      schema_version: "arr.elevation3d.final-delivery-memory.v1",
      selected_glb: { path: selectedPath, sha256: selectedGlbSha256 },
      manifest: { path: manifestPath, sha256: sha256(manifestBytes) }, validation: { path: validationPath, sha256: sha256(validationBytes) },
      viewer: Object.fromEntries(Object.entries(viewer).map(([key, ref]) => [key, { path: join(deliveryRoot, ref.path), sha256: ref.sha256 }])),
      browser_verification: { path: browserPath, sha256: sha256(browserBytes), screenshots }, views: memoryViews,
    },
  };
}
async function renderDurablePresentation(options) {
  const selectedGlbSha256 = sha256(GLB), cameras = presentationCameraPresets(options.cameras);
  const buildingBounds = { center: [5, 4, 6], radius: Math.hypot(10, 8, 12) * 0.75 };
  await mkdir(options.runDir, { recursive: true });
  const browserGlbPath = join(options.runDir, "textured.glb"); await writeFile(browserGlbPath, GLB);
  const viewer = {};
  for (const [key, file, content] of [["html", "index.html", "<html>presentation viewer</html>"], ["app", "app.js", "globalThis.presentation=true;"], ["config", "config.json", JSON.stringify({ cameras: { views: cameras } })]]) {
    const path = join(options.runDir, "viewer", file), bytes = Buffer.from(content);
    await mkdir(join(options.runDir, "viewer"), { recursive: true }); await writeFile(path, bytes);
    viewer[key] = { path, sha256: sha256(bytes) };
  }
  const views = {}, artifacts = {};
  for (const [index, name] of VIEW_NAMES.entries()) {
    const directory = join(options.runDir, "views", name); await mkdir(directory, { recursive: true });
    const image = Buffer.from("presentation-view-" + index), mask = Buffer.from("presentation-mask-" + index);
    const path = join(directory, name + ".png"), maskPath = join(directory, name + "-semantic-roles.png");
    await writeFile(path, image); await writeFile(maskPath, mask);
    const expected = deriveExpectedCameraContract({ name, preset: cameras[name], buildingBounds });
    views[name] = {
      path, sha256: sha256(image), semanticRoleMaskPath: maskPath, semanticRoleMaskSha256: sha256(mask), selectedGlbSha256,
      cameraEvidence: { building_bounds: buildingBounds, expected, actual: structuredClone(expected), expected_hash: cameraContractHash(expected), actual_hash: cameraContractHash(expected) },
    };
    artifacts["view_" + name] = { path, sha256: sha256(image) };
    artifacts["semantic_role_mask_" + name] = { path: maskPath, sha256: sha256(mask) };
  }
  for (const [key, file, value] of [
    ["render_style", "render-style.json", { id: "competition-daylight-v1" }],
    ["presentation_evidence", "presentation-evidence.json", { schema_version: "fixture-presentation-evidence.v1", views: {} }],
    ["semantic_role_evidence", "semantic-role-evidence.json", { schema_version: "fixture-semantic-role-evidence.v1", views: {} }],
    ["baseline_comparison", "baseline-comparison.json", { schema_version: "fixture-baseline-comparison.v1", status: "not_compared", views: {} }],
  ]) {
    const path = join(options.runDir, file), bytes = Buffer.from(JSON.stringify(value)); await writeFile(path, bytes);
    artifacts[key] = { path, sha256: sha256(bytes) };
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
  await writeFile(join(options.runDir, "render-validation.json"), JSON.stringify(report));
  return report;
}
export const fixtureFactory = createFacadeAgentDependencyFactory(async (config) => {
  const failure = process.env.FACADE_TEST_FAILURE;
  if (failure) { const error = new Error("injected boundary failure"); error.code = failure; throw error; }
  const ledgerRoot = join(config.outputRoot, ".fixture-ledger", config.runId);
  await mkdir(ledgerRoot, { recursive: true });
  const ledger = createPaidOperationLedger(join(ledgerRoot, "paid.json"), { approvedRoot: ledgerRoot });
  const providers = Object.fromEntries(config.providers.map((provider) => [provider, createFacadeFixtureTransport({
    buildRequest({ evidence, brief }) { return { provider, fingerprint: sha256(stableJson({ provider, evidence: evidence.manifestSha256, brief: brief.id })) }; },
    async generate({ request, submission }) { if (!consumePaidOperationSubmissionCapability(submission, { requestKey: request.fingerprint, provider, kind: "image-generation" })) throw new Error("submission rejected"); await note("generate:" + provider); if (process.env.FACADE_TEST_PROVIDER_FAILURE) throw new FacadeProviderError(process.env.FACADE_TEST_PROVIDER_FAILURE, "fixture provider failure", { provider, stage: "generate", definitiveNonSubmission: true }); return { bytes: PNG, mimeType: "image/png", remoteId: "fixture-" + provider, actualUsd: 0 }; }
  })]));
  const grammarModels = { "byteplus-seed-mini": "seed-2-0-mini-260428", "openai-gpt-5.5": "gpt-5.5" };
  const grammarId = config.grammarProvider;
  const grammarModel = grammarModels[grammarId];
  const grammarProvider = createFacadeFixtureTransport({
    id: grammarId, model: grammarModel,
    async extract({ provider, request, submission }) {
      if (grammarId !== "openai-gpt-5.5" && !consumePaidOperationSubmissionCapability(submission, { requestKey: request.fingerprint, provider: grammarId, kind: "grammar-extraction" })) throw new Error("grammar submission rejected");
      await note("grammar:" + (provider ?? "openai"));
      return { provider: grammarId, resolvedModel: grammarModel, transport: "fixture", requestFingerprint: request.fingerprint, grammarCandidate: grammar, remoteId: "grammar-" + (provider ?? "openai"), actualUsd: 0 };
    }
  });
  const score = async ({ provider }) => process.env.FACADE_TEST_REJECT === "1"
    ? ({ status: "rejected", accepted: false, provider, reason: "FIXTURE_REJECTED" })
    : ({ status: "scored", accepted: true, provider, score: provider === "gpt-image-2" ? 91 : 80, sha256: sha256(provider) });
  return {
    signal: config.signal,
    loadCandidate: async () => loadedCandidate,
    buildEvidence: async ({ runDir }) => { if (process.env.FACADE_TEST_EVIDENCE_FAILURE) throw new Error("fixture crash during evidence"); return { manifest: { candidate_id: "creative-020" }, manifestPath: join(runDir, "evidence", "manifest.json"), manifestSha256: "e".repeat(64) }; },
    providers, grammarProvider, ledger, score,
    build: async ({ provider, versionId, runDir }) => { await note("build:" + provider); const dir = join(runDir, "artifacts", provider); await mkdir(dir, { recursive: true }); const path = join(dir, versionId + ".glb"); await writeFile(path, GLB); return { artifact: { path, sha256: sha256(GLB) } }; },
    validate: async ({ provider, artifact }) => { await note("validate:" + provider); return { accepted: true, codes: [], metrics: {}, artifacts: { glb: artifact.path, glb_sha256: artifact.sha256 } }; },
    renderDelivery: async ({ deliveryRoot, artifact }) => writeAcceptedTechnicalDelivery(deliveryRoot, artifact.sha256),
    renderPresentation: async ({ runDir, presentationRoot, candidateId, candidateSha256, provider, selectedVersion, artifact, validation, validationReceipt, technicalDelivery, input, signal, lifecycle }) => {
      if (process.env.FACADE_TEST_TAMPER_TECHNICAL === "delete-front-detail") await rm(join(technicalDelivery.run_dir, "views", "front", "view.json"));
      return deliverFacadeFinalPresentation({
        runDir, presentationRoot, candidateId, candidateSha256, provider, selectedVersion,
        artifact, validation, validationReceipt, technicalDelivery, input, signal, lifecycle,
        deps: { renderEmbeddedPbrViews: renderDurablePresentation },
      });
    }
  };
});
registerHooks({ resolve(specifier, context, nextResolve) { const resolved = nextResolve(specifier, context); if (resolved.url === ${JSON.stringify(cliUrl)} && context.parentURL === ${JSON.stringify(scriptUrl)}) return { url: ${JSON.stringify(shimUrl)}, shortCircuit: true }; return resolved; } });
`);
});

after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

function invoke(args: string[], env: Record<string, string> = {}) {
	return spawnSync(process.execPath, [script, ...args], {
		cwd: projectRoot,
		encoding: "utf8",
		env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, ...env },
	});
}

function invokeProduction(args: string[]) {
	return spawnSync(process.execPath, [script, ...args], {
		cwd: projectRoot, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "", OPENAI_API_KEY: "", GEMINI_API_KEY: "" },
	});
}

async function minimalDataset(root: string) {
	const mass = join(root, "candidates", "creative-020", "mass");
	await mkdir(join(mass, "mesh"), { recursive: true });
	await mkdir(join(mass, "elevation-research"), { recursive: true });
	await writeFile(join(root, "candidates", "creative-020", "candidate.json"), JSON.stringify({ candidate_id: "creative-020" }));
	await writeFile(join(mass, "manifest.json"), JSON.stringify({ identity: { candidate_id: "creative-020", geometry_hash: "fixture" }, artifacts: {} }));
	await writeFile(join(mass, "mesh", "indexed-mesh.json"), JSON.stringify({ identity: { geometry_hash: "fixture" }, vertices: [], triangles: [] }));
	for (const name of ["camera-poses.json", "floor-guides.json", "facade-planes.json", "surface-normals.json"]) {
		await writeFile(join(mass, "elevation-research", name), "{}");
	}
}

async function snapshotTree(root: string): Promise<any> {
	const entries: any[] = [];
	async function visit(directory: string, prefix = "") {
		for (const name of (await readdir(directory)).sort()) {
			const path = join(directory, name);
			const relative = prefix ? `${prefix}/${name}` : name;
			const info = await stat(path);
			if (info.isDirectory()) { entries.push({ path: relative, type: "directory", mtimeMs: info.mtimeMs }); await visit(path, relative); }
			else entries.push({ path: relative, type: "file", mtimeMs: info.mtimeMs, bytes: (await readFile(path)).toString("base64") });
		}
	}
	await visit(root);
	return entries;
}

function base(root: string, runId: string) {
	return [
		"--candidate", "creative-020", "--brief", "brick-punched-window-v1",
		"--dataset-root", root, "--output-root", join(root, "output"), "--run-id", runId,
		"--providers", "gpt-image-2,nano-banana-pro",
		"--image-budget-gpt-image-2", "1", "--image-budget-nano-banana-pro", "1", "--grammar-budget", "1",
	];
}

test("canonical router flags persist the selected routes and exact confirmation without exposing environment secrets", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-cli-canonical-router-")); roots.push(root);
	const secrets = {
		OPENAI_API_KEY: "sk-task6-openai-secret",
		ARK_API_KEY: "task6-byteplus-secret",
		DASHSCOPE_API_KEY: "task6-dashscope-secret",
		GEMINI_API_KEY: "task6-gemini-secret",
	};
	const result = invoke([
		"run", "--candidate", "creative-020", "--brief", "brick-punched-window-v1",
		"--dataset-root", root, "--output-root", join(root, "output"), "--run-id", "router-cli-001",
		"--image-provider", "seedream-5-pro", "--image-budget", "seedream-5-pro=0.06",
		"--grammar-provider", "byteplus-seed-mini", "--grammar-budget", "0.01",
		"--confirm-live", "--confirm-total-usd", "0.07",
	], secrets);
	assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
	const summary = JSON.parse(result.stdout);
	assert.deepEqual(summary.router, { image_providers: ["seedream-5-pro"], grammar_provider: "byteplus-seed-mini" });
	const envelope = JSON.parse(await readFile(join(root, "output", "creative-020", "router-cli-001", "facade-agent-config.json"), "utf8"));
	assert.deepEqual(envelope.config.imageProviders, ["seedream-5-pro"]);
	assert.equal(envelope.config.grammarProvider, "byteplus-seed-mini");
	assert.deepEqual(envelope.config.imageBudgetUsd, { "seedream-5-pro": 0.06 });
	assert.equal(envelope.config.grammarBudgetUsd, 0.01);
	assert.equal(envelope.config.confirmedTotalUsd, 0.07);
	const status = invoke(["status", "--run-dir", join(root, "output", "creative-020", "router-cli-001")], secrets);
	assert.equal(status.status, 0, `${status.stderr}\n${status.stdout}`);
	assert.deepEqual(JSON.parse(status.stdout).router, { image_providers: ["seedream-5-pro"], grammar_provider: "byteplus-seed-mini" });
	for (const secret of Object.values(secrets)) assert.doesNotMatch(`${result.stdout}\n${result.stderr}\n${status.stdout}\n${status.stderr}`, new RegExp(secret));
});

test("CLI no-selection live defaults are Seedream plus BytePlus with exact 0.07 confirmation", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-cli-default-router-")); roots.push(root);
	const result = invoke([
		"run", "--candidate", "creative-020", "--brief", "brick-punched-window-v1",
		"--dataset-root", root, "--output-root", join(root, "output"), "--run-id", "default-router-live",
		"--confirm-live", "--confirm-total-usd", "0.07",
	]);
	assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
	const envelope = JSON.parse(await readFile(join(root, "output", "creative-020", "default-router-live", "facade-agent-config.json"), "utf8"));
	assert.deepEqual(envelope.config.imageProviders, ["seedream-5-pro"]);
	assert.equal(envelope.config.grammarProvider, "byteplus-seed-mini");
	assert.deepEqual(envelope.config.imageBudgetUsd, { "seedream-5-pro": 0.06 });
	assert.deepEqual(envelope.config.imageBudgetMicros, { "seedream-5-pro": 60_000 });
	assert.equal(envelope.config.grammarBudgetUsd, 0.01);
	assert.equal(envelope.config.grammarBudgetMicros, 10_000);
	assert.equal(envelope.config.runBudgetMicros, 70_000);
	assert.equal(envelope.config.confirmedTotalMicros, 70_000);
});

test("CLI fixture fails closed when a durable technical detail record is deleted", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-cli-technical-baseline-tamper-")); roots.push(root);
	const runId = "technical-baseline-tamper";
	const result = invoke(["run", ...base(root, runId)], { FACADE_TEST_TAMPER_TECHNICAL: "delete-front-detail" });
	assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
	assert.equal(JSON.parse(result.stdout).status, "presentation-failed");
	const run = JSON.parse(await readFile(join(root, "output", "creative-020", runId, "run.json"), "utf8"));
	assert.equal(run.presentation_execution.status, "failed");
	assert.equal(run.presentation_execution.failure.code, "FACADE_PRESENTATION_TECHNICAL_BINDING_MISMATCH");
});

test("repeatable canonical image-provider flags preserve caller order", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-cli-router-order-")); roots.push(root);
	const result = invoke([
		"preflight", "--candidate", "creative-020", "--brief", "brick-punched-window-v1",
		"--dataset-root", root, "--output-root", join(root, "output"), "--run-id", "router-order",
		"--image-provider", "qwen-image-2", "--image-provider", "seedream-5-pro",
		"--image-budget", "qwen-image-2=0.02", "--image-budget", "seedream-5-pro=0.06",
		"--grammar-provider", "byteplus-seed-mini", "--grammar-budget", "0.01",
	]);
	assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
	const envelope = JSON.parse(await readFile(join(root, "output", "creative-020", "router-order", "facade-agent-config.json"), "utf8"));
	assert.deepEqual(envelope.config.imageProviders, ["qwen-image-2", "seedream-5-pro"]);
	assert.deepEqual(JSON.parse(result.stdout).router.image_providers, ["qwen-image-2", "seedream-5-pro"]);
});

test("legacy providers alias maps to canonical image selection and conflicting representations fail locally", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-cli-router-alias-")); roots.push(root);
	const legacy = invoke(["preflight", ...base(root, "legacy-router")]);
	assert.equal(legacy.status, 0, `${legacy.stderr}\n${legacy.stdout}`);
	const envelope = JSON.parse(await readFile(join(root, "output", "creative-020", "legacy-router", "facade-agent-config.json"), "utf8"));
	assert.deepEqual(envelope.config.imageProviders, ["gpt-image-2", "nano-banana-pro"]);
	assert.deepEqual(JSON.parse(legacy.stdout).router.image_providers, ["gpt-image-2", "nano-banana-pro"]);

	const conflictRun = "conflicting-router";
	const conflict = invoke([
		"preflight", ...base(root, conflictRun),
		"--image-provider", "seedream-5-pro", "--image-budget", "seedream-5-pro=0.06",
	]);
	assert.equal(conflict.status, 30);
	await assert.rejects(() => readFile(join(root, "output", "creative-020", conflictRun, "facade-agent-config.json")), /ENOENT/);
});

test("canonical router rejects missing and unselected positive image budgets before persistence", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-cli-router-budget-")); roots.push(root);
	const prefix = ["preflight", "--candidate", "creative-020", "--brief", "brick-punched-window-v1", "--dataset-root", root, "--output-root", join(root, "output")];
	const missing = invoke([...prefix, "--run-id", "missing-selected-budget", "--image-provider", "seedream-5-pro", "--grammar-provider", "byteplus-seed-mini", "--grammar-budget", "0.01"]);
	assert.equal(missing.status, 30);
	const unselected = invoke([...prefix, "--run-id", "unselected-positive-budget", "--image-provider", "seedream-5-pro", "--image-budget", "seedream-5-pro=0.06", "--image-budget", "qwen-image-2=0.02", "--grammar-provider", "byteplus-seed-mini", "--grammar-budget", "0.01"]);
	assert.equal(unselected.status, 30);
	for (const runId of ["missing-selected-budget", "unselected-positive-budget"]) {
		await assert.rejects(() => readFile(join(root, "output", "creative-020", runId, "facade-agent-config.json")), /ENOENT/);
	}
});

test("canonical live confirmation compares exact decimal micros", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-cli-router-confirm-")); roots.push(root);
	const runId = "inexact-router-total";
	const result = invoke([
		"run", "--candidate", "creative-020", "--brief", "brick-punched-window-v1",
		"--dataset-root", root, "--output-root", join(root, "output"), "--run-id", runId,
		"--image-provider", "seedream-5-pro", "--image-budget", "seedream-5-pro=0.06",
		"--grammar-provider", "byteplus-seed-mini", "--grammar-budget", "0.01",
		"--confirm-live", "--confirm-total-usd", "0.070001",
	]);
	assert.equal(result.status, 30);
	assert.deepEqual(JSON.parse(result.stdout), { state: "error", category: "configuration", code: "LIVE_COST_CONFIRMATION_INVALID" });
	await assert.rejects(() => readFile(join(root, "output", "creative-020", runId, "facade-agent-config.json")), /ENOENT/);
});

test("accepts repeatable provider-keyed budgets and exact decimal live confirmation for three providers", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-cli-provider-budgets-")); roots.push(root);
	const args = [
		"preflight", "--candidate", "creative-020", "--brief", "brick-punched-window-v1",
		"--dataset-root", root, "--output-root", join(root, "output"), "--run-id", "provider-budgets",
		"--providers", "gpt-image-2,seedream-5-pro,qwen-image-2",
		"--image-budget", "gpt-image-2=0.10",
		"--image-budget", "seedream-5-pro=0.20",
		"--image-budget", "qwen-image-2=0.30",
		"--grammar-budget", "0.10",
		"--confirm-live", "--confirm-total-usd", "0.70",
	];
	const result = invoke(args);
	assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
	const envelope = JSON.parse(await readFile(join(root, "output", "creative-020", "provider-budgets", "facade-agent-config.json"), "utf8"));
	assert.deepEqual(envelope.config.providers, ["gpt-image-2", "seedream-5-pro", "qwen-image-2"]);
	assert.deepEqual(envelope.config.imageBudgetUsd, { "gpt-image-2": 0.1, "seedream-5-pro": 0.2, "qwen-image-2": 0.3 });
	assert.equal(envelope.config.runBudgetUsd, 0.7);
});

test("CLI emits one safe JSON document, progress on stderr, and stable outcome codes", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-cli-outcomes-")); roots.push(root);
	const success = invoke(["run", ...base(root, "success")]);
	assert.equal(success.status, 0, `${success.stderr}\n${success.stdout}`);
	assert.equal(JSON.parse(success.stdout).state, "accepted");
	assert.match(success.stderr, /facade-agent.*run/i);
	assert.equal(success.stdout.trim().split(/\r?\n/).filter((line) => line.startsWith("{")).length, 1);
	assert.doesNotMatch(success.stdout, new RegExp(root.replaceAll("\\", "\\\\"), "i"));

	const rejected = invoke(["run", ...base(root, "rejected")], { FACADE_TEST_REJECT: "1" });
	assert.equal(rejected.status, 20);
	assert.equal(JSON.parse(rejected.stdout).state, "rejected");
	const configError = invoke(["preflight", ...base(root, "config"), "--candidate", "wrong"]);
	assert.equal(configError.status, 30);
	const transportError = invoke(["run", ...base(root, "transport")], { FACADE_TEST_PROVIDER_FAILURE: "PROVIDER_TRANSPORT_FAILED" });
	assert.equal(transportError.status, 40, transportError.stdout);
	const securityError = invoke(["preflight", ...base(root, "security")], { FACADE_TEST_FAILURE: "FACADE_AGENT_PATH_UNSAFE" });
	assert.equal(securityError.status, 50);
	const internalError = invoke(["preflight", ...base(root, "internal")], { FACADE_TEST_FAILURE: "UNEXPECTED_FIXTURE_FAILURE" });
	assert.equal(internalError.status, 70);
});

test("each stage subcommand delegates to the harness and refuses corrupted upstream state", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-cli-stages-")); roots.push(root);
	for (const stage of ["preflight", "evidence", "generate", "grammar", "build", "validate", "compare"]) {
		const result = invoke([stage, ...base(root, `stage-${stage}`)]);
		assert.equal(result.status, 0, `${stage}: ${result.stderr}`);
		assert.equal(JSON.parse(result.stdout).stage, stage);
	}
	const runId = "tamper-chain";
	assert.equal(invoke(["preflight", ...base(root, runId)]).status, 0);
	const manifestPath = join(root, "output", "creative-020", runId, "stages", "preflight.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	manifest.output.candidate_sha256 = "0".repeat(64);
	await writeFile(manifestPath, JSON.stringify(manifest));
	const next = invoke(["evidence", ...base(root, runId)]);
	assert.equal(next.status, 50);
});

test("run refuses overwrite, status is read-only, and resume uses only persisted config", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-cli-resume-")); roots.push(root);
	const args = base(root, "persisted");
	assert.equal(invoke(["preflight", ...args]).status, 0);
	const runDir = join(root, "output", "creative-020", "persisted");
	const status = invoke(["status", "--run-dir", runDir]);
	assert.equal(status.status, 0);
	assert.equal(JSON.parse(status.stdout).state, "running");
	const resumed = invoke(["resume", "--run-dir", runDir]);
	assert.equal(resumed.status, 0, resumed.stderr);
	assert.equal(JSON.parse(resumed.stdout).state, "accepted");
	const duplicate = invoke(["run", ...args]);
	assert.equal(duplicate.status, 30);
});

test("resume accepts a verified pre-router config envelope without rewriting it and rejects semantic tampering", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-cli-legacy-config-resume-")); roots.push(root);
	const runId = "legacy-config-resume";
	assert.equal(invoke(["run", ...base(root, runId)]).status, 0);
	const runDir = join(root, "output", "creative-020", runId);
	const configPath = join(runDir, "facade-agent-config.json");
	const canonical = JSON.parse(await readFile(configPath, "utf8"));
	const { schemaVersion: _schemaVersion, imageProviders: _imageProviders, grammarProvider: _grammarProvider, ...legacyConfig } = canonical.config;
	const legacyEnvelope = {
		schema_version: "arr.elevation3d.facade-agent-config.v1",
		config: legacyConfig,
		config_sha256: sha256(stableJson(legacyConfig)),
	};
	const legacyBytes = `${JSON.stringify(legacyEnvelope, null, 2)}\n`;
	await writeFile(configPath, legacyBytes);
	const callLog = join(root, "resume-calls.log");
	const resumed = invoke(["resume", "--run-dir", runDir], { FACADE_TEST_CALL_LOG: callLog });
	assert.equal(resumed.status, 0, `${resumed.stderr}\n${resumed.stdout}`);
	assert.equal(JSON.parse(resumed.stdout).state, "accepted");
	assert.equal(await readFile(configPath, "utf8"), legacyBytes);
	await assert.rejects(() => readFile(callLog), /ENOENT/);

	legacyEnvelope.config.grammarBudgetUsd = 7;
	legacyEnvelope.config_sha256 = sha256(stableJson(legacyEnvelope.config));
	await writeFile(configPath, `${JSON.stringify(legacyEnvelope, null, 2)}\n`);
	const tampered = invoke(["resume", "--run-dir", runDir], { FACADE_TEST_CALL_LOG: callLog });
	assert.equal(tampered.status, 50, `${tampered.stderr}\n${tampered.stdout}`);
	assert.deepEqual(JSON.parse(tampered.stdout), { state: "error", category: "security", code: "FACADE_AGENT_RESUME_MISMATCH" });
	await assert.rejects(() => readFile(callLog), /ENOENT/);
});

test("resume retains normalized configuration when execution crashes after durable state", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-cli-crash-resume-")); roots.push(root);
	const runId = "crash-resume";
	const failed = invoke(["evidence", ...base(root, runId)], { FACADE_TEST_EVIDENCE_FAILURE: "1" });
	assert.equal(failed.status, 70);
	const runDir = join(root, "output", "creative-020", runId);
	const resumed = invoke(["resume", "--run-dir", runDir]);
	assert.equal(resumed.status, 0, resumed.stderr);
	assert.equal(JSON.parse(resumed.stdout).state, "accepted");
});

test("dry-run cannot confirm live and makes zero provider calls", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-cli-dry-")); roots.push(root);
	const log = join(root, "calls.log");
	const dry = invoke(["run", ...base(root, "dry"), "--dry-run"], { FACADE_TEST_CALL_LOG: log });
	assert.equal(dry.status, 0, dry.stderr);
	await assert.rejects(() => readFile(log), /ENOENT/);
	const unsafe = invoke(["run", ...base(root, "dry-live"), "--dry-run", "--confirm-live"]);
	assert.equal(unsafe.status, 30);
});

test("documented cost-ceiling aliases drive zero-fetch preflight and reject mixed aliases before persistence", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-cli-cost-aliases-")); roots.push(root);
	const log = join(root, "calls.log");
	const aliases = [
		"--candidate", "creative-020", "--brief", "brick-punched-window-v1",
		"--dataset-root", root, "--output-root", join(root, "output"), "--run-id", "alias-dry",
		"--providers", "gpt-image-2,nano-banana-pro",
		"--gpt-image-max-usd", "1", "--nano-banana-max-usd", "1", "--grammar-max-usd", "1", "--dry-run",
	];
	const dry = invoke(["preflight", ...aliases], { FACADE_TEST_CALL_LOG: log });
	assert.equal(dry.status, 0, `${dry.stderr}\n${dry.stdout}`);
	assert.equal(JSON.parse(dry.stdout).stage, "preflight");
	await assert.rejects(() => readFile(log), /ENOENT/);
	const envelope = JSON.parse(await readFile(join(root, "output", "creative-020", "alias-dry", "facade-agent-config.json"), "utf8"));
	assert.deepEqual(envelope.config.imageBudgetUsd, { "gpt-image-2": 1, "nano-banana-pro": 1 });
	assert.equal(envelope.config.grammarBudgetUsd, 1);

	const mixedRun = "mixed-aliases";
	const mixed = invoke(["preflight", ...base(root, mixedRun), "--gpt-image-max-usd", "2", "--dry-run"], { FACADE_TEST_CALL_LOG: log });
	assert.equal(mixed.status, 30);
	await assert.rejects(() => readFile(join(root, "output", "creative-020", mixedRun, "facade-agent-config.json")), /ENOENT/);
	await assert.rejects(() => readFile(log), /ENOENT/);
});

test("live intent without every exact ceiling and total confirmation fails before transport", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-cli-live-gate-")); roots.push(root);
	const log = join(root, "calls.log");
	const args = [
		"run", "--candidate", "creative-020", "--brief", "brick-punched-window-v1",
		"--dataset-root", root, "--output-root", join(root, "output"), "--run-id", "unapproved-live",
		"--providers", "gpt-image-2,nano-banana-pro", "--gpt-image-max-usd", "1", "--nano-banana-max-usd", "1",
		"--grammar-max-usd", "1", "--confirm-live",
	];
	const rejected = invoke(args, { FACADE_TEST_CALL_LOG: log });
	assert.equal(rejected.status, 30);
	assert.equal(JSON.parse(rejected.stdout).category, "configuration");
	await assert.rejects(() => readFile(log), /ENOENT/);
	await assert.rejects(() => readFile(join(root, "output", "creative-020", "unapproved-live", "facade-agent-config.json")), /ENOENT/);
});

test("normal CLI preflight constructs production dependencies without secrets or transport", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-cli-production-")); roots.push(root);
	const datasetRoot = resolve("D:/Data/50_ELE/MAAS_ELEVATION_TEST_SET_20260730");
	const productionArgs = (runId: string) => [
		"--candidate", "creative-020", "--brief", "brick-punched-window-v1",
		"--dataset-root", datasetRoot, "--output-root", join(root, "output"), "--run-id", runId,
		"--providers", "gpt-image-2,nano-banana-pro",
		"--image-budget-gpt-image-2", "1", "--image-budget-nano-banana-pro", "1", "--grammar-budget", "1",
	];
	const result = invokeProduction(["preflight", ...productionArgs("production-preflight")]);
	assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
	assert.equal(JSON.parse(result.stdout).stage, "preflight");
	const receipt = JSON.parse(await readFile(join(root, "output", "creative-020", "production-preflight", "stages", "preflight-receipt.json"), "utf8"));
	assert.equal(receipt.capabilities["gpt-image-2"].code, "PROVIDER_CREDENTIALS_MISSING");
	assert.equal(receipt.capabilities["nano-banana-pro"].code, "PROVIDER_CREDENTIALS_MISSING");
	assert.equal(receipt.capabilities["grammar:openai-gpt-5.5"].code, "GRAMMAR_CREDENTIALS_MISSING");

	const evidence = invokeProduction(["evidence", ...productionArgs("production-evidence")]);
	assert.equal(evidence.status, 0, `${evidence.stderr}\n${evidence.stdout}`);
	assert.equal(JSON.parse(evidence.stdout).stage, "evidence");
});

test("resume fails closed when persisted normalized configuration is tampered", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-cli-config-tamper-")); roots.push(root);
	const runId = "config-tamper";
	assert.equal(invoke(["preflight", ...base(root, runId)]).status, 0);
	const runDir = join(root, "output", "creative-020", runId);
	const configPath = join(runDir, "facade-agent-config.json");
	const config = JSON.parse(await readFile(configPath, "utf8"));
	config.config.grammarBudgetUsd = 999;
	await writeFile(configPath, JSON.stringify(config));
	assert.equal(invoke(["resume", "--run-dir", runDir]).status, 50);
});

test("status verifies config integrity and remains byte-for-byte read-only", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-cli-status-integrity-")); roots.push(root);
	const runId = "status-integrity";
	assert.equal(invoke(["preflight", ...base(root, runId)]).status, 0);
	const runDir = join(root, "output", "creative-020", runId);
	const before = await snapshotTree(runDir);
	const status = invoke(["status", "--run-dir", runDir]);
	assert.equal(status.status, 0, status.stderr);
	assert.deepEqual(await snapshotTree(runDir), before);

	const configPath = join(runDir, "facade-agent-config.json");
	const envelope = JSON.parse(await readFile(configPath, "utf8"));
	envelope.config.grammarBudgetUsd = 999;
	await writeFile(configPath, JSON.stringify(envelope));
	const tampered = invoke(["status", "--run-dir", runDir]);
	assert.equal(tampered.status, 50);
	assert.deepEqual(JSON.parse(tampered.stdout), { state: "error", category: "security", code: "FACADE_AGENT_STATE_UNCERTAIN" });
});

test("status rejects missing and relocated config envelopes before reading run status", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-cli-status-binding-")); roots.push(root);
	assert.equal(invoke(["preflight", ...base(root, "status-missing")]).status, 0);
	const missingRun = join(root, "output", "creative-020", "status-missing");
	await rm(join(missingRun, "facade-agent-config.json"));
	assert.equal(invoke(["status", "--run-dir", missingRun]).status, 50);

	assert.equal(invoke(["preflight", ...base(root, "status-source")]).status, 0);
	const sourceRun = join(root, "output", "creative-020", "status-source");
	const relocatedRun = join(root, "output", "creative-020", "status-relocated");
	await cp(sourceRun, relocatedRun, { recursive: true });
	assert.equal(invoke(["status", "--run-dir", relocatedRun]).status, 50);
});
