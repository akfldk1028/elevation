import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProductionFacadeAgentDependencies } from "../plugins/elevation-3d/lib/facade-agent/production-dependencies.mjs";
import { createFacadeImageProviderRegistry } from "../plugins/elevation-3d/lib/facade-agent/routers/image-provider-registry.mjs";
import { createFacadeGrammarProviderRegistry } from "../plugins/elevation-3d/lib/facade-agent/routers/grammar-provider-registry.mjs";

const ALL_ENV = Object.freeze({
	OPENAI_API_KEY: "openai-only",
	ARK_API_KEY: "byteplus-only",
	DASHSCOPE_API_KEY: "alibaba-only",
	DASHSCOPE_WORKSPACE_ID: "workspace-123",
	GEMINI_API_KEY: "google-only",
});

const fetchImpl = async () => new Response();

test("constructs only the selected BytePlus grammar adapter with scoped credentials", () => {
	const calls: any[] = [];
	const providerFactories = {
		"openai-gpt-5.5": () => { throw new Error("unselected OpenAI grammar factory was constructed"); },
		"byteplus-seed-mini": (env: any) => {
			calls.push({ provider: "byteplus-seed-mini", env });
			return Object.freeze({ transport: "live", preflight() {}, async extract() {} });
		},
	};
	const grammar: any = createFacadeGrammarProviderRegistry(
		{ grammarProvider: "byteplus-seed-mini" },
		{ env: ALL_ENV, fetchImpl, providerFactories },
	);

	assert.equal(grammar.id, "byteplus-seed-mini");
	assert.deepEqual(calls, [{
		provider: "byteplus-seed-mini",
		env: { ARK_API_KEY: "byteplus-only" },
	}]);
	assert.equal(typeof grammar.preflight, "function");
	assert.equal(typeof grammar.extract, "function");
});

test("image and grammar selection construct independent factories with independent credentials", () => {
	const calls: any[] = [];
	const imageProviderFactories = {
		"seedream-5-pro": (env: any) => {
			calls.push({ kind: "image", provider: "seedream-5-pro", env });
			return Object.freeze({ preflight() {}, async generate() {} });
		},
	};
	const grammarProviderFactories = {
		"openai-gpt-5.5": (env: any) => {
			calls.push({ kind: "grammar", provider: "openai-gpt-5.5", env });
			return Object.freeze({ preflight() {}, async extract() {} });
		},
	};
	const config = {
		imageProviders: ["seedream-5-pro"], grammarProvider: "openai-gpt-5.5",
		imageBudgetUsd: { "seedream-5-pro": 1 }, imageEstimateUsd: { "seedream-5-pro": 0.1 },
	};

	createFacadeImageProviderRegistry(config, { env: ALL_ENV, fetchImpl, providerFactories: imageProviderFactories });
	createFacadeGrammarProviderRegistry(config, { env: ALL_ENV, fetchImpl, providerFactories: grammarProviderFactories });

	assert.deepEqual(calls, [
		{ kind: "image", provider: "seedream-5-pro", env: { ARK_API_KEY: "byteplus-only" } },
		{ kind: "grammar", provider: "openai-gpt-5.5", env: { OPENAI_API_KEY: "openai-only" } },
	]);
});

test("grammar router rejects unknown selection before reading credentials or constructing adapters", () => {
	let credentialReads = 0;
	let factoryCalls = 0;
	const env = Object.defineProperties({}, {
		OPENAI_API_KEY: { enumerable: true, get() { credentialReads += 1; throw new Error("credential trap"); } },
		ARK_API_KEY: { enumerable: true, get() { credentialReads += 1; throw new Error("credential trap"); } },
	});
	const providerFactories = new Proxy({}, {
		get() { factoryCalls += 1; return () => ({}); },
	});

	assert.throws(
		() => createFacadeGrammarProviderRegistry({ grammarProvider: "unknown" }, { env, fetchImpl, providerFactories }),
		(error: any) => error.code === "GRAMMAR_PROVIDER_INVALID",
	);
	assert.equal(credentialReads, 0);
	assert.equal(factoryCalls, 0);
});

test("each grammar selection reads only its own credential", () => {
	for (const selected of ["openai-gpt-5.5", "byteplus-seed-mini"] as const) {
		const selectedKey = selected === "openai-gpt-5.5" ? "OPENAI_API_KEY" : "ARK_API_KEY";
		const otherKey = selected === "openai-gpt-5.5" ? "ARK_API_KEY" : "OPENAI_API_KEY";
		let otherReads = 0;
		const env = Object.defineProperties({}, {
			[selectedKey]: { enumerable: true, value: "selected-only" },
			[otherKey]: { enumerable: true, get() { otherReads += 1; throw new Error("unselected credential was read"); } },
		});
		const providerFactories = {
			[selected]: (scopedEnv: any) => {
				assert.deepEqual(scopedEnv, { [selectedKey]: "selected-only" });
				return Object.freeze({ preflight() {}, async extract() {} });
			},
		};

		createFacadeGrammarProviderRegistry({ grammarProvider: selected }, { env, fetchImpl, providerFactories });
		assert.equal(otherReads, 0);
	}
});

test("production dependencies expose only the selected image map and grammar adapter", async () => {
	const root = await mkdtemp(join(tmpdir(), "facade-router-production-"));
	try {
		const calls: any[] = [];
		const dependencies: any = await createProductionFacadeAgentDependencies({
			outputRoot: root, candidateId: "creative-020", runId: "router-production",
			imageProviders: ["seedream-5-pro"], grammarProvider: "openai-gpt-5.5",
			imageBudgetUsd: { "seedream-5-pro": 1 }, imageEstimateUsd: { "seedream-5-pro": 0.1 },
		}, {
			env: ALL_ENV, fetchImpl,
			imageProviderFactories: {
				"seedream-5-pro": (env: any) => {
					calls.push({ kind: "image", env });
					return Object.freeze({ preflight() {}, async generate() {} });
				},
			},
			grammarProviderFactories: {
				"openai-gpt-5.5": (env: any) => {
					calls.push({ kind: "grammar", env });
					return Object.freeze({ preflight() {}, async extract() {} });
				},
			},
		});

		assert.deepEqual(Object.keys(dependencies.providers), ["seedream-5-pro"]);
		assert.equal(dependencies.grammarProvider.id, "openai-gpt-5.5");
		assert.deepEqual(calls, [
			{ kind: "image", env: { ARK_API_KEY: "byteplus-only" } },
			{ kind: "grammar", env: { OPENAI_API_KEY: "openai-only" } },
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("selected BytePlus production dependencies neither expose an OpenAI closure nor read OPENAI_API_KEY", async () => {
	const root = await mkdtemp(join(tmpdir(), "facade-router-byteplus-isolation-"));
	try {
		let openAIReads = 0;
		const env = Object.defineProperties({}, {
			ARK_API_KEY: { enumerable: true, value: "byteplus-only" },
			OPENAI_API_KEY: { enumerable: true, get() { openAIReads += 1; throw new Error("unselected OpenAI credential read"); } },
		});
		const dependencies: any = await createProductionFacadeAgentDependencies({
			outputRoot: root, candidateId: "creative-020", runId: "byteplus-production-isolation",
			imageProviders: ["seedream-5-pro"], grammarProvider: "byteplus-seed-mini",
			imageBudgetUsd: { "seedream-5-pro": 0.06 }, imageEstimateUsd: { "seedream-5-pro": 0.06 },
		}, {
			env, fetchImpl,
			imageProviderFactories: { "seedream-5-pro": () => Object.freeze({ preflight() {}, async generate() {} }) },
			grammarProviderFactories: { "byteplus-seed-mini": () => Object.freeze({ preflight() {}, async extract() {} }) },
		});
		assert.equal(openAIReads, 0);
		assert.equal(Object.hasOwn(dependencies, "extractGrammar"), false);
		assert.equal(dependencies.grammarProvider.id, "byteplus-seed-mini");
	} finally { await rm(root, { recursive: true, force: true }); }
});
