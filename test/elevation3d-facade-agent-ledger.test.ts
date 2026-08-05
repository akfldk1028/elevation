import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { FacadeProviderError, normalizeProviderFailure } from "../plugins/elevation-3d/lib/facade-agent/provider.mjs";
import { takeFacadeProviderRemoteIdForLedger } from "../plugins/elevation-3d/lib/facade-agent/provider-internal.mjs";
import { createPaidOperationLedger } from "../plugins/elevation-3d/lib/facade-agent/paid-operation-ledger.mjs";

async function withLedger(run: (root: string, path: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "facade-paid-ledger-"));
	try { await run(root, join(root, "paid-operations.json")); }
	finally { await rm(root, { recursive: true, force: true }); }
}

const requestKey = "a".repeat(64);
const artifactSha256 = "b".repeat(64);
const ledgerModuleUrl = new URL("../plugins/elevation-3d/lib/facade-agent/paid-operation-ledger.mjs", import.meta.url).href;

function spawnLedgerProcess(script: string, env: Record<string, string>) {
	const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "", stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve) => {
		child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
	});
	return { child, completed };
}

async function waitForState(check: () => Promise<boolean>) {
	const deadline = Date.now() + 10_000;
	for (;;) {
		if (await check()) return;
		if (Date.now() >= deadline) throw new Error("Timed out waiting for observable child-process state");
		await delay(20);
	}
}

async function readIfPresent(path: string) {
	try { return await readFile(path, "utf8"); }
	catch (error: any) { if (error?.code === "ENOENT") return null; throw error; }
}

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
		const rawRemoteId = "already-submitted-id";
		await assert.rejects(() => ledger.executeOnce({
			requestKey, provider: "gpt-image-2", kind: "image-generation",
			ceilingUsd: 1, estimateUsd: 0.2,
			operation: async () => {
				calls += 1;
				throw Object.assign(new Error(`bad response for ${rawRemoteId}`), {
					code: "PROVIDER_RESPONSE_INVALID", remoteId: rawRemoteId, definitiveNonSubmission: true,
				});
			},
		}), (error: any) => {
			assert.ok(error instanceof FacadeProviderError);
			assert.equal(error.code, "PROVIDER_REQUEST_FAILED");
			assert.equal(Object.hasOwn(error, "remoteId"), false);
			assert.doesNotMatch(error.message, new RegExp(rawRemoteId));
			assert.doesNotMatch(error.stack, new RegExp(rawRemoteId));
			assert.equal(JSON.stringify(error).includes(rawRemoteId), false);
			assert.equal(error.details, undefined);
			assert.equal(Object.getOwnPropertySymbols(error).length, 0);
			assert.equal(takeFacadeProviderRemoteIdForLedger(error), null);
			return true;
		});
		await assert.rejects(() => ledger.executeOnce({
			requestKey, provider: "gpt-image-2", kind: "image-generation",
			ceilingUsd: 1, estimateUsd: 0.2,
			operation: async () => { calls += 1; return { remoteId: "duplicate", artifactSha256, actualUsd: 0.2 }; },
		}), (error: any) => error.code === "PAID_OPERATION_SUBMISSION_UNCERTAIN");
		assert.equal(calls, 1);
		assert.equal((await ledger.summary()).operations[0].remoteIdHash?.length, 64);
		assert.equal((await readFile(path, "utf8")).includes(rawRemoteId), true);
	});
});

test("public provider errors redact known remote IDs from properties, messages, and exact JSON", () => {
	const rawRemoteId = "provider-remote-secret-123";
	const direct = new FacadeProviderError("PROVIDER_RESPONSE_INVALID", `failed remote ${rawRemoteId}`, {
		provider: "gpt-image-2", stage: "generate", status: 502, retryable: true,
		remoteId: rawRemoteId,
	});
	assert.equal(Object.hasOwn(direct, "remoteId"), false);
	assert.equal(direct.message, "failed remote [REDACTED_REMOTE_ID]");
	assert.equal(JSON.stringify(direct), "{\"name\":\"FacadeProviderError\",\"code\":\"PROVIDER_RESPONSE_INVALID\",\"provider\":\"gpt-image-2\",\"stage\":\"generate\",\"status\":502,\"retryable\":true,\"definitiveNonSubmission\":false}");

	const normalized = normalizeProviderFailure(Object.assign(new Error(`remote ${rawRemoteId} failed`), {
		remoteId: rawRemoteId, status: 503,
	}), "gpt-image-2", "generate");
	assert.equal(Object.hasOwn(normalized, "remoteId"), false);
	assert.equal(normalized.message, "remote [REDACTED_REMOTE_ID] failed");
	assert.equal(JSON.stringify(normalized).includes(rawRemoteId), false);
});

test("persists a FacadeProviderError remote ID privately without leaking it when rethrown", async () => {
	await withLedger(async (_root, path) => {
		const rawRemoteId = "private-provider-remote-456";
		const ledger = createPaidOperationLedger(path);
		await assert.rejects(() => ledger.executeOnce({
			requestKey, provider: "gpt-image-2", kind: "image-generation",
			ceilingUsd: 1, estimateUsd: 0.2,
			operation: async () => {
				throw new FacadeProviderError("PROVIDER_RESPONSE_INVALID", `invalid response for ${rawRemoteId}`, {
					provider: "gpt-image-2", stage: "generate", status: 502, retryable: true,
					definitiveNonSubmission: true, remoteId: rawRemoteId,
				});
			},
		}), (error: any) => {
			assert.ok(error instanceof FacadeProviderError);
			assert.equal(error.code, "PROVIDER_RESPONSE_INVALID");
			assert.equal(Object.hasOwn(error, "remoteId"), false);
			assert.equal(error.remoteId, undefined);
			assert.equal(error.details, undefined);
			assert.equal(Object.getOwnPropertySymbols(error).length, 0);
			assert.doesNotMatch(error.message, new RegExp(rawRemoteId));
			assert.doesNotMatch(error.stack, new RegExp(rawRemoteId));
			assert.equal(JSON.stringify(error).includes(rawRemoteId), false);
			return true;
		});
		const persisted = await readFile(path, "utf8");
		assert.equal(persisted.includes(rawRemoteId), true);
		const summary = await ledger.summary();
		assert.equal(summary.operations[0].remoteIdHash?.length, 64);
		assert.equal(JSON.stringify(summary).includes(rawRemoteId), false);
	});
});

test("preserves private reconciliation data through public failure normalization", async () => {
	await withLedger(async (_root, path) => {
		const rawRemoteId = "normalized-private-remote-789";
		const ledger = createPaidOperationLedger(path);
		await assert.rejects(() => ledger.executeOnce({
			requestKey, provider: "gpt-image-2", kind: "image-generation",
			ceilingUsd: 1, estimateUsd: 0.2,
			operation: async () => {
				const source = new FacadeProviderError("PROVIDER_RESPONSE_INVALID", `bad ${rawRemoteId}`, {
					provider: "gpt-image-2", stage: "generate", remoteId: rawRemoteId,
				});
				throw normalizeProviderFailure(source, "gpt-image-2", "generate");
			},
		}), (error: any) => {
			assert.ok(error instanceof FacadeProviderError);
			assert.equal(error.code, "PROVIDER_RESPONSE_INVALID");
			assert.equal(Object.hasOwn(error, "remoteId"), false);
			assert.equal(Object.getOwnPropertySymbols(error).length, 0);
			assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`, new RegExp(rawRemoteId));
			return true;
		});
		assert.equal((await readFile(path, "utf8")).includes(rawRemoteId), true);
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

test("independent processes sharing one ledger execute exactly one paid callback", async () => {
	await withLedger(async (root, path) => {
		const claimsPath = join(root, "claims.txt");
		const releasePath = join(root, "release");
		const script = `
			import { access, appendFile } from "node:fs/promises";
			import { setTimeout as delay } from "node:timers/promises";
			const { createPaidOperationLedger } = await import(process.env.LEDGER_MODULE);
			const ledger = createPaidOperationLedger(process.env.LEDGER_PATH, { approvedRoot: process.env.APPROVED_ROOT, lockWaitMs: 10000 });
			const result = await ledger.executeOnce({
				requestKey: "${requestKey}", provider: "gpt-image-2", kind: "image-generation",
				ceilingUsd: 1, estimateUsd: 0.2,
				operation: async () => {
					await appendFile(process.env.CLAIMS_PATH, "claim\\n");
					for (;;) { try { await access(process.env.RELEASE_PATH); break; } catch { await delay(10); } }
					return { remoteId: "child-process-remote", artifactSha256: "${artifactSha256}", actualUsd: 0.2 };
				},
			});
			process.stdout.write(JSON.stringify(result));
		`;
		const env = {
			LEDGER_MODULE: ledgerModuleUrl, LEDGER_PATH: path, APPROVED_ROOT: root,
			CLAIMS_PATH: claimsPath, RELEASE_PATH: releasePath,
		};
		const left = spawnLedgerProcess(script, env);
		const right = spawnLedgerProcess(script, env);
		await waitForState(async () => {
			const claims = await readIfPresent(claimsPath);
			const persisted = await readIfPresent(path);
			return claims === "claim\n" && persisted !== null && JSON.parse(persisted).operations[requestKey]?.status === "submitting";
		});
		await writeFile(releasePath, "release\n");
		const [leftResult, rightResult] = await Promise.all([left.completed, right.completed]);
		assert.equal(leftResult.code, 0, leftResult.stderr);
		assert.equal(rightResult.code, 0, rightResult.stderr);
		assert.deepEqual(JSON.parse(leftResult.stdout), JSON.parse(rightResult.stdout));
		assert.equal(await readFile(claimsPath, "utf8"), "claim\n");
	});
});

test("a process killed after the durable submitting checkpoint cannot be resubmitted", async () => {
	await withLedger(async (root, path) => {
		const readyPath = join(root, "owner-ready");
		const duplicatePath = join(root, "duplicate-claim");
		const ownerScript = `
			import { writeFile } from "node:fs/promises";
			const { createPaidOperationLedger } = await import(process.env.LEDGER_MODULE);
			await createPaidOperationLedger(process.env.LEDGER_PATH, { approvedRoot: process.env.APPROVED_ROOT }).executeOnce({
				requestKey: "${requestKey}", provider: "gpt-image-2", kind: "image-generation",
				ceilingUsd: 1, estimateUsd: 0.2,
				operation: async () => { await writeFile(process.env.READY_PATH, "ready\\n"); await new Promise(() => {}); },
			});
		`;
		const owner = spawnLedgerProcess(ownerScript, {
			LEDGER_MODULE: ledgerModuleUrl, LEDGER_PATH: path, APPROVED_ROOT: root, READY_PATH: readyPath,
		});
		await waitForState(async () => {
			const ready = await readIfPresent(readyPath);
			const persisted = await readIfPresent(path);
			return ready === "ready\n" && persisted !== null && JSON.parse(persisted).operations[requestKey]?.status === "submitting";
		});
		owner.child.kill();
		await owner.completed;

		const retryScript = `
			import { appendFile } from "node:fs/promises";
			const { createPaidOperationLedger } = await import(process.env.LEDGER_MODULE);
			try {
				await createPaidOperationLedger(process.env.LEDGER_PATH, { approvedRoot: process.env.APPROVED_ROOT }).executeOnce({
					requestKey: "${requestKey}", provider: "gpt-image-2", kind: "image-generation",
					ceilingUsd: 1, estimateUsd: 0.2,
					operation: async () => { await appendFile(process.env.DUPLICATE_PATH, "duplicate\\n"); return { remoteId: "duplicate", artifactSha256: "${artifactSha256}", actualUsd: 0.2 }; },
				});
			} catch (error) { process.stdout.write(JSON.stringify({ code: error.code, message: error.message })); }
		`;
		const retry = spawnLedgerProcess(retryScript, {
			LEDGER_MODULE: ledgerModuleUrl, LEDGER_PATH: path, APPROVED_ROOT: root, DUPLICATE_PATH: duplicatePath,
		});
		const result = await retry.completed;
		assert.equal(result.code, 0, result.stderr);
		assert.equal(JSON.parse(result.stdout).code, "PAID_OPERATION_SUBMISSION_UNCERTAIN");
		assert.equal(await readIfPresent(duplicatePath), null);
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

test("rejects relative ledger escapes before any filesystem access", async () => {
	await withLedger(async (root) => {
		assert.throws(() => createPaidOperationLedger(join("..", "escape", "paid.json"), { approvedRoot: root }),
			(error: any) => error.code === "PAID_OPERATION_PATH_UNSAFE");
	});
});

test("rejects a junction parent before writing outside the approved root", async () => {
	await withLedger(async (root) => {
		const approvedRoot = join(root, "approved");
		const outsideRoot = join(root, "outside");
		const redirect = join(approvedRoot, "redirect");
		await mkdir(approvedRoot);
		await mkdir(outsideRoot);
		await symlink(outsideRoot, redirect, process.platform === "win32" ? "junction" : "dir");
		let calls = 0;
		await assert.rejects(() => createPaidOperationLedger(join(redirect, "paid.json"), { approvedRoot }).executeOnce({
			requestKey, provider: "gpt-image-2", kind: "image-generation", ceilingUsd: 1, estimateUsd: 0.2,
			operation: async () => { calls += 1; return { remoteId: "outside", artifactSha256, actualUsd: 0.2 }; },
		}), (error: any) => error.code === "PAID_OPERATION_PATH_UNSAFE");
		assert.equal(calls, 0);
		assert.equal(await readIfPresent(join(outsideRoot, "paid.json")), null);
	});
});

test("rejects a junction parent before reading an outside ledger", async () => {
	await withLedger(async (root) => {
		const approvedRoot = join(root, "approved");
		const outsideRoot = join(root, "outside");
		const redirect = join(approvedRoot, "redirect");
		await mkdir(approvedRoot);
		await mkdir(outsideRoot);
		await writeFile(join(outsideRoot, "paid.json"), `${JSON.stringify({ version: 1, operations: {} })}\n`);
		await symlink(outsideRoot, redirect, process.platform === "win32" ? "junction" : "dir");
		await assert.rejects(() => createPaidOperationLedger(join(redirect, "paid.json"), { approvedRoot }).summary(),
			(error: any) => error.code === "PAID_OPERATION_PATH_UNSAFE");
	});
});

test("rejects a symlink ledger entry before reading outside the approved root", async (t) => {
	await withLedger(async (root) => {
		const approvedRoot = join(root, "approved");
		const outsideLedger = join(root, "outside-ledger.json");
		const linkedLedger = join(approvedRoot, "paid.json");
		await mkdir(approvedRoot);
		await writeFile(outsideLedger, `${JSON.stringify({ version: 1, operations: {} })}\n`);
		try { await symlink(outsideLedger, linkedLedger, "file"); }
		catch (error: any) {
			if (process.platform === "win32" && error?.code === "EPERM") { t.skip("Windows file symlinks require Developer Mode"); return; }
			throw error;
		}
		await assert.rejects(() => createPaidOperationLedger(linkedLedger, { approvedRoot }).summary(),
			(error: any) => error.code === "PAID_OPERATION_PATH_UNSAFE");
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
		await assert.rejects(() => createPaidOperationLedger(path).summary(),
			(error: any) => error.code === "PAID_OPERATION_LEDGER_UNCERTAIN");
	});
	const controlRemoteId = "unsafe\nremote-id";
	const failure = new FacadeProviderError("PROVIDER_RESPONSE_INVALID", `bad response ${controlRemoteId}`, {
		provider: "gpt-image-2", stage: "generate", remoteId: controlRemoteId,
	});
	assert.equal(Object.hasOwn(failure, "remoteId"), false);
	assert.equal(failure.message, "bad response [REDACTED_REMOTE_ID]");
});

test("fails closed on truncated, corrupt, and tampered ledgers without a callback", async () => {
	await withLedger(async (root) => {
		const fixtures = [
			"{\"version\":1,\"operations\":",
			"not-json Authorization: Bearer secret-value",
			JSON.stringify({ version: 1, operations: { [requestKey]: {
				provider: "gpt-image-2", kind: "image-generation", status: "succeeded",
				estimateUsd: 0.2, ceilingUsd: 1, remoteId: null, artifactSha256, actualUsd: 0.2,
			} } }),
		];
		for (const [index, fixtureText] of fixtures.entries()) {
			const path = join(root, `tampered-${index}.json`);
			await writeFile(path, `${fixtureText}\n`);
			let calls = 0;
			await assert.rejects(() => createPaidOperationLedger(path, { approvedRoot: root }).executeOnce({
				requestKey, provider: "gpt-image-2", kind: "image-generation", ceilingUsd: 1, estimateUsd: 0.2,
				operation: async () => { calls += 1; return { remoteId: "forbidden", artifactSha256, actualUsd: 0.2 }; },
			}), (error: any) => {
				assert.equal(error.code, "PAID_OPERATION_LEDGER_UNCERTAIN");
				assert.equal(error.message, "Paid operation ledger cannot be trusted; refusing submission");
				assert.doesNotMatch(JSON.stringify(error), /secret-value/);
				return true;
			});
			assert.equal(calls, 0);
		}
	});
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
