import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { redactSecrets, sha256, stableJson } from "../core.mjs";
import { correctGrammar } from "../facade-grammar.mjs";
import { facadeRequestFingerprint, FACADE_AGENT_STAGES, normalizeFacadeAgentConfig } from "./contract.mjs";
import { selectFacadeWinner } from "./score.mjs";

const HEX_SHA256 = /^[a-f0-9]{64}$/;
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
	const inputSha256 = sha256(stableJson(persistent(input)));
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
		final: null,
	};
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
		schema_version: "arr.elevation3d.facade-agent-provider.v1",
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

function buildProviderRequest(entry, { provider, evidence, brief, output }) {
	const request = typeof entry.buildRequest === "function"
		? entry.buildRequest({ evidence, brief, output })
		: { provider, evidence, brief, output };
	if (!request || typeof request !== "object") throw codedError("FACADE_PROVIDER_REQUEST_INVALID", `Provider ${provider} returned an invalid request`);
	const fingerprint = request.fingerprint ?? facadeRequestFingerprint({
		provider,
		evidenceSha256: evidence.manifestSha256,
		briefId: brief.id,
		output: persistent(output),
	});
	if (!HEX_SHA256.test(fingerprint)) throw codedError("FACADE_PROVIDER_REQUEST_INVALID", `Provider ${provider} request is missing a SHA-256 fingerprint`);
	return { ...request, provider, fingerprint };
}

function imageLedger(deps) {
	const ledger = deps.ledger?.image ?? deps.ledger;
	if (!ledger || typeof ledger.executeOnce !== "function") throw codedError("FACADE_LEDGER_MISSING", "A paid-operation ledger is required");
	return ledger;
}

function grammarLedger(deps) {
	return deps.ledger?.grammar ?? deps.ledger;
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
			ceilingUsd: config.imageBudgetUsd[provider],
			estimateUsd: config.imageEstimateUsd?.[provider] ?? config.imageBudgetUsd[provider],
			signal,
			operation: async (submission) => {
				generated = await entry.generate({ request, submission, signal });
				if (!generated || !Buffer.isBuffer(generated.bytes) || generated.bytes.length === 0) {
					throw codedError("PROVIDER_RESPONSE_INVALID", "Provider did not return bounded image bytes");
				}
				return {
					remoteId: generated.remoteId,
					artifactSha256: sha256(generated.bytes),
					actualUsd: generated.actualUsd ?? generated.usage?.cost_usd ?? config.imageEstimateUsd?.[provider] ?? config.imageBudgetUsd[provider],
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
		state.generation = { status: "succeeded", request_sha256: request.fingerprint, artifact_sha256: digest };
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

async function extractProviderGrammar({ config, deps, runDir, run, state, provider, proposal, evidence, previous, signal }) {
	if (!proposal || state.status === "rejected" || state.status === "cancelled") return { state, grammar: null };
	const grammarPath = join(runDir, "providers", provider, "grammar.json");
	if (state.grammar?.status === "submitting") {
		state.status = "rejected";
		state.failure = { code: "PAID_OPERATION_SUBMISSION_UNCERTAIN", message: "Refusing to resubmit a grammar extraction recorded as submitting" };
		await writeProvider(runDir, run, config, provider, state, deps);
		return { state, grammar: null };
	}
	if (state.grammar?.status === "succeeded") {
		try {
			const bytes = await safeRead(runDir, grammarPath, "grammar artifact");
			if (sha256(bytes) !== state.grammar.artifact_sha256) throw new Error();
			return { state, grammar: JSON.parse(bytes.toString("utf8")) };
		} catch {
			state.status = "rejected";
			state.failure = { code: "GRAMMAR_RESULT_UNAVAILABLE", message: "Persisted grammar is unavailable; refusing resubmission" };
			await writeProvider(runDir, run, config, provider, state, deps);
			return { state, grammar: null };
		}
	}
	const submittingStagePath = `providers/${provider}/stages/grammar-submitting.json`;
	const stagePath = `providers/${provider}/stages/grammar.json`;
	const stageInput = { provider, proposal_sha256: proposal.sha256, evidence_sha256: evidence.manifestSha256, model: config.grammarModel };
	const submitting = await writeStage({
		runDir, path: submittingStagePath, stage: "grammar", status: "submitting", input: stageInput,
		output: { proposal_sha256: proposal.sha256 }, previous, provider, deps,
	});
	state.grammar = { status: "submitting", proposal_sha256: proposal.sha256 };
	state.stage_manifests.grammar = submitting.ref;
	await writeProvider(runDir, run, config, provider, state, deps, { stage: "grammar", status: "submitting", provider });
	try {
		throwIfAborted(signal);
		const extracted = await deps.extractGrammar({
			provider,
			proposal,
			proposalPath: proposal,
			providerResult: proposal.providerResult,
			evidence,
			config: { ...config, proposalProvider: provider, candidateId: config.candidateId },
			ledger: grammarLedger(deps),
			signal,
		});
		if (!extracted || typeof extracted !== "object" || Array.isArray(extracted)) throw codedError("GRAMMAR_OUTPUT_INVALID", "Grammar extraction returned an invalid value");
		const bytes = Buffer.from(`${JSON.stringify(persistent(extracted), null, 2)}\n`);
		await atomicWrite(grammarPath, bytes, runDir);
		const digest = sha256(bytes);
		const succeeded = await writeStage({
			runDir, path: stagePath, stage: "grammar", status: "succeeded", input: stageInput,
			output: { grammar_sha256: digest, grammar_path: relativePath(runDir, grammarPath, "grammar artifact") }, previous, provider, deps,
		});
		state.grammar = { status: "succeeded", proposal_sha256: proposal.sha256, artifact_sha256: digest, path: relativePath(runDir, grammarPath, "grammar artifact") };
		state.stage_manifests.grammar = succeeded.ref;
		state.status = "grammar-ready";
		await writeProvider(runDir, run, config, provider, state, deps, { stage: "grammar", status: "succeeded", provider });
		return { state, grammar: extracted };
	} catch (error) {
		if (error instanceof LifecycleHookError) throw error;
		state.status = isAbort(error, signal) ? "cancelled" : "rejected";
		state.failure = safeError(error, isAbort(error, signal) ? "FACADE_AGENT_CANCELLED" : "GRAMMAR_EXTRACTION_FAILED");
		if (error?.definitiveNonSubmission === true) state.grammar.status = "failed";
		await writeProvider(runDir, run, config, provider, state, deps);
		return { state, grammar: null, cancelled: state.status === "cancelled" };
	}
}

function artifactRecord(runDir, built) {
	const artifact = built?.artifact ?? built;
	if (!artifact || typeof artifact.path !== "string" || !HEX_SHA256.test(artifact.sha256 ?? "")) {
		throw codedError("FACADE_BUILD_ARTIFACT_INVALID", "Build stage must return a content-addressed artifact");
	}
	return { path: relativePath(runDir, artifact.path, "built GLB"), sha256: artifact.sha256 };
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

function localRetryAllowed(validation, attempt) {
	if (attempt !== 1 || validation?.accepted === true || validation?.retryable === false) return false;
	const codes = validation?.codes;
	return Array.isArray(codes) && codes.length > 0
		&& codes.every((code) => LOCAL_REPAIR_CODES.has(code))
		&& !codes.some((code) => PROHIBITED_RETRY_CODES.has(code));
}

async function buildAndValidateProvider({ config, deps, runDir, run, state, provider, extractedGrammar, previous, signal, stopAfterStage }) {
	if (!extractedGrammar || state.status === "rejected" || state.status === "cancelled") return { state, scoreResult: null };
	let currentGrammar = extractedGrammar;
	let localPrevious = previous;
	for (let attempt = 1; attempt <= config.maxLocalAttempts; attempt += 1) {
		const versionId = `v${String(attempt).padStart(3, "0")}`;
		let version = state.versions.find((item) => item.id === versionId);
		if (!version) {
			version = { id: versionId, status: "building", grammar_sha256: sha256(stableJson(persistent(currentGrammar))) };
			state.versions.push(version);
			await writeProvider(runDir, run, config, provider, state, deps);
		}
		let artifact;
		let rawBuilt;
		try {
			if (version.artifact) {
				const absolute = containedPath(runDir, join(runDir, version.artifact.path), "built GLB");
				const bytes = await safeRead(runDir, absolute, "built GLB");
				if (sha256(bytes) !== version.artifact.sha256) throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Persisted build artifact hash mismatch");
				artifact = { path: absolute, sha256: version.artifact.sha256 };
				rawBuilt = { artifact };
			} else {
				throwIfAborted(signal);
				rawBuilt = await deps.build({ provider, versionId, attempt, grammar: currentGrammar, input: run._candidate, candidate: run._candidate, evidence: run._evidence, runDir, signal });
				artifact = rawBuilt?.artifact ?? rawBuilt;
				version.artifact = artifactRecord(runDir, rawBuilt);
				version.status = "built";
				const builtStage = await writeStage({
					runDir, path: `providers/${provider}/stages/build-${versionId}.json`, stage: "build", status: "succeeded",
					input: { provider, version_id: versionId, grammar_sha256: version.grammar_sha256 },
					output: { artifact: version.artifact }, previous: localPrevious, provider, versionId, deps,
				});
				state.stage_manifests[`build-${versionId}`] = builtStage.ref;
				await writeProvider(runDir, run, config, provider, state, deps, { stage: "build", status: "succeeded", provider, version_id: versionId });
			}
			if (stopAfterStage === "build") return { state, scoreResult: null };
			throwIfAborted(signal);
			const validation = await deps.validate({
				provider, versionId, attempt, grammar: currentGrammar, extractedGrammar,
				artifact, build: rawBuilt, input: run._candidate, candidate: run._candidate, evidence: run._evidence, runDir, signal,
			});
			const retryable = localRetryAllowed(validation, attempt);
			version.validation = validationRecord(validation, retryable);
			version.status = validation?.accepted === true ? "accepted" : "rejected";
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
				const scoreResult = await scoreCandidate({ provider, validation });
				state.score = persistent(scoreResult);
				state.status = scoreResult?.accepted === true ? "accepted" : "rejected";
				if (state.status === "rejected") state.failure = { code: scoreResult?.reason ?? "SCORE_REJECTED", message: "Authorized scoring rejected the provider" };
				await writeProvider(runDir, run, config, provider, state, deps);
				return { state, scoreResult: scoreResult?.accepted === true ? scoreResult : null, selectedArtifact: artifact };
			}
			if (!retryable || attempt === config.maxLocalAttempts) {
				state.status = "rejected";
				state.failure = { code: version.validation.codes[0] ?? "VALIDATION_REJECTED", message: "Facade validation rejected the provider" };
				await writeProvider(runDir, run, config, provider, state, deps);
				return { state, scoreResult: null };
			}
			currentGrammar = correctGrammar(currentGrammar, version.validation.codes);
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
	} else {
		run = initialRun(normalized, runDir, inputSha256);
		await writeRun(runDir, run);
	}
	throwIfAborted(signal);
	return { normalized, runDir, run, terminal: false };
}

async function executeFacade(config, deps, stopAfterStage = null) {
	if (!deps || typeof deps !== "object") throw new TypeError("Facade agent dependencies are required");
	for (const name of ["loadCandidate", "buildEvidence", "extractGrammar", "build", "validate", "renderDelivery"]) {
		if (typeof deps[name] !== "function") throw new TypeError(`deps.${name} must be a function`);
	}
	const signal = deps.signal ?? config?.signal;
	const initialized = await initialize(config, deps, signal);
	if (initialized.terminal) return initialized.run;
	const { normalized, runDir, run } = initialized;
	try {
		throwIfAborted(signal);
		if (normalized.confirmLive !== true) {
			const unconfirmed = normalized.providers.some((provider) => deps.providers?.[provider]?.transport !== "fixture")
				|| deps.grammarTransport !== "fixture";
			if (unconfirmed) throw codedError("LIVE_CONFIRMATION_REQUIRED", "Live facade transports require explicit confirmation");
		}
		const candidate = await deps.loadCandidate({ datasetRoot: normalized.datasetRoot, candidateId: normalized.candidateId, config: normalized, signal });
		const candidateSha256 = sha256(stableJson(persistent(candidate)));
		let preflight = run.stage_manifests.preflight ? await readStageRef(runDir, run.stage_manifests.preflight) : null;
		if (preflight && preflight.output?.candidate_sha256 !== candidateSha256) throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Candidate changed after preflight");
		if (!preflight) {
			const transition = await writeStage({
				runDir, path: "stages/preflight.json", stage: "preflight", status: "succeeded",
				input: { config_sha256: run.input_sha256 }, output: { candidate_sha256: candidateSha256 }, previous: null, deps,
			});
			preflight = transition.manifest;
			run.stage_manifests.preflight = transition.ref;
			await persistPublicRun(runDir, run);
		}
		if (stopAfterStage === "preflight") return readFacadeAgentStatus(runDir);

		let evidence;
		let evidenceStage = run.stage_manifests.evidence ? await readStageRef(runDir, run.stage_manifests.evidence) : null;
		evidence = await deps.buildEvidence({ input: candidate, candidate, runDir, signal, resume: Boolean(evidenceStage), manifestPath: evidenceStage?.output?.manifest_path });
		if (!evidence || !HEX_SHA256.test(evidence.manifestSha256 ?? "")) throw codedError("FACADE_EVIDENCE_INVALID", "Evidence stage must return a verified manifest SHA-256");
		if (evidenceStage && evidenceStage.output?.evidence_sha256 !== evidence.manifestSha256) throw codedError("FACADE_AGENT_STATE_UNCERTAIN", "Evidence changed after persistence");
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
		for (const provider of normalized.providers) {
			const processed = await buildAndValidateProvider({
				config: normalized, deps, runDir, run, state: states[provider], provider,
				extractedGrammar: grammars[provider], previous: grammarStage, signal, stopAfterStage,
			});
			states[provider] = processed.state;
			if (processed.scoreResult) scores.push(processed.scoreResult);
			if (processed.selectedArtifact) selectedArtifacts[provider] = processed.selectedArtifact;
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

		const select = deps.score?.select ?? deps.selectWinner ?? selectFacadeWinner;
		const decision = select(scores, normalized.scoreTieTolerance ?? 0.5);
		let final;
		if (decision?.status === "winner" && selectedArtifacts[decision.provider]) {
			const artifact = selectedArtifacts[decision.provider];
			try {
				throwIfAborted(signal);
				run.delivery = { status: "submitting", provider: decision.provider, selected_glb_sha256: artifact.sha256 };
				await persistPublicRun(runDir, run);
				await callLifecycle(deps, { stage: "delivery", status: "submitting", provider: decision.provider, selected_glb_sha256: artifact.sha256 });
				const delivery = await deps.renderDelivery({
					runDir, candidateId: normalized.candidateId, provider: decision.provider,
					artifact, input: candidate, signal, lifecycle: deps.lifecycle,
				});
				await callLifecycle(deps, { stage: "delivery", status: "returned", provider: decision.provider, selected_glb_sha256: artifact.sha256 });
				run.delivery = { status: "succeeded", provider: decision.provider, selected_glb_sha256: artifact.sha256, delivery_sha256: sha256(stableJson(persistent(delivery))) };
				await persistPublicRun(runDir, run);
				await callLifecycle(deps, { stage: "delivery", status: "succeeded", provider: decision.provider, selected_glb_sha256: artifact.sha256, delivery_sha256: run.delivery.delivery_sha256 });
				final = {
					status: "winner",
					selected_provider: decision.provider,
					selected_version: states[decision.provider].versions.find((version) => version.status === "accepted")?.id ?? null,
					selected_glb_sha256: artifact.sha256,
					score_sha256: decision.candidate?.sha256 ?? states[decision.provider].score?.sha256 ?? null,
					delivery_sha256: sha256(stableJson(persistent(delivery))),
				};
			} catch (error) {
				if (error instanceof LifecycleHookError) throw error;
				if (isAbort(error, signal)) return terminalCancellation(runDir, run, normalized, deps, decision.provider);
				run.delivery = { status: "failed", provider: decision.provider, selected_glb_sha256: artifact.sha256, failure: safeError(error, "FINAL_DELIVERY_FAILED") };
				await persistPublicRun(runDir, run);
				final = {
					status: "delivery-failed", selected_provider: decision.provider,
					selected_glb_sha256: artifact.sha256, failure: safeError(error, "FINAL_DELIVERY_FAILED"),
				};
			}
		} else if (decision?.status === "human-review") {
			final = { status: "human-review", candidates: decision.candidates.map((candidate) => ({ provider: candidate.provider, score: candidate.score, sha256: candidate.sha256 })) };
		} else final = { status: "no-winner", candidates: [] };

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
	for (const ref of Object.values(run.stage_manifests)) await readStageRef(runDir, ref);
	for (const [provider, ref] of Object.entries(run.provider_manifests)) {
		const path = containedPath(runDir, join(runDir, ref.path), "provider state");
		const bytes = await safeRead(runDir, path, "provider state");
		if (sha256(bytes) !== ref.sha256) throw codedError("FACADE_AGENT_STATE_UNCERTAIN", `Provider state hash mismatch: ${provider}`);
		const state = JSON.parse(bytes.toString("utf8"));
		if (state.provider !== provider || stableJson(state) !== stableJson(run.providers[provider])) throw codedError("FACADE_AGENT_STATE_UNCERTAIN", `Provider state binding mismatch: ${provider}`);
		for (const stageRef of Object.values(state.stage_manifests ?? {})) await readStageRef(runDir, stageRef);
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
