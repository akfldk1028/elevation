import assert from "node:assert/strict";
import { test } from "node:test";
import {
	FacadeAgentContractError,
	facadeRequestFingerprint,
	normalizeFacadeAgentConfig,
} from "../plugins/elevation-3d/lib/facade-agent/contract.mjs";

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
