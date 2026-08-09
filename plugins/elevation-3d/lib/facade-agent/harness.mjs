import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { NodeIO } from "@gltf-transform/core";

import { redactSecrets, sha256, stableJson } from "../core.mjs";
import { readVerifiedFacadeValidationAuthority, rehydrateVerifiedFacadeValidationAuthority } from "../enrichment-validation.mjs";
import { correctGrammar, validatePunchedFacadeGrammar } from "../facade-grammar.mjs";
import { facadeRequestFingerprint, FACADE_AGENT_STAGES, normalizeFacadeAgentConfig } from "./contract.mjs";
import { readVerifiedFacadeEvidenceAuthority } from "./evidence.mjs";
import { isFacadeFixtureTransport } from "./fixture-transport.mjs";
import {
	FACADE_GRAMMAR_SCHEMA,
	readVerifiedFacadeGrammarAuthority,
	rehydrateVerifiedFacadeGrammar,
	serializeVerifiedFacadeGrammarAuthority,
	verifyFacadeProposal,
} from "./grammar-agent.mjs";
import { consumePaidOperationSubmissionCapability } from "./paid-operation-ledger.mjs";
import { createFacadeGrammarRequest } from "./providers/grammar/contract.mjs";
import { buildFacadeGrammarPrompt } from "./providers/grammar/prompt.mjs";
import { rehydrateFacadeScoreResult } from "./score.mjs";
import { normalizeFacadeEvaluationCost } from "./evaluation/cost.mjs";
import { buildFacadeEvaluationReport } from "./evaluation/report.mjs";
import { selectFacadeRecommendation } from "./evaluation/scorecard.mjs";

const HEX_SHA256 = /^[a-f0-9]{64}$/;
const LEGACY_PROVIDER_SCHEMA = "arr.elevation3d.facade-agent-provider.v1";
const PROVIDER_SCHEMA = "arr.elevation3d.facade-agent-provider.v2";
const TERMINAL_RUN_STATES = new Set(["winner", "no-winner", "human-review", "cancelled", "delivery-failed"]);
const LOCAL_REPAIR_CODES = new Set([
	"WINDOW_CROSSES_FLOOR_BAND",
	"DETAIL_BOUNDS_EXCEEDED",
	"CORNER_DATUM_MISMATCH",
	"PRIMITIVE_BUDGET_EXCEEDED",
]);
const PROHIBITED_RETRY_CODES = new Set([
	"EVIDENCE_GEOMETRY_MISMATCH",
	"CANONICAL_SURFACE_MISMATCH",
	"BASE_GEOMETRY_CHANGED",
	"GRAMMAR_PROPOSAL_INVALID",
	"GRAMMAR_TRANSPORT_FAILED",
	"PAID_OPERATION_SUBMISSION_UNCERTAIN",
]);
const grammarSubmissionCapabilities = new WeakMap();

export function consumeFacadeGrammarSubmissionCapability(capability, expected) {
	if ((!capability || typeof capability !== "object") || (!expected || typeof expected !== "object")) return false;
	const record = grammarSubmissionCapabilities.get(capability);
	if (!record || record.consumed) return false;
	for (const key of ["requestKey", "proposalProvider", "proposalSha256", "evidenceSha256", "model"]) {
		if (record[key] !== expected[key]) return false;
	}
	if (!consumePaidOperationSubmissionCapability(record.ledgerSubmission, {
		requestKey: record.requestKey, provider: "openai", kind: "grammar-extraction",
	})) return false;
	record.consumed = true;
	return true;
}

function issueGrammarSubmissionCapability(binding, ledgerSubmission) {
	const capability = Object.freeze(Object.create(null));
	const record = { ...binding, ledgerSubmission, consumed: false };
	grammarSubmissionCapabilities.set(capability, record);
	return { capability, record };
}

class LifecycleHookError extends Error {
	constructor(error) {
		super(error instanceof Error ? error.message : "Facade lifecycle hook failed", { cause: error });
		this.name = "LifecycleHookError";
	}
}

function persistent(value, seen = new Set(), depth = 0) {
	if (depth > 32) return "[OMITTED_DEPTH]";
	if (Buffer.isBuffer(value) || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return "[OMITTED_BINARY]";
	if (value === null || ["string", "boolean"].includes(typeof value)) return redactSecrets(value);
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value !== "object") return undefined;
	if (seen.has(value)) return "[OMITTED_CYCLE]";
	seen.add(value);
	if (Array.isArray(value)) return value.map((item) => persistent(item, seen, depth + 1));
	const output = {};
	for (const [key, item] of Object.entries(value)) {
		if (/(remote[_-]?id|url)$/i.test(key)) continue;
		const safe = persistent(item, seen, depth + 1);
		if (safe !== undefined) output[key] = safe;
	}
	return redactSecrets(output);
}

function codedError(code, message, cause) {
	const error = new Error(message, cause ? { cause } : undefined);
	error.code = code;
	return error;
}

function safeError(error, fallback = "FACADE_STAGE_FAILED") {
	return persistent({
		code: typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code) ? error.code : fallback,
		name: isAbort(error) ? "AbortError" : "Error",
		message: error instanceof Error ? error.message : "Facade stage failed",
	});
}

function preflightCapability(callback) {
	try { return persistent({ available: true, ...callback() }); }
	catch (error) {
		if (error?.definitiveNonSubmission !== true) throw error;
		return { available: false, code: safeError(error, "PREFLIGHT_CAPABILITY_UNAVAILABLE").code };
	}
}

function isAbort(error, signal) {
	return signal?.aborted === true || error?.name === "AbortError" || /_ABORTED$/.test(error?.code ?? "");
}

function throwIfAborted(signal) {
	if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function syncDirectory(path) {
	let handle;
	try {
		handle = await open(path, "r");
		await handle.sync();
	} catch (error) {
		if (!["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(error?.code)) throw error;
	} finally { await handle?.close(); }
}

async function assertNoReparsePoints(path) {
	const absolute = resolve(path);
	const root = parse(absolute).root;
	const parts = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean);
	let current = root;
	for (let index = 0; index < parts.length; index += 1) {
		current = resolve(current, parts[index]);
		let stats;
		try { stats = await lstat(current); }
		catch (error) { if (error?.code === "ENOENT") return; throw error; }
		if (stats.isSymbolicLink()) throw codedError("FACADE_AGENT_PATH_UNSAFE", "Facade agent paths must not contain symlinks or junctions");
		if (index < parts.length - 1 && !stats.isDirectory()) throw codedError("FACADE_AGENT_PATH_UNSAFE", "Facade agent path parent must be a directory");
	}
}

async function safeRead(root, path, label) {
	const absolute = containedPath(root, path, label);
	await assertNoReparsePoints(absolute);
	return readFile(absolute);
}

async function atomicWrite(path, bytes, approvedRoot) {
	containedPath(approvedRoot, path, "atomic output");
	await assertNoReparsePoints(approvedRoot);
	await assertNoReparsePoints(path);
	await mkdir(dirname(path), { recursive: true });
	await assertNoReparsePoints(dirname(path));
	await assertNoReparsePoints(path);
	const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
	let handle;
	try {
		handle = await open(temporary, "wx", 0o600);
		await handle.writeFile(bytes);
		await handle.sync();
		await handle.close();
		handle = null;
		await assertNoReparsePoints(temporary);
		await assertNoReparsePoints(path);
		await rename(temporary, path);
		await syncDirectory(dirname(path));
	} finally {
		await handle?.close();
		await rm(temporary, { force: true });
	}
}

async function atomicJson(path, value, approvedRoot) {
	const safe = persistent(value);
	const bytes = Buffer.from(`${JSON.stringify(safe, null, 2)}\n`);
	await atomicWrite(path, bytes, approvedRoot);
	return { value: safe, sha256: sha256(bytes) };
}

async function readJson(path, approvedRoot) {
	return JSON.parse((await safeRead(approvedRoot, path, "JSON manifest")).toString("utf8"));
}

async function exists(path) {
	try { return (await stat(path)).isFile(); }
	catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function containedPath(root, path, label) {
	const absoluteRoot = resolve(root);
	const absolute = resolve(path);
	const child = relative(absoluteRoot, absolute);
	if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
		throw codedError("FACADE_AGENT_PATH_UNSAFE", `${label} must remain beneath the run directory`);
	}
	return absolute;
}

function relativePath(root, path, label) {
	return relative(resolve(root), containedPath(root, path, label)).replaceAll("\\", "/");
}

export { assertNoReparsePoints, atomicWrite, containedPath };

function manifestOutputHash(output) {
	return sha256(stableJson(persistent(output)));
}

function previousRecord(previous) {
	if (!previous) return null;
	if (previous.status !== "succeeded" || !HEX_SHA256.test(previous.output_sha256 ?? "")) {
		throw codedError("FACADE_AGENT_TRANSITION_INVALID", "Previous stage must be durably succeeded and content-addressed");
	}
	return { stage: previous.stage, status: previous.status, output_sha256: previous.output_sha256 };
}

async function callLifecycle(deps, event) {
	const callbacks = [deps.lifecycle?.onTransition, deps.onTransition].filter((callback) => typeof callback === "function");
	for (const callback of callbacks) {
		try { await callback(persistent(event)); }
		catch (error) { throw new LifecycleHookError(error); }
	}
}

async function writeStage({ runDir, path, stage, status, input, output, previous, provider, versionId, deps }) {
	const safeInput = persistent(input);
	const inputSha256 = sha256(stableJson(safeInput));
	const absolute = containedPath(runDir, join(runDir, path), "stage manifest");
	let existing = null;
	if (await exists(absolute)) existing = await readJson(absolute, runDir);
	if (existing && (existing.stage !== stage || existing.input_sha256 !== inputSha256)) {
		throw codedError("FACADE_AGENT_STATE_UNCERTAIN", `Persisted ${stage} stage does not match its requested input`);
	}
	if (existing?.status === "succeeded" && status !== "succeeded") {
		throw codedError("FACADE_AGENT_TRANSITION_INVALID", `Cannot transition completed ${stage} stage back to ${status}`);
	}
	const safeOutput = persistent(output);
	const manifest = {
		schema_version: "arr.elevation3d.facade-agent-stage.v1",
		stage,
		status,
		input: safeInput,
		input_sha256: inputSha256,
		previous: previousRecord(previous),
		output: safeOutput,
		output_sha256: manifestOutputHash(safeOutput),
		...(provider ? { provider } : {}),
		...(versionId ? { version_id: versionId } : {}),
	};
	const written = await atomicJson(absolute, manifest, runDir);
	const ref = {
		path: relativePath(runDir, absolute, "stage manifest"),
		sha256: written.sha256,
		stage,
		status,
		output_sha256: manifest.output_sha256,
	};
	return { manifest, ref };
}

function runDirectory(config) {
	return resolve(config.outputRoot, config.candidateId, config.runId);
}

function initialRun(config, runDir, inputSha256) {
	return {
		schema_version: "arr.elevation3d.facade-agent-run.v1",
		run_id: config.runId,
		candidate_id: config.candidateId,
		brief_id: config.briefId,
		run_dir: runDir.replaceAll("\\", "/"),
		input_sha256: inputSha256,
		status: "running",
		stage_manifests: {},
		provider_manifests: {},
		providers: {},
		image_submissions: { total: 0, by_provider: Object.fromEntries(config.providers.map((provider) => [provider, 0])) },
		budget: {
			run_ceiling_micros: config.runBudgetMicros,
			image_ceiling_micros: { ...config.imageBudgetMicros },
			grammar_ceiling_micros: config.grammarBudgetMicros,
			grammar_per_call_ceiling_micros: { ...config.grammarBudgetAllocationMicros },
			run_ceiling_usd: config.runBudgetUsd,
			image_ceiling_usd: { ...config.imageBudgetUsd },
			grammar_ceiling_usd: config.grammarBudgetUsd,
			grammar_per_call_ceiling_usd: { ...config.grammarBudgetAllocationUsd },
		},
		final: null,
	};
}

function adapterActualMicros(result, fallbackMicros) {
	const direct = result?.actualMicros;
	if (direct !== undefined && (!Number.isSafeInteger(direct) || direct < 0)) {
		throw codedError("PROVIDER_BILLING_INVALID", "Provider actualMicros must be a nonnegative safe integer");
	}
	const actualUsd = result?.actualUsd ?? result?.usage?.cost_usd;
	if (actualUsd === undefined) return direct ?? fallbackMicros;
	if (!Number.isFinite(actualUsd) || actualUsd < 0) throw codedError("PROVIDER_BILLING_INVALID", "Provider actualUsd must be finite and nonnegative");
	const fromUsd = Math.round(actualUsd * 1_000_000);
	if (!Number.isSafeInteger(fromUsd) || Math.abs(fromUsd / 1_000_000 - actualUsd) > Number.EPSILON) {
		throw codedError("PROVIDER_BILLING_INVALID", "Provider actualUsd must use at most six decimal places");
	}
	if (direct !== undefined && direct !== fromUsd) throw codedError("PROVIDER_BILLING_INVALID", "Provider micro-dollar and USD actual costs disagree");
	return direct ?? fromUsd;
}

async function writeRun(runDir, run) {
	await atomicJson(join(runDir, "run.json"), run, runDir);
}

function countImageSubmissions(run, config) {
	const byProvider = Object.fromEntries(config.providers.map((provider) => {
		const status = run.providers[provider]?.generation?.status;
		return [provider, status === "submitting" || status === "succeeded" ? 1 : 0];
	}));
	run.image_submissions = { total: Object.values(byProvider).reduce((sum, value) => sum + value, 0), by_provider: byProvider };
}

async function writeProvider(runDir, run, config, provider, state, deps, event = null) {
	const path = join(runDir, "providers", provider, "state.json");
	const written = await atomicJson(path, state, runDir);
	run.providers[provider] = written.value;
	run.provider_manifests[provider] = {
		path: relativePath(runDir, path, "provider state"),
		sha256: written.sha256,
		status: state.status,
	};
	countImageSubmissions(run, config);
	await writeRun(runDir, publicRun(run));
	if (event) await callLifecycle(deps, event);
}

async function loadProvider(runDir, run, provider) {
	const ref = run.provider_manifests?.[provider];
	if (!ref) return {
		schema_version: PROVIDER_SCHEMA,
		provider,
		status: "pending",
		generation: { status: "pending" },
		grammar: { status: "pending" },
		stage_manifests: {},
		versions: [],
		score: null,
		failure: null,
	};
	const path = containedPath(runDir, join(runDir, ref.path), "provider state");
	const bytes = await safeRead(runDir, path, "provider state");
	if (sha256(bytes) !== ref.sha256) throw codedError("FACADE_AGENT_STATE_UNCERTAIN", `Provider state hash mismatch: ${provider}`);
	const state = JSON.parse(bytes.toString("utf8"));
	if (state.provider !== provider || stableJson(state) !== stableJson(run.providers?.[provider])) {
		throw codedError("FACADE_AGENT_STATE_UNCERTAIN", `Provider state binding mismatch: ${provider}`);
	}
	return state;
}

function providerEntry(deps, provider) {
	const entry = deps.providers?.[provider];
	if (!entry || typeof entry.generate !== "function") throw codedError("FACADE_PROVIDER_MISSING", `Missing provider dependency: ${provider}`);
	return entry;
}

function grammarProviderEntry(deps, config) {
	const entry = deps.grammarProvider;
	if (!entry || typeof entry !== "object" || typeof entry.extract !== "function") {
		throw codedError("FACADE_GRAMMAR_PROVIDER_MISSING", "A selected grammar provider dependency is required");
	}
	if (entry.id !== config.grammarProvider || typeof entry.model !== "string" || entry.model.length === 0) {
		throw codedError("GRAMMAR_PROVIDER_INVALID", "Grammar provider dependency does not match the canonical route");
	}
	return entry;
}

function transportType(entry) {
	return isFacadeFixtureTransport(entry) ? "fixture" : "live";
}

function buildProviderRequest(entry, { provider, evidence, brief, output }) {
	const request = typeof entry.buildRequest === "function"
		? entry.buildRequest({ evidence, brief, output })
		: { provider, evidence, brief, output };
	if (!request || typeof request !== "object") throw codedError("FACADE_PROVIDER_REQUEST_INVALID", `Provider ${provider} returned an invalid request`);
	let fingerprint = Object.getOwnPropertyDescriptor(request, "fingerprint")?.value;
	const requestProvider = Object.getOwnPropertyDescriptor(request, "provider")?.value;
	if (requestProvider !== provider) throw codedError("FACADE_PROVIDER_REQUEST_INVALID", `Provider ${provider} request identity is invalid`);
	if (fingerprint === undefined && typeof entry.buildRequest !== "function") fingerprint = facadeRequestFingerprint({
		provider,
		evidenceSha256: evidence.manifestSha256,
		briefId: brief.id,
		output: persistent(output),
	});
	if (!HEX_SHA256.test(fingerprint)) throw codedError("FACADE_PROVIDER_REQUEST_INVALID", `Provider ${provider} request is missing a SHA-256 fingerprint`);
	if (Object.getOwnPropertyDescriptor(request, "fingerprint")?.value === undefined) request.fingerprint = fingerprint;
	return request;
}

function imageLedger(deps) {
	const ledger = deps.ledger?.image ?? deps.ledger;
	if (!ledger || typeof ledger.executeOnce !== "function") throw codedError("FACADE_LEDGER_MISSING", "A paid-operation ledger is required");
	return ledger;
}

function grammarLedger(deps) {
	const ledger = deps.ledger?.grammar ?? deps.ledger;
	if (!ledger || typeof ledger.executeOnce !== "function") throw codedError("FACADE_LEDGER_MISSING", "A grammar paid-operation ledger is required");
	return ledger;
}

function assertSharedRunLedger(deps) {
	const image = deps.ledger?.image ?? deps.ledger;
	const grammar = deps.ledger?.grammar ?? deps.ledger;
	if (!image || typeof image.executeOnce !== "function"
		|| !grammar || typeof grammar.executeOnce !== "function"
		|| image !== grammar) {
		throw codedError(
			"FACADE_LEDGER_AGGREGATE_UNAVAILABLE",
			"One shared paid-operation ledger is required to enforce the run-wide budget",
		);
	}
	return image;
}

function proposalExtension(mimeType) {
	if (mimeType === "image/jpeg") return ".jpg";
	if (mimeType === "image/webp") return ".webp";
	return ".png";
}

async function proposalFromState(runDir, state) {
	if (state.generation?.status !== "succeeded" || !state.proposal?.path || !HEX_SHA256.test(state.proposal?.sha256 ?? "")) return null;
	const path = containedPath(runDir, join(runDir, state.proposal.path), "proposal artifact");
	let bytes;
	try { bytes = await safeRead(runDir, path, "proposal artifact"); }
	catch { return null; }
	if (sha256(bytes) !== state.proposal.sha256) return null;
	return { path, bytes, sha256: state.proposal.sha256, mimeType: state.proposal.mime_type };
}

async function generateProvider({ config, deps, runDir, run, state, provider, evidence, previous, signal }) {
	if (state.generation.status === "submitting") {
		state.status = "rejected";
		state.failure = { code: "PAID_OPERATION_SUBMISSION_UNCERTAIN", message: "Refusing to resubmit a generation recorded as submitting" };
		await writeProvider(runDir, run, config, provider, state, deps);
		return { state, proposal: null };
	}
	if (state.generation.status === "succeeded") {
		const proposal = await proposalFromState(runDir, state);
		if (proposal) return { state, proposal };
		state.status = "rejected";
		state.failure = { code: "PAID_OPERATION_RESULT_UNAVAILABLE", message: "Persisted generation artifact is unavailable; refusing resubmission" };
		await writeProvider(runDir, run, config, provider, state, deps);
		return { state, proposal: null };
	}
	if (state.status === "rejected" || state.status === "cancelled") return { state, proposal: null };

	const entry = providerEntry(deps, provider);
	const brief = persistent({ ...(config.brief ?? {}), id: config.briefId, brief_id: config.briefId, candidate_id: config.candidateId });
	const proposalBase = join(runDir, "providers", provider, "proposal");
	const output = { path: proposalBase, count: 1 };
	const request = buildProviderRequest(entry, { provider, evidence, brief, output });
	const submittingStagePath = `providers/${provider}/stages/generate-submitting.json`;
	const stagePath = `providers/${provider}/stages/generate.json`;
	const stageInput = { provider, request_fingerprint: request.fingerprint, evidence_sha256: evidence.manifestSha256, brief_id: config.briefId };
	const submitting = await writeStage({
		runDir, path: submittingStagePath, stage: "generate", status: "submitting", input: stageInput,
		output: { request_fingerprint: request.fingerprint }, previous, provider, deps,
	});
	state.generation = { status: "submitting", request_sha256: request.fingerprint };
	state.stage_manifests.generate = submitting.ref;
	await writeProvider(runDir, run, config, provider, state, deps, { stage: "generate", status: "submitting", provider });

	let generated = null;
	let publicResult;
	try {
		entry.preflight?.({ request, ceilingUsd: config.imageBudgetUsd[provider], estimateUsd: config.imageEstimateUsd?.[provider] ?? config.imageBudgetUsd[provider] });
		throwIfAborted(signal);
		publicResult = await imageLedger(deps).executeOnce({
			requestKey: request.fingerprint,
			provider,
			kind: "image-generation",
			ceilingMicros: config.imageBudgetMicros[provider],
			estimateMicros: config.imageEstimateMicros[provider],
			runCeilingMicros: config.runBudgetMicros,
			kindCeilingMicros: Object.values(config.imageBudgetMicros).reduce((sum, value) => sum + value, 0),
			signal,
			operation: async (submission) => {
				generated = await entry.generate({ request, submission, signal });
				if (!generated || !Buffer.isBuffer(generated.bytes) || generated.bytes.length === 0) {
					throw codedError("PROVIDER_RESPONSE_INVALID", "Provider did not return bounded image bytes");
				}
				return {
					remoteId: generated.remoteId,
					artifactSha256: sha256(generated.bytes),
					actualMicros: adapterActualMicros(generated, config.imageEstimateMicros[provider]),
				};
			},
		});
		if (!generated) throw codedError("PAID_OPERATION_RESULT_UNAVAILABLE", "Persisted paid result cannot be reconstructed without resubmission");
		const digest = sha256(generated.bytes);
		if (publicResult?.artifactSha256 && publicResult.artifactSha256 !== digest) {
			throw codedError("PAID_OPERATION_RESULT_MISMATCH", "Paid ledger artifact hash does not match provider bytes");
		}
		const proposalPath = `${proposalBase}${proposalExtension(generated.mimeType)}`;
		await atomicWrite(proposalPath, generated.bytes, runDir);
		const proposal = { path: proposalPath, bytes: generated.bytes, sha256: digest, mimeType: generated.mimeType, providerResult: generated };
		const succeeded = await writeStage({
			runDir, path: stagePath, stage: "generate", status: "succeeded", input: stageInput,
			output: { proposal_sha256: digest, proposal_path: relativePath(runDir, proposalPath, "proposal artifact") }, previous, provider, deps,
		});
		state.generation = {
			status: "succeeded", request_sha256: request.fingerprint, artifact_sha256: digest,
			transport: transportType(entry),
			cost_receipt: { actualUsd: publicResult.actualUsd },
		};
		state.proposal = { path: relativePath(runDir, proposalPath, "proposal artifact"), sha256: digest, mime_type: generated.mimeType ?? null };
		state.stage_manifests.generate = succeeded.ref;
		state.status = "generated";
		await writeProvider(runDir, run, config, provider, state, deps, { stage: "generate", status: "succeeded", provider });
		return { state, proposal };
	} catch (error) {
		if (error instanceof LifecycleHookError) throw error;
		if (isAbort(error, signal)) {
			state.status = "cancelled";
			state.failure = safeError(error, "FACADE_AGENT_CANCELLED");
		} else {
			state.status = "rejected";
			state.failure = safeError(error, "PROVIDER_GENERATION_FAILED");
			if (error?.definitiveNonSubmission === true) state.generation.status = "failed";
		}
		await writeProvider(runDir, run, config, provider, state, deps);
		return { state, proposal: null, cancelled: state.status === "cancelled" };
	}
}

function parseGrammarCandidate(candidate, evidence) {
	let raw = typeof candidate === "string" ? candidate : persistent(candidate);
	if (typeof candidate === "string") {
		if (Buffer.byteLength(candidate, "utf8") > 1024 * 1024) throw codedError("GRAMMAR_RESPONSE_TOO_LARGE", "Grammar output exceeds the configured size limit");
		const keys = [];
		for (const match of candidate.matchAll(/"(?:\\.|[^"\\])*"\s*:/g)) {
			try { keys.push(JSON.parse(match[0].slice(0, match[0].lastIndexOf(":")))); }
			catch { throw codedError("GRAMMAR_OUTPUT_INVALID", "Grammar output contains invalid object keys"); }
		}
		if (new Set(keys).size !== keys.length) throw codedError("GRAMMAR_OUTPUT_INVALID", "Grammar output contains duplicate or ambiguous elements");
		try { raw = JSON.parse(candidate); }
		catch { throw codedError("GRAMMAR_OUTPUT_INVALID", "Grammar output must be one JSON object"); }
	}
	try {
		const grammar = validatePunchedFacadeGrammar(raw, {
			...(Array.isArray(evidence?.manifest?.floor_guides_m) ? { floorGuides: { floor_guides_m: evidence.manifest.floor_guides_m } } : {}),
			allowDerived: true,
		});
		return {
			...grammar,
			...(raw.wall_opacity !== undefined ? { wall_opacity: raw.wall_opacity } : {}),
			...(raw.curtain_wall_allowed !== undefined ? { curtain_wall_allowed: raw.curtain_wall_allowed } : {}),
			...(raw.floor_elevations_m !== undefined ? { floor_elevations_m: [...raw.floor_elevations_m] } : {}),
			...(raw.facade_lengths_m !== undefined ? { facade_lengths_m: { ...raw.facade_lengths_m } } : {}),
		};
	} catch (error) {
		throw codedError("GRAMMAR_OUTPUT_INVALID", "Grammar output does not match the approved typed facade contract", error);
	}
}

function grammarAuthority(grammar, evidence, proposalProvider, proposalSha256) {
	const authority = readVerifiedFacadeEvidenceAuthority(evidence);
	if (!authority) return null;
	return {
		candidateId: authority.candidateId,
		geometryHash: authority.geometryHash,
		geometryContentSha256: authority.geometryContentSha256,
		geometrySignedVolumeOrientation: authority.geometrySignedVolumeOrientation,
		facadeSegmentAuthority: authority.facadeSegmentAuthority ? {
			sha256: authority.facadeSegmentAuthority.sha256,
			segmentIds: [...authority.facadeSegmentAuthority.segmentIds],
		} : null,
		provider: proposalProvider,
		evidenceManifestSha256: authority.manifestSha256,
		camerasSha256: authority.camerasSha256,
		floorGuides: [...authority.floorGuides],
		facadeLengths: { ...authority.facadeLengths },
		proposalSha256,
		grammarSha256: sha256(stableJson(grammar)),
	};
}

async function buildGrammarRequest({ config, deps, provider, proposal, evidence, entry }) {
	if (!isFacadeFixtureTransport(deps.providers?.[provider])) {
		await verifyFacadeProposal({
			proposalPath: proposal.path,
			providerResult: proposal.providerResult,
			evidence,
			config: {
				...config,
				proposalProvider: provider,
			},
		});
	}
	const manifestText = `${stableJson(persistent(evidence.manifest ?? { manifest_sha256: evidence.manifestSha256 }))}\n`;
	const prompt = buildFacadeGrammarPrompt({
		proposalSha256: proposal.sha256,
		evidenceManifestSha256: evidence.manifestSha256,
		manifestText,
	});
	const boundPrompt = `${prompt.prompt}\nProposal provider identity: ${provider}.`;
	return createFacadeGrammarRequest({
		provider: config.grammarProvider,
		model: entry.model,
		proposalSha256: proposal.sha256,
		evidenceManifestSha256: evidence.manifestSha256,
		promptRevision: prompt.revision,
		prompt: boundPrompt,
		promptSha256: sha256(boundPrompt),
		imageBytes: proposal.bytes,
		imageMimeType: proposal.mimeType,
		schema: FACADE_GRAMMAR_SCHEMA,
		ceilingUsd: config.grammarBudgetAllocationUsd[provider],
		estimateUsd: config.grammarEstimateAllocationUsd[provider],
	});
}

async function extractProviderGrammar({ config, deps, runDir, run, state, provider, proposal, evidence, previous, signal }) {
	if (!proposal || state.status === "rejected" || state.status === "cancelled") return { state, grammar: null };
	const entry = grammarProviderEntry(deps, config);
	const expectedTransport = transportType(entry);
	const grammarIdentity = Object.freeze({
		provider: config.grammarProvider,
		model: entry.model,
		proposalProvider: provider,
		proposalSha256: proposal.sha256,
		evidenceSha256: evidence.manifestSha256,
	});
	const grammarPath = join(runDir, "providers", provider, "grammar.json");
	if (state.grammar?.status === "submitting") {
		state.status = "rejected";
		state.failure = { code: "SUBMISSION_UNCERTAIN", message: "Refusing to resubmit a grammar extraction recorded as submitting without a receipt" };
		await writeProvider(runDir, run, config, provider, state, deps);
		return { state, grammar: null };
	}
	if (state.grammar?.status === "succeeded") {
		try {
			if (!state.grammar_receipt) {
				const legacy = await verifyLegacyGrammarResult(runDir, state);
				const grammar = state.grammar.authority
					? await rehydrateVerifiedFacadeGrammar({
						path: legacy.path, artifactSha256: state.grammar.artifact_sha256,
						authority: state.grammar.authority, evidence, provider,
						proposalSha256: proposal.sha256,
					})
					: parseGrammarCandidate(legacy.value, evidence);
				if (!state.grammar.authority && expectedTransport !== "fixture") throw new Error();
				return { state, grammar };
			}
			if (stableJson(state.grammar.identity) !== stableJson(grammarIdentity)) throw new Error();
			const receipt = await verifyDurableReceipt(runDir, state.grammar_receipt);
			const persistedPath = containedPath(runDir, join(runDir, state.grammar.path), "grammar artifact");
			const bytes = await safeRead(runDir, persistedPath, "grammar artifact");
			if (sha256(bytes) !== state.grammar.artifact_sha256
				|| receipt.schema_version !== "arr.elevation3d.facade-grammar-receipt.v1"
				|| stableJson(receipt.identity) !== stableJson(grammarIdentity)
				|| receipt.artifact?.path !== state.grammar.path
				|| receipt.artifact?.sha256 !== state.grammar.artifact_sha256
				|| receipt.artifact?.content_sha256 !== state.grammar.content_sha256
				|| receipt.result?.provider !== grammarIdentity.provider
				|| receipt.result?.model !== grammarIdentity.model
				|| receipt.result?.transport !== expectedTransport
				|| receipt.result?.request_sha256 !== state.grammar.request_sha256) throw new Error();
			const grammar = state.grammar.authority
				? await rehydrateVerifiedFacadeGrammar({
					path: persistedPath, artifactSha256: state.grammar.artifact_sha256,
					authority: state.grammar.authority, evidence, provider,
					proposalSha256: proposal.sha256,
				})
				: parseGrammarCandidate(JSON.parse(bytes.toString("utf8")), evidence);
			if (!state.grammar.authority && expectedTransport !== "fixture") throw new Error();
			return { state, grammar };
		} catch {
			state.status = "rejected";
			state.failure = { code: "GRAMMAR_RESULT_UNAVAILABLE", message: "Persisted grammar identity, receipt, or artifact is unavailable; refusing resubmission" };
			await writeProvider(runDir, run, config, provider, state, deps);
			return { state, grammar: null };
		}
	}
	const submittingStagePath = `providers/${provider}/stages/grammar-submitting.json`;
	const stagePath = `providers/${provider}/stages/grammar.json`;
	const stageInput = {
		provider,
		grammar_provider: grammarIdentity.provider,
		grammar_model: grammarIdentity.model,
		proposal_sha256: grammarIdentity.proposalSha256,
		evidence_sha256: grammarIdentity.evidenceSha256,
	};
	const submitting = await writeStage({
		runDir, path: submittingStagePath, stage: "grammar", status: "submitting", input: stageInput,
		output: { identity: grammarIdentity }, previous, provider, deps,
	});
	state.grammar = { status: "submitting", identity: grammarIdentity, proposal_sha256: proposal.sha256 };
	state.stage_manifests.grammar = submitting.ref;
	await writeProvider(runDir, run, config, provider, state, deps, { stage: "grammar", status: "submitting", provider });
	try {
		throwIfAborted(signal);
		const request = await buildGrammarRequest({ config, deps, provider, proposal, evidence, entry });
		const requestKey = request.fingerprint;
		let extracted = null;
		let adapterResult = null;
		const publicResult = await grammarLedger(deps).executeOnce({
			requestKey,
			provider: grammarIdentity.provider,
			kind: "grammar-extraction",
			ceilingMicros: config.grammarBudgetAllocationMicros[provider],
			estimateMicros: config.grammarEstimateAllocationMicros[provider],
			runCeilingMicros: config.runBudgetMicros,
			kindCeilingMicros: config.grammarBudgetMicros,
			signal,
			operation: async (submission) => {
				const adapterInput = { request, submission, signal };
				adapterResult = await entry.extract(isFacadeFixtureTransport(entry) ? { ...adapterInput, provider } : adapterInput);
				if (adapterResult?.provider !== grammarIdentity.provider
					|| adapterResult?.resolvedModel !== grammarIdentity.model
					|| adapterResult?.requestFingerprint !== request.fingerprint
					|| adapterResult?.transport !== expectedTransport) {
					throw codedError("GRAMMAR_RESPONSE_INVALID", "Grammar adapter result identity does not match the selected route");
				}
				extracted = parseGrammarCandidate(adapterResult.grammarCandidate, evidence);
				return {
					remoteId: adapterResult.remoteId,
					artifactSha256: sha256(stableJson(extracted)),
					actualMicros: adapterActualMicros(adapterResult, config.grammarEstimateAllocationMicros[provider]),
				};
			},
		});
		if (!adapterResult || !extracted) throw codedError("GRAMMAR_RESULT_UNAVAILABLE", "Persisted grammar cannot be reconstructed without resubmission");
		const contentSha256 = sha256(stableJson(extracted));
		if (publicResult?.artifactSha256 !== contentSha256) throw codedError("PAID_OPERATION_RESULT_MISMATCH", "Grammar ledger hash does not match extracted grammar");
		const bytes = Buffer.from(`${JSON.stringify(extracted, null, 2)}\n`);
		await atomicWrite(grammarPath, bytes, runDir);
		const digest = sha256(bytes);
		let authority = grammarAuthority(extracted, evidence, provider, proposal.sha256);
		if (authority) {
			extracted = await rehydrateVerifiedFacadeGrammar({
				path: grammarPath, artifactSha256: digest, authority, evidence, provider, proposalSha256: proposal.sha256,
			});
			authority = serializeVerifiedFacadeGrammarAuthority(extracted);
		} else if (expectedTransport !== "fixture") {
			throw codedError("GRAMMAR_REHYDRATION_INVALID", "Live grammar results require verified evidence authority");
		}
		const resultRecord = persistent({
			provider: adapterResult.provider,
			model: adapterResult.resolvedModel,
			transport: adapterResult.transport,
			request_sha256: adapterResult.requestFingerprint,
			...(adapterResult.remoteId ? { remote_id_sha256: sha256(adapterResult.remoteId) } : {}),
			actual_usd: adapterResult.actualUsd,
			usage: adapterResult.usage,
		});
		state.grammar_receipt = await writeReceipt(runDir, `providers/${provider}/receipts/grammar.json`, {
			schema_version: "arr.elevation3d.facade-grammar-receipt.v1",
			identity: grammarIdentity,
			result: resultRecord,
			artifact: {
				path: relativePath(runDir, grammarPath, "grammar artifact"),
				sha256: digest,
				content_sha256: contentSha256,
			},
		});
		const succeeded = await writeStage({
			runDir, path: stagePath, stage: "grammar", status: "succeeded", input: stageInput,
			output: {
				identity: grammarIdentity,
				grammar_sha256: digest,
				grammar_path: relativePath(runDir, grammarPath, "grammar artifact"),
				receipt_sha256: state.grammar_receipt.receipt_sha256,
				transport: expectedTransport,
			},
			previous, provider, deps,
		});
		state.grammar = {
			status: "succeeded",
			identity: grammarIdentity,
			proposal_sha256: proposal.sha256,
			request_sha256: request.fingerprint,
			artifact_sha256: digest,
			content_sha256: contentSha256,
			path: relativePath(runDir, grammarPath, "grammar artifact"),
			transport: expectedTransport,
			cost_receipt: { actualUsd: publicResult.actualUsd },
			...(authority ? { authority } : {}),
		};
		state.stage_manifests.grammar = succeeded.ref;
		state.status = "grammar-ready";
		await writeProvider(runDir, run, config, provider, state, deps);
		await callLifecycle(deps, { stage: "grammar", status: "returned", provider, proposal_sha256: proposal.sha256 });
		await writeProvider(runDir, run, config, provider, state, deps, { stage: "grammar", status: "succeeded", provider });
		return { state, grammar: extracted };
	} catch (error) {
		if (error instanceof LifecycleHookError) throw error;
		const aborted = isAbort(error, signal);
		state.status = aborted ? "cancelled" : "rejected";
		state.failure = aborted
			? safeError(error, "FACADE_AGENT_CANCELLED")
			: error?.definitiveNonSubmission === true
				? safeError(error, "GRAMMAR_EXTRACTION_FAILED")
			: { code: "SUBMISSION_UNCERTAIN", message: "Grammar submission outcome is uncertain; refusing replay" };
		if (error?.definitiveNonSubmission === true) state.grammar.status = "failed";
		await writeProvider(runDir, run, config, provider, state, deps);
		return { state, grammar: null, cancelled: state.status === "cancelled" };
	}
}

function artifactClaim(built) {
	const artifact = built?.artifact ?? built;
	const path = artifact && typeof artifact === "object" ? Object.getOwnPropertyDescriptor(artifact, "path")?.value : null;
	const digest = artifact && typeof artifact === "object" ? Object.getOwnPropertyDescriptor(artifact, "sha256")?.value : null;
	if (typeof path !== "string" || !HEX_SHA256.test(digest ?? "")) {
		throw codedError("FACADE_BUILD_ARTIFACT_INVALID", "Build stage must return a content-addressed artifact");
	}
	return { path, sha256: digest };
}

async function authorizeGlb(runDir, claimInput) {
	const claim = artifactClaim(claimInput);
	const path = containedPath(runDir, isAbsolute(claim.path) ? claim.path : join(runDir, claim.path), "built GLB");
	await assertNoReparsePoints(path);
	const handle = await open(path, "r");
	let bytes;
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) throw codedError("FACADE_BUILD_ARTIFACT_INVALID", "Built GLB must be a regular file");
		if (stats.size <= 0 || stats.size > 256 * 1024 * 1024) throw codedError("FACADE_BUILD_ARTIFACT_INVALID", "Built GLB size is invalid");
		bytes = await handle.readFile();
	} finally { await handle.close(); }
	await assertNoReparsePoints(path);
	const digest = sha256(bytes);
	if (digest !== claim.sha256) throw codedError("FACADE_BUILD_ARTIFACT_HASH_MISMATCH", "Built GLB bytes do not match the claimed SHA-256");
	try { await new NodeIO().readBinary(new Uint8Array(bytes)); }
	catch (error) { throw codedError("FACADE_BUILD_ARTIFACT_INVALID", "Built artifact is not a structurally valid GLB", error); }
	return Object.freeze({ path, sha256: digest, size_bytes: bytes.length });
}

function persistedArtifact(runDir, artifact) {
	return Object.freeze({
		path: relativePath(runDir, artifact.path, "built GLB"),
		sha256: artifact.sha256,
		size_bytes: artifact.size_bytes,
	});
}

function validationRecord(validation, retryable) {
	return persistent({
		accepted: validation?.accepted === true,
		codes: Array.isArray(validation?.codes) ? [...new Set(validation.codes.filter((code) => typeof code === "string"))] : [],
		retryable,
		metrics: validation?.metrics ?? {},
		artifacts: validation?.artifacts ?? {},
	});
}

function persistedDeliveryMemory(runDir, value) {
	if (!value || typeof value !== "object") return null;
	const record = (input, label) => input?.path ? {
		...persistent(input), path: relativePath(runDir, input.path, label),
	} : null;
	return persistent({
		manifest: record(value.manifest, "delivery manifest"),
		validation: record(value.validation, "delivery validation"),
		viewer: record(value.viewer, "delivery viewer"),
		browser_verification: record(value.browser_verification, "delivery browser verification"),
		views: value.views && Object.fromEntries(Object.entries(value.views).map(([name, view]) => [
			name, record(view, `delivery ${name} view`),
		])),
	});
}

function localRetryAllowed(validation, attempt) {
	if (attempt !== 1 || validation?.accepted === true || validation?.retryable === false) return false;
	const codes = validation?.codes;
	return Array.isArray(codes) && codes.length > 0
		&& codes.every((code) => LOCAL_REPAIR_CODES.has(code))
		&& !codes.some((code) => PROHIBITED_RETRY_CODES.has(code));
}

function assertValidationAuthorityBindings({ authority, provider, state, artifact, currentGrammar, extractedGrammar }) {
	const grammarAuthority = readVerifiedFacadeGrammarAuthority(extractedGrammar);
	const expected = {
		provider,
		candidateId: grammarAuthority?.candidateId,
		bindings: {
			geometry_hash: grammarAuthority?.geometryHash,
			geometry_content_sha256: grammarAuthority?.geometryContentSha256,
			geometry_signed_volume_orientation: grammarAuthority?.geometrySignedVolumeOrientation,
			facade_segment_authority_sha256: grammarAuthority?.facadeSegmentAuthority?.sha256 ?? null,
			glb_sha256: artifact.sha256,
			evidence_sha256: grammarAuthority?.evidenceManifestSha256,
			cameras_sha256: grammarAuthority?.camerasSha256,
			proposal_sha256: state.proposal?.sha256,
			grammar_sha256: sha256(stableJson(currentGrammar)),
			extracted_grammar_sha256: grammarAuthority?.grammarSha256,
		},
	};
	if (!grammarAuthority || authority?.provider !== expected.provider || authority?.candidateId !== expected.candidateId
		|| Object.entries(expected.bindings).some(([key, value]) => authority?.bindings?.[key] !== value)
		|| stableJson(authority?.grammar) !== stableJson(currentGrammar)) {
		throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Validation authority does not match the current verified artifacts");
	}
}

function assertScoreAuthorityBindings(scoreResult, validation) {
	const authority = readVerifiedFacadeValidationAuthority(validation);
	if (!authority) return;
	if (scoreResult?.provider !== authority.provider
		|| scoreResult?.breakdown?.candidate_id !== authority.candidateId
		|| stableJson(scoreResult?.breakdown?.bindings) !== stableJson(authority.bindings)) {
		throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Score authority does not match the current validation authority");
	}
}

const CORRECTION_FIELDS = Object.freeze({
	WINDOW_CROSSES_FLOOR_BAND: ["window_height_m"],
	DETAIL_BOUNDS_EXCEEDED: ["cladding_depth_m", "reveal_depth_m"],
	CORNER_DATUM_MISMATCH: ["corner_datum_m"],
	PRIMITIVE_BUDGET_EXCEEDED: ["bay_width_m"],
});
const CORRECTION_DERIVED_BINDING_FIELDS = new Set(["wall_opacity", "curtain_wall_allowed", "floor_elevations_m", "facade_lengths_m"]);

function changedGrammarFields(input, output) {
	return [...new Set([...Object.keys(input), ...Object.keys(output)])]
		.filter((field) => stableJson(input[field]) !== stableJson(output[field])).sort();
}

function correctionBindings({ provider, state, evidence, candidate, extractedGrammar }) {
	const authority = readVerifiedFacadeGrammarAuthority(extractedGrammar);
	return persistent({
		provider,
		proposal_sha256: state.proposal?.sha256,
		evidence_sha256: evidence?.manifestSha256,
		candidate_id: candidate?.candidate?.candidate_id ?? candidate?.candidate_id,
		geometry_hash: authority?.geometryHash ?? candidate?.identity?.geometry_hash ?? null,
		geometry_content_sha256: authority?.geometryContentSha256 ?? null,
		geometry_signed_volume_orientation: authority?.geometrySignedVolumeOrientation ?? null,
		cameras_sha256: authority?.camerasSha256 ?? null,
		floor_guides_m: authority?.floorGuides ?? extractedGrammar?.floor_elevations_m ?? [],
		facade_lengths_m: authority?.facadeLengths ?? extractedGrammar?.facade_lengths_m ?? {},
		facade_segment_authority: authority?.facadeSegmentAuthority ?? null,
	});
}

async function persistOrLoadCorrection({ runDir, run, config, deps, state, provider, inputGrammar, extractedGrammar, codes }) {
	const grammarPath = join(runDir, "providers", provider, "grammar-v002.json");
	const correctionPath = join(runDir, "providers", provider, "correction-v002.json");
	if (state.correction_v002) {
		const ref = state.correction_v002;
		let grammarBytes;
		let correctionBytes;
		try {
			grammarBytes = await safeRead(runDir, join(runDir, ref.grammar.path), "v002 grammar");
			correctionBytes = await safeRead(runDir, join(runDir, ref.correction.path), "v002 correction");
		} catch (error) { throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Persisted v002 correction artifacts are unavailable", error); }
		if (sha256(grammarBytes) !== ref.grammar.sha256 || sha256(correctionBytes) !== ref.correction.sha256) {
			throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Persisted v002 correction artifact hash mismatch");
		}
		const grammar = JSON.parse(grammarBytes.toString("utf8"));
		const correction = JSON.parse(correctionBytes.toString("utf8"));
		if (sha256(stableJson(grammar)) !== correction.output_grammar_sha256
			|| correction.input_grammar_sha256 !== sha256(stableJson(inputGrammar))
			|| stableJson(correction.correction_codes) !== stableJson(codes)
			|| stableJson(correction.bindings) !== stableJson(correctionBindings({ provider, state, evidence: run._evidence, candidate: run._candidate, extractedGrammar }))) {
			throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Persisted v002 correction bindings are invalid");
		}
		return { grammar, ref };
	}
	const grammar = typeof deps.correctGrammar === "function"
		? deps.correctGrammar(inputGrammar, codes, run._candidate)
		: correctGrammar(inputGrammar, codes);
	const changedFields = changedGrammarFields(inputGrammar, grammar);
	const correctedFields = changedFields.filter((field) => !CORRECTION_DERIVED_BINDING_FIELDS.has(field));
	const allowedFields = [...new Set(codes.flatMap((code) => CORRECTION_FIELDS[code] ?? []))].sort();
	if (stableJson(correctedFields) !== stableJson(allowedFields)) throw codedError("FACADE_CORRECTION_INVALID", "Correction changed fields outside its allowlist");
	const grammarWritten = await atomicJson(grammarPath, grammar, runDir);
	const correction = {
		schema_version: "arr.elevation3d.facade-correction.v1",
		input_grammar_sha256: sha256(stableJson(inputGrammar)),
		output_grammar_sha256: sha256(stableJson(grammar)),
		correction_codes: [...codes], changed_fields: correctedFields,
		bindings: correctionBindings({ provider, state, evidence: run._evidence, candidate: run._candidate, extractedGrammar }),
	};
	const correctionWritten = await atomicJson(correctionPath, correction, runDir);
	const ref = {
		grammar: { path: relativePath(runDir, grammarPath, "v002 grammar"), sha256: grammarWritten.sha256, content_sha256: correction.output_grammar_sha256 },
		correction: { path: relativePath(runDir, correctionPath, "v002 correction"), sha256: correctionWritten.sha256, content_sha256: sha256(stableJson(correction)) },
	};
	state.correction_v002 = ref;
	await writeProvider(runDir, run, config, provider, state, deps, { stage: "correction", status: "succeeded", provider, version_id: "v002" });
	return { grammar, ref };
}

async function buildAndValidateProvider({ config, deps, runDir, run, state, provider, extractedGrammar, previous, signal, stopAfterStage }) {
	if (!extractedGrammar || state.status === "rejected" || state.status === "cancelled") return { state, scoreResult: null };
	let currentGrammar = extractedGrammar;
	let localPrevious = previous;
	for (let attempt = 1; attempt <= config.maxLocalAttempts; attempt += 1) {
		const versionId = `v${String(attempt).padStart(3, "0")}`;
		let version = state.versions.find((item) => item.id === versionId);
		if (!version) {
			version = {
				id: versionId, status: "building", grammar_sha256: sha256(stableJson(persistent(currentGrammar))),
				...(attempt === 2 ? {
					grammar_artifact: structuredClone(state.correction_v002?.grammar),
					correction_record: structuredClone(state.correction_v002?.correction),
				} : {}),
			};
			state.versions.push(version);
			await writeProvider(runDir, run, config, provider, state, deps);
		}
		let artifact;
		try {
			if (version.artifact) {
				artifact = await authorizeGlb(runDir, version.artifact);
			} else {
				throwIfAborted(signal);
				const built = await deps.build({ provider, versionId, attempt, grammar: currentGrammar, input: run._candidate, candidate: run._candidate, evidence: run._evidence, runDir, signal });
				artifact = await authorizeGlb(runDir, built);
				version.artifact = persistedArtifact(runDir, artifact);
				version.status = "built";
				const builtStage = await writeStage({
					runDir, path: `providers/${provider}/stages/build-${versionId}.json`, stage: "build", status: "succeeded",
					input: {
						provider, version_id: versionId, grammar_sha256: version.grammar_sha256,
						...(version.grammar_artifact ? { grammar_artifact: version.grammar_artifact, correction_record: version.correction_record } : {}),
					},
					output: { artifact: version.artifact }, previous: localPrevious, provider, versionId, deps,
				});
				state.stage_manifests[`build-${versionId}`] = builtStage.ref;
				await writeProvider(runDir, run, config, provider, state, deps, { stage: "build", status: "succeeded", provider, version_id: versionId });
			}
			if (stopAfterStage === "build") return { state, scoreResult: null };
			throwIfAborted(signal);
			artifact = await authorizeGlb(runDir, version.artifact);
			let validation;
			let retryable;
			if (version.validation_receipt) {
				const receipt = await verifyDurableReceipt(runDir, version.validation_receipt);
				if (receipt.schema_version !== "arr.elevation3d.facade-validation-receipt.v1" || receipt.provider !== provider
					|| receipt.version_id !== versionId || receipt.artifact_sha256 !== artifact.sha256
					|| receipt.grammar_sha256 !== version.grammar_sha256
					|| stableJson(receipt.grammar_artifact ?? null) !== stableJson(version.grammar_artifact ?? null)
					|| stableJson(receipt.correction_record ?? null) !== stableJson(version.correction_record ?? null)
					|| stableJson(receipt.validation) !== stableJson(version.validation)) {
					throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Validation receipt bindings do not match durable artifacts");
				}
				validation = receipt.validation;
				if (receipt.validation_authority) {
					assertValidationAuthorityBindings({
						authority: receipt.validation_authority, provider, state, artifact, currentGrammar, extractedGrammar,
					});
					validation = rehydrateVerifiedFacadeValidationAuthority(validation, receipt.validation_authority);
				}
				retryable = localRetryAllowed(validation, attempt);
			} else {
				version.validation_execution = { status: "submitting", artifact_sha256: artifact.sha256 };
				await writeProvider(runDir, run, config, provider, state, deps);
				validation = await deps.validate({
					provider, versionId, attempt, grammar: currentGrammar, extractedGrammar,
					artifact, build: Object.freeze({ artifact }), input: run._candidate, candidate: run._candidate, evidence: run._evidence, runDir, signal,
				});
				await callLifecycle(deps, { stage: "validate", status: "returned", provider, version_id: versionId, artifact_sha256: artifact.sha256 });
				retryable = localRetryAllowed(validation, attempt);
				version.validation = validationRecord(validation, retryable);
				version.status = validation?.accepted === true ? "accepted" : "rejected";
				const validationAuthority = readVerifiedFacadeValidationAuthority(validation);
				version.validation_receipt = await writeReceipt(runDir, `providers/${provider}/receipts/validation-${versionId}.json`, {
					schema_version: "arr.elevation3d.facade-validation-receipt.v1",
					provider, version_id: versionId, artifact_sha256: version.artifact.sha256,
					grammar_sha256: version.grammar_sha256, validation: version.validation,
					...(version.grammar_artifact ? { grammar_artifact: version.grammar_artifact, correction_record: version.correction_record } : {}),
					...(validationAuthority ? { validation_authority: validationAuthority } : {}),
				});
				version.validation_execution = { status: "succeeded", receipt_sha256: version.validation_receipt.receipt_sha256 };
				await writeProvider(runDir, run, config, provider, state, deps, { stage: "validation-receipt", status: "succeeded", provider, version_id: versionId, receipt_sha256: version.validation_receipt.receipt_sha256 });
			}
			const validateStage = await writeStage({
				runDir, path: `providers/${provider}/stages/validate-${versionId}.json`, stage: "validate", status: "succeeded",
				input: { provider, version_id: versionId, artifact_sha256: version.artifact.sha256, grammar_sha256: version.grammar_sha256 },
				output: { validation: version.validation }, previous: state.stage_manifests[`build-${versionId}`], provider, versionId, deps,
			});
			state.stage_manifests[`validate-${versionId}`] = validateStage.ref;
			localPrevious = validateStage.manifest;
			await writeProvider(runDir, run, config, provider, state, deps, { stage: "validate", status: "succeeded", provider, version_id: versionId });
			if (validation?.accepted === true) {
				const scoreCandidate = typeof deps.score === "function" ? deps.score : deps.score?.candidate;
				if (typeof scoreCandidate !== "function") throw codedError("FACADE_SCORE_MISSING", "A score dependency is required");
				let scoreResult;
				if (state.score_receipt) {
					const receipt = await verifyDurableReceipt(runDir, state.score_receipt);
					if (receipt.schema_version !== "arr.elevation3d.facade-score-receipt.v1" || receipt.provider !== provider
						|| receipt.validation_receipt_sha256 !== version.validation_receipt.receipt_sha256
						|| stableJson(receipt.score) !== stableJson(state.score)) {
						throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Score receipt bindings do not match durable validation");
					}
					scoreResult = typeof deps.score?.rehydrate === "function"
						? deps.score.rehydrate(receipt.score)
						: rehydrateFacadeScoreResult(receipt.score);
					assertScoreAuthorityBindings(scoreResult, validation);
				} else {
					state.score_execution = { status: "submitting", validation_receipt_sha256: version.validation_receipt.receipt_sha256 };
					await writeProvider(runDir, run, config, provider, state, deps);
					scoreResult = await scoreCandidate({ provider, validation });
					await callLifecycle(deps, { stage: "score", status: "returned", provider, validation_receipt_sha256: version.validation_receipt.receipt_sha256 });
					state.score = persistent(scoreResult);
					state.score_receipt = await writeReceipt(runDir, `providers/${provider}/receipts/score.json`, {
						schema_version: "arr.elevation3d.facade-score-receipt.v1",
						provider, validation_receipt_sha256: version.validation_receipt.receipt_sha256,
						score: state.score,
					});
					state.score_execution = { status: "succeeded", receipt_sha256: state.score_receipt.receipt_sha256 };
				}
				state.status = scoreResult?.accepted === true ? "accepted" : "rejected";
				if (state.status === "rejected") state.failure = { code: scoreResult?.reason ?? "SCORE_REJECTED", message: "Authorized scoring rejected the provider" };
				await writeProvider(runDir, run, config, provider, state, deps, { stage: "score-receipt", status: "succeeded", provider, receipt_sha256: state.score_receipt.receipt_sha256 });
				return {
					state, scoreResult: scoreResult?.accepted === true ? scoreResult : null,
					selectedArtifact: artifact, selectedValidation: validation, selectedValidationReceipt: version.validation_receipt,
				};
			}
			if (!retryable || attempt === config.maxLocalAttempts) {
				state.status = "rejected";
				state.failure = { code: version.validation.codes[0] ?? "VALIDATION_REJECTED", message: "Facade validation rejected the provider" };
				await writeProvider(runDir, run, config, provider, state, deps);
				return { state, scoreResult: null };
			}
			const correction = await persistOrLoadCorrection({
				runDir, run, config, deps, state, provider, inputGrammar: currentGrammar,
				extractedGrammar, codes: version.validation.codes,
			});
			currentGrammar = correction.grammar;
		} catch (error) {
			if (error instanceof LifecycleHookError) throw error;
			version.status = isAbort(error, signal) ? "cancelled" : "rejected";
			version.failure = safeError(error, isAbort(error, signal) ? "FACADE_AGENT_CANCELLED" : "LOCAL_STAGE_FAILED");
			state.status = version.status === "cancelled" ? "cancelled" : "rejected";
			state.failure = version.failure;
			await writeProvider(runDir, run, config, provider, state, deps);
			return { state, scoreResult: null, cancelled: state.status === "cancelled" };
		}
	}
	return { state, scoreResult: null };
}

async function terminalCancellation(runDir, run, config, deps, provider) {
	run.status = "cancelled";
	run.final = { status: "cancelled", ...(provider ? { cancelled_provider: provider } : {}) };
	const written = await atomicJson(join(runDir, "final.json"), run.final, runDir);
	run.final_manifest = { path: "final.json", sha256: written.sha256 };
	await writeRun(runDir, run);
	return readFacadeAgentStatus(runDir);
}

function publicRun(run) {
	const { _candidate, _evidence, _scoreAuthorities, ...publicValue } = run;
	return publicValue;
}

async function persistPublicRun(runDir, run) {
	await writeRun(runDir, publicRun(run));
}

async function writeReceipt(runDir, path, receipt) {
	const safe = persistent(receipt);
	const absolute = containedPath(runDir, join(runDir, path), "durable receipt");
	const written = await atomicJson(absolute, safe, runDir);
	return Object.freeze({
		path: relativePath(runDir, absolute, "durable receipt"),
		sha256: written.sha256,
		receipt_sha256: sha256(stableJson(safe)),
	});
}

function durableReceiptRefs(run) {
	const refs = [];
	for (const [provider, state] of Object.entries(run.providers ?? {})) {
		for (const version of state?.versions ?? []) {
			if (version.validation_receipt) refs.push({ provider, kind: "validation", version_id: version.id, ...version.validation_receipt });
			else if (version.validation_execution?.status === "submitting") refs.push({ provider, kind: "validation-uncertain", version_id: version.id });
		}
		if (state?.score_receipt) refs.push({ provider, kind: "score", ...state.score_receipt });
		else if (state?.score_execution?.status === "submitting") refs.push({ provider, kind: "score-uncertain" });
	}
	return refs;
}

async function verifyDurableReceipt(runDir, ref) {
	if (typeof ref.path !== "string" || !HEX_SHA256.test(ref.sha256 ?? "") || !HEX_SHA256.test(ref.receipt_sha256 ?? "")) {
		throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Durable receipt reference is invalid");
	}
	let bytes;
	try { bytes = await safeRead(runDir, join(runDir, ref.path), "durable receipt"); }
	catch (error) { throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Durable receipt is unavailable", error); }
	if (sha256(bytes) !== ref.sha256) throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Durable receipt file hash mismatch");
	let receipt;
	try { receipt = JSON.parse(bytes.toString("utf8")); }
	catch (error) { throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Durable receipt is invalid", error); }
	if (sha256(stableJson(receipt)) !== ref.receipt_sha256) throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Durable receipt content hash mismatch");
	return receipt;
}

function hasCurrentGrammarBindings(grammar) {
	return ["identity", "request_sha256", "content_sha256", "transport"].some((key) => Object.hasOwn(grammar ?? {}, key));
}

function validLegacyGrammarAuthority(authority, state, grammar, contentSha256) {
	const segmentAuthority = authority?.facadeSegmentAuthority;
	return authority && typeof authority === "object" && !Array.isArray(authority)
		&& typeof authority.candidateId === "string" && authority.candidateId.length > 0
		&& typeof authority.geometryHash === "string" && authority.geometryHash.length > 0
		&& (authority.geometryContentSha256 === null || HEX_SHA256.test(authority.geometryContentSha256 ?? ""))
		&& [null, -1, 1].includes(authority.geometrySignedVolumeOrientation)
		&& (segmentAuthority === null || (HEX_SHA256.test(segmentAuthority?.sha256 ?? "")
			&& Array.isArray(segmentAuthority.segmentIds) && segmentAuthority.segmentIds.length > 0
			&& segmentAuthority.segmentIds.every((id) => typeof id === "string" && id.length > 0)
			&& new Set(segmentAuthority.segmentIds).size === segmentAuthority.segmentIds.length))
		&& authority.provider === state.provider && authority.proposalSha256 === grammar.proposal_sha256
		&& authority.grammarSha256 === contentSha256 && HEX_SHA256.test(authority.evidenceManifestSha256 ?? "")
		&& HEX_SHA256.test(authority.camerasSha256 ?? "")
		&& Array.isArray(authority.floorGuides) && authority.floorGuides.length >= 2
		&& authority.floorGuides.every((value) => Number.isFinite(value))
		&& authority.facadeLengths && typeof authority.facadeLengths === "object" && !Array.isArray(authority.facadeLengths)
		&& Object.values(authority.facadeLengths).every((value) => Number.isFinite(value));
}

async function verifyLegacyGrammarResult(runDir, state) {
	const grammar = state?.grammar;
	const ref = state?.stage_manifests?.grammar;
	if (state?.schema_version !== LEGACY_PROVIDER_SCHEMA || grammar?.status !== "succeeded"
		|| hasCurrentGrammarBindings(grammar) || !ref || ref.status !== "succeeded") {
		throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Completed grammar is missing its durable receipt");
	}
	const stage = await readStageRef(runDir, ref);
	const outputKeys = Object.keys(stage.output ?? {}).sort();
	if (stage.input !== undefined || stableJson(outputKeys) !== stableJson(["grammar_path", "grammar_sha256"])
		|| stage.output.grammar_path !== grammar.path || stage.output.grammar_sha256 !== grammar.artifact_sha256
		|| typeof grammar.path !== "string" || !HEX_SHA256.test(grammar.artifact_sha256 ?? "")
		|| !HEX_SHA256.test(grammar.proposal_sha256 ?? "")) {
		throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Legacy grammar stage bindings are invalid");
	}
	let bytes;
	let value;
	try {
		bytes = await safeRead(runDir, join(runDir, grammar.path), "legacy grammar artifact");
		value = JSON.parse(bytes.toString("utf8"));
		parseGrammarCandidate(value, null);
	} catch (error) {
		throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Legacy grammar artifact is unavailable or invalid", error);
	}
	const contentSha256 = sha256(stableJson(value));
	if (sha256(bytes) !== grammar.artifact_sha256) {
		throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Legacy grammar artifact hash mismatch");
	}
	if (grammar.authority) {
		if (!validLegacyGrammarAuthority(grammar.authority, state, grammar, contentSha256)) {
			throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Legacy grammar authority bindings are invalid");
		}
	}
	return { bytes, value, path: containedPath(runDir, join(runDir, grammar.path), "legacy grammar artifact") };
}

async function verifyProviderReceipts(runDir, state) {
	if (state?.grammar_receipt) {
		const receipt = await verifyDurableReceipt(runDir, state.grammar_receipt);
		if (state.grammar?.status !== "succeeded"
			|| receipt.schema_version !== "arr.elevation3d.facade-grammar-receipt.v1"
			|| stableJson(receipt.identity) !== stableJson(state.grammar.identity)
			|| receipt.artifact?.path !== state.grammar.path
			|| receipt.artifact?.sha256 !== state.grammar.artifact_sha256
			|| receipt.artifact?.content_sha256 !== state.grammar.content_sha256
			|| receipt.result?.provider !== state.grammar.identity?.provider
			|| receipt.result?.model !== state.grammar.identity?.model
			|| receipt.result?.transport !== state.grammar.transport
			|| receipt.result?.request_sha256 !== state.grammar.request_sha256) {
			throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Grammar receipt bindings do not match durable grammar state");
		}
		let bytes;
		let grammar;
		try {
			bytes = await safeRead(runDir, join(runDir, receipt.artifact.path), "grammar artifact");
			grammar = JSON.parse(bytes.toString("utf8"));
		} catch (error) {
			throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Grammar receipt artifact is unavailable or invalid", error);
		}
		if (sha256(bytes) !== receipt.artifact.sha256 || sha256(stableJson(grammar)) !== receipt.artifact.content_sha256) {
			throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Grammar receipt artifact hash mismatch");
		}
	} else if (state?.grammar?.status === "succeeded") {
		await verifyLegacyGrammarResult(runDir, state);
	}
	if (state?.correction_v002) {
		const { grammar, correction } = state.correction_v002;
		if (!grammar?.path || !HEX_SHA256.test(grammar.sha256 ?? "") || !correction?.path || !HEX_SHA256.test(correction.sha256 ?? "")) {
			throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Persisted v002 correction references are invalid");
		}
		let grammarBytes;
		let correctionBytes;
		try {
			grammarBytes = await safeRead(runDir, join(runDir, grammar.path), "v002 grammar");
			correctionBytes = await safeRead(runDir, join(runDir, correction.path), "v002 correction");
		} catch (error) { throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Persisted v002 correction artifacts are unavailable", error); }
		if (sha256(grammarBytes) !== grammar.sha256 || sha256(correctionBytes) !== correction.sha256) {
			throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Persisted v002 correction artifact hash mismatch");
		}
		let grammarValue;
		let correctionValue;
		try { grammarValue = JSON.parse(grammarBytes); correctionValue = JSON.parse(correctionBytes); }
		catch (error) { throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Persisted v002 correction artifact is invalid", error); }
		if (sha256(stableJson(grammarValue)) !== grammar.content_sha256
			|| sha256(stableJson(correctionValue)) !== correction.content_sha256
			|| correctionValue.output_grammar_sha256 !== grammar.content_sha256) {
			throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Persisted v002 correction content binding mismatch");
		}
	}
	for (const version of state?.versions ?? []) {
		if (version.validation_receipt) {
			await verifyDurableReceipt(runDir, version.validation_receipt);
			if (version.validation_execution?.status === "succeeded"
				&& version.validation_execution.receipt_sha256 !== version.validation_receipt.receipt_sha256) {
				throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Validation receipt execution binding mismatch");
			}
		} else if (version.validation_execution?.status === "succeeded") {
			throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Completed validation is missing its durable receipt");
		}
	}
	if (state?.score_receipt) {
		await verifyDurableReceipt(runDir, state.score_receipt);
		if (state.score_execution?.status === "succeeded" && state.score_execution.receipt_sha256 !== state.score_receipt.receipt_sha256) {
			throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Score receipt execution binding mismatch");
		}
	} else if (state?.score_execution?.status === "succeeded") {
		throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Completed score is missing its durable receipt");
	}
}

async function failClosedForDurableReceipts(runDir, run, refs) {
	for (const ref of refs) if (ref.path) await verifyDurableReceipt(runDir, ref);
	run.status = "blocked";
	run.failure = { code: "DURABLE_RECEIPT_RECONCILIATION_REQUIRED", message: "Refusing to rerun or reinterpret durable validation or score receipts after process restart" };
	run.final = { status: "blocked", failure: run.failure, receipts: refs.map(({ provider, kind, version_id, receipt_sha256 }) => ({ provider, kind, ...(version_id ? { version_id } : {}), receipt_sha256 })) };
	const written = await atomicJson(join(runDir, "final.json"), run.final, runDir);
	run.final_manifest = { path: "final.json", sha256: written.sha256 };
	await writeRun(runDir, run);
	return { run, terminal: true };
}

async function initialize(config, deps, signal) {
	const normalized = normalizeFacadeAgentConfig(config);
	const runDir = runDirectory(normalized);
	await assertNoReparsePoints(normalized.outputRoot);
	await assertNoReparsePoints(runDir);
	await mkdir(runDir, { recursive: true });
	await assertNoReparsePoints(runDir);
	const inputSha256 = facadeRequestFingerprint(normalized);
	const runPath = join(runDir, "run.json");
	let run;
	if (await exists(runPath)) {
		run = await readFacadeAgentStatus(runDir);
		if (run.input_sha256 !== inputSha256 || run.run_id !== normalized.runId || run.candidate_id !== normalized.candidateId || run.brief_id !== normalized.briefId) {
			throw codedError("FACADE_AGENT_RESUME_MISMATCH", "Persisted run does not match the requested configuration");
		}
		if (TERMINAL_RUN_STATES.has(run.status)) return { normalized, runDir, run, terminal: true };
		if (run.final?.status === "blocked" && run.failure?.code === "DURABLE_RECEIPT_RECONCILIATION_REQUIRED") return { normalized, runDir, run, terminal: true };
		if (["submitting", "succeeded"].includes(run.delivery?.status)) {
			run.status = "delivery-failed";
			run.final = {
				status: "delivery-failed",
				selected_provider: run.delivery.provider,
				selected_glb_sha256: run.delivery.selected_glb_sha256,
				failure: { code: "FINAL_DELIVERY_UNCERTAIN", message: "Refusing to repeat a delivery recorded as submitting" },
			};
			const written = await atomicJson(join(runDir, "final.json"), run.final, runDir);
			run.final_manifest = { path: "final.json", sha256: written.sha256 };
			await writeRun(runDir, run);
			return { normalized, runDir, run, terminal: true };
		}
		const receiptRefs = durableReceiptRefs(run);
		const uncertainRefs = receiptRefs.filter((ref) => ref.kind.endsWith("-uncertain"));
		if (uncertainRefs.length > 0) {
			const terminal = await failClosedForDurableReceipts(runDir, run, uncertainRefs);
			return { normalized, runDir, ...terminal };
		}
	} else {
		run = initialRun(normalized, runDir, inputSha256);
		await writeRun(runDir, run);
	}
	throwIfAborted(signal);
	return { normalized, runDir, run, terminal: false };
}

async function executeFacade(config, deps, stopAfterStage = null) {
	if (!deps || typeof deps !== "object") throw new TypeError("Facade agent dependencies are required");
	for (const name of ["loadCandidate", "buildEvidence", "build", "validate", "renderDelivery"]) {
		if (typeof deps[name] !== "function") throw new TypeError(`deps.${name} must be a function`);
	}
	if (!deps.grammarProvider || typeof deps.grammarProvider !== "object" || typeof deps.grammarProvider.extract !== "function") {
		throw new TypeError("deps.grammarProvider.extract must be a function");
	}
	const signal = deps.signal ?? config?.signal;
	const initialized = await initialize(config, deps, signal);
	if (initialized.terminal) return initialized.run;
	const { normalized, runDir, run } = initialized;
	try {
		throwIfAborted(signal);
		const candidate = await deps.loadCandidate({ datasetRoot: normalized.datasetRoot, candidateId: normalized.candidateId, config: normalized, signal });
		const candidateSha256 = sha256(stableJson(persistent(candidate)));
		let preflight = run.stage_manifests.preflight ? await readStageRef(runDir, run.stage_manifests.preflight) : null;
		if (preflight && preflight.output?.candidate_sha256 !== candidateSha256) throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Candidate changed after preflight");
		let evidenceStage = run.stage_manifests.evidence ? await readStageRef(runDir, run.stage_manifests.evidence) : null;
		const evidenceManifestPath = evidenceStage?.output?.manifest_path ?? preflight?.output?.evidence_manifest_path;
		const evidence = await deps.buildEvidence({
			input: candidate, candidate, runDir, signal, resume: Boolean(evidenceManifestPath), manifestPath: evidenceManifestPath,
		});
		if (!evidence || !HEX_SHA256.test(evidence.manifestSha256 ?? "")) throw codedError("FACADE_EVIDENCE_INVALID", "Evidence stage must return a verified manifest SHA-256");
		if ((preflight?.output?.evidence_sha256 && preflight.output.evidence_sha256 !== evidence.manifestSha256)
			|| (evidenceStage?.output?.evidence_sha256 && evidenceStage.output.evidence_sha256 !== evidence.manifestSha256)) {
			throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Evidence changed after persistence");
		}
		if (!preflight) {
			const brief = persistent({ ...(normalized.brief ?? {}), id: normalized.briefId, brief_id: normalized.briefId, candidate_id: normalized.candidateId });
			const requests = {};
			const capabilities = {};
			for (const provider of normalized.providers) {
				const entry = providerEntry(deps, provider);
				const request = buildProviderRequest(entry, {
					provider, evidence, brief, output: { path: join(runDir, "providers", provider, "proposal"), count: 1 },
				});
				const requestManifest = {
					schema_version: "arr.elevation3d.facade-request.v1", provider,
					request_fingerprint: request.fingerprint, evidence_sha256: evidence.manifestSha256,
					brief_id: normalized.briefId,
					budget: { ceiling_usd: normalized.imageBudgetUsd[provider], estimate_usd: normalized.imageEstimateUsd?.[provider] ?? normalized.imageBudgetUsd[provider] },
				};
				const requestPath = join(runDir, "providers", provider, "request-manifest.json");
				const written = await atomicJson(requestPath, requestManifest, runDir);
				requests[provider] = { path: relativePath(runDir, requestPath, "provider request manifest"), sha256: written.sha256, fingerprint: request.fingerprint };
				if (typeof entry.preflight === "function") capabilities[provider] = preflightCapability(() => entry.preflight({
					request, ceilingUsd: normalized.imageBudgetUsd[provider],
					estimateUsd: normalized.imageEstimateUsd?.[provider] ?? normalized.imageBudgetUsd[provider],
				}));
				else if (isFacadeFixtureTransport(entry)) capabilities[provider] = { available: true, provider, model: provider, fixture: true };
				else throw codedError("PREFLIGHT_CAPABILITY_MISSING", `Provider ${provider} has no non-network preflight capability`);
			}
			const selectedGrammarProvider = grammarProviderEntry(deps, normalized);
			const grammarCapabilityKey = `grammar:${normalized.grammarProvider}`;
			if (typeof selectedGrammarProvider.preflight === "function") {
				capabilities[grammarCapabilityKey] = preflightCapability(() => selectedGrammarProvider.preflight({
					model: selectedGrammarProvider.model, ceilingUsd: normalized.grammarBudgetUsd, estimateUsd: normalized.grammarEstimateUsd,
				}));
			} else if (isFacadeFixtureTransport(selectedGrammarProvider)) {
				capabilities[grammarCapabilityKey] = {
					available: true, provider: normalized.grammarProvider,
					model: selectedGrammarProvider.model, transport: "fixture",
				};
			} else throw codedError("PREFLIGHT_CAPABILITY_MISSING", "Grammar transport has no non-network preflight capability");
			const persistedEvidenceManifestPath = evidence.manifestPath && await exists(evidence.manifestPath)
				? relativePath(runDir, evidence.manifestPath, "evidence manifest") : null;
			const receiptValue = {
				schema_version: "arr.elevation3d.facade-preflight-receipt.v1",
				candidate_sha256: candidateSha256, evidence_sha256: evidence.manifestSha256,
				evidence_manifest_path: persistedEvidenceManifestPath,
				requests, capabilities,
				budget: {
					run: { ceiling_usd: normalized.runBudgetUsd, estimate_usd: normalized.runEstimateUsd },
					images: Object.fromEntries(normalized.providers.map((provider) => [provider, {
						ceiling_usd: normalized.imageBudgetUsd[provider], estimate_usd: normalized.imageEstimateUsd?.[provider] ?? normalized.imageBudgetUsd[provider],
					}])),
					grammar: {
						ceiling_usd: normalized.grammarBudgetUsd, estimate_usd: normalized.grammarEstimateUsd,
						per_call_ceiling_usd: normalized.grammarBudgetAllocationUsd,
						per_call_estimate_usd: normalized.grammarEstimateAllocationUsd,
					},
				},
			};
			run.preflight_receipt = await writeReceipt(runDir, "stages/preflight-receipt.json", receiptValue);
			const transition = await writeStage({
				runDir, path: "stages/preflight.json", stage: "preflight", status: "succeeded",
				input: { config_sha256: run.input_sha256 }, output: {
					candidate_sha256: candidateSha256, evidence_sha256: evidence.manifestSha256,
					evidence_manifest_path: receiptValue.evidence_manifest_path,
					request_fingerprints: Object.fromEntries(Object.entries(requests).map(([provider, ref]) => [provider, ref.fingerprint])),
					preflight_receipt_sha256: run.preflight_receipt.receipt_sha256,
				}, previous: null, deps,
			});
			preflight = transition.manifest;
			run.stage_manifests.preflight = transition.ref;
			await persistPublicRun(runDir, run);
		}
		if (stopAfterStage === "preflight") return readFacadeAgentStatus(runDir);
		if (!evidenceStage) {
			const transition = await writeStage({
				runDir, path: "stages/evidence.json", stage: "evidence", status: "succeeded",
				input: { candidate_sha256: candidateSha256 },
				output: { evidence_sha256: evidence.manifestSha256, ...(evidence.manifestPath ? { manifest_path: relativePath(runDir, evidence.manifestPath, "evidence manifest") } : {}) },
				previous: preflight, deps,
			});
			evidenceStage = transition.manifest;
			run.stage_manifests.evidence = transition.ref;
			await persistPublicRun(runDir, run);
		}
		if (stopAfterStage === "evidence") return readFacadeAgentStatus(runDir);
		run._candidate = candidate;
		run._evidence = evidence;
		assertSharedRunLedger(deps);
		if (normalized.confirmLive !== true) {
			const unconfirmed = normalized.providers.some((provider) => !isFacadeFixtureTransport(deps.providers?.[provider]))
				|| !isFacadeFixtureTransport(deps.grammarProvider);
			if (unconfirmed) throw codedError("LIVE_CONFIRMATION_REQUIRED", "Live facade transports require explicit confirmation");
		}

		const states = {};
		const proposals = {};
		for (const provider of normalized.providers) {
			states[provider] = await loadProvider(runDir, run, provider);
			const generated = await generateProvider({
				config: normalized, deps, runDir, run, state: states[provider], provider, evidence,
				previous: evidenceStage, signal,
			});
			states[provider] = generated.state;
			proposals[provider] = generated.proposal;
			if (generated.cancelled) return terminalCancellation(runDir, run, normalized, deps, provider);
		}
		let generateStage = run.stage_manifests.generate ? await readStageRef(runDir, run.stage_manifests.generate) : null;
		if (!generateStage) {
			const transition = await writeStage({
				runDir, path: "stages/generate.json", stage: "generate", status: "succeeded",
				input: { evidence_sha256: evidence.manifestSha256, brief_id: normalized.briefId },
				output: { proposals: Object.fromEntries(normalized.providers.map((provider) => [provider, states[provider].proposal?.sha256 ?? null])) },
				previous: evidenceStage, deps,
			});
			generateStage = transition.manifest;
			run.stage_manifests.generate = transition.ref;
			await persistPublicRun(runDir, run);
		}
		if (stopAfterStage === "generate") return readFacadeAgentStatus(runDir);

		const grammars = {};
		for (const provider of normalized.providers) {
			const extracted = await extractProviderGrammar({
				config: normalized, deps, runDir, run, state: states[provider], provider,
				proposal: proposals[provider], evidence, previous: generateStage, signal,
			});
			states[provider] = extracted.state;
			grammars[provider] = extracted.grammar;
			if (extracted.cancelled) return terminalCancellation(runDir, run, normalized, deps, provider);
		}
		let grammarStage = run.stage_manifests.grammar ? await readStageRef(runDir, run.stage_manifests.grammar) : null;
		if (!grammarStage) {
			const transition = await writeStage({
				runDir, path: "stages/grammar.json", stage: "grammar", status: "succeeded",
				input: { proposals: Object.fromEntries(normalized.providers.map((provider) => [provider, states[provider].proposal?.sha256 ?? null])) },
				output: { grammars: Object.fromEntries(normalized.providers.map((provider) => [provider, states[provider].grammar?.artifact_sha256 ?? null])) },
				previous: generateStage, deps,
			});
			grammarStage = transition.manifest;
			run.stage_manifests.grammar = transition.ref;
			await persistPublicRun(runDir, run);
		}
		if (stopAfterStage === "grammar") return readFacadeAgentStatus(runDir);

		const scores = [];
		const selectedArtifacts = {};
		const selectedValidations = {};
		const selectedValidationReceipts = {};
		for (const provider of normalized.providers) {
			const processed = await buildAndValidateProvider({
				config: normalized, deps, runDir, run, state: states[provider], provider,
				extractedGrammar: grammars[provider], previous: grammarStage, signal, stopAfterStage,
			});
			states[provider] = processed.state;
			if (processed.scoreResult) scores.push(processed.scoreResult);
			if (processed.selectedArtifact) selectedArtifacts[provider] = processed.selectedArtifact;
			if (processed.selectedValidation) selectedValidations[provider] = processed.selectedValidation;
			if (processed.selectedValidationReceipt) selectedValidationReceipts[provider] = processed.selectedValidationReceipt;
			if (processed.cancelled) return terminalCancellation(runDir, run, normalized, deps, provider);
		}
		if (stopAfterStage === "build") return readFacadeAgentStatus(runDir);

		let validateStage = run.stage_manifests.validate ? await readStageRef(runDir, run.stage_manifests.validate) : null;
		if (!validateStage) {
			const transition = await writeStage({
				runDir, path: "stages/validate.json", stage: "validate", status: "succeeded",
				input: { grammars: Object.fromEntries(normalized.providers.map((provider) => [provider, states[provider].grammar?.artifact_sha256 ?? null])) },
				output: { providers: Object.fromEntries(normalized.providers.map((provider) => [provider, states[provider].status])) },
				previous: grammarStage, deps,
			});
			validateStage = transition.manifest;
			run.stage_manifests.validate = transition.ref;
			await persistPublicRun(runDir, run);
		}
		if (stopAfterStage === "validate") return readFacadeAgentStatus(runDir);

		const evaluationCandidates = [];
		for (const provider of normalized.providers) {
			const state = states[provider];
			const cost = normalizeFacadeEvaluationCost({
				accepted: state.status === "accepted",
				imageReceipt: state.generation?.cost_receipt,
				grammarReceipt: state.grammar?.cost_receipt,
				correctionReceipt: { actualUsd: 0 },
			});
			state.cost = cost;
			await writeProvider(runDir, run, normalized, provider, state, deps);
			evaluationCandidates.push({
				provider,
				accepted: state.status === "accepted",
				score: state.score?.score,
				cost,
				diagnostics: {
					local_correction_count: state.versions?.some((version) => version.id === "v002") ? 1 : 0,
				},
				artifacts: {
					...(state.proposal ? { proposal: state.proposal } : {}),
					...(selectedArtifacts[provider] ? { glb: {
						path: relativePath(runDir, selectedArtifacts[provider].path, "selected GLB"),
						sha256: selectedArtifacts[provider].sha256,
					} } : {}),
				},
			});
		}
		const recommendation = selectFacadeRecommendation(evaluationCandidates);
		const actualCosts = evaluationCandidates.map((candidate) => candidate.cost.actual_total_usd);
		const actualTotalUsd = actualCosts.every((value) => value !== null)
			? actualCosts.reduce((sum, value) => sum + Math.round(value * 1_000_000), 0) / 1_000_000
			: null;
		const technicalCandidate = scores.find((score) => score.provider === recommendation.technical_winner);
		const decision = technicalCandidate
			? { status: "winner", provider: technicalCandidate.provider, candidate: technicalCandidate, score: technicalCandidate.score }
			: { status: "no-winner", candidates: [] };
		const deliveries = {};
		for (const provider of normalized.providers) {
			if (!selectedArtifacts[provider]) continue;
			if (states[provider].delivery?.status === "succeeded") {
				deliveries[provider] = states[provider].delivery;
				continue;
			}
			let artifact = selectedArtifacts[provider];
			try {
				throwIfAborted(signal);
				artifact = await authorizeGlb(runDir, artifact);
				run.delivery = { status: "submitting", provider, selected_glb_sha256: artifact.sha256 };
				await persistPublicRun(runDir, run);
				await callLifecycle(deps, { stage: "delivery", status: "submitting", provider, selected_glb_sha256: artifact.sha256 });
				artifact = await authorizeGlb(runDir, artifact);
				const delivery = await deps.renderDelivery({
					runDir, candidateId: normalized.candidateId, provider,
					deliveryRoot: containedPath(runDir, join(runDir, "providers", provider, "delivery"), "provider delivery"),
					artifact, validation: selectedValidations[provider],
					validationReceipt: selectedValidationReceipts[provider],
					input: candidate, signal, lifecycle: deps.lifecycle,
				});
				await callLifecycle(deps, { stage: "delivery", status: "returned", provider, selected_glb_sha256: artifact.sha256 });
				const deliveryRecord = {
					status: "succeeded", provider, selected_glb_sha256: artifact.sha256,
					delivery_sha256: sha256(stableJson(persistent(delivery))),
					memory_record: persistedDeliveryMemory(runDir, delivery?.memory_record),
				};
				states[provider].delivery = deliveryRecord;
				const acceptedVersion = states[provider].versions.find((version) => version.status === "accepted");
				if (acceptedVersion) acceptedVersion.delivery = deliveryRecord.memory_record;
				await writeProvider(runDir, run, normalized, provider, states[provider], deps);
				run.delivery = deliveryRecord;
				await persistPublicRun(runDir, run);
				await callLifecycle(deps, { stage: "delivery", status: "succeeded", provider, selected_glb_sha256: artifact.sha256, delivery_sha256: deliveryRecord.delivery_sha256 });
				deliveries[provider] = deliveryRecord;
				run.delivery = null;
				await persistPublicRun(runDir, run);
			} catch (error) {
				if (error instanceof LifecycleHookError) throw error;
				if (isAbort(error, signal)) return terminalCancellation(runDir, run, normalized, deps, provider);
				const failed = { status: "failed", provider, selected_glb_sha256: artifact.sha256, failure: safeError(error, "FINAL_DELIVERY_FAILED") };
				states[provider].delivery = failed;
				await writeProvider(runDir, run, normalized, provider, states[provider], deps);
				deliveries[provider] = failed;
				run.delivery = null;
				await persistPublicRun(runDir, run);
			}
		}
		for (const candidate of evaluationCandidates) {
			const views = states[candidate.provider].delivery?.memory_record?.views;
			if (views) candidate.artifacts.delivery_views = Object.values(views);
		}
		const evaluationReport = buildFacadeEvaluationReport({
			candidateId: normalized.candidateId,
			runId: normalized.runId,
			recommendation,
			candidates: evaluationCandidates,
		});
		const evaluationPath = join(runDir, "evaluation", "evaluation.json");
		const evaluationWritten = await atomicJson(evaluationPath, evaluationReport, runDir);
		run.evaluation_manifest = {
			path: relativePath(runDir, evaluationPath, "evaluation report"),
			sha256: evaluationWritten.sha256,
		};

		let final;
		if (decision?.status === "winner" && selectedArtifacts[decision.provider]) {
			const delivery = deliveries[decision.provider];
			if (delivery?.status === "succeeded") {
				run.delivery = delivery;
				final = {
					status: "winner",
					selected_provider: decision.provider,
					selected_version: states[decision.provider].versions.find((version) => version.status === "accepted")?.id ?? null,
					selected_glb_sha256: delivery.selected_glb_sha256,
					score_sha256: decision.candidate?.sha256 ?? states[decision.provider].score?.sha256 ?? null,
					delivery_sha256: delivery.delivery_sha256,
				};
			} else {
				final = {
					status: "delivery-failed", selected_provider: decision.provider,
					selected_glb_sha256: delivery?.selected_glb_sha256 ?? selectedArtifacts[decision.provider].sha256,
					failure: delivery?.failure ?? { code: "FINAL_DELIVERY_FAILED", message: "Selected provider delivery is unavailable" },
				};
			}
		} else if (decision?.status === "human-review") {
			final = { status: "human-review", candidates: decision.candidates.map((candidate) => ({ provider: candidate.provider, score: candidate.score, sha256: candidate.sha256 })) };
		} else final = { status: "no-winner", candidates: [] };
		final = {
			...final,
			technical_winner: recommendation.technical_winner,
			recommended_default: recommendation.recommended_default,
			quality_fallback: recommendation.quality_fallback,
			providers: Object.fromEntries(normalized.providers.map((provider) => [provider, { status: states[provider].status }])),
			cost: { currency: "USD", actual_total_usd: actualTotalUsd },
			evaluation_report: { ...run.evaluation_manifest },
		};
		run.comparison_memory = persistent({
			selected_providers: [...normalized.providers],
			technical_winner: recommendation.technical_winner,
			recommended_default: recommendation.recommended_default,
			quality_fallback: recommendation.quality_fallback,
			providers: Object.fromEntries(evaluationCandidates.map((candidate) => [candidate.provider, {
				status: candidate.accepted ? "accepted" : "rejected",
				cost: candidate.cost,
			}])),
			cost: final.cost,
		});

		const compareTransition = await writeStage({
			runDir, path: "stages/compare.json", stage: "compare", status: "succeeded",
			input: { scores: scores.map((score) => score.sha256 ?? sha256(stableJson(persistent(score)))) },
			output: final, previous: validateStage, deps,
		});
		run.stage_manifests.compare = compareTransition.ref;
		const finalWritten = await atomicJson(join(runDir, "final.json"), final, runDir);
		run.final_manifest = { path: "final.json", sha256: finalWritten.sha256 };
		run.final = finalWritten.value;
		run.status = final.status;
		await persistPublicRun(runDir, run);
		return readFacadeAgentStatus(runDir);
	} catch (error) {
		if (error instanceof LifecycleHookError) throw error.cause ?? error;
		if (isAbort(error, signal)) return terminalCancellation(runDir, run, normalized, deps);
		run.status = "blocked";
		run.failure = safeError(error);
		await persistPublicRun(runDir, run);
		throw error;
	}
}

async function readStageRef(runDir, ref) {
	if (!ref || typeof ref.path !== "string" || !HEX_SHA256.test(ref.sha256 ?? "")) throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Invalid stage manifest reference");
	const path = containedPath(runDir, join(runDir, ref.path), "stage manifest");
	const bytes = await safeRead(runDir, path, "stage manifest");
	if (sha256(bytes) !== ref.sha256) throw codedError("FACADE_AGENT_STATE_UNCERTAIN", `Stage manifest hash mismatch: ${ref.path}`);
	const manifest = JSON.parse(bytes.toString("utf8"));
	if (!HEX_SHA256.test(manifest.input_sha256 ?? "") || manifest.output_sha256 !== manifestOutputHash(manifest.output)
		|| (manifest.input !== undefined && manifest.input_sha256 !== sha256(stableJson(persistent(manifest.input))))
		|| manifest.stage !== ref.stage || manifest.status !== ref.status || manifest.output_sha256 !== ref.output_sha256) {
		throw codedError("FACADE_AGENT_STATE_UNCERTAIN", `Stage manifest binding mismatch: ${ref.path}`);
	}
	return manifest;
}

export async function readFacadeAgentStatus(runDirInput) {
	const runDir = resolve(runDirInput);
	let run;
	try { run = await readJson(join(runDir, "run.json"), runDir); }
	catch (error) { throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Facade agent run manifest is unavailable or invalid", error); }
	if (run?.schema_version !== "arr.elevation3d.facade-agent-run.v1" || !HEX_SHA256.test(run.input_sha256 ?? "")
		|| !run.providers || !run.provider_manifests || !run.stage_manifests) {
		throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Facade agent run manifest is invalid");
	}
	if (run.preflight_receipt) {
		const receipt = await verifyDurableReceipt(runDir, run.preflight_receipt);
		const stage = run.stage_manifests.preflight ? await readStageRef(runDir, run.stage_manifests.preflight) : null;
		if (receipt.schema_version !== "arr.elevation3d.facade-preflight-receipt.v1" || !stage
			|| stage.output?.preflight_receipt_sha256 !== run.preflight_receipt.receipt_sha256
			|| stage.output?.candidate_sha256 !== receipt.candidate_sha256
			|| stage.output?.evidence_sha256 !== receipt.evidence_sha256
			|| run.budget?.run_ceiling_usd !== receipt.budget?.run?.ceiling_usd
			|| run.budget?.grammar_ceiling_usd !== receipt.budget?.grammar?.ceiling_usd
			|| stableJson(run.budget?.image_ceiling_usd) !== stableJson(Object.fromEntries(Object.entries(receipt.budget?.images ?? {}).map(([provider, value]) => [provider, value.ceiling_usd])))
			|| stableJson(run.budget?.grammar_per_call_ceiling_usd) !== stableJson(receipt.budget?.grammar?.per_call_ceiling_usd)) {
			throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Preflight receipt binding is invalid");
		}
		if (receipt.evidence_manifest_path) {
			const evidenceBytes = await safeRead(runDir, join(runDir, receipt.evidence_manifest_path), "preflight evidence manifest");
			if (sha256(evidenceBytes) !== receipt.evidence_sha256) throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Preflight evidence manifest hash mismatch");
		}
		for (const [provider, ref] of Object.entries(receipt.requests ?? {})) {
			if (!ref?.path || !HEX_SHA256.test(ref.sha256 ?? "") || !HEX_SHA256.test(ref.fingerprint ?? "")) {
				throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Preflight request manifest reference is invalid");
			}
			const bytes = await safeRead(runDir, join(runDir, ref.path), "preflight request manifest");
			if (sha256(bytes) !== ref.sha256) throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Preflight request manifest hash mismatch");
			const request = JSON.parse(bytes.toString("utf8"));
			if (request.provider !== provider || request.request_fingerprint !== ref.fingerprint
				|| request.evidence_sha256 !== receipt.evidence_sha256) throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Preflight request manifest binding mismatch");
		}
	} else if (run.stage_manifests.preflight) {
		throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Completed preflight is missing its durable receipt");
	}
	for (const ref of Object.values(run.stage_manifests)) await readStageRef(runDir, ref);
	for (const [provider, ref] of Object.entries(run.provider_manifests)) {
		const path = containedPath(runDir, join(runDir, ref.path), "provider state");
		const bytes = await safeRead(runDir, path, "provider state");
		if (sha256(bytes) !== ref.sha256) throw codedError("FACADE_AGENT_STATE_UNCERTAIN", `Provider state hash mismatch: ${provider}`);
		const state = JSON.parse(bytes.toString("utf8"));
		if (state.provider !== provider || stableJson(state) !== stableJson(run.providers[provider])) throw codedError("FACADE_AGENT_STATE_UNCERTAIN", `Provider state binding mismatch: ${provider}`);
		for (const stageRef of Object.values(state.stage_manifests ?? {})) await readStageRef(runDir, stageRef);
		await verifyProviderReceipts(runDir, state);
	}
	if (run.evaluation_manifest) {
		const path = containedPath(runDir, join(runDir, run.evaluation_manifest.path), "evaluation report");
		const bytes = await safeRead(runDir, path, "evaluation report");
		let report;
		try { report = JSON.parse(bytes.toString("utf8")); }
		catch (error) { throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Evaluation report is invalid", error); }
		if (sha256(bytes) !== run.evaluation_manifest.sha256
			|| report.schema_version !== "arr.elevation3d.facade-evaluation.v1"
			|| report.candidate_id !== run.candidate_id || report.run_id !== run.run_id
			|| (run.final && (report.technical_winner !== run.final.technical_winner
				|| report.recommended_default !== run.final.recommended_default
				|| report.quality_fallback !== run.final.quality_fallback))) {
			throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Evaluation report binding mismatch");
		}
	} else if (run.stage_manifests.compare) {
		throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Completed comparison is missing its evaluation report");
	}
	if (run.final_manifest) {
		const path = containedPath(runDir, join(runDir, run.final_manifest.path), "final manifest");
		const bytes = await safeRead(runDir, path, "final manifest");
		if (sha256(bytes) !== run.final_manifest.sha256 || stableJson(JSON.parse(bytes.toString("utf8"))) !== stableJson(run.final)) {
			throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Final decision hash mismatch");
		}
	}
	return run;
}

export async function runFacadeAgent(config, deps) {
	return executeFacade(config, deps, null);
}

export async function runFacadeStage(stage, config, deps) {
	if (!FACADE_AGENT_STAGES.includes(stage)) throw codedError("FACADE_AGENT_STAGE_INVALID", `Unknown facade agent stage: ${stage}`);
	return executeFacade(config, deps, stage);
}
