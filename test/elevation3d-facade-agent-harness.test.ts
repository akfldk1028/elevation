import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { sha256, stableJson } from "../plugins/elevation-3d/lib/core.mjs";
import { FacadeProviderError } from "../plugins/elevation-3d/lib/facade-agent/provider.mjs";
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

async function fixture(overrides: any = {}) {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-harness-"));
	roots.push(root);
	const outputRoot = join(root, "output");
	await mkdir(outputRoot, { recursive: true });
	const runId = overrides.runId ?? "facade-harness-001";
	const runDir = join(outputRoot, "creative-020", runId);
	const ledgerRoot = join(root, "ledger");
	await mkdir(ledgerRoot, { recursive: true });
	const ledger = createPaidOperationLedger(join(ledgerRoot, "paid.json"), { approvedRoot: ledgerRoot });
	const calls: any = { generate: [], request: [], grammar: [], build: [], validate: [], delivery: [], score: [] };
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
	score.select = (candidates: any[], tolerance = 0.5) => {
		const authorized = candidates.filter((candidate) => scoreAuthorities.has(candidate) && candidate.accepted === true)
			.sort((left, right) => right.score - left.score || left.provider.localeCompare(right.provider));
		if (!authorized.length) return { status: "no-winner", candidates: [] };
		const review = authorized.filter((candidate) => authorized[0].score - candidate.score <= tolerance);
		if (review.length > 1) return { status: "human-review", candidates: review, tolerance };
		return { status: "winner", provider: authorized[0].provider, candidate: authorized[0], score: authorized[0].score };
	};

	const providers = Object.fromEntries(PROVIDERS.map((provider) => [provider, {
		transport: "fixture",
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
			const bytes = Buffer.from(`fixture-proposal:${provider}`);
			return { bytes, mimeType: "image/png", remoteId: `fixture-${provider}`, usage: { fixture: true } };
		},
	}]));

	const deps: any = {
		loadCandidate: async () => ({ candidate: { candidate_id: "creative-020" }, identity: { geometry_hash: "geometry-fixture" } }),
		buildEvidence: async ({ runDir: target }: any) => ({
			manifest: { candidate_id: "creative-020" }, manifestPath: join(target, "evidence", "manifest.json"),
			manifestSha256: EVIDENCE_SHA, contactSheetBytes: Buffer.from("fixture-evidence"),
		}),
		providers,
		grammarTransport: "fixture",
		extractGrammar: async ({ provider, proposal, evidence, ledger: paidLedger, signal }: any) => {
			const requestKey = sha256(stableJson({ provider, proposal: proposal.sha256, evidence: evidence.manifestSha256, model: "gpt-5.6" }));
			let extracted: any = null;
			await paidLedger.executeOnce({
				requestKey, provider: `openai-grammar-${provider}`, kind: "grammar-extraction", ceilingUsd: 1, estimateUsd: 0, signal,
				operation: async (submission: any) => {
					assert.equal(consumePaidOperationSubmissionCapability(submission, {
						requestKey, provider: `openai-grammar-${provider}`, kind: "grammar-extraction",
					}), true);
					calls.grammar.push(provider);
					extracted = grammar();
					return { remoteId: `grammar-${provider}`, artifactSha256: sha256(stableJson(extracted)), actualUsd: 0 };
				},
			});
			if (!extracted) throw Object.assign(new Error("persisted grammar cannot be re-authorized"), { code: "GRAMMAR_RESULT_UNAVAILABLE" });
			return extracted;
		},
		build: async ({ provider, versionId, grammar: value, runDir: target }: any) => {
			calls.build.push({ provider, versionId, windowHeight: value.window_height_m });
			const directory = join(target, "fixture-artifacts", provider);
			await mkdir(directory, { recursive: true });
			const path = join(directory, `${versionId}.glb`);
			const bytes = Buffer.from(`fixture-glb:${provider}:${versionId}:${value.window_height_m}`);
			await writeFile(path, bytes);
			return { artifact: { path, sha256: sha256(bytes) } };
		},
		validate: async ({ provider, versionId, artifact }: any) => {
			calls.validate.push({ provider, versionId });
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
			providers: [...PROVIDERS], briefId: "brick-punched-window-v1", confirmLive: false,
			imageBudgetUsd: { "gpt-image-2": 1, "nano-banana-pro": 1 }, grammarBudgetUsd: 1,
			grammarModel: "gpt-5.6", maxLocalAttempts: 2,
		},
	};
}

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
	assert.deepEqual(value.calls.request, PROVIDERS.map((provider) => ({ provider, evidenceSha: EVIDENCE_SHA, briefId: "brick-punched-window-v1" })));
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
	assert.match(await readFile(join(value.runDir, "providers", "gpt-image-2", "stages", "validate-v002.json"), "utf8"), /"previous"/);
	const v002Build = JSON.parse(await readFile(join(value.runDir, "providers", "gpt-image-2", "stages", "build-v002.json"), "utf8"));
	assert.equal(v002Build.previous.stage, "validate");
	assert.equal(v002Build.previous.status, "succeeded");
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
	value.deps.providers["gpt-image-2"].transport = "live";
	await assert.rejects(() => runFacadeAgent(value.config, value.deps), (error: any) => error.code === "LIVE_CONFIRMATION_REQUIRED");
	assert.deepEqual(value.calls.generate, []);
	assert.deepEqual(value.calls.grammar, []);
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

test("routes an authorized score tie to human review without rendering a final delivery", async () => {
	const value = await fixture({ scores: { "gpt-image-2": 90, "nano-banana-pro": 90 } });
	const result = await runFacadeAgent(value.config, value.deps);
	assert.equal(result.final.status, "human-review");
	assert.equal("selected_provider" in result.final, false);
	assert.equal(value.calls.delivery.length, 0);
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
