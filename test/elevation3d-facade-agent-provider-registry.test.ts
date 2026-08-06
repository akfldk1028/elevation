import assert from "node:assert/strict";
import test from "node:test";

import {
	createFacadeImageProviderRegistry,
	FACADE_IMAGE_PROVIDER_IDS,
} from "../plugins/elevation-3d/lib/facade-agent/routers/image-provider-registry.mjs";

const ALL_ENV = Object.freeze({
	OPENAI_API_KEY: "openai-only",
	ARK_API_KEY: "byteplus-only",
	DASHSCOPE_API_KEY: "alibaba-only",
	DASHSCOPE_WORKSPACE_ID: "workspace-123",
	GEMINI_API_KEY: "google-only",
});

function config(providers: string[]) {
	return Object.freeze({
		imageProviders: Object.freeze([...providers]),
		imageBudgetUsd: Object.freeze(Object.fromEntries(providers.map((provider) => [provider, 1]))),
		imageEstimateUsd: Object.freeze(Object.fromEntries(providers.map((provider) => [provider, 0.1]))),
	});
}

test("constructs selected providers in order with isolated credentials", () => {
	const calls: any[] = [];
	const providerFactories = Object.fromEntries(FACADE_IMAGE_PROVIDER_IDS.map((provider) => [provider, (env: any, options: any) => {
		calls.push({ provider, env, options });
		return Object.freeze({ provider, preflight() {}, async generate() {} });
	}]));
	const fetchImpl = async () => new Response();
	const lookupImpl = async () => [{ address: "93.184.216.34", family: 4 }];
	const providers = ["qwen-image-2", "gpt-image-2", "seedream-5-pro"];
	const registry: any = createFacadeImageProviderRegistry(config(providers), { env: ALL_ENV, fetchImpl, lookupImpl, providerFactories });

	assert.deepEqual(Object.keys(registry), providers);
	assert.ok(Object.isFrozen(registry));
	assert.deepEqual(calls.map((call) => call.provider), providers);
	assert.deepEqual(Object.keys(calls[0].env).sort(), ["DASHSCOPE_API_KEY", "DASHSCOPE_WORKSPACE_ID"]);
	assert.deepEqual(Object.keys(calls[1].env), ["OPENAI_API_KEY"]);
	assert.deepEqual(Object.keys(calls[2].env), ["ARK_API_KEY"]);
	assert.equal(calls.every((call) => call.options.fetchImpl === fetchImpl), true);
	assert.equal(calls[0].options.lookupImpl, lookupImpl);
	assert.equal("lookupImpl" in calls[1].options, false);
	assert.equal("lookupImpl" in calls[2].options, false);
});

test("rejects unknown and duplicate providers before constructing any adapter", () => {
	let calls = 0;
	const providerFactories = Object.fromEntries(FACADE_IMAGE_PROVIDER_IDS.map((provider) => [provider, () => { calls += 1; return {}; }]));
	for (const providers of [["unknown"], ["gpt-image-2", "gpt-image-2"], []]) {
		assert.throws(() => createFacadeImageProviderRegistry(config(providers), { env: ALL_ENV, fetchImpl: async () => new Response(), lookupImpl: async () => [], providerFactories }), (error: any) => error.code === "PROVIDER_SET_INVALID");
	}
	assert.equal(calls, 0);
});

test("retains the legacy providers field as an image-router compatibility input", () => {
	const providerFactories = {
		"gpt-image-2": () => Object.freeze({ preflight() {}, async generate() {} }),
	};
	const registry = createFacadeImageProviderRegistry({
		providers: ["gpt-image-2"],
		imageBudgetUsd: { "gpt-image-2": 1 },
		imageEstimateUsd: { "gpt-image-2": 0.1 },
	}, { env: ALL_ENV, fetchImpl: async () => new Response(), providerFactories });

	assert.deepEqual(Object.keys(registry), ["gpt-image-2"]);
});

test("retains Nano Banana compatibility as an explicitly selected provider", () => {
	const registry: any = createFacadeImageProviderRegistry(config(["nano-banana-pro"]), {
		env: ALL_ENV,
		fetchImpl: async () => new Response(),
		lookupImpl: async () => [],
	});
	assert.deepEqual(Object.keys(registry), ["nano-banana-pro"]);
	assert.equal(typeof registry["nano-banana-pro"].preflight, "function");
	assert.equal(typeof registry["nano-banana-pro"].generate, "function");
	assert.equal(typeof registry["nano-banana-pro"].buildRequest, "function");
});

test("constructs Qwen without credentials so offline preflight can report missing capabilities", () => {
	const registry: any = createFacadeImageProviderRegistry(config(["qwen-image-2"]), {
		env: {},
		fetchImpl: async () => new Response(),
		lookupImpl: async () => [],
	});
	assert.throws(() => registry["qwen-image-2"].preflight({}), (error: any) => error.code === "PROVIDER_CREDENTIALS_MISSING");
});
