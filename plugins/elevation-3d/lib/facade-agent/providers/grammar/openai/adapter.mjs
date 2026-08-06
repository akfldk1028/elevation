import { createHash } from "node:crypto";

import { FacadeProviderError } from "../../../provider.mjs";
import { normalizeFacadeGrammarResult, readVerifiedFacadeGrammarRequestAuthority } from "../contract.mjs";

const PROVIDER = "openai-gpt-5.6";
const MODEL = "gpt-5.6";
const ENDPOINT = "https://api.openai.com/v1/responses";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function failure(code, message, { definitiveNonSubmission = false, remoteId = null, status = null } = {}) {
	return new FacadeProviderError(code, message, {
		provider: "openai", stage: "grammar", definitiveNonSubmission, remoteId, status,
	});
}

function constructorRecord(value, label, allowedKeys) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("GRAMMAR_BOUNDARY_INVALID", `${label} must be a plain data object`, { definitiveNonSubmission: true });
	let prototype;
	let descriptors;
	try {
		prototype = Object.getPrototypeOf(value);
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch {
		throw failure("GRAMMAR_BOUNDARY_INVALID", `${label} could not be inspected safely`, { definitiveNonSubmission: true });
	}
	if (prototype !== Object.prototype && prototype !== null) throw failure("GRAMMAR_BOUNDARY_INVALID", `${label} must be a plain data object`, { definitiveNonSubmission: true });
	const result = Object.create(null);
	for (const key of Reflect.ownKeys(descriptors)) {
		const descriptor = descriptors[key];
		if (typeof key !== "string" || !allowedKeys.has(key) || descriptor.get || descriptor.set || !("value" in descriptor)) {
			throw failure("GRAMMAR_BOUNDARY_INVALID", `${label} contains an unauthorized field or accessor`, { definitiveNonSubmission: true });
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
		throw failure("GRAMMAR_BOUNDARY_INVALID", "signal must be an authentic AbortSignal", { definitiveNonSubmission: true });
	}
}

function throwIfAborted(signal, beforeSubmission = false) {
	if (signal?.aborted) throw failure("GRAMMAR_ABORTED", "Grammar extraction was aborted", { definitiveNonSubmission: beforeSubmission });
}

function requestBody(request) {
	return {
		model: MODEL,
		input: [{
			role: "user",
			content: [
				{ type: "input_text", text: request.prompt },
				{ type: "input_image", image_url: `data:${request.imageMimeType};base64,${request.imageBase64}`, detail: "high" },
			],
		}],
		text: { format: { type: "json_schema", name: "brick_punched_window_facade", strict: true, schema: request.schema } },
	};
}

async function readBoundedJson(response) {
	const declared = response?.headers?.get?.("content-length");
	if (declared !== null && declared !== undefined
		&& (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
		throw failure("GRAMMAR_RESPONSE_TOO_LARGE", "Grammar response exceeds the configured size limit");
	}
	const reader = response?.body?.getReader?.();
	if (!reader) throw failure("GRAMMAR_RESPONSE_INVALID", "Grammar response body is missing");
	const chunks = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!(value instanceof Uint8Array)) throw failure("GRAMMAR_RESPONSE_INVALID", "Grammar response body is invalid");
			size += value.byteLength;
			if (size > MAX_RESPONSE_BYTES) {
				await reader.cancel().catch(() => {});
				throw failure("GRAMMAR_RESPONSE_TOO_LARGE", "Grammar response exceeds the configured size limit");
			}
			chunks.push(Buffer.from(value));
		}
	} finally { reader.releaseLock(); }
	try { return JSON.parse(Buffer.concat(chunks, size).toString("utf8")); }
	catch { throw failure("GRAMMAR_RESPONSE_INVALID", "Grammar response is not valid JSON"); }
}

function outputText(payload) {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw failure("GRAMMAR_RESPONSE_INVALID", "Grammar response payload is invalid");
	if (payload.status !== undefined && payload.status !== "completed") throw failure("GRAMMAR_RESPONSE_INVALID", "Grammar response did not complete");
	if (!Array.isArray(payload.output) || payload.output.length !== 1) throw failure("GRAMMAR_RESPONSE_INVALID", "Grammar response must contain exactly one output message");
	const message = payload.output[0];
	if (!message || message.type !== "message" || message.role !== "assistant" || !Array.isArray(message.content) || message.content.length !== 1) {
		throw failure("GRAMMAR_RESPONSE_INVALID", "Grammar response message is ambiguous");
	}
	const content = message.content[0];
	if (!content || content.type !== "output_text" || typeof content.text !== "string" || !content.text.length) {
		throw failure("GRAMMAR_RESPONSE_INVALID", "Grammar response is missing structured output text");
	}
	return content.text;
}

async function fetchWithDeadline(fetchImpl, body, apiKey, signal, timeoutMs) {
	throwIfAborted(signal, true);
	const controller = new AbortController();
	let timedOut = false;
	const onAbort = () => controller.abort(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
	signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort(new DOMException("Grammar extraction timed out", "TimeoutError"));
	}, timeoutMs);
	let abortListener;
	const aborted = new Promise((_, reject) => {
		abortListener = () => reject(controller.signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
		controller.signal.addEventListener("abort", abortListener, { once: true });
	});
	try {
		const work = Promise.resolve(fetchImpl(ENDPOINT, {
			method: "POST",
			headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify(body),
			signal: controller.signal,
		})).then(async (response) => ({ response, payload: await readBoundedJson(response) }));
		return await Promise.race([work, aborted]);
	} catch (error) {
		if (error instanceof FacadeProviderError) throw error;
		if (timedOut) throw failure("GRAMMAR_TIMEOUT", "Grammar extraction timed out");
		if (signal?.aborted) throw failure("GRAMMAR_ABORTED", "Grammar extraction was aborted");
		throw failure("GRAMMAR_TRANSPORT_FAILED", "Grammar extraction transport failed");
	} finally {
		clearTimeout(timer);
		controller.signal.removeEventListener("abort", abortListener);
		signal?.removeEventListener("abort", onAbort);
	}
}

export function createProvider(env = {}, options = {}) {
	const envFields = constructorRecord(env, "OpenAI grammar environment", new Set(["OPENAI_API_KEY"]));
	const optionFields = constructorRecord(options, "OpenAI grammar options", new Set(["fetchImpl", "timeoutMs"]));
	const apiKey = envFields.OPENAI_API_KEY;
	const fetchImpl = optionFields.fetchImpl;
	const timeoutMs = optionFields.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	function preflight(input = {}) {
		const fields = constructorRecord(input, "OpenAI grammar preflight input", new Set(["request", "model", "ceilingUsd", "estimateUsd"]));
		const request = fields.request;
		if (request !== undefined) {
			const authority = readVerifiedFacadeGrammarRequestAuthority(request);
			if (!authority) throw failure("GRAMMAR_BOUNDARY_INVALID", "A verified common grammar request is required", { definitiveNonSubmission: true });
			if (authority.provider !== PROVIDER || authority.model !== MODEL) throw failure("GRAMMAR_MODEL_INVALID", `Grammar provider and model must be ${PROVIDER}/${MODEL}`, { definitiveNonSubmission: true });
		} else if (fields.model !== MODEL) throw failure("GRAMMAR_MODEL_INVALID", `Grammar model must be ${MODEL}`, { definitiveNonSubmission: true });
		if (typeof apiKey !== "string" || !apiKey.trim()) throw failure("GRAMMAR_CREDENTIALS_MISSING", "OPENAI_API_KEY is required", { definitiveNonSubmission: true });
		if (apiKey.length > 4_096 || /[\r\n\0]/.test(apiKey)) throw failure("GRAMMAR_CREDENTIALS_INVALID", "OpenAI credential is invalid", { definitiveNonSubmission: true });
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) throw failure("GRAMMAR_TIMEOUT_INVALID", "Grammar timeout must be a bounded positive value", { definitiveNonSubmission: true });
		const ceilingUsd = request?.ceilingUsd ?? fields.ceilingUsd;
		const estimateUsd = request?.estimateUsd ?? fields.estimateUsd;
		if (!Number.isFinite(ceilingUsd) || ceilingUsd < 0 || !Number.isFinite(estimateUsd) || estimateUsd < 0 || estimateUsd > ceilingUsd) {
			throw failure("GRAMMAR_BUDGET_INVALID", "Grammar budget and estimate are invalid", { definitiveNonSubmission: true });
		}
		return { provider: PROVIDER, model: MODEL, transport: "live", ceilingUsd, estimateUsd };
	}

	async function extract(input = {}) {
		const fields = constructorRecord(input, "OpenAI grammar extraction input", new Set(["request", "signal"]));
		const { request, signal } = fields;
		preflight({ request });
		authenticSignal(signal);
		throwIfAborted(signal, true);
		if (typeof fetchImpl !== "function") throw failure("GRAMMAR_BOUNDARY_INVALID", "fetchImpl is required", { definitiveNonSubmission: true });
		const { response, payload } = await fetchWithDeadline(fetchImpl, requestBody(request), apiKey, signal, timeoutMs);
		const headerRemoteId = response?.headers?.get?.("x-request-id") ?? null;
		const payloadRemoteId = typeof payload?.id === "string" ? payload.id : null;
		const remoteId = headerRemoteId ?? payloadRemoteId;
		if (!response || typeof response.ok !== "boolean" || !response.ok) {
			throw failure("GRAMMAR_REQUEST_REJECTED", "Grammar extraction request was rejected", {
				status: Number.isInteger(response?.status) ? response.status : null, remoteId,
			});
		}
		const grammarCandidate = outputText(payload);
		const fallbackId = `openai-${createHash("sha256").update(grammarCandidate).digest("hex")}`;
		const stableRemoteId = typeof remoteId === "string" && remoteId.length > 0 && remoteId.length <= 4_096 && !/[\r\n\0]/.test(remoteId) ? remoteId : fallbackId;
		const reportedCost = payload?.usage?.cost_usd;
		const actualUsd = reportedCost === undefined ? request.estimateUsd : reportedCost;
		return normalizeFacadeGrammarResult({
			request, provider: PROVIDER, resolvedModel: MODEL, transport: "live", grammarCandidate,
			remoteId: stableRemoteId, actualUsd, usage: payload?.usage ?? null,
		});
	}

	return Object.freeze({ transport: "live", preflight, extract });
}
