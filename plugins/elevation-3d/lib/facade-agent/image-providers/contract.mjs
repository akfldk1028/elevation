import { createHash } from "node:crypto";

import { stableJson } from "../../core.mjs";
import { decodeBoundedProviderImage, FACADE_PROVIDER_IMAGE_LIMITS } from "./image-codec.mjs";
import { cloneBoundedPlainData, FacadeImageBoundaryError, redactBoundedPlainData } from "./response-boundary.mjs";

const HASH = /^[a-f0-9]{64}$/;
const REQUEST_KEYS = new Set(["provider", "model", "candidate", "brief", "evidence", "prompt", "output", "prohibitedChanges", "estimateUsd", "ceilingUsd"]);
const RESULT_KEYS = new Set(["provider", "resolvedModel", "requestFingerprint", "bytes", "remoteId", "usage", "actualUsd", "latencyMs", "rawMeta"]);
const requestAuthorities = new WeakMap();
const resultAuthorities = new WeakMap();

function fail(code, message) {
	throw new FacadeImageBoundaryError(code, message);
}

function record(value, label, allowedKeys) {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail("PROVIDER_BOUNDARY_INVALID", `${label} must be a plain object`);
	let prototype;
	let descriptors;
	try {
		prototype = Object.getPrototypeOf(value);
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch {
		fail("PROVIDER_BOUNDARY_INVALID", `${label} could not be inspected safely`);
	}
	if (prototype !== Object.prototype && prototype !== null) fail("PROVIDER_BOUNDARY_INVALID", `${label} must be a plain object`);
	const result = {};
	for (const key of Reflect.ownKeys(descriptors)) {
		const descriptor = descriptors[key];
		if (typeof key !== "string" || !allowedKeys.has(key) || descriptor.get || descriptor.set || !("value" in descriptor)) fail("PROVIDER_BOUNDARY_INVALID", `${label} contains an unauthorized field or accessor`);
		result[key] = descriptor.value;
	}
	return result;
}

function string(value, label) {
	if (typeof value !== "string" || !value.trim() || value.length > 16_384) fail("PROVIDER_BOUNDARY_INVALID", `${label} must be a bounded non-empty string`);
	return value;
}

function hash(value, label) {
	if (typeof value !== "string" || !HASH.test(value)) fail("PROVIDER_EVIDENCE_INVALID", `${label} must be a lowercase SHA-256`);
	return value;
}

function money(value, label) {
	if (!Number.isFinite(value) || value < 0 || value > 10_000) fail("PROVIDER_BUDGET_INVALID", `${label} must be a finite nonnegative amount`);
	return value;
}

function deepFreeze(value) {
	if (!value || typeof value !== "object" || Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

export function readVerifiedFacadeImageEditRequestAuthority(value) {
	const authority = value && typeof value === "object" ? requestAuthorities.get(value) : null;
	return authority ? { ...authority } : null;
}

export function readVerifiedFacadeImageEditResultAuthority(value) {
	const authority = value && typeof value === "object" ? resultAuthorities.get(value) : null;
	if (!authority || !Buffer.isBuffer(value.bytes) || createHash("sha256").update(value.bytes).digest("hex") !== authority.proposalSha256) return null;
	return { ...authority };
}

export function createFacadeImageEditRequest(input) {
	const fields = record(input, "Facade image request", REQUEST_KEYS);
	const provider = string(fields.provider, "provider");
	const model = string(fields.model, "model");
	const candidate = cloneBoundedPlainData(fields.candidate);
	const brief = cloneBoundedPlainData(fields.brief);
	const evidence = record(fields.evidence, "evidence", new Set(["manifestSha256", "sha256", "pngBytes"]));
	const prompt = cloneBoundedPlainData(fields.prompt);
	const output = cloneBoundedPlainData(fields.output);
	const prohibitedChanges = cloneBoundedPlainData(fields.prohibitedChanges);
	if (typeof candidate.id !== "string" || !candidate.id) fail("PROVIDER_BOUNDARY_INVALID", "candidate.id is required");
	if (typeof brief.id !== "string" || !brief.id || typeof brief.revision !== "string" || !brief.revision) fail("PROVIDER_BOUNDARY_INVALID", "brief identity and revision are required");
	if (!Buffer.isBuffer(evidence.pngBytes) && !(evidence.pngBytes instanceof Uint8Array)) fail("PROVIDER_EVIDENCE_INVALID", "evidence PNG bytes are required");
	const evidenceBytes = Buffer.from(evidence.pngBytes);
	if (evidenceBytes.length > FACADE_PROVIDER_IMAGE_LIMITS.maxEncodedBytes) fail("PROVIDER_REQUEST_TOO_LARGE", "evidence PNG exceeds the provider request limit");
	if (evidenceBytes.length < 8 || !evidenceBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail("PROVIDER_EVIDENCE_INVALID", "evidence must be PNG");
	const evidenceSha256 = createHash("sha256").update(evidenceBytes).digest("hex");
	if (evidence.sha256 !== undefined && evidence.sha256 !== evidenceSha256) fail("PROVIDER_EVIDENCE_INVALID", "evidence hash does not match its bytes");
	const manifestSha256 = hash(evidence.manifestSha256, "evidence.manifestSha256");
	if (typeof prompt.revision !== "string" || !prompt.revision || typeof prompt.text !== "string" || !prompt.text) fail("PROVIDER_BOUNDARY_INVALID", "prompt revision and text are required");
	if (!HASH.test(prompt.sha256) || createHash("sha256").update(prompt.text).digest("hex") !== prompt.sha256) fail("PROVIDER_BOUNDARY_INVALID", "prompt hash does not match its text");
	if (!Number.isSafeInteger(output.width) || output.width < 256 || output.width > 4096
		|| !Number.isSafeInteger(output.height) || output.height < 256 || output.height > 4096
		|| output.format !== "png" || output.count !== 1) fail("PROVIDER_OUTPUT_INVALID", "output must request exactly one bounded PNG");
	if (!Array.isArray(prohibitedChanges) || prohibitedChanges.length === 0 || prohibitedChanges.some((item) => typeof item !== "string" || !item)) fail("PROVIDER_BOUNDARY_INVALID", "prohibitedChanges must be a non-empty string list");
	const estimateUsd = money(fields.estimateUsd, "estimateUsd");
	const ceilingUsd = money(fields.ceilingUsd, "ceilingUsd");
	if (estimateUsd > ceilingUsd) fail("PROVIDER_BUDGET_EXCEEDED", "Estimated provider cost exceeds its ceiling");
	const request = {
		provider,
		model,
		candidate,
		brief,
		evidence: { manifestSha256, sha256: evidenceSha256, pngBase64: evidenceBytes.toString("base64") },
		prompt,
		output,
		prohibitedChanges,
		estimateUsd,
		ceilingUsd,
	};
	request.fingerprint = createHash("sha256").update(stableJson(request)).digest("hex");
	const authorized = deepFreeze(request);
	requestAuthorities.set(authorized, Object.freeze({
		provider,
		model,
		candidateId: candidate.id,
		evidenceManifestSha256: manifestSha256,
		fingerprint: request.fingerprint,
	}));
	return authorized;
}

export async function verifyFacadeImageEditResult(input) {
	const fields = record(input, "Facade image result", RESULT_KEYS);
	const provider = string(fields.provider, "provider");
	const resolvedModel = string(fields.resolvedModel, "resolvedModel");
	const requestFingerprint = hash(fields.requestFingerprint, "requestFingerprint");
	const image = await decodeBoundedProviderImage({ bytes: fields.bytes });
	const actualUsd = fields.actualUsd === null || fields.actualUsd === undefined ? null : money(fields.actualUsd, "actualUsd");
	const latencyMs = fields.latencyMs === null || fields.latencyMs === undefined ? null : money(fields.latencyMs, "latencyMs");
	const usage = fields.usage === null || fields.usage === undefined ? null : redactBoundedPlainData(fields.usage);
	const rawMeta = fields.rawMeta === null || fields.rawMeta === undefined ? null : redactBoundedPlainData(fields.rawMeta);
	const remoteIdHash = typeof fields.remoteId === "string" && fields.remoteId ? createHash("sha256").update(fields.remoteId).digest("hex") : null;
	const result = deepFreeze({
		provider,
		resolvedModel,
		requestFingerprint,
		bytes: Buffer.from(image.bytes),
		mimeType: image.mimeType,
		width: image.width,
		height: image.height,
		byteSize: image.byteSize,
		sha256: image.sha256,
		remoteIdHash,
		usage,
		actualUsd,
		latencyMs,
		rawMeta,
	});
	resultAuthorities.set(result, Object.freeze({
		provider,
		resolvedModel,
		requestFingerprint,
		proposalSha256: image.sha256,
	}));
	return result;
}
