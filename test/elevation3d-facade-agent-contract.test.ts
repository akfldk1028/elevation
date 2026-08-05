import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import {
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
	assert.deepEqual(value.providers, ["gpt-image-2", "nano-banana-pro"]);
	assert.throws(() => normalizeFacadeAgentConfig({ ...value, candidateId: "../escape" }), FacadeAgentContractError);
	assert.throws(() => normalizeFacadeAgentConfig({ ...value, maxLocalAttempts: 3 }), /two local attempts/i);
});

test("fingerprint is stable and excludes consent-free defaults", () => {
	const left = facadeRequestFingerprint({ provider: "gpt-image-2", evidenceSha256: "a".repeat(64), briefId: "brick-punched-window-v1", parameters: { quality: "high", size: "auto" } });
	const right = facadeRequestFingerprint({ parameters: { size: "auto", quality: "high" }, briefId: "brick-punched-window-v1", evidenceSha256: "a".repeat(64), provider: "gpt-image-2" });
	assert.equal(left, right);
});

test("rejects altered provider comparisons and invalid budget ceilings", () => {
	assert.throws(() => normalizeFacadeAgentConfig(approvedConfig({ providers: ["nano-banana-pro", "gpt-image-2"] })), FacadeAgentContractError);
	assert.throws(() => normalizeFacadeAgentConfig(approvedConfig({ providers: ["gpt-image-2"] })), FacadeAgentContractError);
	for (const value of [undefined, Number.NaN, Infinity, -1]) {
		assert.throws(() => normalizeFacadeAgentConfig(approvedConfig({ imageBudgetUsd: { "gpt-image-2": value, "nano-banana-pro": 1 } })), /finite nonnegative/i);
		assert.throws(() => normalizeFacadeAgentConfig(approvedConfig({ grammarBudgetUsd: value })), /finite nonnegative/i);
	}
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
