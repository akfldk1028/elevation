import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";

import { sha256, stableJson } from "../plugins/elevation-3d/lib/core.mjs";
import { FacadeProviderError } from "../plugins/elevation-3d/lib/facade-agent/provider.mjs";
import { verifyFacadeEvidencePack } from "../plugins/elevation-3d/lib/facade-agent/evidence.mjs";
import { createFacadeFixtureTransport } from "../plugins/elevation-3d/lib/facade-agent/fixture-transport.mjs";
import { normalizeFacadeGrammarResult } from "../plugins/elevation-3d/lib/facade-agent/providers/grammar/contract.mjs";
import { createProvider as createOpenAIGrammarProvider } from "../plugins/elevation-3d/lib/facade-agent/providers/grammar/openai/adapter.mjs";
import { buildRequest as buildOpenAIRequest, createProvider as createOpenAIProvider } from "../plugins/elevation-3d/lib/facade-agent/providers/openai-image.mjs";
import { buildRequest as buildGeminiRequest, createProvider as createGeminiProvider } from "../plugins/elevation-3d/lib/facade-agent/providers/gemini-image.mjs";
import {
	consumePaidOperationSubmissionCapability,
	createPaidOperationLedger,
} from "../plugins/elevation-3d/lib/facade-agent/paid-operation-ledger.mjs";
import {
	readFacadeAgentStatus,
	runFacadeAgent,
	runFacadeStage,
} from "../plugins/elevation-3d/lib/facade-agent/harness.mjs";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

const PROVIDERS = ["gpt-image-2", "nano-banana-pro"] as const;
const EVIDENCE_SHA = "e".repeat(64);
const GLB_DOCUMENT = new Document();
GLB_DOCUMENT.createScene("Scene");
const GLB_BYTES = Buffer.from(await new NodeIO().writeBinary(GLB_DOCUMENT));
const REPLACEMENT_GLB_DOCUMENT = new Document();
REPLACEMENT_GLB_DOCUMENT.createScene("Replacement");
const REPLACEMENT_GLB_BYTES = Buffer.from(await new NodeIO().writeBinary(REPLACEMENT_GLB_DOCUMENT));
const PROVIDER_PNG = await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 7, g: 8, b: 9 } } }).png().toBuffer();
const VIEW_NAMES = ["front", "right", "back", "left", "top", "axon", "opposite-axon"];
const PASS_NAMES = ["color", "depth", "normal", "edge", "surface-id"];

async function verifiedEvidenceFixture(root: string) {
	const evidenceRoot = join(root, "verified-evidence");
	await mkdir(evidenceRoot, { recursive: true });
	const sourceBytes = Buffer.from("geometry authority fixture");
	const sourcePath = join(root, "source.bin");
	await writeFile(sourcePath, sourceBytes);
	const artifacts: Record<string, any> = {};
	for (const mode of PASS_NAMES) {
		await mkdir(join(evidenceRoot, mode), { recursive: true });
		for (const view of VIEW_NAMES) {
			await writeFile(join(evidenceRoot, mode, `${view}.png`), PROVIDER_PNG);
			artifacts[`${mode}:${view}`] = { path: `${mode}/${view}.png`, sha256: sha256(PROVIDER_PNG), width: 1, height: 1, mode, view };
		}
	}
	await writeFile(join(evidenceRoot, "contact-sheet.png"), PROVIDER_PNG);
	const input = {
		candidate: { candidate_id: "creative-020" }, identity: { geometry_hash: "geometry-fixture" },
		floor_guides: { floor_guides_m: [0, 3] }, facade_planes: { planes: [] }, cameras: { views: [] },
		artifacts: [{ name: "source", path: "source.bin", sha256: sha256(sourceBytes), absolute_path: sourcePath }],
	};
	const manifest = {
		schema_version: "arr.elevation3d.facade-evidence.v1", candidate_id: "creative-020",
		geometry_hash: input.identity.geometry_hash, floor_guides_m: input.floor_guides.floor_guides_m,
		facade_planes_sha256: sha256(stableJson(input.facade_planes)), cameras_sha256: sha256(stableJson(input.cameras)),
		source_artifacts: [{ name: "source", path: "source.bin", sha256: sha256(sourceBytes) }], artifacts,
		contact_sheet: { path: "contact-sheet.png", sha256: sha256(PROVIDER_PNG), width: 1, height: 1 },
	};
	const manifestPath = join(evidenceRoot, "evidence-manifest.json");
	await writeFile(manifestPath, `${stableJson(manifest)}\n`);
	return verifyFacadeEvidencePack({ manifestPath, input });
}

function grammar() {
	return {
		system: "brick-punched-window-v1",
		surfaces: ["front", "right", "back", "left"],
		materials: ["brick", "precast", "window-frame", "glass"],
		corner_datum_m: 0,
		bay_width_m: 2.4,
		window_width_m: 1.4,
		window_height_m: 1.8,
		sill_height_m: 0.8,
		reveal_depth_m: 0.2,
		frame_width_m: 0.06,
		lintel_height_m: 0.15,
		sill_depth_m: 0.1,
		cladding_depth_m: 0.1,
		brick_module_m: [0.22, 0.07],
		confidence: 0.92,
		unresolved_surfaces: [],
		floor_elevations_m: [0, 3, 6],
		facade_lengths_m: { front: 8, right: 6, back: 8, left: 6 },
	};
}

function fixtureGrammarResult(input: any, actualUsd = 0, grammarCandidate = grammar()) {
	assert.equal(consumePaidOperationSubmissionCapability(input.submission, {
		requestKey: input.request.fingerprint,
		provider: "byteplus-seed-mini",
		kind: "grammar-extraction",
	}), true);
	return normalizeFacadeGrammarResult({
		request: input.request,
		provider: "byteplus-seed-mini",
		resolvedModel: "seed-2-0-mini-260428",
		transport: "fixture",
		grammarCandidate,
		remoteId: `grammar-${input.provider}`,
		actualUsd,
		usage: { fixture: true },
	});
}

async function fixture(overrides: any = {}) {
	const selectedProviders = overrides.providers ?? [...PROVIDERS];
	const root = await mkdtemp(join(tmpdir(), "elevation3d-harness-"));
	roots.push(root);
	const outputRoot = join(root, "output");
	await mkdir(outputRoot, { recursive: true });
	const runId = overrides.runId ?? "facade-harness-001";
	const runDir = join(outputRoot, "creative-020", runId);
	const ledgerRoot = join(root, "ledger");
	await mkdir(ledgerRoot, { recursive: true });
	const ledger = createPaidOperationLedger(join(ledgerRoot, "paid.json"), { approvedRoot: ledgerRoot });
	const calls: any = { preflight: [], generate: [], request: [], grammar: [], build: [], validate: [], delivery: [], score: [] };
	const validations = overrides.validations ?? {};
	const scores = overrides.scores ?? { "gpt-image-2": 91, "nano-banana-pro": 95 };
	const scoreAuthorities = new WeakSet<object>();

	const score: any = async ({ provider, validation }: any) => {
		calls.score.push(provider);
		if (validation?.accepted !== true) return Object.freeze({ status: "rejected", accepted: false, provider });
		const result = Object.freeze({ status: "scored", accepted: true, provider, score: scores[provider], sha256: sha256(`${provider}:${scores[provider]}`) });
		scoreAuthorities.add(result);
		return result;
	};
	score.rehydrate = (value: any) => { scoreAuthorities.add(value); return value; };
	score.select = (candidates: any[], tolerance = 0.5) => {
		const authorized = candidates.filter((candidate) => scoreAuthorities.has(candidate) && candidate.accepted === true)
			.sort((left, right) => right.score - left.score || left.provider.localeCompare(right.provider));
		if (!authorized.length) return { status: "no-winner", candidates: [] };
		const review = authorized.filter((candidate) => authorized[0].score - candidate.score <= tolerance);
		if (review.length > 1) return { status: "human-review", candidates: review, tolerance };
		return { status: "winner", provider: authorized[0].provider, candidate: authorized[0], score: authorized[0].score };
	};

	const providers = Object.fromEntries(selectedProviders.map((provider: string) => [provider, createFacadeFixtureTransport({
		preflight({ request, ceilingUsd, estimateUsd }: any) {
			calls.preflight.push({ provider, fingerprint: request.fingerprint, ceilingUsd, estimateUsd });
			return { provider, model: provider, requestBytes: 1, ceilingUsd, estimateUsd, fixture: true };
		},
		buildRequest({ evidence, brief }: any) {
			calls.request.push({ provider, evidenceSha: evidence.manifestSha256, briefId: brief.id });
			return {
				provider,
				fingerprint: sha256(stableJson({ provider, evidenceSha: evidence.manifestSha256, briefId: brief.id })),
				evidenceSha: evidence.manifestSha256,
				briefId: brief.id,
			};
		},
		async generate({ request, submission }: any) {
			assert.equal(consumePaidOperationSubmissionCapability(submission, {
				requestKey: request.fingerprint, provider, kind: "image-generation",
			}), true);
			calls.generate.push(provider);
			if (overrides.generateFailure?.provider === provider) throw overrides.generateFailure.error;
			const bytes = PROVIDER_PNG;
			return { bytes, mimeType: "image/png", remoteId: `fixture-${provider}`, usage: { fixture: true }, actualUsd: overrides.imageCosts?.[provider] ?? 0 };
		},
	})]));
	const grammarProvider = createFacadeFixtureTransport({
		id: "byteplus-seed-mini",
		model: "seed-2-0-mini-260428",
		preflight({ ceilingUsd, estimateUsd }: any) {
			calls.preflight.push({ provider: "byteplus-seed-mini", model: "seed-2-0-mini-260428", ceilingUsd, estimateUsd });
			return { provider: "byteplus-seed-mini", model: "seed-2-0-mini-260428", transport: "fixture", ceilingUsd, estimateUsd };
		},
		async extract(input: any) {
			calls.grammar.push(input.provider);
			if (overrides.grammarFailure) throw overrides.grammarFailure;
			return fixtureGrammarResult(input, overrides.grammarCosts?.[input.provider] ?? 0, overrides.grammarCandidate ?? grammar());
		},
	});

	const deps: any = {
		loadCandidate: async () => ({ candidate: { candidate_id: "creative-020" }, identity: { geometry_hash: "geometry-fixture" } }),
		buildEvidence: async ({ runDir: target }: any) => ({
			manifest: { candidate_id: "creative-020" }, manifestPath: join(target, "evidence", "manifest.json"),
			manifestSha256: EVIDENCE_SHA, contactSheetBytes: Buffer.from("fixture-evidence"),
		}),
		providers,
		grammarProvider,
		build: overrides.build ?? (async ({ provider, versionId, grammar: value, runDir: target }: any) => {
			calls.build.push({ provider, versionId, windowHeight: value.window_height_m });
			const directory = join(target, "fixture-artifacts", provider);
			await mkdir(directory, { recursive: true });
			const path = join(directory, `${versionId}.glb`);
			const bytes = GLB_BYTES;
			await writeFile(path, bytes);
			return { artifact: { path, sha256: sha256(bytes) } };
		}),
		validate: async ({ provider, versionId, artifact }: any) => {
			calls.validate.push({ provider, versionId });
			if (overrides.validate) return overrides.validate({ provider, versionId, artifact });
			const scripted = validations[provider]?.[versionId];
			if (scripted instanceof Error) throw scripted;
			return scripted ?? { accepted: true, codes: [], metrics: {}, artifacts: { glb: artifact.path, glb_sha256: artifact.sha256 } };
		},
		renderDelivery: async ({ provider, artifact }: any) => {
			calls.delivery.push({ provider, artifact });
			return { schema_version: "fixture-delivery.v1", selected_glb_sha256: artifact.sha256 };
		},
		score,
		ledger,
		lifecycle: overrides.lifecycle,
	};

	return {
		root, runDir, calls, deps,
		config: {
			candidateId: "creative-020", datasetRoot: root, outputRoot, runId,
			providers: [...selectedProviders], briefId: "brick-punched-window-v1", confirmLive: false,
			imageBudgetUsd: Object.fromEntries(selectedProviders.map((provider: string) => [provider, 1])), grammarBudgetUsd: 1,
			grammarProvider: "byteplus-seed-mini", maxLocalAttempts: 2,
		},
	};
}

async function rewriteJson(path: string, value: any) {
	const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
	await writeFile(path, bytes);
	return sha256(bytes);
}

async function rewriteProviderState(value: any, provider: string, mutate: (state: any) => Promise<void> | void) {
	const runPath = join(value.runDir, "run.json");
	const run = JSON.parse(await readFile(runPath, "utf8"));
	const statePath = join(value.runDir, run.provider_manifests[provider].path);
	const state = JSON.parse(await readFile(statePath, "utf8"));
	await mutate(state);
	const stateSha256 = await rewriteJson(statePath, state);
	run.providers[provider] = state;
	run.provider_manifests[provider] = { ...run.provider_manifests[provider], sha256: stateSha256, status: state.status };
	await rewriteJson(runPath, run);
	return { run, state };
}

async function rewriteGrammarAsLegacy(value: any, provider: string, providerSchema = "arr.elevation3d.facade-agent-provider.v1") {
	return rewriteProviderState(value, provider, async (state) => {
		const grammar = state.grammar;
		const receiptPath = state.grammar_receipt?.path;
		const stagePath = join(value.runDir, state.stage_manifests.grammar.path);
		const stage = JSON.parse(await readFile(stagePath, "utf8"));
		const legacyInput = {
			provider,
			proposal_sha256: grammar.proposal_sha256,
			evidence_sha256: grammar.identity.evidenceSha256,
		};
		const legacyOutput = { grammar_sha256: grammar.artifact_sha256, grammar_path: grammar.path };
		delete stage.input;
		stage.input_sha256 = sha256(stableJson(legacyInput));
		stage.output = legacyOutput;
		stage.output_sha256 = sha256(stableJson(legacyOutput));
		const stageSha256 = await rewriteJson(stagePath, stage);
		state.schema_version = providerSchema;
		state.grammar = {
			status: "succeeded",
			proposal_sha256: grammar.proposal_sha256,
			artifact_sha256: grammar.artifact_sha256,
			path: grammar.path,
			cost_receipt: grammar.cost_receipt,
			...(grammar.authority ? { authority: grammar.authority } : {}),
		};
		state.stage_manifests.grammar = {
			...state.stage_manifests.grammar,
			sha256: stageSha256,
			output_sha256: stage.output_sha256,
		};
		delete state.grammar_receipt;
		if (receiptPath) await rm(join(value.runDir, receiptPath));
	});
}

test("persists a redacted three-provider cost and practical-equivalence recommendation", async () => {
	const providers = ["gpt-image-2", "seedream-5-pro", "qwen-image-2"];
	const value = await fixture({
		runId: "three-provider-recommendation", providers,
		scores: { "gpt-image-2": 95, "seedream-5-pro": 93, "qwen-image-2": 92 },
		imageCosts: { "gpt-image-2": 0.4, "seedream-5-pro": 0.08, "qwen-image-2": 0.02 },
		grammarCosts: { "gpt-image-2": 0.1, "seedream-5-pro": 0.02, "qwen-image-2": 0.03 },
	});
	const result = await runFacadeAgent(value.config, value.deps);
	assert.deepEqual(value.calls.generate, providers);
	assert.deepEqual(value.calls.grammar, providers);
	assert.deepEqual(value.calls.delivery.map((call: any) => call.provider), providers);
	assert.ok(providers.every((provider) => result.providers[provider].delivery?.status === "succeeded"));
	assert.equal(result.final.technical_winner, "gpt-image-2");
	assert.equal(result.final.recommended_default, "qwen-image-2");
	assert.equal(result.final.quality_fallback, "gpt-image-2");
	assert.equal(result.final.cost.actual_total_usd, 0.65);
	assert.equal(result.providers["gpt-image-2"].generation.transport, "fixture");
	assert.equal(result.providers["gpt-image-2"].grammar.transport, "fixture");
	assert.deepEqual(result.comparison_memory.selected_providers, providers);
	assert.equal(result.comparison_memory.recommended_default, "qwen-image-2");
	assert.match(result.evaluation_manifest.path, /^evaluation\/evaluation\.json$/);
	const report = JSON.parse(await readFile(join(value.runDir, result.evaluation_manifest.path), "utf8"));
	assert.deepEqual(Object.keys(report.providers), [...providers].sort());
	assert.equal(report.providers["qwen-image-2"].cost.actual_total_usd, 0.05);
	const serialized = JSON.stringify(report);
	for (const provider of providers) {
		assert.equal(serialized.includes(`fixture-${provider}`), false);
		assert.equal(serialized.includes(`grammar-${provider}`), false);
	}
	assert.equal(/https?:|token|secret/i.test(serialized), false);
});

test("status fails closed when the persisted evaluation report is tampered", async () => {
	const value = await fixture({ runId: "tampered-evaluation-report" });
	const result = await runFacadeAgent(value.config, value.deps);
	await writeFile(join(value.runDir, result.evaluation_manifest.path), "{}\n");
	await assert.rejects(() => readFacadeAgentStatus(value.runDir), (error: any) => error.code === "FACADE_AGENT_STATE_UNCERTAIN");
});

test("isolates one failed provider without fallback or duplicate submissions", async () => {
	const providers = ["gpt-image-2", "seedream-5-pro", "qwen-image-2"];
	const value = await fixture({
		runId: "isolated-provider-failure", providers,
		scores: { "gpt-image-2": 95, "qwen-image-2": 94 },
		generateFailure: {
			provider: "seedream-5-pro",
			error: new FacadeProviderError("PROVIDER_AUTH_FAILED", "credential rejected", {
				provider: "seedream-5-pro", stage: "generate", definitiveNonSubmission: true,
			}),
		},
	});
	const result = await runFacadeAgent(value.config, value.deps);
	assert.deepEqual(value.calls.generate, providers);
	assert.deepEqual(value.calls.grammar, ["gpt-image-2", "qwen-image-2"]);
	assert.deepEqual(value.calls.delivery.map((call: any) => call.provider), ["gpt-image-2", "qwen-image-2"]);
	assert.deepEqual(result.image_submissions.by_provider, {
		"gpt-image-2": 1, "seedream-5-pro": 0, "qwen-image-2": 1,
	});
	assert.equal(result.providers["seedream-5-pro"].failure.code, "PROVIDER_AUTH_FAILED");
	assert.equal(result.final.technical_winner, "gpt-image-2");
});

test("submits each image and grammar exactly once, applies only v002 locally, and delivers only the authorized winner", async () => {
	const value = await fixture({
		validations: {
			"gpt-image-2": {
				v001: { accepted: false, codes: ["WINDOW_CROSSES_FLOOR_BAND"], retryable: true },
				v002: { accepted: false, codes: ["WINDOW_CROSSES_FLOOR_BAND"], retryable: true },
			},
		},
	});
	const result = await runFacadeAgent(value.config, value.deps);

	assert.deepEqual(value.calls.generate, ["gpt-image-2", "nano-banana-pro"]);
	assert.deepEqual(value.calls.grammar, ["gpt-image-2", "nano-banana-pro"]);
	assert.deepEqual(value.calls.request, [...PROVIDERS, ...PROVIDERS].map((provider) => ({ provider, evidenceSha: EVIDENCE_SHA, briefId: "brick-punched-window-v1" })));
	assert.deepEqual(result.providers["gpt-image-2"].versions.map((version: any) => version.id), ["v001", "v002"]);
	assert.ok(value.calls.build[1].windowHeight < value.calls.build[0].windowHeight);
	assert.equal(result.image_submissions.total, 2);
	assert.equal(result.final.status, "winner");
	assert.equal(result.final.selected_provider, "nano-banana-pro");
	assert.equal(value.calls.delivery.length, 1);
	assert.equal(value.calls.delivery[0].provider, "nano-banana-pro");
	assert.equal(value.calls.delivery[0].artifact.sha256, result.final.selected_glb_sha256);

	const persisted = await readFacadeAgentStatus(value.runDir);
	assert.deepEqual(persisted, result);
	assert.match(await readFile(join(value.runDir, "run.json"), "utf8"), /"input_sha256"/);
	for (const provider of PROVIDERS) {
		const proposalSha256 = result.providers[provider].proposal.sha256;
		const identity = {
			provider: "byteplus-seed-mini",
			model: "seed-2-0-mini-260428",
			proposalProvider: provider,
			proposalSha256,
			evidenceSha256: EVIDENCE_SHA,
		};
		assert.deepEqual(result.providers[provider].grammar.identity, identity);
		const grammarStage = JSON.parse(await readFile(join(value.runDir, "providers", provider, "stages", "grammar.json"), "utf8"));
		assert.deepEqual(grammarStage.input, {
			provider,
			grammar_provider: identity.provider,
			grammar_model: identity.model,
			proposal_sha256: proposalSha256,
			evidence_sha256: EVIDENCE_SHA,
		});
		const receipt = JSON.parse(await readFile(join(value.runDir, result.providers[provider].grammar_receipt.path), "utf8"));
		assert.equal(receipt.schema_version, "arr.elevation3d.facade-grammar-receipt.v1");
		assert.deepEqual(receipt.identity, identity);
		assert.equal(receipt.result.provider, identity.provider);
		assert.equal(receipt.result.model, identity.model);
		assert.equal(receipt.result.transport, "fixture");
		assert.equal(receipt.artifact.sha256, result.providers[provider].grammar.artifact_sha256);
	}
	assert.match(await readFile(join(value.runDir, "providers", "gpt-image-2", "stages", "validate-v002.json"), "utf8"), /"previous"/);
	const v002Build = JSON.parse(await readFile(join(value.runDir, "providers", "gpt-image-2", "stages", "build-v002.json"), "utf8"));
	assert.equal(v002Build.previous.stage, "validate");
	assert.equal(v002Build.previous.status, "succeeded");
	const v002Grammar = await readFile(join(value.runDir, "providers", "gpt-image-2", "grammar-v002.json"), "utf8");
	const correction = JSON.parse(await readFile(join(value.runDir, "providers", "gpt-image-2", "correction-v002.json"), "utf8"));
	assert.equal(correction.schema_version, "arr.elevation3d.facade-correction.v1");
	assert.equal(correction.input_grammar_sha256, result.providers["gpt-image-2"].versions[0].grammar_sha256);
	assert.equal(correction.output_grammar_sha256, sha256(stableJson(JSON.parse(v002Grammar))));
	assert.deepEqual(correction.correction_codes, ["WINDOW_CROSSES_FLOOR_BAND"]);
	assert.deepEqual(correction.changed_fields, ["window_height_m"]);
	assert.equal(v002Build.input_sha256.length, 64);
});

test("missing or tampered v002 grammar artifacts fail closed before v002 build on resume", async (context) => {
	for (const mode of ["missing", "tampered"] as const) await context.test(mode, async () => {
		let crash = true;
		const value = await fixture({
			runId: `v002-artifact-${mode}`,
			validations: { "gpt-image-2": { v001: { accepted: false, codes: ["WINDOW_CROSSES_FLOOR_BAND"], retryable: true } } },
			lifecycle: { onTransition(event: any) {
				if (crash && event.stage === "correction" && event.status === "succeeded") {
					crash = false;
					throw new Error("crash after correction persistence");
				}
			} },
		});
		await assert.rejects(() => runFacadeAgent(value.config, value.deps), /correction persistence/);
		const path = join(value.runDir, "providers", "gpt-image-2", "grammar-v002.json");
		if (mode === "missing") await rm(path);
		else await writeFile(path, `${JSON.stringify({ ...grammar(), window_height_m: 0.9 }, null, 2)}\n`);
		const before = value.calls.build.length;
		await assert.rejects(() => runFacadeAgent(value.config, value.deps), (error: any) => error.code === "FACADE_AGENT_STATE_UNCERTAIN");
		assert.equal(value.calls.build.length, before);
	});
});

test("runFacadeStage stops after the requested durable stage", async () => {
	const value = await fixture({ runId: "single-stage-generate" });
	const result = await runFacadeStage("generate", value.config, value.deps);
	assert.deepEqual(value.calls.generate, ["gpt-image-2", "nano-banana-pro"]);
	assert.deepEqual(value.calls.grammar, []);
	assert.equal(result.stage_manifests.generate.status, "succeeded");
	await assert.rejects(() => runFacadeStage("not-a-stage", value.config, value.deps), (error: any) => error.code === "FACADE_AGENT_STAGE_INVALID");
});

test("build stage cannot invent v002 before v001 validation authorizes a correction", async () => {
	const value = await fixture({ runId: "single-stage-build" });
	const result = await runFacadeStage("build", value.config, value.deps);
	assert.deepEqual(value.calls.validate, []);
	assert.deepEqual(result.providers["gpt-image-2"].versions.map((version: any) => version.id), ["v001"]);
	assert.deepEqual(result.providers["nano-banana-pro"].versions.map((version: any) => version.id), ["v001"]);
});

test("refuses an unconfirmed non-fixture transport before any paid callback", async () => {
	const value = await fixture({ runId: "unconfirmed-live" });
	value.deps.providers["gpt-image-2"] = { ...value.deps.providers["gpt-image-2"], transport: "live" };
	await assert.rejects(() => runFacadeAgent(value.config, value.deps), (error: any) => error.code === "LIVE_CONFIRMATION_REQUIRED");
	assert.deepEqual(value.calls.generate, []);
	assert.deepEqual(value.calls.grammar, []);
});

test("preflight and evidence build verified request evidence and capability receipts without paid callbacks", async () => {
	for (const stage of ["preflight", "evidence"] as const) {
		const value = await fixture({ runId: `unconfirmed-local-${stage}` });
		assert.equal(value.deps.providers["nano-banana-pro"].transport, "fixture");
		assert.equal(value.deps.grammarProvider.transport, "fixture");
		value.deps.providers["gpt-image-2"] = { ...value.deps.providers["gpt-image-2"], transport: "live" };
		const result = await runFacadeStage(stage, value.config, value.deps);
		assert.equal(result.stage_manifests[stage].status, "succeeded");
		assert.deepEqual(value.calls.generate, []);
		assert.deepEqual(value.calls.grammar, []);
		assert.equal(value.calls.preflight.length, 3);
		assert.equal(result.preflight_receipt.receipt_sha256.length, 64);
		const receipt = JSON.parse(await readFile(join(value.runDir, result.preflight_receipt.path), "utf8"));
		assert.equal(receipt.evidence_sha256, EVIDENCE_SHA);
		assert.equal(receipt.budget.run.ceiling_usd, 3);
		assert.equal(receipt.budget.grammar.ceiling_usd, 1);
		assert.equal(Object.keys(receipt.requests).length, 2);
		assert.deepEqual(receipt.capabilities["grammar:byteplus-seed-mini"], {
			available: true, provider: "byteplus-seed-mini", model: "seed-2-0-mini-260428",
			transport: "fixture", ceilingUsd: 1, estimateUsd: 1,
		});
	}
});

test("preflight fails deterministically on a missing non-network capability before fetch or ledger work", async () => {
	const value = await fixture({ runId: "missing-preflight-capability" });
	value.deps.providers["gpt-image-2"] = { generate: value.deps.providers["gpt-image-2"].generate, buildRequest: value.deps.providers["gpt-image-2"].buildRequest };
	await assert.rejects(() => runFacadeStage("preflight", value.config, value.deps), (error: any) => error.code === "PREFLIGHT_CAPABILITY_MISSING");
	assert.deepEqual(value.calls.generate, []);
	assert.deepEqual(value.calls.grammar, []);
});

test("a caller-set fixture label cannot authorize an unconfirmed transport", async () => {
	const value = await fixture({ runId: "forged-fixture-label" });
	value.deps.providers["gpt-image-2"] = { ...value.deps.providers["gpt-image-2"], transport: "fixture" };
	await assert.rejects(() => runFacadeAgent(value.config, value.deps), (error: any) => error.code === "LIVE_CONFIRMATION_REQUIRED");
	assert.deepEqual(value.calls.generate, []);
});

test("grammar provider receives a provider-bound capability consumable only once", async () => {
	const value = await fixture({ runId: "grammar-capability-once" });
	value.deps.grammarProvider = createFacadeFixtureTransport({
		id: "byteplus-seed-mini",
		model: "seed-2-0-mini-260428",
		preflight: value.deps.grammarProvider.preflight,
		async extract(input: any) {
			const expected = {
				requestKey: input.request.fingerprint,
				provider: "byteplus-seed-mini",
				kind: "grammar-extraction",
			};
			assert.equal(consumePaidOperationSubmissionCapability(input.submission, expected), true);
			assert.equal(consumePaidOperationSubmissionCapability(input.submission, expected), false);
			return normalizeFacadeGrammarResult({
				request: input.request, provider: expected.provider, resolvedModel: "seed-2-0-mini-260428",
				transport: "fixture", grammarCandidate: grammar(), remoteId: `grammar-${input.provider}`, actualUsd: 0,
			});
		},
	});

	const result = await runFacadeAgent(value.config, value.deps);
	assert.equal(result.final.status, "winner");
});

test("selected grammar adapter errors never fall back or retry", async () => {
	const value = await fixture({
		runId: "grammar-no-fallback", providers: ["gpt-image-2"],
		grammarFailure: new FacadeProviderError("SUBMISSION_UNCERTAIN", "BytePlus outcome is uncertain", {
			provider: "byteplus-seed-mini", stage: "grammar",
		}),
	});
	let openAICalls = 0;
	value.deps.extractGrammar = async () => { openAICalls += 1; throw new Error("OpenAI fallback must not run"); };

	const first = await runFacadeAgent(value.config, value.deps);
	assert.deepEqual(value.calls.grammar, ["gpt-image-2"]);
	assert.equal(openAICalls, 0);
	assert.equal(first.providers["gpt-image-2"].failure.code, "SUBMISSION_UNCERTAIN");

	const resumed = await runFacadeAgent(value.config, value.deps);
	assert.deepEqual(value.calls.grammar, ["gpt-image-2"]);
	assert.equal(openAICalls, 0);
	assert.equal(resumed.providers["gpt-image-2"].failure.code, "SUBMISSION_UNCERTAIN");
});

test("a submitting grammar stage without a receipt resumes uncertain with zero adapter calls", async () => {
	let crash = true;
	const value = await fixture({
		runId: "grammar-submitting-resume", providers: ["gpt-image-2"],
		lifecycle: { onTransition(event: any) {
			if (crash && event.stage === "grammar" && event.status === "submitting") {
				crash = false;
				throw new Error("crash before grammar adapter");
			}
		} },
	});
	await assert.rejects(() => runFacadeAgent(value.config, value.deps), /crash before grammar adapter/);
	assert.deepEqual(value.calls.grammar, []);
	const persisted = JSON.parse(await readFile(join(value.runDir, "providers", "gpt-image-2", "state.json"), "utf8"));
	assert.equal(persisted.grammar.status, "submitting");
	assert.equal(persisted.grammar_receipt, undefined);

	const resumed = await runFacadeAgent(value.config, value.deps);
	assert.deepEqual(value.calls.grammar, []);
	assert.equal(resumed.providers["gpt-image-2"].failure.code, "SUBMISSION_UNCERTAIN");
});

test("a persisted legacy v1 grammar result remains readable and resumes without another adapter call", async () => {
	const { floor_elevations_m: _floors, facade_lengths_m: _lengths, ...canonicalGrammar } = grammar();
	const value = await fixture({
		runId: "legacy-v1-grammar-resume", providers: ["gpt-image-2"], grammarCandidate: canonicalGrammar,
	});
	const verifiedEvidence = await verifiedEvidenceFixture(value.runDir);
	value.deps.buildEvidence = async () => verifiedEvidence;
	await runFacadeStage("grammar", value.config, value.deps);
	assert.deepEqual(value.calls.grammar, ["gpt-image-2"]);
	await rewriteGrammarAsLegacy(value, "gpt-image-2");
	const beforeStatus = await readFile(join(value.runDir, "run.json"), "utf8");
	const providerStatePath = join(value.runDir, "providers", "gpt-image-2", "state.json");
	const beforeProviderStatus = await readFile(providerStatePath, "utf8");

	const status = await readFacadeAgentStatus(value.runDir);
	assert.equal(status.providers["gpt-image-2"].grammar.status, "succeeded");
	assert.equal(await readFile(join(value.runDir, "run.json"), "utf8"), beforeStatus);
	assert.equal(await readFile(providerStatePath, "utf8"), beforeProviderStatus);
	assert.deepEqual(value.calls.grammar, ["gpt-image-2"]);

	const resumed = await runFacadeAgent(value.config, value.deps);
	assert.equal(resumed.final.status, "winner");
	assert.deepEqual(value.calls.grammar, ["gpt-image-2"]);
});

test("a new provider-state schema cannot downgrade missing grammar receipt into legacy compatibility", async () => {
	const value = await fixture({ runId: "new-schema-missing-grammar-receipt", providers: ["gpt-image-2"] });
	await runFacadeStage("grammar", value.config, value.deps);
	await rewriteGrammarAsLegacy(value, "gpt-image-2", "arr.elevation3d.facade-agent-provider.v2");

	await assert.rejects(() => readFacadeAgentStatus(value.runDir), (error: any) => error.code === "FACADE_AGENT_STATE_UNCERTAIN");
	assert.deepEqual(value.calls.grammar, ["gpt-image-2"]);
});

test("a crash at grammar returned observes a hash-bound receipt and resumes without another adapter call", async () => {
	let crash = true;
	const value = await fixture({
		runId: "grammar-returned-durable", providers: ["gpt-image-2"],
		lifecycle: { onTransition(event: any) {
			if (crash && event.stage === "grammar" && event.status === "returned") {
				crash = false;
				throw new Error("crash after grammar returned");
			}
		} },
	});
	await assert.rejects(() => runFacadeAgent(value.config, value.deps), /crash after grammar returned/);
	assert.deepEqual(value.calls.grammar, ["gpt-image-2"]);

	const status = await readFacadeAgentStatus(value.runDir);
	const persisted = status.providers["gpt-image-2"];
	assert.equal(persisted.grammar.status, "succeeded");
	const artifactBytes = await readFile(join(value.runDir, persisted.grammar.path));
	const receiptBytes = await readFile(join(value.runDir, persisted.grammar_receipt.path));
	const receipt = JSON.parse(receiptBytes.toString("utf8"));
	assert.equal(sha256(artifactBytes), persisted.grammar.artifact_sha256);
	assert.equal(receipt.artifact.sha256, persisted.grammar.artifact_sha256);
	assert.equal(sha256(receiptBytes), persisted.grammar_receipt.sha256);

	const resumed = await runFacadeAgent(value.config, value.deps);
	assert.equal(resumed.final.status, "winner");
	assert.deepEqual(value.calls.grammar, ["gpt-image-2"]);
});

test("an abort before grammar submission remains a cancellation without an adapter call", async () => {
	const controller = new AbortController();
	const value = await fixture({
		runId: "grammar-pre-submission-abort", providers: ["gpt-image-2"],
		lifecycle: { onTransition(event: any) {
			if (event.stage === "generate" && event.status === "succeeded") controller.abort();
		} },
	});
	value.deps.signal = controller.signal;

	const result = await runFacadeAgent(value.config, value.deps);
	assert.equal(result.final.status, "cancelled");
	assert.deepEqual(value.calls.grammar, []);
	assert.equal(result.providers["gpt-image-2"].failure.code, "FACADE_AGENT_CANCELLED");
});

test("a missing shared grammar ledger fails closed before any paid callback", async () => {
	const value = await fixture({ runId: "grammar-ledger-missing" });
	value.deps.ledger = { image: value.deps.ledger, grammar: {} };

	await assert.rejects(() => runFacadeAgent(value.config, value.deps), (error: any) => error.code === "FACADE_LEDGER_AGGREGATE_UNAVAILABLE");
	assert.deepEqual(value.calls.generate, []);
	assert.deepEqual(value.calls.grammar, []);
});

test("a crash after grammar ledger success cannot repeat the grammar callback", async () => {
	let crash = true;
	const value = await fixture({
		runId: "grammar-returned-crash",
		lifecycle: {
			onTransition(event: any) {
				if (crash && event.stage === "grammar" && event.status === "returned") {
					crash = false;
					throw new Error("crash after grammar ledger success");
				}
			},
		},
	});

	await assert.rejects(() => runFacadeAgent(value.config, value.deps), /crash after grammar ledger success/);
	assert.deepEqual(value.calls.grammar, ["gpt-image-2"]);
	const resumed = await runFacadeAgent(value.config, value.deps);
	assert.deepEqual(value.calls.grammar, ["gpt-image-2", "nano-banana-pro"]);
	assert.equal(resumed.providers["gpt-image-2"].grammar.status, "succeeded");
	assert.equal(resumed.providers["gpt-image-2"].failure, null);
	assert.equal(resumed.final.status, "winner");
});

test("resume after canonical grammar persistence continues local work without paid calls", async () => {
	let crash = true;
	const value = await fixture({
		runId: "grammar-persisted-crash",
		lifecycle: { onTransition(event: any) {
			if (crash && event.stage === "grammar" && event.status === "succeeded" && event.provider === "nano-banana-pro") {
				crash = false;
				throw new Error("crash after canonical grammar persistence");
			}
		} },
	});
	await assert.rejects(() => runFacadeAgent(value.config, value.deps), /canonical grammar persistence/);
	assert.deepEqual(value.calls.generate, [...PROVIDERS]);
	assert.deepEqual(value.calls.grammar, [...PROVIDERS]);
	const resumed = await runFacadeAgent(value.config, value.deps);
	assert.equal(resumed.final.status, "winner");
	assert.deepEqual(value.calls.generate, [...PROVIDERS]);
	assert.deepEqual(value.calls.grammar, [...PROVIDERS]);
	assert.equal(value.calls.delivery.length, 2);
});

test("rejects false hashes and structurally invalid GLBs before validation or delivery", async (context) => {
	for (const scenario of ["false-hash", "invalid-glb"]) await context.test(scenario, async () => {
		const value = await fixture({
			runId: `bad-artifact-${scenario}`,
			async build({ provider, versionId, runDir }: any) {
				const directory = join(runDir, "bad-artifacts", provider);
				await mkdir(directory, { recursive: true });
				const path = join(directory, `${versionId}.glb`);
				const bytes = scenario === "false-hash" ? GLB_BYTES : Buffer.from("not-a-glb");
				await writeFile(path, bytes);
				return { artifact: { path, sha256: scenario === "false-hash" ? "f".repeat(64) : sha256(bytes) } };
			},
		});

		const result = await runFacadeAgent(value.config, value.deps);
		assert.deepEqual(value.calls.validate, []);
		assert.deepEqual(value.calls.delivery, []);
		assert.match(result.providers["gpt-image-2"].versions[0].failure.code, /FACADE_BUILD_ARTIFACT_(HASH_MISMATCH|INVALID)/);
	});
});

test("re-reads and re-hashes the canonical GLB immediately before validation", async () => {
	let value: any;
	value = await fixture({
		runId: "artifact-replaced-before-validation",
		lifecycle: {
			async onTransition(event: any) {
				if (event.stage === "build" && event.status === "succeeded") {
					const artifact = value.calls.build.at(-1);
					await writeFile(join(value.runDir, "fixture-artifacts", event.provider, `${event.version_id}.glb`), REPLACEMENT_GLB_BYTES);
					assert.ok(artifact);
				}
			},
		},
	});

	const result = await runFacadeAgent(value.config, value.deps);
	assert.deepEqual(value.calls.validate, []);
	assert.deepEqual(value.calls.delivery, []);
	assert.equal(result.providers["gpt-image-2"].versions[0].failure.code, "FACADE_BUILD_ARTIFACT_HASH_MISMATCH");
});

test("rejects a GLB path routed through a junction before validation", async () => {
	let value: any;
	value = await fixture({
		runId: "artifact-junction",
		async build({ provider, versionId, runDir }: any) {
			const outside = join(value.root, "outside-artifacts", provider);
			const links = join(runDir, "artifact-links");
			await mkdir(outside, { recursive: true });
			await mkdir(links, { recursive: true });
			const link = join(links, provider);
			await symlink(outside, link, "junction");
			const path = join(link, `${versionId}.glb`);
			await writeFile(join(outside, `${versionId}.glb`), GLB_BYTES);
			return { artifact: { path, sha256: sha256(GLB_BYTES) } };
		},
	});
	const result = await runFacadeAgent(value.config, value.deps);
	assert.deepEqual(value.calls.validate, []);
	assert.deepEqual(value.calls.delivery, []);
	assert.equal(result.providers["gpt-image-2"].versions[0].failure.code, "FACADE_AGENT_PATH_UNSAFE");
});

test("re-hashes the selected GLB immediately before delivery", async () => {
	let value: any;
	value = await fixture({
		runId: "artifact-replaced-before-delivery",
		lifecycle: { async onTransition(event: any) {
			if (event.stage === "score-receipt" && event.status === "succeeded" && event.provider === "nano-banana-pro") {
				await writeFile(join(value.runDir, "fixture-artifacts", event.provider, "v001.glb"), REPLACEMENT_GLB_BYTES);
			}
		} },
	});
	const result = await runFacadeAgent(value.config, value.deps);
	assert.deepEqual(value.calls.delivery.map((call: any) => call.provider), ["gpt-image-2"]);
	assert.equal(result.final.status, "delivery-failed");
	assert.equal(result.final.failure.code, "FACADE_BUILD_ARTIFACT_HASH_MISMATCH");
	assert.equal(result.providers["nano-banana-pro"].delivery.failure.code, "FACADE_BUILD_ARTIFACT_HASH_MISMATCH");
});

test("re-authorizes the GLB after the delivery checkpoint hook", async () => {
	let value: any;
	value = await fixture({
		runId: "artifact-replaced-in-delivery-hook",
		lifecycle: { async onTransition(event: any) {
			if (event.stage === "delivery" && event.status === "submitting") {
				await writeFile(join(value.runDir, "fixture-artifacts", event.provider, "v001.glb"), REPLACEMENT_GLB_BYTES);
			}
		} },
	});
	const result = await runFacadeAgent(value.config, value.deps);
	assert.deepEqual(value.calls.delivery, []);
	assert.equal(result.final.status, "delivery-failed");
	assert.equal(result.final.failure.code, "FACADE_BUILD_ARTIFACT_HASH_MISMATCH");
});

test("validation receives only an immutable canonical artifact authority", async () => {
	let validations = 0;
	const value = await fixture({
		runId: "canonical-artifact-authority",
		validate({ artifact }: any) {
			validations += 1;
			assert.equal(Object.isFrozen(artifact), true);
			assert.equal(artifact.sha256, sha256(GLB_BYTES));
			assert.equal(artifact.size_bytes, GLB_BYTES.length);
			assert.equal(Object.getPrototypeOf(artifact), Object.prototype);
			return { accepted: true, codes: [], metrics: {}, artifacts: { glb: artifact.path, glb_sha256: artifact.sha256 } };
		},
	});
	const result = await runFacadeAgent(value.config, value.deps);
	assert.equal(validations, 2);
	assert.equal(result.final.status, "winner");
});

test("resume after a rejected v001 validation receipt continues with v002 without revalidation", async () => {
	let crash = true;
	const value = await fixture({
		runId: "validation-receipt-crash",
		lifecycle: { onTransition(event: any) {
			if (crash && event.stage === "validation-receipt" && event.status === "succeeded") {
				crash = false;
				throw new Error("crash after validation receipt");
			}
		} },
		validations: { "gpt-image-2": { v001: { accepted: false, codes: ["WINDOW_CROSSES_FLOOR_BAND"], retryable: true }, v002: { accepted: true, codes: [] } } },
	});

	await assert.rejects(() => runFacadeAgent(value.config, value.deps), /crash after validation receipt/);
	assert.deepEqual(value.calls.validate, [{ provider: "gpt-image-2", versionId: "v001" }]);
	assert.deepEqual(value.calls.score, []);
	const resumed = await runFacadeAgent(value.config, value.deps);
	assert.equal(resumed.final.status, "winner");
	assert.equal(value.calls.validate.filter((call: any) => call.provider === "gpt-image-2" && call.versionId === "v001").length, 1);
	assert.ok(value.calls.build.some((call: any) => call.provider === "gpt-image-2" && call.versionId === "v002"));
	assert.equal(value.calls.delivery.length, 2);
});

test("resume after a durable score receipt continues comparison and delivery without rescoring", async () => {
	let crash = true;
	const value = await fixture({
		runId: "score-receipt-crash",
		lifecycle: { onTransition(event: any) {
			if (crash && event.stage === "score-receipt" && event.status === "succeeded") {
				crash = false;
				throw new Error("crash after score receipt");
			}
		} },
	});

	await assert.rejects(() => runFacadeAgent(value.config, value.deps), /crash after score receipt/);
	assert.deepEqual(value.calls.validate, [{ provider: "gpt-image-2", versionId: "v001" }]);
	assert.deepEqual(value.calls.score, ["gpt-image-2"]);
	const resumed = await runFacadeAgent(value.config, value.deps);
	assert.equal(resumed.final.status, "winner");
	assert.equal(value.calls.score.filter((provider: string) => provider === "gpt-image-2").length, 1);
	assert.equal(value.calls.delivery.length, 2);
});

test("in-flight markers prevent callback replay before validation and score receipt publication", async (context) => {
	for (const boundary of ["validate", "score"]) await context.test(boundary, async () => {
		let crash = true;
		const value = await fixture({
			runId: `${boundary}-returned-before-receipt`,
			lifecycle: { onTransition(event: any) {
				if (crash && event.stage === boundary && event.status === "returned") {
					crash = false;
					throw new Error(`crash after ${boundary} returned`);
				}
			} },
		});
		await assert.rejects(() => runFacadeAgent(value.config, value.deps), new RegExp(`crash after ${boundary} returned`));
		const validateCount = value.calls.validate.length;
		const scoreCount = value.calls.score.length;
		const resumed = await runFacadeAgent(value.config, value.deps);
		assert.equal(resumed.final.status, "blocked");
		assert.equal(resumed.final.failure.code, "DURABLE_RECEIPT_RECONCILIATION_REQUIRED");
		assert.equal(value.calls.validate.length, validateCount);
		assert.equal(value.calls.score.length, scoreCount);
		assert.equal(value.calls.delivery.length, 0);
	});
});

test("terminal status rejects a missing durable receipt", async () => {
	const value = await fixture({ runId: "terminal-missing-receipt" });
	const result = await runFacadeAgent(value.config, value.deps);
	const ref = result.providers["gpt-image-2"].versions[0].validation_receipt;
	await rm(join(value.runDir, ref.path));
	await assert.rejects(() => readFacadeAgentStatus(value.runDir), (error: any) => error.code === "FACADE_AGENT_STATE_UNCERTAIN");
});

test("terminal status rejects a grammar artifact that no longer matches its receipt", async () => {
	const value = await fixture({ runId: "terminal-tampered-grammar" });
	const result = await runFacadeAgent(value.config, value.deps);
	await writeFile(join(value.runDir, result.providers["gpt-image-2"].grammar.path), "{}\n");
	await assert.rejects(() => readFacadeAgentStatus(value.runDir), (error: any) => error.code === "FACADE_AGENT_STATE_UNCERTAIN");
});

test("preserves request identity through actual provider factories with mocked fetch", async () => {
	const value = await fixture({ runId: "actual-provider-request-identity" });
	const verifiedEvidence = await verifiedEvidenceFixture(value.runDir);
	const fetchCalls = { openai: 0, gemini: 0, grammar: 0 };
	const openai = createOpenAIProvider({ OPENAI_API_KEY: "sk-fixture" }, {
		fetchImpl: async () => {
			fetchCalls.openai += 1;
			return Response.json({ id: "openai-fixture-id", data: [{ b64_json: PROVIDER_PNG.toString("base64") }], usage: { input_tokens: 1, output_tokens: 1 } });
		},
		timeoutMs: 1_000,
	});
	const gemini = createGeminiProvider({ GEMINI_API_KEY: "gemini-fixture" }, {
		fetchImpl: async () => {
			fetchCalls.gemini += 1;
			return Response.json({
				responseId: "gemini-fixture-id", modelVersion: "gemini-3-pro-image",
				candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { mimeType: "image/png", data: PROVIDER_PNG.toString("base64") } }] } }],
				usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
			});
		},
		timeoutMs: 1_000,
	});
	value.deps.buildEvidence = async () => verifiedEvidence;
	value.deps.providers = {
		"gpt-image-2": Object.freeze({ buildRequest: buildOpenAIRequest, preflight: openai.preflight, generate: openai.generate }),
		"nano-banana-pro": Object.freeze({ buildRequest: buildGeminiRequest, preflight: gemini.preflight, generate: gemini.generate }),
	};
	const grammarProvider = createOpenAIGrammarProvider({ OPENAI_API_KEY: "sk-fixture" }, {
		fetchImpl: async () => {
			fetchCalls.grammar += 1;
			const { floor_elevations_m: _floors, facade_lengths_m: _lengths, ...value } = grammar();
			return Response.json({
				id: `grammar-${fetchCalls.grammar}`, status: "completed",
				output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(value) }] }],
				usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0.04 },
			});
		},
		timeoutMs: 1_000,
	});
	value.deps.grammarProvider = Object.freeze({
		id: "openai-gpt-5.6", model: "gpt-5.6", transport: "live",
		preflight: grammarProvider.preflight, extract: grammarProvider.extract,
	});
	value.config.grammarProvider = "openai-gpt-5.6";
	value.config.confirmLive = true;
	value.config.confirmedTotalUsd = 3;

	const result = await runFacadeAgent(value.config, value.deps);
	assert.deepEqual(fetchCalls, { openai: 1, gemini: 1, grammar: 2 });
	assert.equal(result.image_submissions.total, 2);
	assert.equal(result.final.status, "winner");
});

test("a crash after delivery returns persists uncertainty and never invokes delivery again", async () => {
	let crashed = false;
	const first = await fixture({ runId: "delivery-crash", lifecycle: {
		onTransition(event: any) {
			if (!crashed && event.stage === "delivery" && event.status === "returned") {
				crashed = true;
				throw new Error("fixture crash after delivery returned");
			}
		},
	} });
	await assert.rejects(() => runFacadeAgent(first.config, first.deps), /fixture crash/);
	assert.equal(first.calls.delivery.length, 1);

	const resumed = await fixture({ runId: "unused" });
	resumed.config = first.config;
	resumed.deps.ledger = first.deps.ledger;
	const result = await runFacadeAgent(resumed.config, resumed.deps);
	assert.equal(resumed.calls.delivery.length, 0);
	assert.equal(result.final.status, "delivery-failed");
	assert.equal(result.final.failure.code, "FINAL_DELIVERY_UNCERTAIN");
});

test("a crash after delivery success is checkpointed cannot repeat delivery before final selection", async () => {
	let crashed = false;
	const first = await fixture({ runId: "delivery-success-crash", lifecycle: {
		onTransition(event: any) {
			if (!crashed && event.stage === "delivery" && event.status === "succeeded") {
				crashed = true;
				throw new Error("fixture crash after delivery success checkpoint");
			}
		},
	} });
	await assert.rejects(() => runFacadeAgent(first.config, first.deps), /fixture crash/);
	assert.equal(first.calls.delivery.length, 1);

	const resumed = await fixture({ runId: "unused" });
	resumed.config = first.config;
	resumed.deps.ledger = first.deps.ledger;
	const result = await runFacadeAgent(resumed.config, resumed.deps);
	assert.equal(resumed.calls.delivery.length, 0);
	assert.equal(result.final.failure.code, "FINAL_DELIVERY_UNCERTAIN");
});

test("refuses to write manifests through a junction beneath the run directory", async (context) => {
	const value = await fixture({ runId: "junction-run" });
	const outside = join(value.root, "outside-stages");
	await mkdir(join(value.runDir, "providers", "gpt-image-2"), { recursive: true });
	await mkdir(outside);
	try { await symlink(outside, join(value.runDir, "providers", "gpt-image-2", "stages"), "junction"); }
	catch (error: any) {
		if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) return context.skip("junction creation is unavailable");
		throw error;
	}
	await assert.rejects(() => runFacadeAgent(value.config, value.deps), (error: any) => error.code === "FACADE_AGENT_PATH_UNSAFE");
	assert.deepEqual(value.calls.generate, []);
	await assert.rejects(() => readFile(join(outside, "generate-submitting.json")), (error: any) => error.code === "ENOENT");
});

test("ends after v002 rejection and produces no winner when both providers reject", async () => {
	const rejection = { accepted: false, codes: ["WINDOW_CROSSES_FLOOR_BAND"], retryable: true };
	const value = await fixture({ validations: {
		"gpt-image-2": { v001: rejection, v002: rejection },
		"nano-banana-pro": { v001: rejection, v002: rejection },
	} });
	const result = await runFacadeAgent(value.config, value.deps);
	assert.deepEqual(result.providers["gpt-image-2"].versions.map((version: any) => version.id), ["v001", "v002"]);
	assert.deepEqual(result.providers["nano-banana-pro"].versions.map((version: any) => version.id), ["v001", "v002"]);
	assert.equal(result.final.status, "no-winner");
	assert.equal(value.calls.delivery.length, 0);
	assert.equal(value.calls.generate.length, 2);
	assert.equal(value.calls.grammar.length, 2);
});

test("breaks an authorized technical tie by provider ID after rendering both accepted candidates", async () => {
	const value = await fixture({ scores: { "gpt-image-2": 90, "nano-banana-pro": 90 } });
	const result = await runFacadeAgent(value.config, value.deps);
	assert.equal(result.final.status, "winner");
	assert.equal(result.final.selected_provider, "gpt-image-2");
	assert.equal(result.final.technical_winner, "gpt-image-2");
	assert.equal(value.calls.delivery.length, 2);
});

test("transport, uncertain submission, geometry mismatch, unknown validation, and cancellation never create v002", async (context) => {
	const cases = [
		{
			name: "transport",
			options: { generateFailure: { provider: "gpt-image-2", error: new FacadeProviderError("PROVIDER_TRANSPORT_FAILED", "fixture transport secret=do-not-store", { provider: "gpt-image-2", stage: "generate", definitiveNonSubmission: true }) } },
			wantVersions: 0,
		},
		{
			name: "uncertain submission",
			options: { generateFailure: { provider: "gpt-image-2", error: new Error("socket ended after write secret=do-not-store") } },
			wantVersions: 0,
		},
		{
			name: "geometry mismatch",
			options: { validations: { "gpt-image-2": { v001: { accepted: false, codes: ["EVIDENCE_GEOMETRY_MISMATCH"], retryable: true } } } },
			wantVersions: 1,
		},
		{
			name: "unknown validation code",
			options: { validations: { "gpt-image-2": { v001: { accepted: false, codes: ["UNRECOGNIZED_FIXTURE_CODE"], retryable: true } } } },
			wantVersions: 1,
		},
		{
			name: "cancellation",
			options: { validations: { "gpt-image-2": { v001: Object.assign(new Error("stop now"), { name: "AbortError" }) } } },
			wantVersions: 1,
		},
	];
	for (const item of cases) await context.test(item.name, async () => {
		const value = await fixture({ ...item.options, runId: `prohibited-${item.name.replaceAll(" ", "-")}` });
		const result = await runFacadeAgent(value.config, value.deps);
		assert.equal(result.providers["gpt-image-2"].versions.length, item.wantVersions);
		assert.equal(result.providers["gpt-image-2"].versions.some((version: any) => version.id === "v002"), false);
		const persisted = await readFile(join(value.runDir, "run.json"), "utf8");
		assert.doesNotMatch(persisted, /do-not-store/);
	});
});

test("resume never resubmits a generation durably recorded as succeeded", async () => {
	let crashed = false;
	const first = await fixture({ lifecycle: {
		onTransition(event: any) {
			if (!crashed && event.stage === "generate" && event.provider === "gpt-image-2" && event.status === "succeeded") {
				crashed = true;
				throw new Error("fixture crash after durable success");
			}
		},
	} });
	await assert.rejects(() => runFacadeAgent(first.config, first.deps), /fixture crash/);
	assert.deepEqual(first.calls.generate, ["gpt-image-2"]);

	const resumed = await fixture({ runId: "unused" });
	resumed.config = first.config;
	resumed.deps.ledger = first.deps.ledger;
	const result = await runFacadeAgent(resumed.config, resumed.deps);
	assert.deepEqual(resumed.calls.generate, ["nano-banana-pro"]);
	assert.equal(result.image_submissions.total, 2);
	assert.equal(result.final.status, "winner");
});

test("resume never submits a generation durably recorded as submitting", async () => {
	let crashed = false;
	const first = await fixture({ lifecycle: {
		onTransition(event: any) {
			if (!crashed && event.stage === "generate" && event.provider === "gpt-image-2" && event.status === "submitting") {
				crashed = true;
				throw new Error("fixture crash before callback");
			}
		},
	} });
	await assert.rejects(() => runFacadeAgent(first.config, first.deps), /fixture crash/);
	assert.deepEqual(first.calls.generate, []);

	const resumed = await fixture({ runId: "unused" });
	resumed.config = first.config;
	resumed.deps.ledger = first.deps.ledger;
	const result = await runFacadeAgent(resumed.config, resumed.deps);
	assert.deepEqual(resumed.calls.generate, ["nano-banana-pro"]);
	assert.equal(result.providers["gpt-image-2"].status, "rejected");
	assert.equal(result.providers["gpt-image-2"].failure.code, "PAID_OPERATION_SUBMISSION_UNCERTAIN");
});
