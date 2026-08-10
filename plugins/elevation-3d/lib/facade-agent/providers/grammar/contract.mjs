import { createHash } from "node:crypto";

import { stableJson } from "../../../core.mjs";
import { FacadeProviderError } from "../../provider.mjs";
import { FACADE_GRAMMAR_PROMPT_REVISION } from "./prompt.mjs";

const HASH = /^[a-f0-9]{64}$/;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_PROMPT_BYTES = 128 * 1024;
const MAX_PLAIN_BYTES = 1024 * 1024;
const MAX_PLAIN_DEPTH = 32;
const REQUEST_KEYS = new Set([
	"provider", "model", "proposalSha256", "evidenceManifestSha256", "promptRevision", "prompt",
	"promptSha256", "imageBytes", "imageMimeType", "schema", "ceilingUsd", "estimateUsd",
]);
const RESULT_KEYS = new Set([
	"request", "provider", "resolvedModel", "transport", "grammarCandidate", "remoteId", "actualUsd", "usage",
]);
const requestAuthorities = new WeakMap();
const ALLOWED_PROMPT_REVISIONS = new Set([
	FACADE_GRAMMAR_PROMPT_REVISION,
	"arr.elevation3d.facade-design-prompt.v1",
]);

function fail(code, message, provider = "grammar") {
	throw new FacadeProviderError(code, message, {
		provider,
		stage: "grammar",
		definitiveNonSubmission: true,
	});
}

function failResult(code, message, provider = "grammar", remoteId = null) {
	throw new FacadeProviderError(code, message, {
		provider,
		stage: "grammar",
		definitiveNonSubmission: false,
		remoteId,
	});
}

function validRemoteId(value) {
	return typeof value === "string" && value.length > 0
		&& Buffer.byteLength(value, "utf8") <= 4_096 && !/[\r\n\0]/.test(value);
}

function ownDataRemoteId(descriptors) {
	const descriptor = descriptors?.remoteId;
	return descriptor && !descriptor.get && !descriptor.set && Object.hasOwn(descriptor, "value")
		&& validRemoteId(descriptor.value) ? descriptor.value : null;
}

function record(value, label, allowedKeys) {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail("GRAMMAR_BOUNDARY_INVALID", `${label} must be a plain data object`);
	let prototype;
	let descriptors;
	try {
		prototype = Object.getPrototypeOf(value);
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch {
		fail("GRAMMAR_BOUNDARY_INVALID", `${label} could not be inspected safely`);
	}
	if (prototype !== Object.prototype && prototype !== null) fail("GRAMMAR_BOUNDARY_INVALID", `${label} must be a plain data object`);
	const result = Object.create(null);
	for (const key of Reflect.ownKeys(descriptors)) {
		const descriptor = descriptors[key];
		if (typeof key !== "string" || !allowedKeys.has(key) || descriptor.get || descriptor.set || !("value" in descriptor)) {
			fail("GRAMMAR_BOUNDARY_INVALID", `${label} contains an unauthorized field or accessor`);
		}
		result[key] = descriptor.value;
	}
	return result;
}

function resultRecord(value, label, allowedKeys) {
	if (!value || typeof value !== "object") failResult("GRAMMAR_RESPONSE_INVALID", `${label} must be a plain data object`);
	let prototype;
	let descriptors;
	try {
		prototype = Object.getPrototypeOf(value);
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch {
		failResult("GRAMMAR_RESPONSE_INVALID", `${label} could not be inspected safely`);
	}
	const remoteId = ownDataRemoteId(descriptors);
	if (Array.isArray(value) || (prototype !== Object.prototype && prototype !== null)) {
		failResult("GRAMMAR_RESPONSE_INVALID", `${label} must be a plain data object`, "grammar", remoteId);
	}
	const result = Object.create(null);
	for (const key of Reflect.ownKeys(descriptors)) {
		const descriptor = descriptors[key];
		if (typeof key !== "string" || !allowedKeys.has(key) || descriptor.get || descriptor.set || !("value" in descriptor)) {
			failResult("GRAMMAR_RESPONSE_INVALID", `${label} contains an unauthorized field or accessor`, "grammar", remoteId);
		}
		result[key] = descriptor.value;
	}
	return result;
}

function boundedString(value, label, maxBytes = 16_384) {
	if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maxBytes || /\0/.test(value)) {
		fail("GRAMMAR_BOUNDARY_INVALID", `${label} must be a bounded non-empty string`);
	}
	return value;
}

function hash(value, label) {
	if (typeof value !== "string" || !HASH.test(value)) fail("GRAMMAR_BOUNDARY_INVALID", `${label} must be a lowercase SHA-256 hash`);
	return value;
}

function money(value, label) {
	if (!Number.isFinite(value) || value < 0 || value > 10_000) fail("GRAMMAR_BUDGET_INVALID", `${label} must be a finite nonnegative amount`);
	return value;
}

function clonePlain(value, context = {}, seen = new Set(), state = { nodes: 0 }, depth = 0) {
	const reject = (message) => context.result
		? failResult("GRAMMAR_RESPONSE_INVALID", message, context.provider, context.remoteId)
		: fail("GRAMMAR_BOUNDARY_INVALID", message);
	if (depth > MAX_PLAIN_DEPTH) reject("Plain data exceeds the grammar nesting-depth limit");
	if (++state.nodes > 16_384) reject("Plain data exceeds the grammar boundary limit");
	if (value === null || typeof value === "string" || typeof value === "boolean"
		|| (typeof value === "number" && Number.isFinite(value))) return value;
	if (!value || typeof value !== "object" || seen.has(value)) reject("Value must contain only acyclic plain data");
	seen.add(value);
	let prototype;
	let descriptors;
	try {
		prototype = Object.getPrototypeOf(value);
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch {
		reject("Plain data could not be inspected safely");
	}
	if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) {
		reject("Value must contain only plain data objects and arrays");
	}
	if (Array.isArray(value)) {
		if (prototype !== Array.prototype) reject("Array prototype is invalid");
		const length = descriptors.length?.value;
		const keys = Reflect.ownKeys(descriptors).filter((key) => key !== "length");
		if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length) reject("Array shape is invalid");
		const result = new Array(length);
		for (const key of keys) {
			const descriptor = descriptors[key];
			if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length
				|| descriptor.get || descriptor.set || !("value" in descriptor)) reject("Array contains unsafe data");
			result[Number(key)] = clonePlain(descriptor.value, context, seen, state, depth + 1);
		}
		return result;
	}
	if (prototype !== Object.prototype && prototype !== null) reject("Object prototype is invalid");
	const result = Object.create(null);
	for (const key of Reflect.ownKeys(descriptors)) {
		const descriptor = descriptors[key];
		if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)
			|| descriptor.get || descriptor.set || !("value" in descriptor)) reject("Object contains unsafe data");
		result[key] = clonePlain(descriptor.value, context, seen, state, depth + 1);
	}
	return result;
}

function deepFreeze(value, depth = 0, context = {}) {
	if (depth > MAX_PLAIN_DEPTH + 2) {
		if (context.result) failResult("GRAMMAR_RESPONSE_INVALID", "Plain data exceeds the grammar nesting-depth limit", context.provider, context.remoteId);
		fail("GRAMMAR_BOUNDARY_INVALID", "Plain data exceeds the grammar nesting-depth limit");
	}
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child, depth + 1, context);
	return Object.freeze(value);
}

function imageType(bytes) {
	if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	return null;
}

export function readVerifiedFacadeGrammarRequestAuthority(value) {
	const authority = value && typeof value === "object" ? requestAuthorities.get(value) : null;
	return authority ? { ...authority } : null;
}

export function createFacadeGrammarRequest(input) {
	const fields = record(input, "Facade grammar request", REQUEST_KEYS);
	const provider = boundedString(fields.provider, "provider");
	const model = boundedString(fields.model, "model");
	const proposalSha256 = hash(fields.proposalSha256, "proposalSha256");
	const evidenceManifestSha256 = hash(fields.evidenceManifestSha256, "evidenceManifestSha256");
	const promptRevision = boundedString(fields.promptRevision, "promptRevision");
	const prompt = boundedString(fields.prompt, "prompt", MAX_PROMPT_BYTES);
	const promptSha256 = hash(fields.promptSha256, "promptSha256");
	if (!ALLOWED_PROMPT_REVISIONS.has(promptRevision)) fail("GRAMMAR_BOUNDARY_INVALID", "prompt revision is not approved");
	if (createHash("sha256").update(prompt).digest("hex") !== promptSha256) fail("GRAMMAR_BOUNDARY_INVALID", "prompt hash does not match its text");
	if (!prompt.includes(proposalSha256) || !prompt.includes(evidenceManifestSha256)) fail("GRAMMAR_BOUNDARY_INVALID", "prompt must bind the proposal and evidence hashes");
	if (!Buffer.isBuffer(fields.imageBytes) && !(fields.imageBytes instanceof Uint8Array)) fail("GRAMMAR_PROPOSAL_INVALID", "Proposal image bytes are required");
	const imageBytes = Buffer.from(fields.imageBytes);
	if (imageBytes.length === 0 || imageBytes.length > MAX_IMAGE_BYTES) fail("GRAMMAR_REQUEST_TOO_LARGE", "Proposal image exceeds the grammar request limit");
	const detectedType = imageType(imageBytes);
	if (!detectedType || fields.imageMimeType !== detectedType) fail("GRAMMAR_PROPOSAL_INVALID", "Proposal media must be a matching PNG or JPEG");
	if (createHash("sha256").update(imageBytes).digest("hex") !== proposalSha256) fail("GRAMMAR_PROPOSAL_INVALID", "Proposal hash does not match its image bytes");
	const schema = clonePlain(fields.schema);
	if (Buffer.byteLength(stableJson(schema), "utf8") > MAX_PLAIN_BYTES) fail("GRAMMAR_REQUEST_TOO_LARGE", "Grammar schema exceeds the request limit");
	const ceilingUsd = money(fields.ceilingUsd, "ceilingUsd");
	const estimateUsd = money(fields.estimateUsd, "estimateUsd");
	if (estimateUsd > ceilingUsd) fail("GRAMMAR_BUDGET_EXCEEDED", "Estimated grammar cost exceeds its ceiling");
	const request = {
		provider, model, proposalSha256, evidenceManifestSha256, promptRevision, prompt, promptSha256,
		imageMimeType: detectedType, imageBase64: imageBytes.toString("base64"), schema, ceilingUsd, estimateUsd,
	};
	request.fingerprint = createHash("sha256").update(stableJson(request)).digest("hex");
	const authorized = deepFreeze(request);
	requestAuthorities.set(authorized, Object.freeze({ provider, model, fingerprint: request.fingerprint, ceilingUsd, estimateUsd }));
	return authorized;
}

export function normalizeFacadeGrammarResult(input) {
	const fields = resultRecord(input, "Facade grammar result", RESULT_KEYS);
	let remoteId = fields.remoteId;
	if (remoteId !== null && remoteId !== undefined && !validRemoteId(remoteId)) {
		failResult("GRAMMAR_RESPONSE_INVALID", "Grammar result remoteId is invalid");
	}
	remoteId ??= null;
	const authority = readVerifiedFacadeGrammarRequestAuthority(fields.request);
	if (!authority) failResult("GRAMMAR_RESPONSE_INVALID", "A verified common grammar request is required", "grammar", remoteId);
	if (typeof fields.provider !== "string" || !fields.provider.trim() || Buffer.byteLength(fields.provider, "utf8") > 16_384) {
		failResult("GRAMMAR_RESPONSE_INVALID", "provider must be a bounded non-empty string", "grammar", remoteId);
	}
	if (typeof fields.resolvedModel !== "string" || !fields.resolvedModel.trim() || Buffer.byteLength(fields.resolvedModel, "utf8") > 16_384) {
		failResult("GRAMMAR_RESPONSE_INVALID", "resolvedModel must be a bounded non-empty string", fields.provider, remoteId);
	}
	const provider = fields.provider;
	const resolvedModel = fields.resolvedModel;
	if (provider !== authority.provider || resolvedModel !== authority.model) failResult("GRAMMAR_RESPONSE_INVALID", "Grammar result identity does not match its request", provider, remoteId);
	if (fields.transport !== "live" && fields.transport !== "fixture") failResult("GRAMMAR_RESPONSE_INVALID", "Grammar transport is invalid", provider, remoteId);
	let grammarCandidate;
	if (typeof fields.grammarCandidate === "string") {
		if (!fields.grammarCandidate.trim() || Buffer.byteLength(fields.grammarCandidate, "utf8") > MAX_PLAIN_BYTES) {
			failResult("GRAMMAR_RESPONSE_INVALID", "grammarCandidate must be bounded non-empty data", provider, remoteId);
		}
		grammarCandidate = fields.grammarCandidate;
	} else grammarCandidate = clonePlain(fields.grammarCandidate, { result: true, provider, remoteId });
	const actualUsd = fields.actualUsd === null || fields.actualUsd === undefined ? null : fields.actualUsd;
	if (actualUsd !== null && (!Number.isFinite(actualUsd) || actualUsd < 0 || actualUsd > 10_000 || actualUsd > authority.ceilingUsd)) {
		failResult("GRAMMAR_RESPONSE_INVALID", "Grammar response reported an invalid cost", provider, remoteId);
	}
	const usage = fields.usage === null || fields.usage === undefined ? null
		: clonePlain(fields.usage, { result: true, provider, remoteId });
	if (usage !== null && Buffer.byteLength(stableJson(usage), "utf8") > MAX_PLAIN_BYTES) failResult("GRAMMAR_RESPONSE_TOO_LARGE", "Grammar usage exceeds the response limit", provider, remoteId);
	return deepFreeze({
		provider, resolvedModel, transport: fields.transport, requestFingerprint: authority.fingerprint,
		grammarCandidate, remoteId, actualUsd, usage,
	}, 0, { result: true, provider, remoteId });
}
