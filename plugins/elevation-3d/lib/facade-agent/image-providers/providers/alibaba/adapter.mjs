import { createHash } from "node:crypto";

import { readVerifiedFacadeImageEditRequestAuthority, verifyFacadeImageEditResult } from "../../contract.mjs";
import { downloadVerifiedProviderImage } from "../../download.mjs";
import { FacadeImageBoundaryError } from "../../response-boundary.mjs";
import { fetchWithProviderDeadline } from "../../transport.mjs";
import { consumePaidOperationSubmissionCapability } from "../../../paid-operation-ledger.mjs";
import { FacadeProviderError, normalizeProviderFailure } from "../../../provider.mjs";
import { serializeAlibabaRequest } from "./request.mjs";
import { readAlibabaResponse, selectAlibabaImageResponse } from "./response.mjs";

export const ALIBABA_QWEN_POLICY = Object.freeze({
	provider: "qwen-image-2",
	model: "qwen-image-2.0",
	region: "ap-southeast-1",
	width: 1536,
	height: 1536,
	estimateUsd: 0.035,
	endpoint: (workspaceId) => `https://${workspaceId}.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`,
});

const DEFAULT_TIMEOUT_MS = 120_000;
const resultAuthorities = new WeakMap();

function failure(code, message, options = {}) {
	return new FacadeProviderError(code, message, {
		provider: ALIBABA_QWEN_POLICY.provider,
		stage: options.stage ?? "generate",
		status: options.status,
		retryable: options.retryable,
		definitiveNonSubmission: options.definitiveNonSubmission,
		remoteId: options.remoteId,
	});
}

function record(value, label) {
	try {
		if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error();
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (Reflect.ownKeys(descriptors).length > 4_096) throw new Error();
		const result = {};
		for (const key of Reflect.ownKeys(descriptors)) {
			const descriptor = descriptors[key];
			if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key) || descriptor.get || descriptor.set || !("value" in descriptor)) throw new Error();
			result[key] = descriptor.value;
		}
		return result;
	} catch {
		throw failure("PROVIDER_BOUNDARY_INVALID", `${label} must be a plain data record`, { stage: "preflight", definitiveNonSubmission: true });
	}
}

function validatedRequest(request) {
	const authority = readVerifiedFacadeImageEditRequestAuthority(request);
	if (!authority) throw failure("PROVIDER_REQUEST_UNAUTHORIZED", "Qwen requires an authorized common request", { stage: "preflight", definitiveNonSubmission: true });
	if (authority.provider !== ALIBABA_QWEN_POLICY.provider || authority.model !== ALIBABA_QWEN_POLICY.model) throw failure("PROVIDER_MODEL_NOT_ALLOWED", `Only ${ALIBABA_QWEN_POLICY.model} is allowed`, { stage: "preflight", definitiveNonSubmission: true });
	if (request.output.width !== 1536 || request.output.height !== 1536 || request.output.format !== "png" || request.output.count !== 1) throw failure("PROVIDER_OUTPUT_INVALID", "Qwen comparison output must be one 1536x1536 PNG", { stage: "preflight", definitiveNonSubmission: true });
	return authority;
}

function validateBudget(fields, request) {
	if (!Number.isFinite(fields.estimateUsd) || fields.estimateUsd < 0 || !Number.isFinite(fields.ceilingUsd) || fields.ceilingUsd < 0 || fields.estimateUsd !== request.estimateUsd || fields.ceilingUsd !== request.ceilingUsd) {
		throw failure("PROVIDER_BUDGET_INVALID", "Qwen budget must be finite and match its authorized request", { stage: "preflight", definitiveNonSubmission: true });
	}
	if (fields.estimateUsd > fields.ceilingUsd) throw failure("PROVIDER_BUDGET_EXCEEDED", "Qwen estimate exceeds its ceiling", { stage: "preflight", definitiveNonSubmission: true });
}

function validateWorkspace(workspaceId) {
	if (typeof workspaceId !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(workspaceId)) throw failure("PROVIDER_WORKSPACE_INVALID", "DASHSCOPE_WORKSPACE_ID is invalid", { stage: "preflight", definitiveNonSubmission: true });
	return workspaceId;
}

function statusCode(status, payload) {
	const marker = `${payload?.code ?? ""} ${payload?.error?.code ?? ""}`.toLowerCase();
	if (/moderation|safety|content[_ -]?policy/.test(marker)) return "PROVIDER_MODERATION_BLOCKED";
	if (status === 401 || status === 403) return "PROVIDER_AUTH_FAILED";
	if (status === 429) return "PROVIDER_RATE_LIMITED";
	if (status >= 500) return "PROVIDER_SERVER_ERROR";
	return "PROVIDER_REQUEST_REJECTED";
}

export function readVerifiedProposalResultAuthority(value) {
	const authority = value && typeof value === "object" ? resultAuthorities.get(value) : null;
	if (!authority || !Buffer.isBuffer(value.bytes) || createHash("sha256").update(value.bytes).digest("hex") !== authority.proposalSha256) return null;
	return { ...authority };
}

export function createProvider(envInput = {}, optionsInput = {}) {
	const env = record(envInput, "Alibaba environment");
	const options = record(optionsInput, "Alibaba options");
	const apiKey = env.DASHSCOPE_API_KEY;
	const workspaceId = env.DASHSCOPE_WORKSPACE_ID;
	const fetchImpl = options.fetchImpl;
	const lookupImpl = options.lookupImpl;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (typeof fetchImpl !== "function" || typeof lookupImpl !== "function") throw new TypeError("fetchImpl and lookupImpl are required functions");
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive finite number");

	return Object.freeze({
		transport: "live",
		preflight(input) {
			if (typeof apiKey !== "string" || !apiKey.trim()) throw failure("PROVIDER_CREDENTIALS_MISSING", "DASHSCOPE_API_KEY is required", { stage: "preflight", definitiveNonSubmission: true });
			validateWorkspace(workspaceId);
			const fields = record(input, "Qwen preflight input");
			validatedRequest(fields.request);
			validateBudget(fields, fields.request);
			return { provider: ALIBABA_QWEN_POLICY.provider, model: ALIBABA_QWEN_POLICY.model, requestBytes: Buffer.from(fields.request.evidence.pngBase64, "base64").length, ceilingUsd: fields.ceilingUsd };
		},
		async generate(input) {
			try {
				if (typeof apiKey !== "string" || !apiKey.trim()) throw failure("PROVIDER_CREDENTIALS_MISSING", "DASHSCOPE_API_KEY is required", { stage: "preflight", definitiveNonSubmission: true });
				const endpoint = ALIBABA_QWEN_POLICY.endpoint(validateWorkspace(workspaceId));
				const fields = record(input, "Qwen generation input");
				const authority = validatedRequest(fields.request);
				if (!consumePaidOperationSubmissionCapability(fields.submission, { requestKey: authority.fingerprint, provider: ALIBABA_QWEN_POLICY.provider, kind: "image-generation" })) throw failure("PROVIDER_SUBMISSION_UNAUTHORIZED", "Qwen requires a one-shot paid submission capability", { stage: "preflight", definitiveNonSubmission: true });
				const started = Date.now();
				const { response, payload } = await fetchWithProviderDeadline({
					fetchImpl,
					url: endpoint,
					init: { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(serializeAlibabaRequest(fields.request)) },
					signal: fields.signal,
					timeoutMs,
					provider: ALIBABA_QWEN_POLICY.provider,
					consume: async (response) => ({ response, payload: await readAlibabaResponse(response) }),
				});
				const selected = selectAlibabaImageResponse(payload, response.headers.get("x-request-id"));
				if (!response.ok) {
					const code = statusCode(response.status, payload);
					throw failure(code, code === "PROVIDER_MODERATION_BLOCKED" ? "Provider blocked the request by policy" : `Provider request failed with HTTP ${response.status}`, { status: response.status, retryable: response.status === 429 || response.status >= 500, definitiveNonSubmission: response.status < 500, remoteId: selected.remoteId });
				}
				if (selected.imageCount === 0) throw failure("PROVIDER_IMAGE_MISSING", "Provider response did not contain an image", { remoteId: selected.remoteId });
				if (selected.imageCount !== 1) throw failure("PROVIDER_IMAGE_COUNT_INVALID", "Provider response must contain exactly one image", { remoteId: selected.remoteId });
				const image = await downloadVerifiedProviderImage({ url: selected.imageUrl, fetchImpl, lookupImpl, signal: fields.signal, timeoutMs, maxBytes: 32 * 1024 * 1024, maxRedirects: 3 });
				if (image.width !== fields.request.output.width || image.height !== fields.request.output.height) throw failure("PROVIDER_OUTPUT_INVALID", "Provider image dimensions do not match the authorized output", { remoteId: selected.remoteId });
				const stableRemoteId = selected.remoteId ?? `alibaba-${image.sha256}`;
				const commonResult = await verifyFacadeImageEditResult({
					provider: ALIBABA_QWEN_POLICY.provider,
					resolvedModel: ALIBABA_QWEN_POLICY.model,
					requestFingerprint: authority.fingerprint,
					bytes: image.bytes,
					remoteId: stableRemoteId,
					usage: selected.usage,
					actualUsd: ALIBABA_QWEN_POLICY.estimateUsd,
					latencyMs: Date.now() - started,
					rawMeta: { provider: ALIBABA_QWEN_POLICY.provider, model: ALIBABA_QWEN_POLICY.model, remoteIdHash: createHash("sha256").update(stableRemoteId).digest("hex") },
				});
				const result = { ...commonResult };
				Object.defineProperty(result, "remoteId", { value: stableRemoteId, enumerable: false, writable: false, configurable: false });
				Object.freeze(result);
				resultAuthorities.set(result, Object.freeze({ provider: ALIBABA_QWEN_POLICY.provider, candidateId: authority.candidateId, evidenceManifestSha256: authority.evidenceManifestSha256, proposalSha256: image.sha256 }));
				return result;
			} catch (error) {
				if (error instanceof FacadeImageBoundaryError) throw failure(error.code, error.message);
				throw normalizeProviderFailure(error, ALIBABA_QWEN_POLICY.provider, error?.stage === "preflight" ? "preflight" : "generate");
			}
		},
	});
}
