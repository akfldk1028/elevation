import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import {
	DEFAULT_GRAMMAR_PROVIDER,
	DEFAULT_IMAGE_PROVIDERS,
	FACADE_AGENT_PROVIDERS,
	FACADE_GRAMMAR_PROVIDER_IDS,
	FacadeAgentContractError,
	facadeRequestFingerprint,
	normalizeFacadeAgentConfig,
} from "../plugins/elevation-3d/lib/facade-agent/contract.mjs";

function approvedConfig(overrides = {}) {
	return {
		candidateId: "creative-020",
		datasetRoot: "D:/dataset",
		outputRoot: "D:/results",
		runId: "brick-ab-001",
		providers: ["gpt-image-2", "nano-banana-pro"],
		briefId: "brick-punched-window-v1",
		confirmLive: false,
		imageBudgetUsd: { "gpt-image-2": 1, "nano-banana-pro": 1 },
		grammarBudgetUsd: 1,
		grammarModel: "gpt-5.6",
		...overrides,
	};
}

test("normalizes schema-v2 router configuration and preserves legacy compatibility views", () => {
	assert.deepEqual(FACADE_GRAMMAR_PROVIDER_IDS, ["byteplus-seed-mini", "openai-gpt-5.6"]);
	assert.deepEqual(DEFAULT_IMAGE_PROVIDERS, ["seedream-5-pro"]);
	assert.equal(DEFAULT_GRAMMAR_PROVIDER, "byteplus-seed-mini");
	const canonical = normalizeFacadeAgentConfig({
		candidateId: "creative-020", datasetRoot: "D:/dataset", outputRoot: "D:/results",
		runId: "router-v2-001", briefId: "brick-punched-window-v1",
		imageProviders: ["seedream-5-pro"], grammarProvider: "byteplus-seed-mini",
		imageBudgetUsd: { "seedream-5-pro": 0.06 }, grammarBudgetUsd: 0.01,
		confirmLive: true, confirmedTotalUsd: 0.07,
	});
	assert.equal(canonical.schemaVersion, 2);
	assert.deepEqual(canonical.imageProviders, ["seedream-5-pro"]);
	assert.equal(canonical.grammarProvider, "byteplus-seed-mini");
	assert.deepEqual(canonical.providers, canonical.imageProviders);
	assert.equal(canonical.runBudgetUsd, 0.07);

	const legacy = normalizeFacadeAgentConfig({
		candidateId: "creative-020", datasetRoot: "D:/dataset", outputRoot: "D:/results",
		runId: "router-v1-001", briefId: "brick-punched-window-v1",
		providers: ["gpt-image-2"], grammarModel: "gpt-5.6",
		imageBudgetUsd: { "gpt-image-2": 0.5 }, grammarBudgetUsd: 0.35,
		confirmLive: false,
	});
	assert.deepEqual(legacy.imageProviders, ["gpt-image-2"]);
	assert.equal(legacy.grammarProvider, "openai-gpt-5.6");
});

test("rejects conflicting router representations, unknown grammar providers, and imprecise live confirmation", () => {
	assert.throws(() => normalizeFacadeAgentConfig(approvedConfig({
		imageProviders: ["seedream-5-pro"],
	})), (error: any) => error.code === "CONFIG_FIELD_CONFLICT");
	assert.throws(() => normalizeFacadeAgentConfig(approvedConfig({
		grammarProvider: "byteplus-seed-mini",
	})), (error: any) => error.code === "CONFIG_FIELD_CONFLICT");
	assert.throws(() => normalizeFacadeAgentConfig(approvedConfig({
		grammarProvider: "unknown-grammar-provider",
		grammarModel: undefined,
	})), (error: any) => error.code === "GRAMMAR_PROVIDER_INVALID");
	assert.throws(() => normalizeFacadeAgentConfig({
		candidateId: "creative-020", datasetRoot: "D:/dataset", outputRoot: "D:/results",
		runId: "router-v2-002", briefId: "brick-punched-window-v1",
		imageProviders: ["seedream-5-pro"], grammarProvider: "byteplus-seed-mini",
		imageBudgetUsd: { "seedream-5-pro": 0.06 }, grammarBudgetUsd: 0.01,
		confirmLive: true, confirmedTotalUsd: 0.070001,
	}), (error: any) => error.code === "LIVE_COST_CONFIRMATION_INVALID");
});

test("locks the first comparison and rejects unsafe expansion", () => {
	const value = normalizeFacadeAgentConfig({
		candidateId: "creative-020",
		datasetRoot: "D:/dataset",
		outputRoot: "D:/results",
		runId: "brick-ab-001",
		providers: ["gpt-image-2", "nano-banana-pro"],
		briefId: "brick-punched-window-v1",
		confirmLive: false,
		imageBudgetUsd: { "gpt-image-2": 1, "nano-banana-pro": 1 },
		grammarBudgetUsd: 1,
		grammarModel: "gpt-5.6",
	});
	assert.equal(value.maxLocalAttempts, 2);
	assert.equal(value.maxImageSubmissionsPerProvider, 1);
	assert.deepEqual(value.grammarBudgetAllocationUsd, { "gpt-image-2": 0.5, "nano-banana-pro": 0.5 });
	assert.equal(value.runBudgetUsd, 3);
	assert.deepEqual(value.providers, ["gpt-image-2", "nano-banana-pro"]);
	assert.throws(() => normalizeFacadeAgentConfig({ ...value, candidateId: "../escape" }), FacadeAgentContractError);
	assert.throws(() => normalizeFacadeAgentConfig({ ...value, maxLocalAttempts: 3 }), /two local attempts/i);
});

test("allocates 0.35 across three providers as exact deterministic micro-dollars", () => {
	const value = normalizeFacadeAgentConfig({
		candidateId: "creative-020", datasetRoot: "D:/dataset", outputRoot: "D:/results",
		runId: "exact-micros-001", briefId: "brick-punched-window-v1",
		imageProviders: ["gpt-image-2", "seedream-5-pro", "qwen-image-2"],
		grammarProvider: "openai-gpt-5.6",
		imageBudgetUsd: { "gpt-image-2": 0.5, "seedream-5-pro": 0.1, "qwen-image-2": 0.05 },
		grammarBudgetUsd: 0.35,
		confirmLive: true, confirmedTotalUsd: 1,
	});
	assert.deepEqual(value.imageBudgetMicros, { "gpt-image-2": 500_000, "seedream-5-pro": 100_000, "qwen-image-2": 50_000 });
	assert.deepEqual(value.grammarBudgetAllocationMicros, {
		"gpt-image-2": 116_667,
		"seedream-5-pro": 116_667,
		"qwen-image-2": 116_666,
	});
	assert.deepEqual(value.grammarEstimateAllocationMicros, value.grammarBudgetAllocationMicros);
	assert.equal(Object.values(value.grammarBudgetAllocationMicros).reduce((sum: number, amount: number) => sum + amount, 0), 350_000);
	assert.equal(value.grammarBudgetMicros, 350_000);
	assert.equal(value.runBudgetMicros, 1_000_000);
	assert.equal(value.confirmedTotalMicros, 1_000_000);
	assert.deepEqual(value.grammarBudgetAllocationUsd, {
		"gpt-image-2": 0.116667,
		"seedream-5-pro": 0.116667,
		"qwen-image-2": 0.116666,
	});
});

test("fingerprint is stable and excludes consent-free defaults", () => {
	const left = facadeRequestFingerprint({ provider: "gpt-image-2", evidenceSha256: "a".repeat(64), briefId: "brick-punched-window-v1", parameters: { quality: "high", size: "auto" } });
	const right = facadeRequestFingerprint({ parameters: { size: "auto", quality: "high" }, briefId: "brick-punched-window-v1", evidenceSha256: "a".repeat(64), provider: "gpt-image-2" });
	assert.equal(left, right);
});

test("rejects altered provider comparisons and invalid budget ceilings", () => {
	assert.deepEqual(normalizeFacadeAgentConfig(approvedConfig({ providers: ["nano-banana-pro", "gpt-image-2"] })).providers, ["nano-banana-pro", "gpt-image-2"]);
	assert.deepEqual(normalizeFacadeAgentConfig(approvedConfig({ providers: ["gpt-image-2"], imageBudgetUsd: { "gpt-image-2": 1 } })).providers, ["gpt-image-2"]);
	for (const providers of [[], ["gpt-image-2", "gpt-image-2"], ["unknown-provider"]]) {
		assert.throws(() => normalizeFacadeAgentConfig(approvedConfig({ providers })), (error: any) => error.code === "PROVIDER_SET_INVALID");
	}
	for (const value of [undefined, Number.NaN, Infinity, -1]) {
		assert.throws(() => normalizeFacadeAgentConfig(approvedConfig({ imageBudgetUsd: { "gpt-image-2": value, "nano-banana-pro": 1 } })), /finite nonnegative/i);
		assert.throws(() => normalizeFacadeAgentConfig(approvedConfig({ grammarBudgetUsd: value })), /finite nonnegative/i);
	}
	assert.throws(() => normalizeFacadeAgentConfig(approvedConfig({
		imageEstimateUsd: { "gpt-image-2": 1.01, "nano-banana-pro": 1 },
	})), /cannot exceed/i);
	assert.throws(() => normalizeFacadeAgentConfig(approvedConfig({
		imageEstimateUsd: { "gpt-image-2": Number.NaN, "nano-banana-pro": 1 },
	})), /finite nonnegative/i);
});

test("defaults to the approved three-provider evaluation and rejects missing or unselected positive budgets", () => {
	assert.deepEqual(FACADE_AGENT_PROVIDERS, ["gpt-image-2", "seedream-5-pro", "qwen-image-2"]);
	const value = normalizeFacadeAgentConfig(approvedConfig({
		providers: ["gpt-image-2", "seedream-5-pro", "qwen-image-2"],
		imageBudgetUsd: { "gpt-image-2": 0.5, "seedream-5-pro": 0.1, "qwen-image-2": 0.05 },
		grammarBudgetUsd: 0.35,
	}));
	assert.deepEqual(value.providers, ["gpt-image-2", "seedream-5-pro", "qwen-image-2"]);
	assert.equal(value.runBudgetUsd, 1);
	assert.throws(() => normalizeFacadeAgentConfig(approvedConfig({ providers: ["gpt-image-2", "seedream-5-pro"], imageBudgetUsd: { "gpt-image-2": 0.5 } })), (error: any) => error.code === "BUDGET_INVALID");
	assert.throws(() => normalizeFacadeAgentConfig(approvedConfig({ providers: ["gpt-image-2"], imageBudgetUsd: { "gpt-image-2": 0.5, "qwen-image-2": 0.05 } })), (error: any) => error.code === "BUDGET_INVALID");
});

test("normalizes filesystem roots, coercion, and secrets", () => {
	const value = normalizeFacadeAgentConfig(approvedConfig({
		datasetRoot: "relative-dataset",
		outputRoot: "relative-results",
		confirmLive: "yes",
		accessToken: "super-secret-token",
	}));
	assert.equal(value.datasetRoot, resolve("relative-dataset"));
	assert.equal(value.outputRoot, resolve("relative-results"));
	assert.equal(value.confirmLive, false);
	assert.equal(value.accessToken, "[REDACTED]");
});

test("rejects URI-like roots without exposing credentials", () => {
	for (const root of ["https://alice:secret@example.test/dataset", "file:///D:/dataset", "data:text/plain,secret"]) {
		assert.throws(() => normalizeFacadeAgentConfig(approvedConfig({ datasetRoot: root })), (error) => {
			assert.ok(error instanceof FacadeAgentContractError);
			assert.equal(error.code, "ROOT_INVALID");
			assert.doesNotMatch(error.message, /secret|alice|example/i);
			return true;
		});
	}
});

test("returns deeply immutable provider and budget controls", () => {
	const value = normalizeFacadeAgentConfig(approvedConfig());
	assert.ok(Object.isFrozen(value.providers));
	assert.ok(Object.isFrozen(value.imageBudgetUsd));
	assert.throws(() => { value.providers.pop(); }, TypeError);
	assert.throws(() => { value.imageBudgetUsd["gpt-image-2"] = 99; }, TypeError);
	assert.deepEqual(value.providers, ["gpt-image-2", "nano-banana-pro"]);
	assert.equal(value.imageBudgetUsd["gpt-image-2"], 1);
});
