import { redactSecrets, sha256, stableJson } from "../../core.mjs";
import sharp from "sharp";
import { readVerifiedFacadeEvidenceAuthority } from "../evidence.mjs";
import { consumePaidOperationSubmissionCapability } from "../paid-operation-ledger.mjs";
import { FacadeProviderError, normalizeProviderFailure } from "../provider.mjs";

const PROVIDER = "nano-banana-pro";
const MODEL = "gemini-3-pro-image";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent";
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_PROMPT_DATA_BYTES = 1024 * 1024;
const MAX_BOUNDARY_DEPTH = 32;
const MAX_BOUNDARY_ENTRIES = 4_096;
const MAX_RESPONSE_NODES = 4_096;
const MAX_RESPONSE_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const requestAuthorities = new WeakMap();
const proposalResultAuthorities = new WeakMap();

export function readVerifiedProposalResultAuthority(value) {
	const authority = value && typeof value === "object" ? proposalResultAuthorities.get(value) : null;
	return authority ? { ...authority } : null;
}

function failure(code, message, options = {}) {
	return new FacadeProviderError(code, message, { provider: PROVIDER, stage: "generate", ...options });
}

function preflightFailure(code, message) {
	return new FacadeProviderError(code, message, {
		provider: PROVIDER, stage: "preflight", definitiveNonSubmission: true,
	});
}

function boundaryRecord(value) {
	try {
		if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error();
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (Reflect.ownKeys(descriptors).length > MAX_BOUNDARY_ENTRIES) throw new Error();
		const record = Object.create(null);
		for (const key of Reflect.ownKeys(descriptors)) {
			const descriptor = descriptors[key];
			if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)
				|| descriptor.get || descriptor.set || !("value" in descriptor)) throw new Error();
			record[key] = descriptor.value;
		}
		return record;
	} catch {
		throw preflightFailure("PROVIDER_BOUNDARY_INVALID", "Provider boundary input must be a plain data object without accessors");
	}
}

function clonePlainData(value, seen = new Set(), depth = 0) {
	if (depth > MAX_BOUNDARY_DEPTH) throw preflightFailure("PROVIDER_BOUNDARY_INVALID", "Provider boundary input exceeds the nesting limit");
	if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean"
		|| (typeof value === "number" && Number.isFinite(value))) return value;
	try {
		if (typeof value !== "object" || seen.has(value)) throw new Error();
		seen.add(value);
		const prototype = Object.getPrototypeOf(value);
		if (Array.isArray(value)) {
			if (prototype !== Array.prototype) throw new Error();
			const descriptors = Object.getOwnPropertyDescriptors(value);
			const length = descriptors.length?.value;
			const keys = Reflect.ownKeys(descriptors).filter((key) => key !== "length");
			if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BOUNDARY_ENTRIES || keys.length !== length) throw new Error();
			const result = new Array(length);
			for (const key of Reflect.ownKeys(descriptors)) {
				const descriptor = descriptors[key];
				if (typeof key !== "string" || descriptor.get || descriptor.set || !("value" in descriptor)) throw new Error();
				if (key !== "length") {
					if (!/^(?:0|[1-9][0-9]*)$/.test(key)) throw new Error();
					const index = Number(key);
					if (index >= length) throw new Error();
					result[index] = clonePlainData(descriptor.value, seen, depth + 1);
				}
			}
			return result;
		}
		if (prototype !== Object.prototype && prototype !== null) throw new Error();
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (Reflect.ownKeys(descriptors).length > MAX_BOUNDARY_ENTRIES) throw new Error();
		const result = Object.create(null);
		for (const key of Reflect.ownKeys(descriptors)) {
			const descriptor = descriptors[key];
			if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)
				|| descriptor.get || descriptor.set || !("value" in descriptor)) throw new Error();
			result[key] = clonePlainData(descriptor.value, seen, depth + 1);
		}
		return result;
	} catch {
		throw preflightFailure("PROVIDER_BOUNDARY_INVALID", "Provider boundary input must contain only plain data without accessors");
	}
}

function cloneResponsePayload(value) {
	const seen = new Set();
	let nodes = 0;
	function clone(item, depth) {
		if (depth > MAX_BOUNDARY_DEPTH || ++nodes > MAX_RESPONSE_NODES) throw new Error();
		if (item === null || typeof item === "string" || typeof item === "boolean"
			|| (typeof item === "number" && Number.isFinite(item))) return item;
		if (typeof item !== "object" || seen.has(item)) throw new Error();
		seen.add(item);
		const prototype = Object.getPrototypeOf(item);
		if (Array.isArray(item)) {
			if (prototype !== Array.prototype) throw new Error();
			const descriptors = Object.getOwnPropertyDescriptors(item);
			const length = descriptors.length?.value;
			const keys = Reflect.ownKeys(descriptors).filter((key) => key !== "length");
			if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BOUNDARY_ENTRIES || keys.length !== length) throw new Error();
			const result = new Array(length);
			for (const key of keys) {
				const descriptor = descriptors[key];
				if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key)
					|| descriptor.get || descriptor.set || !("value" in descriptor)) throw new Error();
				const index = Number(key);
				if (index >= length) throw new Error();
				result[index] = clone(descriptor.value, depth + 1);
			}
			return result;
		}
		if (prototype !== Object.prototype && prototype !== null) throw new Error();
		const descriptors = Object.getOwnPropertyDescriptors(item);
		const keys = Reflect.ownKeys(descriptors);
		if (keys.length > MAX_BOUNDARY_ENTRIES) throw new Error();
		const result = Object.create(null);
		for (const key of keys) {
			const descriptor = descriptors[key];
			if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)
				|| descriptor.get || descriptor.set || !("value" in descriptor)) throw new Error();
			result[key] = clone(descriptor.value, depth + 1);
		}
		return result;
	}
	try { return clone(value, 0); }
	catch { throw failure("PROVIDER_RESPONSE_INVALID", "Provider returned an invalid JSON payload"); }
}

async function readBoundedJsonResponse(response) {
	const declaredLength = response.headers.get("content-length");
	if (declaredLength !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)) {
		throw failure("PROVIDER_RESPONSE_TOO_LARGE", "Provider response exceeds the configured size limit");
	}
	const reader = response.body?.getReader();
	if (!reader) return { payload: Object.create(null), parseFailed: true };
	const chunks = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!(value instanceof Uint8Array)) throw failure("PROVIDER_RESPONSE_INVALID", "Provider returned an invalid response body");
			totalBytes += value.byteLength;
			if (totalBytes > MAX_RESPONSE_BYTES) {
				await reader.cancel().catch(() => {});
				throw failure("PROVIDER_RESPONSE_TOO_LARGE", "Provider response exceeds the configured size limit");
			}
			chunks.push(Buffer.from(value));
		}
	} finally { reader.releaseLock(); }
	try {
		return { payload: cloneResponsePayload(JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8"))), parseFailed: false };
	} catch (error) {
		if (error instanceof FacadeProviderError && error.code === "PROVIDER_RESPONSE_INVALID") {
			return { payload: Object.create(null), parseFailed: true };
		}
		return { payload: Object.create(null), parseFailed: true };
	}
}

function validateAbortSignal(signal) {
	if (signal === undefined) return;
	try {
		if (Object.getPrototypeOf(signal) !== AbortSignal.prototype) throw new Error();
		const descriptors = Object.getOwnPropertyDescriptors(signal);
		if (Reflect.ownKeys(descriptors).some((key) => typeof key === "string")) throw new Error();
		Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get.call(signal);
	} catch {
		throw preflightFailure("PROVIDER_BOUNDARY_INVALID", "Provider signal must be an authentic AbortSignal without overrides");
	}
}

function verifiedEvidence(evidence) {
	const authority = readVerifiedFacadeEvidenceAuthority(evidence);
	if (!authority) throw preflightFailure("PROVIDER_EVIDENCE_UNVERIFIED", "Evidence must come from the verified facade evidence authority");
	const bytes = authority.contactSheetBytes;
	if (!/^[a-f0-9]{64}$/.test(authority.manifestSha256)) throw preflightFailure("PROVIDER_EVIDENCE_UNVERIFIED", "Verified evidence manifest digest is required");
	if (imageType(bytes) !== "image/png") throw preflightFailure("PROVIDER_EVIDENCE_INVALID", "Evidence contact sheet must be a PNG image");
	if (sha256(bytes) !== authority.contactSheetSha256) {
		throw preflightFailure("PROVIDER_EVIDENCE_MISMATCH", "Evidence contact sheet does not match its verified manifest");
	}
	return { ...authority, contactSheetBytes: bytes };
}

function canonicalPrompt(evidenceAuthority, brief, output) {
	const candidateId = brief?.candidate_id ?? brief?.candidateId ?? evidenceAuthority.candidateId;
	const briefId = brief?.brief_id ?? brief?.briefId ?? brief?.id ?? "brick-punched-window-v1";
	const evidenceDigest = evidenceAuthority.manifestSha256;
	return [
		`Geometry-locked facade image for candidate ${candidateId}.`,
		`Approved brief: ${briefId}.`,
		`Evidence manifest SHA-256: ${evidenceDigest}. Treat the supplied contact sheet as binding authority for silhouette, massing, storey count, facade planes, opening rhythm, and camera framing.`,
		`Facade brief: ${stableJson(redactSecrets(brief ?? {}))}.`,
		`Requested output: ${stableJson(redactSecrets(output ?? {}))}.`,
		"Preserve the evidence geometry exactly. NO CURTAIN WALL. Do not invent projections, setbacks, floors, openings, or a different camera.",
	].join("\n");
}

export function buildRequest(input) {
	const fields = boundaryRecord(input);
	const evidence = fields.evidence;
	const brief = clonePlainData(fields.brief ?? {});
	const output = clonePlainData(fields.output ?? {});
	if (Buffer.byteLength(stableJson({ brief, output }), "utf8") > MAX_PROMPT_DATA_BYTES) {
		throw preflightFailure("PROVIDER_REQUEST_TOO_LARGE", "Provider prompt data exceeds the configured size limit");
	}
	const evidenceAuthority = verifiedEvidence(evidence);
	const evidenceBytes = evidenceAuthority.contactSheetBytes;
	const request = {
		provider: PROVIDER,
		model: MODEL,
		prompt: canonicalPrompt(evidenceAuthority, brief, output),
		evidenceBytes,
		evidenceSha256: sha256(evidenceBytes),
		evidenceManifestSha256: evidenceAuthority.manifestSha256,
		output: redactSecrets(output ?? {}),
	};
	request.fingerprint = sha256(stableJson({
		provider: request.provider, model: request.model, prompt: request.prompt,
		evidenceSha256: request.evidenceSha256, evidenceManifestSha256: request.evidenceManifestSha256,
		output: request.output,
	}));
	const authorizedRequest = Object.freeze(request);
	requestAuthorities.set(authorizedRequest, Object.freeze({
		fingerprint: request.fingerprint,
		candidateId: evidenceAuthority.candidateId,
		evidenceManifestSha256: evidenceAuthority.manifestSha256,
	}));
	return authorizedRequest;
}

function validateRequest(request) {
	const authority = request && typeof request === "object" ? requestAuthorities.get(request) : null;
	if (!authority) throw preflightFailure("PROVIDER_REQUEST_UNAUTHORIZED", "Provider request must come from the verified request builder");
	if (!request || request.model !== MODEL) throw preflightFailure("PROVIDER_MODEL_NOT_ALLOWED", `Only ${MODEL} is allowed`);
	if (typeof request.prompt !== "string" || !request.prompt) throw preflightFailure("PROVIDER_REQUEST_INVALID", "Provider prompt is required");
	if (!Buffer.isBuffer(request.evidenceBytes) && !(request.evidenceBytes instanceof Uint8Array)) {
		throw preflightFailure("PROVIDER_REQUEST_INVALID", "Evidence bytes are required");
	}
	if (request.evidenceBytes.byteLength > MAX_REQUEST_BYTES) {
		throw preflightFailure("PROVIDER_REQUEST_TOO_LARGE", "Evidence request exceeds the configured size limit");
	}
	const requestBytes = Buffer.byteLength(JSON.stringify(request.prompt), "utf8")
		+ Math.ceil(request.evidenceBytes.byteLength / 3) * 4 + 1_024;
	if (requestBytes > MAX_REQUEST_BYTES) throw preflightFailure("PROVIDER_REQUEST_TOO_LARGE", "Complete provider request exceeds the configured size limit");
	if (imageType(Buffer.from(request.evidenceBytes)) !== "image/png") throw preflightFailure("PROVIDER_EVIDENCE_INVALID", "Evidence contact sheet must be a PNG image");
	if (request.evidenceSha256 && sha256(request.evidenceBytes) !== request.evidenceSha256) {
		throw preflightFailure("PROVIDER_EVIDENCE_MISMATCH", "Evidence bytes changed after request construction");
	}
	return { requestBytes, authority };
}

function validateBudget(config) {
	const estimate = config?.estimateUsd ?? config?.estimatedCostUsd;
	const ceiling = config?.ceilingUsd;
	if (!Number.isFinite(estimate) || estimate < 0 || !Number.isFinite(ceiling) || ceiling < 0) {
		throw preflightFailure("PROVIDER_BUDGET_INVALID", "A finite nonnegative estimate and ceiling are required");
	}
	if (estimate > ceiling) throw preflightFailure("PROVIDER_BUDGET_EXCEEDED", "Estimated provider cost exceeds the configured ceiling");
}

function imageType(bytes) {
	if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	return null;
}

function validBase64(value, padding) {
	for (let index = 0; index < value.length - padding; index += 1) {
		const code = value.charCodeAt(index);
		if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47)) return false;
	}
	for (let index = value.length - padding; index < value.length; index += 1) if (value.charCodeAt(index) !== 61) return false;
	return true;
}

async function decodeImage(value, declaredMimeType, remoteId) {
	if (typeof value !== "string" || !value.length) {
		throw failure("PROVIDER_RESPONSE_INVALID", "Provider returned malformed image encoding", { remoteId });
	}
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	const decodedLength = Math.floor(value.length / 4) * 3 - padding;
	if (decodedLength > MAX_IMAGE_BYTES) {
		throw failure("PROVIDER_RESPONSE_TOO_LARGE", "Provider image exceeds 32 MiB", { remoteId });
	}
	if (value.length % 4 !== 0 || !validBase64(value, padding)) {
		throw failure("PROVIDER_RESPONSE_INVALID", "Provider returned malformed image encoding", { remoteId });
	}
	const bytes = Buffer.from(value, "base64");
	const mimeType = imageType(bytes);
	if (!mimeType || !new Set(["image/png", "image/jpeg", "image/webp"]).has(declaredMimeType) || declaredMimeType !== mimeType) {
		throw failure("PROVIDER_RESPONSE_INVALID", "Provider image MIME type or signature is invalid", { remoteId });
	}
	let metadata;
	try { metadata = await sharp(bytes, { limitInputPixels: MAX_IMAGE_BYTES }).metadata(); }
	catch { throw failure("PROVIDER_RESPONSE_INVALID", "Provider image did not fully decode", { remoteId }); }
	if (!Number.isInteger(metadata.width) || metadata.width <= 0 || !Number.isInteger(metadata.height) || metadata.height <= 0
		|| !Number.isInteger(metadata.channels) || metadata.channels < 1 || metadata.channels > 4
		|| metadata.width * metadata.height * metadata.channels > MAX_IMAGE_BYTES) {
		throw failure("PROVIDER_RESPONSE_INVALID", "Provider image dimensions are invalid", { remoteId });
	}
	let decoded;
	try { decoded = await sharp(bytes, { limitInputPixels: MAX_IMAGE_BYTES }).raw().toBuffer({ resolveWithObject: true }); }
	catch { throw failure("PROVIDER_RESPONSE_INVALID", "Provider image did not fully decode", { remoteId }); }
	if (decoded.info.width !== metadata.width || decoded.info.height !== metadata.height || decoded.info.channels !== metadata.channels
		|| decoded.data.length !== metadata.width * metadata.height * metadata.channels) {
		throw failure("PROVIDER_RESPONSE_INVALID", "Provider decoded image payload is inconsistent", { remoteId });
	}
	return { bytes, mimeType };
}

function sanitized(value, secret) {
	function removeSecret(item) {
		if (typeof item === "string") {
			const redacted = redactSecrets(item);
			return secret ? redacted.split(secret).join("[REDACTED]") : redacted;
		}
		if (Array.isArray(item)) return item.map(removeSecret);
		if (!item || typeof item !== "object") return item;
		return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key,
			/(secret|api[_-]?key|authorization)/i.test(key) || (/token/i.test(key) && typeof entry !== "number")
				? "[REDACTED]" : removeSecret(entry)]));
	}
	return removeSecret(value);
}

function moderationBlocked(payload) {
	if (payload?.promptFeedback?.blockReason && payload.promptFeedback.blockReason !== "BLOCK_REASON_UNSPECIFIED") return true;
	return (payload?.candidates ?? []).some((candidate) => /SAFETY|BLOCK|PROHIBITED_CONTENT/.test(candidate?.finishReason ?? ""));
}

function statusCode(status, payload) {
	const marker = `${payload?.error?.status ?? ""} ${payload?.error?.message ?? ""}`.toLowerCase();
	if (/moderation|safety|blocked|content[_ -]?policy/.test(marker)) return "PROVIDER_MODERATION_BLOCKED";
	if (status === 401 || status === 403) return "PROVIDER_AUTH_FAILED";
	if (status === 429) return "PROVIDER_RATE_LIMITED";
	if (status >= 500) return "PROVIDER_SERVER_ERROR";
	return "PROVIDER_REQUEST_REJECTED";
}

async function fetchWithDeadline(fetchImpl, url, init, callerSignal, timeoutMs, consume) {
	if (callerSignal?.aborted) throw failure("PROVIDER_ABORTED", "Provider request was aborted before submission", { definitiveNonSubmission: true });
	const controller = new AbortController();
	let timedOut = false;
	const onAbort = () => controller.abort(callerSignal.reason ?? new DOMException("The operation was aborted", "AbortError"));
	callerSignal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort(new DOMException("Provider request timed out", "TimeoutError"));
	}, timeoutMs);
	try {
		const response = await fetchImpl(url, { ...init, signal: controller.signal });
		const result = await consume(response);
		if (controller.signal.aborted) throw controller.signal.reason;
		return result;
	} catch (error) {
		if (timedOut) throw failure("PROVIDER_TIMEOUT", "Provider request timed out");
		if (callerSignal?.aborted) throw failure("PROVIDER_ABORTED", "Provider request was aborted");
		if (error instanceof FacadeProviderError) throw error;
		throw failure("PROVIDER_REQUEST_FAILED", "Provider transport failed");
	} finally {
		clearTimeout(timer);
		callerSignal?.removeEventListener("abort", onAbort);
	}
}

export function createProvider(envInput = {}, optionsInput = {}) {
	const env = boundaryRecord(envInput);
	const options = boundaryRecord(optionsInput);
	const apiKey = env.GEMINI_API_KEY;
	const fetchImpl = options.fetchImpl;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required and must be a function");
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive finite number");

	return Object.freeze({
		preflight(config) {
			if (typeof apiKey !== "string" || !apiKey.trim()) throw preflightFailure("PROVIDER_CREDENTIALS_MISSING", "GEMINI_API_KEY is required");
			const fields = boundaryRecord(config);
			if (fields.model !== undefined && fields.model !== MODEL) throw preflightFailure("PROVIDER_MODEL_NOT_ALLOWED", `Only ${MODEL} is allowed`);
			const request = Object.hasOwn(fields, "request") ? fields.request : config;
			const { requestBytes } = validateRequest(request);
			validateBudget(fields);
			return { provider: PROVIDER, model: MODEL, requestBytes, ceilingUsd: fields.ceilingUsd };
		},
		async generate(input) {
			try {
				const fields = boundaryRecord(input);
				const { request, signal, submission } = fields;
				validateAbortSignal(signal);
				if (typeof apiKey !== "string" || !apiKey.trim()) throw preflightFailure("PROVIDER_CREDENTIALS_MISSING", "GEMINI_API_KEY is required");
				const { authority } = validateRequest(request);
				if (!consumePaidOperationSubmissionCapability(submission, {
					requestKey: authority.fingerprint, provider: PROVIDER, kind: "image-generation",
				})) throw preflightFailure("PROVIDER_SUBMISSION_UNAUTHORIZED", "A one-shot paid-operation submission authorization is required");
				const body = JSON.stringify({
					contents: [{ role: "user", parts: [
						{ text: request.prompt },
						{ inlineData: { mimeType: "image/png", data: Buffer.from(request.evidenceBytes).toString("base64") } },
					] }],
					generationConfig: { responseModalities: ["IMAGE"] },
				});
				const { response, payload, parseFailed, headerRemoteId } = await fetchWithDeadline(fetchImpl, ENDPOINT, {
					method: "POST",
					headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
					body,
				}, signal, timeoutMs, async (response) => {
					const headerRemoteId = response.headers.get("x-request-id");
					return { response, ...await readBoundedJsonResponse(response), headerRemoteId };
				});
				const remoteId = headerRemoteId ?? payload?.responseId ?? null;
				if (!response.ok) {
					const code = statusCode(response.status, payload);
					throw failure(code, code === "PROVIDER_MODERATION_BLOCKED" ? "Provider blocked the request by policy" : `Provider request failed with HTTP ${response.status}`, {
						status: response.status,
						retryable: response.status === 429 || response.status >= 500,
						definitiveNonSubmission: response.status < 500,
						remoteId,
					});
				}
				if (parseFailed) throw failure("PROVIDER_RESPONSE_INVALID", "Provider returned invalid JSON", { status: response.status, remoteId });
				if (moderationBlocked(payload)) throw failure("PROVIDER_MODERATION_BLOCKED", "Provider blocked the request by policy", { status: response.status, remoteId });
				const images = (payload?.candidates ?? []).flatMap((candidate) => candidate?.content?.parts ?? [])
					.filter((part) => part?.inlineData && typeof part.inlineData === "object")
					.map((part) => part.inlineData);
				if (images.length === 0) throw failure("PROVIDER_IMAGE_MISSING", "Provider response did not contain an image", { status: response.status, remoteId });
				if (images.length !== 1) throw failure("PROVIDER_IMAGE_COUNT_INVALID", "Provider response must contain exactly one image", { status: response.status, remoteId });
				const decoded = await decodeImage(images[0].data, images[0].mimeType, remoteId);
				const stableRemoteId = remoteId ?? `gemini-${sha256(decoded.bytes)}`;
				const usage = sanitized(payload?.usageMetadata ?? null, apiKey);
				const result = {
					...decoded,
					remoteId: stableRemoteId,
					usage,
					rawMeta: sanitized({
						provider: PROVIDER,
						model: MODEL,
						modelVersion: payload?.modelVersion ?? null,
						finishReasons: (payload?.candidates ?? []).map((candidate) => candidate?.finishReason ?? null),
						remoteIdHash: sha256(stableRemoteId),
						usage,
					}, apiKey),
				};
				proposalResultAuthorities.set(result, Object.freeze({
					provider: PROVIDER,
					candidateId: authority.candidateId,
					evidenceManifestSha256: authority.evidenceManifestSha256,
					proposalSha256: sha256(decoded.bytes),
				}));
				return result;
			} catch (error) {
				throw normalizeProviderFailure(error, PROVIDER, error?.stage === "preflight" ? "preflight" : "generate");
			}
		},
	});
}
