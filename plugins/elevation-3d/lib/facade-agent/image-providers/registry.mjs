import { createFacadeImageEditRequest } from "./contract.mjs";
import { buildFacadeArchitecturalPrompt, FACADE_PROHIBITED_CHANGES } from "./prompt.mjs";
import { createProvider as createAlibabaProvider } from "./providers/alibaba/adapter.mjs";
import { createProvider as createBytePlusProvider } from "./providers/byteplus/adapter.mjs";
import { buildRequest as buildGoogleRequest, createProvider as createGoogleProvider } from "./providers/google/adapter.mjs";
import { buildRequest as buildOpenAIRequest, createProvider as createOpenAIProvider } from "./providers/openai/adapter.mjs";
import { readVerifiedFacadeEvidenceAuthority } from "../evidence.mjs";

export const FACADE_IMAGE_PROVIDER_IDS = Object.freeze([
	"gpt-image-2",
	"seedream-5-pro",
	"qwen-image-2",
	"nano-banana-pro",
]);

const PROVIDER_ID_SET = new Set(FACADE_IMAGE_PROVIDER_IDS);
const DEFAULT_FACTORIES = Object.freeze({
	"gpt-image-2": createOpenAIProvider,
	"seedream-5-pro": createBytePlusProvider,
	"qwen-image-2": createAlibabaProvider,
	"nano-banana-pro": createGoogleProvider,
});

const MODELS = Object.freeze({
	"seedream-5-pro": "dola-seedream-5-0-pro-260628",
	"qwen-image-2": "qwen-image-2.0",
});

function invalidSet(message) {
	const error = new Error(message);
	error.code = "PROVIDER_SET_INVALID";
	return error;
}

function validateProviders(value) {
	if (!Array.isArray(value) || value.length === 0 || value.some((provider) => typeof provider !== "string" || !PROVIDER_ID_SET.has(provider)) || new Set(value).size !== value.length) {
		throw invalidSet("Facade image providers must be a unique non-empty allowlisted selection");
	}
	return [...value];
}

function commonRequestBuilder(provider, config) {
	return ({ evidence, brief }) => {
		const authority = readVerifiedFacadeEvidenceAuthority(evidence);
		if (!authority) {
			const error = new Error("Facade image evidence must have verified authority");
			error.code = "PROVIDER_EVIDENCE_UNVERIFIED";
			throw error;
		}
		const briefId = brief?.brief_id ?? brief?.briefId ?? brief?.id ?? config.briefId;
		const prompt = buildFacadeArchitecturalPrompt({ candidateId: authority.candidateId, briefId, evidenceManifestSha256: authority.manifestSha256 });
		return createFacadeImageEditRequest({
			provider,
			model: MODELS[provider],
			candidate: { id: authority.candidateId },
			brief: { id: briefId, revision: String(brief?.revision ?? "1") },
			evidence: { manifestSha256: authority.manifestSha256, pngBytes: authority.contactSheetBytes },
			prompt: { revision: prompt.revision, text: prompt.prompt, sha256: prompt.sha256 },
			output: { width: 1536, height: 1536, format: "png", count: 1 },
			prohibitedChanges: FACADE_PROHIBITED_CHANGES,
			estimateUsd: config.imageEstimateUsd[provider],
			ceilingUsd: config.imageBudgetUsd[provider],
		});
	};
}

function requestBuilder(provider, config) {
	if (provider === "gpt-image-2") return buildOpenAIRequest;
	if (provider === "nano-banana-pro") return buildGoogleRequest;
	return commonRequestBuilder(provider, config);
}

function scopedEnvironment(provider, env) {
	if (provider === "gpt-image-2") return { OPENAI_API_KEY: env.OPENAI_API_KEY };
	if (provider === "seedream-5-pro") return { ARK_API_KEY: env.ARK_API_KEY };
	if (provider === "qwen-image-2") return { DASHSCOPE_API_KEY: env.DASHSCOPE_API_KEY, DASHSCOPE_WORKSPACE_ID: env.DASHSCOPE_WORKSPACE_ID };
	return { GEMINI_API_KEY: env.GEMINI_API_KEY };
}

function scopedOptions(provider, options) {
	const result = { fetchImpl: options.fetchImpl };
	if (options.timeoutMs !== undefined) result.timeoutMs = options.timeoutMs;
	if (provider === "qwen-image-2") result.lookupImpl = options.lookupImpl;
	return result;
}

export function createFacadeImageProviderRegistry(config, options = {}) {
	const providers = validateProviders(config?.imageProviders ?? config?.providers);
	const env = options.env ?? process.env;
	const factories = options.providerFactories ?? DEFAULT_FACTORIES;
	if (!factories || typeof factories !== "object") throw new TypeError("providerFactories must be an allowlisted factory record");
	const registry = {};
	for (const provider of providers) {
		const factory = factories[provider];
		if (typeof factory !== "function") throw invalidSet(`Facade image provider factory is missing: ${provider}`);
		const adapter = factory(scopedEnvironment(provider, env), scopedOptions(provider, options));
		registry[provider] = Object.freeze({
			transport: adapter.transport ?? "live",
			preflight: adapter.preflight,
			generate: adapter.generate,
			buildRequest: requestBuilder(provider, config),
		});
	}
	return Object.freeze(registry);
}
