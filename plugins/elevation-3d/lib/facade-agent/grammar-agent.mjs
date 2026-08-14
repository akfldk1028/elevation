import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";

import { sha256, stableJson } from "../core.mjs";
import {
	PUNCHED_FACADE_FIELDS,
	PUNCHED_FACADE_MATERIALS,
	PUNCHED_FACADE_SURFACES,
	PUNCHED_FACADE_SYSTEM,
	validatePunchedFacadeGrammar,
} from "../facade-grammar.mjs";
import { readVerifiedFacadeEvidenceAuthority } from "./evidence.mjs";
import { consumeFacadeGrammarSubmissionCapability } from "./harness.mjs";
import { consumePaidOperationSubmissionCapability } from "./paid-operation-ledger.mjs";
import { FacadeProviderError } from "./provider.mjs";
import { createFacadeGrammarRequest } from "./providers/grammar/contract.mjs";
import { buildFacadeGrammarPrompt } from "./providers/grammar/prompt.mjs";
import { createProvider as createOpenAIGrammarProvider } from "./providers/grammar/openai/adapter.mjs";
import { readVerifiedProposalResultAuthority as readOpenAIProposalResultAuthority } from "./providers/openai-image.mjs";
import { readVerifiedProposalResultAuthority as readGeminiProposalResultAuthority } from "./providers/gemini-image.mjs";
import { readVerifiedProposalResultAuthority as readBytePlusProposalResultAuthority } from "./image-providers/providers/byteplus/adapter.mjs";
import { readVerifiedProposalResultAuthority as readAlibabaProposalResultAuthority } from "./image-providers/providers/alibaba/adapter.mjs";

const PROVIDER = "openai";
const MODEL = "gpt-5.5";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_PROPOSAL_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const PROPOSAL_PROVIDERS = new Set(["gpt-image-2", "seedream-5-pro", "qwen-image-2", "nano-banana-pro"]);
const verifiedProposalAuthorities = new WeakMap();
const verifiedGrammarAuthorities = new WeakMap();
const claimedProviderResults = new WeakSet();

function deepFreeze(value) {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const item of Object.values(value)) deepFreeze(item);
	return Object.freeze(value);
}

export function readVerifiedFacadeGrammarAuthority(value) {
	if (!value || typeof value !== "object") return null;
	const authority = verifiedGrammarAuthorities.get(value);
	return authority ? { ...authority } : null;
}

export function serializeVerifiedFacadeGrammarAuthority(value) {
	const authority = readVerifiedFacadeGrammarAuthority(value);
	if (!authority) throw failure("GRAMMAR_REHYDRATION_INVALID", "Only a verified grammar authority can be persisted", { definitiveNonSubmission: true });
	return structuredClone(authority);
}

function grammarAuthorityFromEvidence(grammar, evidenceAuthority, provider, proposalSha256) {
	return {
		candidateId: evidenceAuthority.candidateId,
		geometryHash: evidenceAuthority.geometryHash,
		geometryContentSha256: evidenceAuthority.geometryContentSha256,
		geometrySignedVolumeOrientation: evidenceAuthority.geometrySignedVolumeOrientation,
		facadeSegmentAuthority: evidenceAuthority.facadeSegmentAuthority ? {
			sha256: evidenceAuthority.facadeSegmentAuthority.sha256,
			segmentIds: [...evidenceAuthority.facadeSegmentAuthority.segmentIds],
		} : null,
		provider,
		evidenceManifestSha256: evidenceAuthority.manifestSha256,
		camerasSha256: evidenceAuthority.camerasSha256,
		floorGuides: [...evidenceAuthority.floorGuides],
		facadeLengths: { ...evidenceAuthority.facadeLengths },
		proposalSha256,
		grammarSha256: sha256(stableJson(grammar)),
	};
}

export async function rehydrateVerifiedFacadeGrammar(input = {}) {
	try {
		const { path, artifactSha256, authority, evidence, provider, proposalSha256 } = input;
		if (typeof path !== "string" || !/^[a-f0-9]{64}$/.test(artifactSha256 ?? "")
			|| typeof provider !== "string" || !/^[a-f0-9]{64}$/.test(proposalSha256 ?? "")) throw new Error();
		const evidenceAuthority = readVerifiedFacadeEvidenceAuthority(evidence);
		if (!evidenceAuthority) throw new Error();
		const absolute = resolve(path);
		const stats = await lstat(absolute);
		if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > MAX_RESPONSE_BYTES
			|| await realpath(absolute) !== absolute) throw new Error();
		const bytes = await readFile(absolute);
		if (sha256(bytes) !== artifactSha256) throw new Error();
		const raw = JSON.parse(bytes.toString("utf8"));
		const grammar = validatePunchedFacadeGrammar(raw, { floorGuides: { floor_guides_m: evidence.manifest.floor_guides_m } });
		if (!bytes.equals(Buffer.from(`${JSON.stringify(grammar, null, 2)}\n`))) throw new Error();
		const expected = grammarAuthorityFromEvidence(grammar, evidenceAuthority, provider, proposalSha256);
		if (stableJson(authority) !== stableJson(expected)) throw new Error();
		deepFreeze(grammar);
		verifiedGrammarAuthorities.set(grammar, Object.freeze(structuredClone(expected)));
		return grammar;
	} catch (error) {
		if (error?.code === "GRAMMAR_REHYDRATION_INVALID") throw error;
		throw failure("GRAMMAR_REHYDRATION_INVALID", "Persisted grammar authority could not be verified", { definitiveNonSubmission: true });
	}
}

export const FACADE_GRAMMAR_SCHEMA = Object.freeze({
	type: "object",
	additionalProperties: false,
	required: [...PUNCHED_FACADE_FIELDS],
	properties: {
		system: { type: "string", const: PUNCHED_FACADE_SYSTEM },
		surfaces: {
			type: "array", minItems: 4, maxItems: 4, uniqueItems: true,
			items: { type: "string", enum: [...PUNCHED_FACADE_SURFACES] },
		},
		materials: {
			type: "array", minItems: 4, maxItems: 4, uniqueItems: true,
			items: { type: "string", enum: [...PUNCHED_FACADE_MATERIALS] },
		},
		corner_datum_m: { type: "number", minimum: -0.25, maximum: 0.25 },
		bay_width_m: { type: "number", minimum: 0.9, maximum: 3 },
		window_width_m: { type: "number", minimum: 0.6, maximum: 2.2 },
		window_height_m: { type: "number", minimum: 0.8, maximum: 2.4 },
		sill_height_m: { type: "number", minimum: 0.45, maximum: 1.2 },
		reveal_depth_m: { type: "number", minimum: 0.12, maximum: 0.4 },
		frame_width_m: { type: "number", minimum: 0.03, maximum: 0.12 },
		lintel_height_m: { type: "number", minimum: 0.08, maximum: 0.4 },
		sill_depth_m: { type: "number", minimum: 0.03, maximum: 0.25 },
		cladding_depth_m: { type: "number", minimum: 0.04, maximum: 0.25 },
		brick_module_m: {
			type: "array", minItems: 2, maxItems: 2,
			prefixItems: [
				{ type: "number", minimum: 0.18, maximum: 0.26 },
				{ type: "number", minimum: 0.05, maximum: 0.09 },
			],
			items: false,
		},
		confidence: { type: "number", minimum: 0.8, maximum: 1 },
		unresolved_surfaces: {
			type: "array", maxItems: 0, uniqueItems: true,
			items: { type: "string", enum: [...PUNCHED_FACADE_SURFACES] },
		},
	},
});

function failure(code, message, { definitiveNonSubmission = false, remoteId = null, status = null } = {}) {
	return new FacadeProviderError(code, message, {
		provider: PROVIDER,
		stage: "grammar",
		definitiveNonSubmission,
		remoteId,
		status,
	});
}

function dataRecord(value, label) {
	try {
		if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error();
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const result = Object.create(null);
		for (const key of Reflect.ownKeys(descriptors)) {
			const descriptor = descriptors[key];
			if (typeof key !== "string" || descriptor.get || descriptor.set || !Object.hasOwn(descriptor, "value")) throw new Error();
			result[key] = descriptor.value;
		}
		return result;
	} catch {
		throw failure("GRAMMAR_BOUNDARY_INVALID", `${label} must be a plain data object`, { definitiveNonSubmission: true });
	}
}

function authenticSignal(signal) {
	if (signal === undefined) return;
	try {
		if (Object.getPrototypeOf(signal) !== AbortSignal.prototype) throw new Error();
		Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get.call(signal);
	} catch {
		throw failure("GRAMMAR_BOUNDARY_INVALID", "signal must be an authentic AbortSignal", { definitiveNonSubmission: true });
	}
}

function throwIfAborted(signal, beforeSubmission = false) {
	if (!signal?.aborted) return;
	throw failure("GRAMMAR_ABORTED", "Grammar extraction was aborted", { definitiveNonSubmission: beforeSubmission });
}

function imageType(bytes) {
	if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	return null;
}

async function readProposalFile(path, expected = {}) {
	if (typeof path !== "string" || !path) throw failure("GRAMMAR_PROPOSAL_INVALID", "A proposal image path is required", { definitiveNonSubmission: true });
	const absolute = resolve(path);
	let stats;
	try { stats = await lstat(absolute); }
	catch { throw failure("GRAMMAR_PROPOSAL_INVALID", "Proposal image is unavailable", { definitiveNonSubmission: true }); }
	if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > MAX_PROPOSAL_BYTES) {
		throw failure("GRAMMAR_PROPOSAL_INVALID", "Proposal must be a bounded regular image file", { definitiveNonSubmission: true });
	}
	const canonical = await realpath(absolute);
	if (canonical !== absolute) throw failure("GRAMMAR_PROPOSAL_INVALID", "Proposal image path is not canonical", { definitiveNonSubmission: true });
	const bytes = await readFile(canonical);
	const mimeType = imageType(bytes);
	if (!mimeType) throw failure("GRAMMAR_PROPOSAL_INVALID", "Proposal image type is not approved", { definitiveNonSubmission: true });
	let metadata;
	let decoded;
	try {
		metadata = await sharp(bytes, { limitInputPixels: MAX_PROPOSAL_BYTES }).metadata();
		decoded = await sharp(bytes, { limitInputPixels: MAX_PROPOSAL_BYTES }).raw().toBuffer({ resolveWithObject: true });
	} catch {
		throw failure("GRAMMAR_PROPOSAL_INVALID", "Proposal image did not fully decode", { definitiveNonSubmission: true });
	}
	if (!Number.isInteger(metadata.width) || metadata.width <= 0 || !Number.isInteger(metadata.height) || metadata.height <= 0
		|| !Number.isInteger(metadata.channels) || metadata.channels < 1 || metadata.channels > 4
		|| metadata.width * metadata.height * metadata.channels > MAX_PROPOSAL_BYTES
		|| decoded.info.width !== metadata.width || decoded.info.height !== metadata.height || decoded.info.channels !== metadata.channels
		|| decoded.data.length !== metadata.width * metadata.height * metadata.channels) {
		throw failure("GRAMMAR_PROPOSAL_INVALID", "Proposal decoded image payload is inconsistent", { definitiveNonSubmission: true });
	}
	const digest = sha256(bytes);
	if (expected.path !== undefined && canonical !== expected.path) {
		throw failure("GRAMMAR_PROPOSAL_INVALID", "Verified proposal path does not match its approved path", { definitiveNonSubmission: true });
	}
	if (expected.digest !== undefined && digest !== expected.digest) {
		throw failure("GRAMMAR_PROPOSAL_INVALID", "Verified proposal hash does not match its provider result", { definitiveNonSubmission: true });
	}
	return { path: canonical, bytes, mimeType, digest };
}

function clonePlainData(value, seen = new Set(), depth = 0, state = { nodes: 0 }) {
	if (depth > 32 || ++state.nodes > 16_384) throw new Error();
	if (value === null || typeof value === "string" || typeof value === "boolean"
		|| (typeof value === "number" && Number.isFinite(value))) return value;
	if (!value || typeof value !== "object" || seen.has(value)) throw new Error();
	seen.add(value);
	const prototype = Object.getPrototypeOf(value);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (Reflect.ownKeys(descriptors).length > 16_384) throw new Error();
	if (Array.isArray(value)) {
		if (prototype !== Array.prototype) throw new Error();
		const length = descriptors.length?.value;
		const keys = Reflect.ownKeys(descriptors).filter((key) => key !== "length");
		if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length) throw new Error();
		const result = new Array(length);
		for (const key of keys) {
			const descriptor = descriptors[key];
			if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key)
				|| descriptor.get || descriptor.set || !Object.hasOwn(descriptor, "value")) throw new Error();
			const index = Number(key);
			if (index >= length) throw new Error();
			result[index] = clonePlainData(descriptor.value, seen, depth + 1, state);
		}
		return result;
	}
	if (prototype !== Object.prototype && prototype !== null) throw new Error();
	const result = Object.create(null);
	for (const key of Reflect.ownKeys(descriptors)) {
		const descriptor = descriptors[key];
		if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)
			|| descriptor.get || descriptor.set || !Object.hasOwn(descriptor, "value")) throw new Error();
		result[key] = clonePlainData(descriptor.value, seen, depth + 1, state);
	}
	return result;
}

function verifiedEvidence(evidence, candidateId) {
	const authority = readVerifiedFacadeEvidenceAuthority(evidence);
	if (!authority) throw failure("GRAMMAR_EVIDENCE_UNVERIFIED", "Verified evidence provenance is required", { definitiveNonSubmission: true });
	let manifestText;
	try { manifestText = `${stableJson(clonePlainData(evidence.manifest))}\n`; }
	catch { throw failure("GRAMMAR_EVIDENCE_UNVERIFIED", "Verified evidence manifest is not safe plain data", { definitiveNonSubmission: true }); }
	if (Buffer.byteLength(manifestText, "utf8") > MAX_MANIFEST_BYTES || sha256(manifestText) !== authority.manifestSha256) {
		throw failure("GRAMMAR_EVIDENCE_UNVERIFIED", "Verified evidence manifest provenance changed", { definitiveNonSubmission: true });
	}
	if (candidateId !== undefined && candidateId !== authority.candidateId) {
		throw failure("GRAMMAR_EVIDENCE_UNVERIFIED", "Verified evidence candidate does not match configuration", { definitiveNonSubmission: true });
	}
	return { authority, manifestText };
}

function validateConfig(config) {
	const fields = dataRecord(config, "config");
	if (fields.grammarModel !== MODEL) throw failure("GRAMMAR_MODEL_INVALID", `Grammar model must be ${MODEL}`, { definitiveNonSubmission: true });
	const ceilingUsd = fields.grammarBudgetUsd;
	const estimateUsd = fields.grammarEstimateUsd ?? ceilingUsd;
	if (!Number.isFinite(ceilingUsd) || ceilingUsd < 0 || !Number.isFinite(estimateUsd) || estimateUsd < 0) {
		throw failure("GRAMMAR_BUDGET_INVALID", "Grammar budget and estimate must be finite nonnegative values", { definitiveNonSubmission: true });
	}
	if (estimateUsd > ceilingUsd) throw failure("GRAMMAR_BUDGET_EXCEEDED", "Estimated grammar cost exceeds its approved budget", { definitiveNonSubmission: true });
	const timeoutMs = fields.grammarTimeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
		throw failure("GRAMMAR_TIMEOUT_INVALID", "Grammar timeout must be a bounded positive value", { definitiveNonSubmission: true });
	}
	const apiKey = fields.openAIApiKey;
	if (apiKey !== undefined && (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 4_096 || /[\r\n\0]/.test(apiKey))) {
		throw failure("GRAMMAR_CREDENTIALS_INVALID", "OpenAI credential is invalid", { definitiveNonSubmission: true });
	}
	const proposalProvider = fields.proposalProvider;
	if (!PROPOSAL_PROVIDERS.has(proposalProvider)) {
		throw failure("GRAMMAR_PROPOSAL_INVALID", "An approved proposal provider identity is required", { definitiveNonSubmission: true });
	}
	return { candidateId: fields.candidateId, proposalProvider, ceilingUsd, estimateUsd, timeoutMs, apiKey };
}

function validateProposalConfig(config) {
	const fields = dataRecord(config, "config");
	const proposalProvider = fields.proposalProvider;
	if (!PROPOSAL_PROVIDERS.has(proposalProvider)) {
		throw failure("GRAMMAR_PROPOSAL_INVALID", "An approved proposal provider identity is required", { definitiveNonSubmission: true });
	}
	return { candidateId: fields.candidateId, proposalProvider };
}

export function preflightFacadeGrammar(input = {}) {
	const fields = dataRecord(input, "grammar preflight input");
	const config = fields.config && typeof fields.config === "object" ? {
		...fields.config,
		grammarModel: fields.model ?? fields.config.grammarModel,
		grammarBudgetUsd: fields.ceilingUsd ?? fields.config.grammarBudgetUsd,
		grammarEstimateUsd: fields.estimateUsd ?? fields.config.grammarEstimateUsd,
		proposalProvider: fields.config.proposalProvider ?? "gpt-image-2",
	} : fields;
	const controls = validateConfig(config);
	createOpenAIGrammarProvider({ OPENAI_API_KEY: controls.apiKey }, { timeoutMs: controls.timeoutMs }).preflight({
		model: MODEL, ceilingUsd: controls.ceilingUsd, estimateUsd: controls.estimateUsd,
	});
	return Object.freeze({ provider: PROVIDER, model: MODEL, ceilingUsd: controls.ceilingUsd, estimateUsd: controls.estimateUsd });
}

function providerResultAuthority(providerResult) {
	const authorities = [
		readOpenAIProposalResultAuthority,
		readBytePlusProposalResultAuthority,
		readAlibabaProposalResultAuthority,
		readGeminiProposalResultAuthority,
	].map((read) => read(providerResult)).filter(Boolean);
	if (authorities.length > 1) throw failure("GRAMMAR_PROPOSAL_INVALID", "Verified proposal provider identity is ambiguous", { definitiveNonSubmission: true });
	return authorities[0] ?? null;
}

export async function verifyFacadeProposal(input) {
	const fields = dataRecord(input, "verifyFacadeProposal input");
	const controls = validateProposalConfig(fields.config);
	const evidenceAuthority = verifiedEvidence(fields.evidence, controls.candidateId);
	const providerAuthority = providerResultAuthority(fields.providerResult);
	if (!providerAuthority) throw failure("GRAMMAR_PROPOSAL_INVALID", "Verified proposal provider result is required", { definitiveNonSubmission: true });
	if (providerAuthority.provider !== controls.proposalProvider) {
		throw failure("GRAMMAR_PROPOSAL_INVALID", "Verified proposal provider does not match configuration", { definitiveNonSubmission: true });
	}
	if (providerAuthority.candidateId !== controls.candidateId) {
		throw failure("GRAMMAR_PROPOSAL_INVALID", "Verified proposal candidate does not match configuration", { definitiveNonSubmission: true });
	}
	if (providerAuthority.evidenceManifestSha256 !== evidenceAuthority.authority.manifestSha256) {
		throw failure("GRAMMAR_PROPOSAL_INVALID", "Verified proposal evidence does not match extraction evidence", { definitiveNonSubmission: true });
	}
	if (claimedProviderResults.has(fields.providerResult)) {
		throw failure("GRAMMAR_PROPOSAL_INVALID", "Verified proposal provider result was already bound to an approved path", { definitiveNonSubmission: true });
	}
	const proposal = await readProposalFile(fields.proposalPath, { digest: providerAuthority.proposalSha256 });
	const publicAuthority = Object.freeze({
		path: proposal.path,
		proposalSha256: proposal.digest,
		provider: providerAuthority.provider,
		candidateId: providerAuthority.candidateId,
		evidenceManifestSha256: providerAuthority.evidenceManifestSha256,
	});
	claimedProviderResults.add(fields.providerResult);
	verifiedProposalAuthorities.set(publicAuthority, Object.freeze({
		path: proposal.path,
		digest: proposal.digest,
		provider: providerAuthority.provider,
		candidateId: providerAuthority.candidateId,
		evidenceManifestSha256: providerAuthority.evidenceManifestSha256,
	}));
	return publicAuthority;
}

async function readVerifiedProposal(value, evidenceAuthority, controls) {
	const authority = value && typeof value === "object" ? verifiedProposalAuthorities.get(value) : null;
	if (!authority) throw failure("GRAMMAR_PROPOSAL_INVALID", "Verified proposal authority is required", { definitiveNonSubmission: true });
	if (authority.provider !== controls.proposalProvider || authority.candidateId !== controls.candidateId
		|| authority.evidenceManifestSha256 !== evidenceAuthority.authority.manifestSha256) {
		throw failure("GRAMMAR_PROPOSAL_INVALID", "Verified proposal provenance does not match extraction controls", { definitiveNonSubmission: true });
	}
	return readProposalFile(authority.path, { path: authority.path, digest: authority.digest });
}

function parseGrammar(text, floorGuides) {
	if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw failure("GRAMMAR_RESPONSE_TOO_LARGE", "Grammar output exceeds the configured size limit");
	const keys = [];
	for (const match of text.matchAll(/"(?:\\.|[^"\\])*"\s*:/g)) {
		try { keys.push(JSON.parse(match[0].slice(0, match[0].lastIndexOf(":")))); }
		catch { throw failure("GRAMMAR_OUTPUT_INVALID", "Grammar output contains invalid object keys"); }
	}
	if (new Set(keys).size !== keys.length) throw failure("GRAMMAR_OUTPUT_INVALID", "Grammar output contains duplicate or ambiguous elements");
	let parsed;
	try { parsed = JSON.parse(text); }
	catch { throw failure("GRAMMAR_OUTPUT_INVALID", "Grammar output must be one JSON object"); }
	try { return validatePunchedFacadeGrammar(parsed, { floorGuides }); }
	catch { throw failure("GRAMMAR_OUTPUT_INVALID", "Grammar output does not match the approved typed facade contract"); }
}

export async function extractFacadeGrammar(input) {
	const fields = dataRecord(input, "extractFacadeGrammar input");
	const { proposalPath, evidence, config, fetchImpl, ledger, signal, submission, requestKey: harnessRequestKey } = fields;
	const harnessMode = submission !== undefined;
	authenticSignal(signal);
	throwIfAborted(signal, true);
	if (typeof fetchImpl !== "function") throw failure("GRAMMAR_BOUNDARY_INVALID", "fetchImpl is required", { definitiveNonSubmission: true });
	if (!harnessMode && (!ledger || typeof ledger !== "object" || typeof ledger.executeOnce !== "function")) {
		throw failure("GRAMMAR_BOUNDARY_INVALID", "A paid operation ledger is required", { definitiveNonSubmission: true });
	}
	const controls = validateConfig(config);
	const verified = verifiedEvidence(evidence, controls.candidateId);
	const proposal = await readVerifiedProposal(proposalPath, verified, controls);
	throwIfAborted(signal, true);
	const prompt = buildFacadeGrammarPrompt({
		proposalSha256: proposal.digest,
		evidenceManifestSha256: verified.authority.manifestSha256,
		manifestText: verified.manifestText,
	});
	const request = createFacadeGrammarRequest({
		provider: "openai-gpt-5.5", model: MODEL,
		proposalSha256: proposal.digest, evidenceManifestSha256: verified.authority.manifestSha256,
		promptRevision: prompt.revision, prompt: prompt.prompt, promptSha256: prompt.sha256,
		imageBytes: proposal.bytes, imageMimeType: proposal.mimeType, schema: FACADE_GRAMMAR_SCHEMA,
		ceilingUsd: controls.ceilingUsd, estimateUsd: controls.estimateUsd,
	});
	const requestKey = request.fingerprint;
	const provider = createOpenAIGrammarProvider({ OPENAI_API_KEY: controls.apiKey }, {
		fetchImpl, timeoutMs: controls.timeoutMs,
		submissionAuthorizer: harnessMode
			? (capability) => {
				const authorized = consumeFacadeGrammarSubmissionCapability(capability, {
				requestKey: harnessRequestKey, proposalProvider: controls.proposalProvider,
				proposalSha256: proposal.digest, evidenceSha256: verified.authority.manifestSha256,
				model: config.grammarModel,
				});
				if (!authorized) throw failure("GRAMMAR_SUBMISSION_UNAUTHORIZED", "A one-shot paid-operation submission authorization is required", { definitiveNonSubmission: true });
				return true;
			}
			: (capability) => {
				const authorized = consumePaidOperationSubmissionCapability(capability, {
				requestKey, provider: PROVIDER, kind: "grammar-extraction",
				});
				if (!authorized) throw failure("GRAMMAR_SUBMISSION_UNAUTHORIZED", "A one-shot paid-operation submission authorization is required", { definitiveNonSubmission: true });
				return true;
			},
	});
	let parsedGrammar = null;
	let transportReceipt = null;
	const operation = async (submissionCapability, facadeMode = false) => {
		const result = await provider.extract({ request, submission: submissionCapability, signal });
		try { parsedGrammar = parseGrammar(result.grammarCandidate, { floor_guides_m: evidence.manifest.floor_guides_m }); }
		catch (error) {
			if (error instanceof FacadeProviderError) throw failure(error.code, error.message, { remoteId: result.remoteId });
			throw error;
		}
		const artifactSha256 = sha256(stableJson(parsedGrammar));
		transportReceipt = {
			remoteId: result.remoteId ?? `openai-${artifactSha256}`,
			artifactSha256,
			actualUsd: result.actualUsd,
		};
		return transportReceipt;
	};
	if (harnessMode) {
		if (typeof harnessRequestKey !== "string") throw failure("GRAMMAR_BOUNDARY_INVALID", "Harness request key is required", { definitiveNonSubmission: true });
		await operation(submission, true);
	} else await ledger.executeOnce({
		requestKey,
		provider: PROVIDER,
		kind: "grammar-extraction",
		ceilingUsd: controls.ceilingUsd,
		estimateUsd: controls.estimateUsd,
		signal,
		operation,
	});
	if (!parsedGrammar) throw failure("GRAMMAR_RESULT_UNAVAILABLE", "Persisted grammar result is unavailable without resubmission");
	deepFreeze(parsedGrammar);
	verifiedGrammarAuthorities.set(parsedGrammar, Object.freeze(grammarAuthorityFromEvidence(
		parsedGrammar, verified.authority, controls.proposalProvider, proposal.digest,
	)));
	return harnessMode ? { grammar: parsedGrammar, remoteId: transportReceipt.remoteId, actualUsd: transportReceipt.actualUsd } : parsedGrammar;
}
