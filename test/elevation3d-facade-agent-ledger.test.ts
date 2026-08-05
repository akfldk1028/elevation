import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { FacadeProviderError, normalizeProviderFailure } from "../plugins/elevation-3d/lib/facade-agent/provider.mjs";
import { createPaidOperationLedger } from "../plugins/elevation-3d/lib/facade-agent/paid-operation-ledger.mjs";

async function withLedger(run: (root: string, path: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "facade-paid-ledger-"));
	try { await run(root, join(root, "paid-operations.json")); }
	finally { await rm(root, { recursive: true, force: true }); }
}

const requestKey = "a".repeat(64);
const artifactSha256 = "b".repeat(64);

test("persists one paid result and reuses it without another submission", async () => {
	await withLedger(async (_root, path) => {
		let calls = 0;
		const ledger = createPaidOperationLedger(path);
		const first = await ledger.executeOnce({
			requestKey, provider: "gpt-image-2", kind: "image-generation",
			ceilingUsd: 1, estimateUsd: 0.2,
			operation: async () => { calls += 1; return { remoteId: "secret-id", artifactSha256, actualUsd: 0.18 }; },
		});
		const second = await ledger.executeOnce({
			requestKey, provider: "gpt-image-2", kind: "image-generation",
			ceilingUsd: 1, estimateUsd: 0.2,
			operation: async () => { calls += 1; throw new Error("must not run"); },
		});
		assert.equal(calls, 1);
		assert.equal(first.artifactSha256, second.artifactSha256);
		assert.equal(Object.hasOwn(first, "remoteId"), false);
		assert.equal(first.remoteIdHash, second.remoteIdHash);
		assert.equal(first.remoteIdHash.length, 64);
		const summary = await ledger.summary();
		assert.equal(summary.operations[0].remoteIdHash.length, 64);
		assert.equal(Object.hasOwn(summary.operations[0], "remoteId"), false);
		assert.equal((await readFile(path, "utf8")).includes("secret-id"), true);
	});
});

test("a returned remote ID overrides a contradictory non-submission marker", async () => {
	await withLedger(async (_root, path) => {
		const ledger = createPaidOperationLedger(path);
		let calls = 0;
		await assert.rejects(() => ledger.executeOnce({
			requestKey, provider: "gpt-image-2", kind: "image-generation",
			ceilingUsd: 1, estimateUsd: 0.2,
			operation: async () => {
				calls += 1;
				throw new FacadeProviderError("PROVIDER_RESPONSE_INVALID", "bad response", {
					provider: "gpt-image-2", stage: "generate", remoteId: "already-submitted-id",
					definitiveNonSubmission: true,
				});
			},
		}), (error: any) => {
			assert.equal(error.code, "PROVIDER_RESPONSE_INVALID");
			assert.equal(error.remoteId, null);
			return true;
		});
		await assert.rejects(() => ledger.executeOnce({
			requestKey, provider: "gpt-image-2", kind: "image-generation",
			ceilingUsd: 1, estimateUsd: 0.2,
			operation: async () => { calls += 1; return { remoteId: "duplicate", artifactSha256, actualUsd: 0.2 }; },
		}), (error: any) => error.code === "PAID_OPERATION_SUBMISSION_UNCERTAIN");
		assert.equal(calls, 1);
		assert.equal((await ledger.summary()).operations[0].remoteIdHash?.length, 64);
	});
});

test("refuses a crash-left submitting operation without invoking it", async () => {
	await withLedger(async (_root, path) => {
		await writeFile(path, `${JSON.stringify({ version: 1, operations: {
			[requestKey]: {
				provider: "gpt-image-2", kind: "image-generation", status: "submitting",
				estimateUsd: 0.2, ceilingUsd: 1, remoteId: null, artifactSha256: null, actualUsd: null,
			},
		} }, null, 2)}\n`);
		let calls = 0;
		const ledger = createPaidOperationLedger(path);
		await assert.rejects(() => ledger.executeOnce({
			requestKey, provider: "gpt-image-2", kind: "image-generation",
			ceilingUsd: 1, estimateUsd: 0.2,
			operation: async () => { calls += 1; return { remoteId: "duplicate", artifactSha256, actualUsd: 0.2 }; },
		}), (error: any) => error.code === "PAID_OPERATION_SUBMISSION_UNCERTAIN");
		assert.equal(calls, 0);
	});
});

test("serializes parallel ledger instances so only one callback runs", async () => {
	await withLedger(async (_root, path) => {
		let calls = 0;
		const input = {
			requestKey, provider: "gpt-image-2", kind: "image-generation",
			ceilingUsd: 1, estimateUsd: 0.2,
			operation: async () => {
				calls += 1;
				await delay(75);
				return { remoteId: "parallel-secret-id", artifactSha256, actualUsd: 0.18 };
			},
		};
		const [left, right] = await Promise.all([
			createPaidOperationLedger(path).executeOnce(input),
			createPaidOperationLedger(path).executeOnce(input),
		]);
		assert.equal(calls, 1);
		assert.deepEqual(left, right);
	});
});

test("rejects over-ceiling work before touching a reservation or callback", async () => {
	await withLedger(async (_root, path) => {
		await writeFile(`${path}.lock`, "not-json");
		let calls = 0;
		await assert.rejects(() => createPaidOperationLedger(path).executeOnce({
			requestKey, provider: "gpt-image-2", kind: "image-generation",
			ceilingUsd: 0.1, estimateUsd: 0.2,
			operation: async () => { calls += 1; return { remoteId: "forbidden", artifactSha256, actualUsd: 0.2 }; },
		}), (error: any) => error.code === "PAID_OPERATION_BUDGET_EXCEEDED");
		assert.equal(calls, 0);
	});
});

test("retains uncertain callback failures and redacts their details", async () => {
	await withLedger(async (_root, path) => {
		const ledger = createPaidOperationLedger(path);
		await assert.rejects(() => ledger.executeOnce({
			requestKey, provider: "gpt-image-2", kind: "image-generation",
			ceilingUsd: 1, estimateUsd: 0.2,
			operation: async () => { throw new Error("Authorization: Bearer secret-key-value"); },
		}), (error: any) => {
			assert.equal(error.code, "PAID_OPERATION_SUBMISSION_UNCERTAIN");
			assert.doesNotMatch(error.message, /secret-key-value/);
			return true;
		});
		await assert.rejects(() => ledger.executeOnce({
			requestKey, provider: "gpt-image-2", kind: "image-generation",
			ceilingUsd: 1, estimateUsd: 0.2,
			operation: async () => ({ remoteId: "must-not-run", artifactSha256, actualUsd: 0.2 }),
		}), (error: any) => error.code === "PAID_OPERATION_SUBMISSION_UNCERTAIN");
	});
});

test("allows a retry only after a normalized definitive non-submission failure", async () => {
	await withLedger(async (_root, path) => {
		const ledger = createPaidOperationLedger(path);
		let calls = 0;
		await assert.rejects(() => ledger.executeOnce({
			requestKey, provider: "gpt-image-2", kind: "image-generation",
			ceilingUsd: 1, estimateUsd: 0.2,
			operation: async () => {
				calls += 1;
				throw new FacadeProviderError("PROVIDER_REQUEST_REJECTED", "request was rejected", {
					provider: "gpt-image-2", stage: "generate", definitiveNonSubmission: true,
				});
			},
		}), (error: any) => error.code === "PROVIDER_REQUEST_REJECTED");
		const result = await ledger.executeOnce({
			requestKey, provider: "gpt-image-2", kind: "image-generation",
			ceilingUsd: 1, estimateUsd: 0.2,
			operation: async () => { calls += 1; return { remoteId: "retried", artifactSha256, actualUsd: 0.2 }; },
		});
		assert.equal(calls, 2);
		assert.equal(result.artifactSha256, artifactSha256);
	});
});

test("validates paid-operation inputs and results", async () => {
	await withLedger(async (_root, path) => {
		const ledger = createPaidOperationLedger(path);
		for (const input of [
			{ requestKey: "short", provider: "gpt-image-2", kind: "image-generation", ceilingUsd: 1, estimateUsd: 0.2 },
			{ requestKey, provider: "gpt-image-2", kind: "other", ceilingUsd: 1, estimateUsd: 0.2 },
			{ requestKey, provider: "gpt-image-2", kind: "grammar-extraction", ceilingUsd: Number.NaN, estimateUsd: 0.2 },
		]) {
			await assert.rejects(() => ledger.executeOnce({ ...input, operation: async () => ({ remoteId: "x", artifactSha256, actualUsd: 0.2 }) } as any), TypeError);
		}
		await assert.rejects(() => ledger.executeOnce({
			requestKey, provider: "gpt-image-2", kind: "grammar-extraction", ceilingUsd: 1, estimateUsd: 0.2,
			operation: async () => ({ remoteId: "x", artifactSha256: "invalid", actualUsd: 0.2 }),
		}), (error: any) => error.code === "PAID_OPERATION_SUBMISSION_UNCERTAIN");
	});
});

test("rejects malformed persisted records and control-bearing remote IDs", async () => {
	await withLedger(async (_root, path) => {
		await writeFile(path, `${JSON.stringify({ version: 1, operations: {
			[requestKey]: {
				provider: 123, kind: "image-generation", status: "submitting",
				estimateUsd: 0.2, ceilingUsd: 1, remoteId: null, artifactSha256: null, actualUsd: null,
			},
		} })}\n`);
		await assert.rejects(() => createPaidOperationLedger(path).summary(), /Invalid paid operation ledger/);
	});
	const failure = new FacadeProviderError("PROVIDER_RESPONSE_INVALID", "bad response", {
		provider: "gpt-image-2", stage: "generate", remoteId: "unsafe\nremote-id",
	});
	assert.equal(failure.remoteId, null);
});

test("normalizes provider failures with redacted metadata", () => {
	const normalized = normalizeProviderFailure(
		Object.assign(new Error("Authorization: Bearer secret-key-value"), { status: 503 }),
		"gpt-image-2",
		"generate",
	);
	assert.ok(normalized instanceof FacadeProviderError);
	assert.equal(normalized.code, "PROVIDER_REQUEST_FAILED");
	assert.equal(normalized.provider, "gpt-image-2");
	assert.equal(normalized.stage, "generate");
	assert.equal(normalized.status, 503);
	assert.equal(normalized.retryable, true);
	assert.equal(normalized.definitiveNonSubmission, false);
	assert.doesNotMatch(normalized.message, /secret-key-value/);
});
