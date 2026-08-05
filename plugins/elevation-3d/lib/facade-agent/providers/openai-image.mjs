import { redactSecrets, sha256, stableJson } from "../../core.mjs";
import { FacadeProviderError, normalizeProviderFailure } from "../provider.mjs";

const PROVIDER = "gpt-image-2";
const MODEL = "gpt-image-2";
const ENDPOINT = "https://api.openai.com/v1/images/edits";
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

function failure(code, message, options = {}) {
	return new FacadeProviderError(code, message, { provider: PROVIDER, stage: "generate", ...options });
}

function preflightFailure(code, message) {
	return new FacadeProviderError(code, message, {
		provider: PROVIDER, stage: "preflight", definitiveNonSubmission: true,
	});
}

function bytesFromEvidence(evidence) {
	const value = evidence?.contactSheetBytes ?? evidence?.contact_sheet_bytes ?? evidence?.evidenceBytes ?? evidence?.bytes;
	if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
		throw preflightFailure("PROVIDER_REQUEST_INVALID", "Verified evidence contact sheet bytes are required");
	}
	const bytes = Buffer.from(value);
	if (!bytes.length) throw preflightFailure("PROVIDER_REQUEST_INVALID", "Verified evidence contact sheet bytes are required");
	if (imageType(bytes) !== "image/png") throw preflightFailure("PROVIDER_EVIDENCE_INVALID", "Evidence contact sheet must be a PNG image");
	const expected = evidence?.contactSheetSha256 ?? evidence?.contact_sheet_sha256 ?? evidence?.manifest?.contact_sheet?.sha256;
	if (expected !== undefined && (typeof expected !== "string" || sha256(bytes) !== expected.toLowerCase())) {
		throw preflightFailure("PROVIDER_EVIDENCE_MISMATCH", "Evidence contact sheet does not match its verified manifest");
	}
	return bytes;
}

function canonicalPrompt(evidence, brief, output) {
	const candidateId = brief?.candidate_id ?? brief?.candidateId ?? evidence?.manifest?.candidate_id ?? "creative-020";
	const briefId = brief?.brief_id ?? brief?.briefId ?? brief?.id ?? "brick-punched-window-v1";
	const evidenceDigest = evidence?.manifestSha256 ?? evidence?.manifest_sha256 ?? evidence?.manifest?.contact_sheet?.sha256 ?? "unavailable";
	return [
		`Geometry-locked facade image for candidate ${candidateId}.`,
		`Approved brief: ${briefId}.`,
		`Evidence manifest SHA-256: ${evidenceDigest}. Treat the supplied contact sheet as binding authority for silhouette, massing, storey count, facade planes, opening rhythm, and camera framing.`,
		`Facade brief: ${stableJson(redactSecrets(brief ?? {}))}.`,
		`Requested output: ${stableJson(redactSecrets(output ?? {}))}.`,
		"Preserve the evidence geometry exactly. NO CURTAIN WALL. Do not invent projections, setbacks, floors, openings, or a different camera.",
	].join("\n");
}

export function buildRequest({ evidence, brief, output } = {}) {
	const evidenceBytes = bytesFromEvidence(evidence);
	return Object.freeze({
		provider: PROVIDER,
		model: MODEL,
		prompt: canonicalPrompt(evidence, brief, output),
		evidenceBytes,
		evidenceSha256: sha256(evidenceBytes),
		evidenceManifestSha256: evidence?.manifestSha256 ?? evidence?.manifest_sha256 ?? null,
		output: redactSecrets(output ?? {}),
	});
}

function validateRequest(request) {
	if (!request || request.model !== MODEL) throw preflightFailure("PROVIDER_MODEL_NOT_ALLOWED", `Only ${MODEL} is allowed`);
	if (typeof request.prompt !== "string" || !request.prompt) throw preflightFailure("PROVIDER_REQUEST_INVALID", "Provider prompt is required");
	if (!Buffer.isBuffer(request.evidenceBytes) && !(request.evidenceBytes instanceof Uint8Array)) {
		throw preflightFailure("PROVIDER_REQUEST_INVALID", "Evidence bytes are required");
	}
	if (request.evidenceBytes.byteLength > MAX_REQUEST_BYTES) {
		throw preflightFailure("PROVIDER_REQUEST_TOO_LARGE", "Evidence request exceeds the configured size limit");
	}
	const requestBytes = request.evidenceBytes.byteLength + Buffer.byteLength(request.prompt, "utf8") + 4_096;
	if (requestBytes > MAX_REQUEST_BYTES) throw preflightFailure("PROVIDER_REQUEST_TOO_LARGE", "Complete provider request exceeds the configured size limit");
	if (imageType(Buffer.from(request.evidenceBytes)) !== "image/png") throw preflightFailure("PROVIDER_EVIDENCE_INVALID", "Evidence contact sheet must be a PNG image");
	if (request.evidenceSha256 && sha256(request.evidenceBytes) !== request.evidenceSha256) {
		throw preflightFailure("PROVIDER_EVIDENCE_MISMATCH", "Evidence bytes changed after request construction");
	}
	return requestBytes;
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

function decodeImage(value, remoteId) {
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
	if (!mimeType) throw failure("PROVIDER_RESPONSE_INVALID", "Provider image has an unsupported signature", { remoteId });
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

function statusCode(status, payload) {
	const marker = `${payload?.error?.code ?? ""} ${payload?.error?.type ?? ""}`.toLowerCase();
	if (/moderation|safety|content[_ -]?policy/.test(marker)) return "PROVIDER_MODERATION_BLOCKED";
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

export function createProvider(env = {}, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	const apiKey = env.OPENAI_API_KEY;
	if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive finite number");

	return Object.freeze({
		preflight(config) {
			if (typeof apiKey !== "string" || !apiKey.trim()) throw preflightFailure("PROVIDER_CREDENTIALS_MISSING", "OPENAI_API_KEY is required");
			const requestBytes = validateRequest(config?.request ?? config);
			validateBudget(config);
			return { provider: PROVIDER, model: MODEL, requestBytes, ceilingUsd: config.ceilingUsd };
		},
		async generate({ request, signal } = {}) {
			try {
				if (typeof apiKey !== "string" || !apiKey.trim()) throw preflightFailure("PROVIDER_CREDENTIALS_MISSING", "OPENAI_API_KEY is required");
				validateRequest(request);
				const form = new FormData();
				form.set("model", MODEL);
				form.set("prompt", request.prompt);
				form.set("quality", "high");
				form.set("n", "1");
				form.set("image", new Blob([request.evidenceBytes], { type: "image/png" }), "evidence.png");
				const { response, payload, parseFailed, headerRemoteId } = await fetchWithDeadline(fetchImpl, ENDPOINT, {
					method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form,
				}, signal, timeoutMs, async (response) => {
					const headerRemoteId = response.headers.get("x-request-id");
					try { return { response, payload: await response.json(), parseFailed: false, headerRemoteId }; }
					catch { return { response, payload: {}, parseFailed: true, headerRemoteId }; }
				});
				const remoteId = headerRemoteId ?? payload?.id ?? null;
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
				const outputs = Array.isArray(payload?.data) ? payload.data : [];
				if (outputs.length === 0) throw failure("PROVIDER_IMAGE_MISSING", "Provider response did not contain an image", { status: response.status, remoteId });
				if (outputs.length !== 1) throw failure("PROVIDER_IMAGE_COUNT_INVALID", "Provider response must contain exactly one image", { status: response.status, remoteId });
				if (!outputs[0] || typeof outputs[0] !== "object" || !("b64_json" in outputs[0])) {
					throw failure("PROVIDER_IMAGE_MISSING", "Provider response did not contain inline image bytes", { status: response.status, remoteId });
				}
				const decoded = decodeImage(outputs[0].b64_json, remoteId);
				const stableRemoteId = remoteId ?? `openai-${sha256(decoded.bytes)}`;
				const usage = sanitized(payload?.usage ?? null, apiKey);
				return {
					...decoded,
					remoteId: stableRemoteId,
					usage,
					rawMeta: sanitized({ provider: PROVIDER, model: MODEL, created: payload?.created ?? null, remoteIdHash: sha256(stableRemoteId), usage }, apiKey),
				};
			} catch (error) {
				throw normalizeProviderFailure(error, PROVIDER, error?.stage === "preflight" ? "preflight" : "generate");
			}
		},
	});
}
