import { createProvider as createBytePlusProvider } from "../providers/grammar/byteplus/adapter.mjs";
import { createProvider as createOpenAIProvider } from "../providers/grammar/openai/adapter.mjs";

export const FACADE_GRAMMAR_PROVIDER_IDS = Object.freeze([
	"openai-gpt-5.6",
	"byteplus-seed-mini",
]);

const PROVIDER_ID_SET = new Set(FACADE_GRAMMAR_PROVIDER_IDS);
const DEFAULT_FACTORIES = Object.freeze({
	"openai-gpt-5.6": createOpenAIProvider,
	"byteplus-seed-mini": createBytePlusProvider,
});
const MODELS = Object.freeze({
	"openai-gpt-5.6": "gpt-5.6",
	"byteplus-seed-mini": "seed-2-0-mini-260428",
});

function invalidProvider(message) {
	const error = new Error(message);
	error.code = "GRAMMAR_PROVIDER_INVALID";
	return error;
}

function scopedEnvironment(id, env) {
	return id === "openai-gpt-5.6"
		? { OPENAI_API_KEY: env.OPENAI_API_KEY }
		: { ARK_API_KEY: env.ARK_API_KEY };
}

export function createFacadeGrammarProviderRegistry(config, options = {}) {
	const id = config?.grammarProvider;
	if (typeof id !== "string" || !PROVIDER_ID_SET.has(id)) {
		throw invalidProvider("Facade grammar provider must be allowlisted");
	}
	const factories = options.providerFactories ?? DEFAULT_FACTORIES;
	if (!factories || typeof factories !== "object") throw new TypeError("providerFactories must be an allowlisted factory record");
	const factory = factories[id];
	if (typeof factory !== "function") throw invalidProvider(`Facade grammar provider factory is missing: ${id}`);
	const env = options.env ?? process.env;
	const adapter = factory(scopedEnvironment(id, env), {
		fetchImpl: options.fetchImpl,
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
	});
	return Object.freeze({
		id,
		model: MODELS[id],
		transport: adapter.transport ?? "live",
		preflight: adapter.preflight,
		extract: adapter.extract,
	});
}
