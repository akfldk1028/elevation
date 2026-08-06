import { createHash } from "node:crypto";

import {
	readVerifiedFacadeImageEditRequestAuthority,
	verifyFacadeImageEditResult,
} from "../../contract.mjs";
import { decodeBoundedBase64Png } from "../../image-codec.mjs";
import { FacadeImageBoundaryError } from "../../response-boundary.mjs";
import { fetchWithProviderDeadline } from "../../transport.mjs";
import { consumePaidOperationSubmissionCapability } from "../../../paid-operation-ledger.mjs";
import { FacadeProviderError, normalizeProviderFailure } from "../../../provider.mjs";
import { serializeBytePlusRequest } from "./request.mjs";
import { readBytePlusResponse, selectBytePlusImageResponse } from "./response.mjs";

export const BYTEPLUS_SEEDREAM_POLICY = Object.freeze({
	provider: "seedream-5-pro",
	model: "dola-seedream-5-0-pro-260628",
	endpoint: "https://ark.ap-southeast.bytepluses.com/api/v3/images/generations",
	width: 1536,
	height: 1536,
	estimateUsd: 0.045,
});

const DEFAULT_TIMEOUT_MS = 120_000;
const resultAuthorities = new WeakMap();

function failure(code, message, options = {}) {
	return new FacadeProviderError(code, message, {
		provider: BYTEPLUS_SEEDREAM_POLICY.provider,
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
	if (!authority) throw failure("PROVIDER_REQUEST_UNAUTHORIZED", "Seedream requires an authorized common request", { stage: "preflight", definitiveNonSubmission: true });
	if (authority.provider !== BYTEPLUS_SEEDREAM_POLICY.provider || authority.model !== BYTEPLUS_SEEDREAM_POLICY.model) {
		throw failure("PROVIDER_MODEL_NOT_ALLOWED", `Only ${BYTEPLUS_SEEDREAM_POLICY.model} is allowed`, { stage: "preflight", definitiveNonSubmission: true });
	}
	if (request.output.width !== BYTEPLUS_SEEDREAM_POLICY.width || request.output.height !== BYTEPLUS_SEEDREAM_POLICY.height
		|| request.output.format !== "png" || request.output.count !== 1) {
		throw failure("PROVIDER_OUTPUT_INVALID", "Seedream comparison output must be one 1536x1536 PNG", { stage: "preflight", definitiveNonSubmission: true });
	}
	return authority;
}

function validateBudget(fields, request) {
	if (!Number.isFinite(fields.estimateUsd) || fields.estimateUsd < 0 || !Number.isFinite(fields.ceilingUsd) || fields.ceilingUsd < 0) {
		throw failure("PROVIDER_BUDGET_INVALID", "Seedream estimate and ceiling must be finite nonnegative amounts", { stage: "preflight", definitiveNonSubmission: true });
	}
	if (fields.estimateUsd !== request.estimateUsd || fields.ceilingUsd !== request.ceilingUsd) {
		throw failure("PROVIDER_BUDGET_INVALID", "Seedream budget must match its authorized request", { stage: "preflight", definitiveNonSubmission: true });
	}
	if (fields.estimateUsd > fields.ceilingUsd) throw failure("PROVIDER_BUDGET_EXCEEDED", "Seedream estimate exceeds its ceiling", { stage: "preflight", definitiveNonSubmission: true });
}

function statusCode(status, payload) {
	const marker = `${payload?.error?.code ?? ""} ${payload?.error?.type ?? ""}`.toLowerCase();
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
	const env = record(envInput, "BytePlus environment");
	const options = record(optionsInput, "BytePlus options");
	const apiKey = env.ARK_API_KEY;
	const fetchImpl = options.fetchImpl;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required and must be a function");
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive finite number");

	return Object.freeze({
		transport: "live",
		preflight(input) {
			if (typeof apiKey !== "string" || !apiKey.trim()) throw failure("PROVIDER_CREDENTIALS_MISSING", "ARK_API_KEY is required", { stage: "preflight", definitiveNonSubmission: true });
			const fields = record(input, "Seedream preflight input");
			validatedRequest(fields.request);
			validateBudget(fields, fields.request);
			return {
				provider: BYTEPLUS_SEEDREAM_POLICY.provider,
				model: BYTEPLUS_SEEDREAM_POLICY.model,
				requestBytes: Buffer.from(fields.request.evidence.pngBase64, "base64").length,
				ceilingUsd: fields.ceilingUsd,
			};
		},
		async generate(input) {
			try {
				if (typeof apiKey !== "string" || !apiKey.trim()) throw failure("PROVIDER_CREDENTIALS_MISSING", "ARK_API_KEY is required", { stage: "preflight", definitiveNonSubmission: true });
				const fields = record(input, "Seedream generation input");
				const authority = validatedRequest(fields.request);
				if (!consumePaidOperationSubmissionCapability(fields.submission, {
					requestKey: authority.fingerprint,
					provider: BYTEPLUS_SEEDREAM_POLICY.provider,
					kind: "image-generation",
				})) throw failure("PROVIDER_SUBMISSION_UNAUTHORIZED", "Seedream requires a one-shot paid submission capability", { stage: "preflight", definitiveNonSubmission: true });
				const started = Date.now();
				const { response, payload } = await fetchWithProviderDeadline({
					fetchImpl,
					url: BYTEPLUS_SEEDREAM_POLICY.endpoint,
					init: {
						method: "POST",
						headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}` },
						body: JSON.stringify(serializeBytePlusRequest(fields.request)),
					},
					signal: fields.signal,
					timeoutMs,
					provider: BYTEPLUS_SEEDREAM_POLICY.provider,
					consume: async (response) => ({ response, payload: await readBytePlusResponse(response) }),
				});
				const selected = selectBytePlusImageResponse(payload, response.headers.get("x-request-id"));
				if (!response.ok) {
					const code = statusCode(response.status, payload);
					throw failure(code, code === "PROVIDER_MODERATION_BLOCKED" ? "Provider blocked the request by policy" : `Provider request failed with HTTP ${response.status}`, {
						status: response.status,
						retryable: response.status === 429 || response.status >= 500,
						definitiveNonSubmission: response.status < 500,
						remoteId: selected.remoteId,
					});
				}
				if (selected.imageCount === 0) throw failure("PROVIDER_IMAGE_MISSING", "Provider response did not contain an image", { remoteId: selected.remoteId });
				if (selected.imageCount !== 1) throw failure("PROVIDER_IMAGE_COUNT_INVALID", "Provider response must contain exactly one image", { remoteId: selected.remoteId });
				const image = await decodeBoundedBase64Png(selected.encodedImage);
				if (image.width !== fields.request.output.width || image.height !== fields.request.output.height) {
					throw failure("PROVIDER_OUTPUT_INVALID", "Provider image dimensions do not match the authorized output", { remoteId: selected.remoteId });
				}
				const stableRemoteId = selected.remoteId ?? `byteplus-${image.sha256}`;
				const commonResult = await verifyFacadeImageEditResult({
					provider: BYTEPLUS_SEEDREAM_POLICY.provider,
					resolvedModel: selected.resolvedModel ?? BYTEPLUS_SEEDREAM_POLICY.model,
					requestFingerprint: authority.fingerprint,
					bytes: image.bytes,
					remoteId: stableRemoteId,
					usage: selected.usage,
					actualUsd: BYTEPLUS_SEEDREAM_POLICY.estimateUsd,
					latencyMs: Date.now() - started,
					rawMeta: { provider: BYTEPLUS_SEEDREAM_POLICY.provider, model: selected.resolvedModel ?? BYTEPLUS_SEEDREAM_POLICY.model, created: selected.created, remoteIdHash: createHash("sha256").update(stableRemoteId).digest("hex") },
				});
				const result = { ...commonResult };
				Object.defineProperty(result, "remoteId", { value: stableRemoteId, enumerable: false, writable: false, configurable: false });
				Object.freeze(result);
				resultAuthorities.set(result, Object.freeze({
					provider: BYTEPLUS_SEEDREAM_POLICY.provider,
					candidateId: authority.candidateId,
					evidenceManifestSha256: authority.evidenceManifestSha256,
					proposalSha256: image.sha256,
				}));
				return result;
			} catch (error) {
				if (error instanceof FacadeImageBoundaryError) throw failure(error.code, error.message);
				throw normalizeProviderFailure(error, BYTEPLUS_SEEDREAM_POLICY.provider, error?.stage === "preflight" ? "preflight" : "generate");
			}
		},
	});
}
