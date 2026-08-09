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
	const document = new Document();
	document.createScene("Scene");
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
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { sha256, stableJson } from ${JSON.stringify(moduleUrl("plugins/elevation-3d/lib/core.mjs"))};
import { createFacadeAgentDependencyFactory } from ${JSON.stringify(cliUrl)};
import { createFacadeFixtureTransport } from ${JSON.stringify(moduleUrl("plugins/elevation-3d/lib/facade-agent/fixture-transport.mjs"))};
import { FacadeProviderError } from ${JSON.stringify(moduleUrl("plugins/elevation-3d/lib/facade-agent/provider.mjs"))};
import { createPaidOperationLedger, consumePaidOperationSubmissionCapability } from ${JSON.stringify(moduleUrl("plugins/elevation-3d/lib/facade-agent/paid-operation-ledger.mjs"))};
const GLB = Buffer.from(${JSON.stringify(glb)}, "base64");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const grammar = { system: "brick-punched-window-v1", surfaces: ["front", "right", "back", "left"], materials: ["brick", "precast", "window-frame", "glass"], corner_datum_m: 0, bay_width_m: 2.4, window_width_m: 1.4, window_height_m: 1.8, sill_height_m: 0.8, reveal_depth_m: 0.2, frame_width_m: 0.06, lintel_height_m: 0.15, sill_depth_m: 0.1, cladding_depth_m: 0.1, brick_module_m: [0.22, 0.07], confidence: 0.92, unresolved_surfaces: [], floor_elevations_m: [0, 3, 6], facade_lengths_m: { front: 8, right: 6, back: 8, left: 6 } };
const note = async (value) => { if (process.env.FACADE_TEST_CALL_LOG) await appendFile(process.env.FACADE_TEST_CALL_LOG, value + "\\n"); };
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
  const grammarModels = { "byteplus-seed-mini": "seed-2-0-mini-260428", "openai-gpt-5.6": "gpt-5.6" };
  const grammarId = config.grammarProvider;
  const grammarModel = grammarModels[grammarId];
  const grammarProvider = createFacadeFixtureTransport({
    id: grammarId, model: grammarModel,
    async extract({ provider, request, submission }) {
      if (grammarId !== "openai-gpt-5.6" && !consumePaidOperationSubmissionCapability(submission, { requestKey: request.fingerprint, provider: grammarId, kind: "grammar-extraction" })) throw new Error("grammar submission rejected");
      await note("grammar:" + (provider ?? "openai"));
      return { provider: grammarId, resolvedModel: grammarModel, transport: "fixture", requestFingerprint: request.fingerprint, grammarCandidate: grammar, remoteId: "grammar-" + (provider ?? "openai"), actualUsd: 0 };
    }
  });
  const score = async ({ provider }) => process.env.FACADE_TEST_REJECT === "1"
    ? ({ status: "rejected", accepted: false, provider, reason: "FIXTURE_REJECTED" })
    : ({ status: "scored", accepted: true, provider, score: provider === "gpt-image-2" ? 91 : 80, sha256: sha256(provider) });
  return {
    signal: config.signal,
    loadCandidate: async () => ({ candidate: { candidate_id: "creative-020" }, identity: { geometry_hash: "fixture" } }),
    buildEvidence: async ({ runDir }) => { if (process.env.FACADE_TEST_EVIDENCE_FAILURE) throw new Error("fixture crash during evidence"); return { manifest: { candidate_id: "creative-020" }, manifestPath: join(runDir, "evidence", "manifest.json"), manifestSha256: "e".repeat(64) }; },
    providers, grammarProvider, ledger, score,
    build: async ({ provider, versionId, runDir }) => { await note("build:" + provider); const dir = join(runDir, "artifacts", provider); await mkdir(dir, { recursive: true }); const path = join(dir, versionId + ".glb"); await writeFile(path, GLB); return { artifact: { path, sha256: sha256(GLB) } }; },
    validate: async ({ provider, artifact }) => { await note("validate:" + provider); return { accepted: true, codes: [], metrics: {}, artifacts: { glb: artifact.path, glb_sha256: artifact.sha256 } }; },
    renderDelivery: async ({ provider, artifact, deliveryRoot }) => {
      await mkdir(deliveryRoot, { recursive: true });
      const manifest = { selected_glb: { sha256: artifact.sha256 } };
      const manifestPath = join(deliveryRoot, "technical-delivery.json");
      const manifestBytes = Buffer.from(JSON.stringify(manifest));
      await writeFile(manifestPath, manifestBytes);
      return { provider, run_dir: deliveryRoot, manifest, memory_record: { manifest: { path: manifestPath, sha256: sha256(manifestBytes) } } };
    },
    renderPresentation: async ({ artifact, presentationRoot }) => {
      await mkdir(presentationRoot, { recursive: true });
      const presentation = { selected_glb: { sha256: artifact.sha256 } };
      const presentationPath = join(presentationRoot, "presentation.json");
      const presentationBytes = Buffer.from(JSON.stringify(presentation));
      await writeFile(presentationPath, presentationBytes);
      return {
        memory_record: { presentation: { path: presentationPath, sha256: sha256(presentationBytes) }, selected_glb: { sha256: artifact.sha256 } },
        render: { selected_glb: { sha256: artifact.sha256 }, provider_calls: 0, credits_consumed: 0 },
      };
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
	assert.equal(receipt.capabilities["grammar:openai-gpt-5.6"].code, "GRAMMAR_CREDENTIALS_MISSING");

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
