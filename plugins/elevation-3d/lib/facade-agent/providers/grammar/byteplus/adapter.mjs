import { consumePaidOperationSubmissionCapability } from "../../../paid-operation-ledger.mjs";
import { FacadeProviderError } from "../../../provider.mjs";
import { normalizeFacadeGrammarResult, readVerifiedFacadeGrammarRequestAuthority } from "../contract.mjs";
import { serializeBytePlusGrammarRequest } from "./request.mjs";
import {
	BytePlusGrammarResponseError,
	decodeBytePlusGrammarResponse,
	parseBytePlusJson,
	selectBytePlusGrammarRemoteId,
} from "./response.mjs";

const PROVIDER = "byteplus-seed-mini";
const MODEL = "seed-2-0-mini-260428";
const ENDPOINT = "https://ark.ap-southeast.bytepluses.com/api/v3/responses";
const MAX_COST_USD = 0.01;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;

function failure(code, message, { definitiveNonSubmission = false, remoteId = null, status = null } = {}) {
	return new FacadeProviderError(code, message, {
		provider: PROVIDER,
		stage: "grammar",
		definitiveNonSubmission,
		remoteId,
		status,
		retryable: code === "RATE_LIMITED" || code === "PROVIDER_UNAVAILABLE",
	});
}

function record(value, label, allowedKeys) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("INVALID_PROVIDER_RESPONSE", `${label} must be a plain data object`, { definitiveNonSubmission: true });
	let prototype;
	let descriptors;
	try {
		prototype = Object.getPrototypeOf(value);
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch {
		throw failure("INVALID_PROVIDER_RESPONSE", `${label} could not be inspected safely`, { definitiveNonSubmission: true });
	}
	if (prototype !== Object.prototype && prototype !== null) throw failure("INVALID_PROVIDER_RESPONSE", `${label} must be a plain data object`, { definitiveNonSubmission: true });
	const result = Object.create(null);
	for (const key of Reflect.ownKeys(descriptors)) {
		const descriptor = descriptors[key];
		if (typeof key !== "string" || !allowedKeys.has(key) || descriptor.get || descriptor.set || !Object.hasOwn(descriptor, "value")) {
			throw failure("INVALID_PROVIDER_RESPONSE", `${label} contains an unauthorized field or accessor`, { definitiveNonSubmission: true });
		}
		result[key] = descriptor.value;
	}
	return result;
}

function authenticSignal(signal) {
	if (signal === undefined) return;
	try {
		if (Object.getPrototypeOf(signal) !== AbortSignal.prototype) throw new Error();
		Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get.call(signal);
	} catch {
		throw failure("INVALID_PROVIDER_RESPONSE", "Grammar signal must be an authentic AbortSignal", { definitiveNonSubmission: true });
	}
}

function safeRemoteId(response, payload = null) {
	return selectBytePlusGrammarRemoteId(payload, response?.headers?.get?.("x-request-id") ?? null);
}

async function readBoundedText(response) {
	if (!(response instanceof Response)) throw failure("INVALID_PROVIDER_RESPONSE", "BytePlus returned an invalid HTTP response");
	const declared = response.headers.get("content-length");
	if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
		throw failure("RESPONSE_TOO_LARGE", "BytePlus grammar response exceeds the size limit");
	}
	const reader = response.body?.getReader();
	if (!reader) throw failure("INVALID_PROVIDER_RESPONSE", "BytePlus grammar response body is missing");
	const chunks = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!(value instanceof Uint8Array)) throw failure("INVALID_PROVIDER_RESPONSE", "BytePlus grammar response body is invalid");
			total += value.byteLength;
			if (total > MAX_RESPONSE_BYTES) {
				await reader.cancel().catch(() => {});
				throw failure("RESPONSE_TOO_LARGE", "BytePlus grammar response exceeds the size limit");
			}
			chunks.push(Buffer.from(value));
		}
	} finally { reader.releaseLock(); }
	return Buffer.concat(chunks, total).toString("utf8");
}

function statusCode(status, payload) {
	const marker = `${payload?.error?.code ?? ""} ${payload?.error?.type ?? ""}`.toLowerCase();
	if (/moderation|safety|content[_ -]?policy/.test(marker)) return "CONTENT_REJECTED";
	if (status === 401 || status === 403) return "AUTHENTICATION_FAILED";
	if (status === 429) return "RATE_LIMITED";
	if (status >= 500) return "PROVIDER_UNAVAILABLE";
	return "INVALID_PROVIDER_RESPONSE";
}

export function createProvider(env = {}, options = {}) {
	const envFields = record(env, "BytePlus grammar environment", new Set(["ARK_API_KEY"]));
	const optionFields = record(options, "BytePlus grammar options", new Set(["fetchImpl", "timeoutMs"]));
	const apiKey = envFields.ARK_API_KEY;
	const fetchImpl = optionFields.fetchImpl;
	const timeoutMs = optionFields.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	function preflight(input = {}) {
		const fields = record(input, "BytePlus grammar preflight input", new Set(["request", "model", "ceilingUsd", "estimateUsd"]));
		const commonRequest = fields.request;
		if (commonRequest !== undefined) {
			const authority = readVerifiedFacadeGrammarRequestAuthority(commonRequest);
			if (!authority || authority.provider !== PROVIDER || authority.model !== MODEL) {
				throw failure("INVALID_PROVIDER_RESPONSE", `Grammar provider and model must be ${PROVIDER}/${MODEL}`, { definitiveNonSubmission: true });
			}
		} else if (fields.model !== MODEL) {
			throw failure("INVALID_PROVIDER_RESPONSE", `Grammar model must be ${MODEL}`, { definitiveNonSubmission: true });
		}
		if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 4_096 || /[\r\n\0]/.test(apiKey)) {
			throw failure("AUTHENTICATION_FAILED", "ARK_API_KEY is missing or invalid", { definitiveNonSubmission: true });
		}
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
			throw failure("REQUEST_TIMEOUT", "BytePlus grammar timeout is invalid", { definitiveNonSubmission: true });
		}
		const ceilingUsd = commonRequest?.ceilingUsd ?? fields.ceilingUsd;
		const estimateUsd = commonRequest?.estimateUsd ?? fields.estimateUsd;
		if (!Number.isFinite(ceilingUsd) || ceilingUsd < 0 || ceilingUsd > MAX_COST_USD
			|| !Number.isFinite(estimateUsd) || estimateUsd < 0 || estimateUsd > ceilingUsd) {
			throw failure("INVALID_PROVIDER_RESPONSE", "BytePlus grammar budget is invalid", { definitiveNonSubmission: true });
		}
		return { provider: PROVIDER, model: MODEL, transport: "live", ceilingUsd, estimateUsd };
	}

	async function extract(input = {}) {
		const fields = record(input, "BytePlus grammar extraction input", new Set(["request", "submission", "signal"]));
		const { request, submission, signal } = fields;
		preflight({ request });
		authenticSignal(signal);
		if (signal?.aborted) throw failure("REQUEST_TIMEOUT", "BytePlus grammar request was aborted before submission", { definitiveNonSubmission: true });
		if (typeof fetchImpl !== "function") throw failure("INVALID_PROVIDER_RESPONSE", "fetchImpl is required", { definitiveNonSubmission: true });
		if (!consumePaidOperationSubmissionCapability(submission, {
			requestKey: request.fingerprint,
			provider: PROVIDER,
			kind: "grammar-extraction",
		})) throw failure("SUBMISSION_UNCERTAIN", "BytePlus grammar submission capability is unavailable");

		const controller = new AbortController();
		let timedOut = false;
		const onAbort = () => controller.abort(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
		signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort(new DOMException("BytePlus grammar extraction timed out", "TimeoutError"));
		}, timeoutMs);
		let abortListener;
		const aborted = new Promise((_, reject) => {
			abortListener = () => reject(controller.signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
			controller.signal.addEventListener("abort", abortListener, { once: true });
		});
		try {
			const work = Promise.resolve().then(async () => {
				const response = await fetchImpl(ENDPOINT, {
					method: "POST",
					headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}` },
					body: JSON.stringify(serializeBytePlusGrammarRequest(request)),
					signal: controller.signal,
				});
				const text = await readBoundedText(response);
				let payload;
				try { payload = parseBytePlusJson(text); }
				catch (error) {
					if (response.ok) throw error;
					payload = null;
				}
				const remoteId = safeRemoteId(response, payload);
				if (!response.ok) {
					throw failure(statusCode(response.status, payload), "BytePlus grammar request failed", {
						status: response.status,
						remoteId,
					});
				}
				const decoded = decodeBytePlusGrammarResponse(payload, { headerRemoteId: response.headers.get("x-request-id") });
				const actualUsd = decoded.actualUsd ?? request.estimateUsd;
				if (!Number.isFinite(actualUsd) || actualUsd < 0 || actualUsd > MAX_COST_USD || actualUsd > request.ceilingUsd) {
					throw failure("INVALID_PROVIDER_RESPONSE", "BytePlus reported invalid grammar cost", { remoteId: decoded.remoteId });
				}
				try {
					return normalizeFacadeGrammarResult({
						request,
						provider: PROVIDER,
						resolvedModel: MODEL,
						transport: "live",
						grammarCandidate: decoded.grammarCandidate,
						remoteId: decoded.remoteId,
						actualUsd,
						usage: decoded.usage,
					});
				} catch (error) {
					if (error instanceof FacadeProviderError) throw failure("INVALID_PROVIDER_RESPONSE", "BytePlus result failed the common grammar boundary", { remoteId: decoded.remoteId });
					throw error;
				}
			});
			return await Promise.race([work, aborted]);
		} catch (error) {
			if (error instanceof FacadeProviderError) throw error;
			if (error instanceof BytePlusGrammarResponseError) {
				throw failure(error.code, error.message, { remoteId: error.remoteId });
			}
			if (timedOut) throw failure("REQUEST_TIMEOUT", "BytePlus grammar extraction timed out");
			if (signal?.aborted) throw failure("SUBMISSION_UNCERTAIN", "BytePlus grammar submission outcome is uncertain after caller abort");
			throw failure("SUBMISSION_UNCERTAIN", "BytePlus grammar submission outcome is uncertain");
		} finally {
			clearTimeout(timer);
			controller.signal.removeEventListener("abort", abortListener);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	return Object.freeze({ transport: "live", preflight, extract });
}
