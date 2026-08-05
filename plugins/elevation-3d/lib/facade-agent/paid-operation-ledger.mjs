import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sha256 } from "../core.mjs";
import { FacadeProviderError, normalizeProviderFailure } from "./provider.mjs";

const ALLOWED_KINDS = new Set(["image-generation", "grammar-extraction"]);
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function codedError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

function finiteNonnegative(value, label) {
	if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be a finite nonnegative number`);
	return value;
}

function validateIdentity({ requestKey, provider, kind, ceilingUsd, estimateUsd, operation }) {
	if (typeof requestKey !== "string" || !HEX_SHA256.test(requestKey)) throw new TypeError("requestKey must be a lowercase SHA-256 digest");
	if (typeof provider !== "string" || !PROVIDER.test(provider)) throw new TypeError("provider must be a safe identifier");
	if (!ALLOWED_KINDS.has(kind)) throw new TypeError("kind must be image-generation or grammar-extraction");
	finiteNonnegative(ceilingUsd, "ceilingUsd");
	finiteNonnegative(estimateUsd, "estimateUsd");
	if (typeof operation !== "function") throw new TypeError("operation must be a function");
	if (estimateUsd > ceilingUsd) throw codedError("PAID_OPERATION_BUDGET_EXCEEDED", "Estimated paid operation cost exceeds its approved ceiling");
}

function validRemoteId(value) {
	return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\r\n\0]/.test(value);
}

function validateOperationRecord(requestKey, value) {
	if (!HEX_SHA256.test(requestKey) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid paid operation ledger");
	if (typeof value.provider !== "string" || !PROVIDER.test(value.provider) || !ALLOWED_KINDS.has(value.kind)) throw new Error("Invalid paid operation ledger");
	if (!new Set(["submitting", "succeeded"]).has(value.status)) throw new Error("Invalid paid operation ledger");
	finiteNonnegative(value.estimateUsd, "persisted estimateUsd");
	finiteNonnegative(value.ceilingUsd, "persisted ceilingUsd");
	if (value.estimateUsd > value.ceilingUsd) throw new Error("Invalid paid operation ledger");
	if (value.remoteId !== null && !validRemoteId(value.remoteId)) throw new Error("Invalid paid operation ledger");
	if (value.artifactSha256 !== null && (typeof value.artifactSha256 !== "string" || !HEX_SHA256.test(value.artifactSha256))) throw new Error("Invalid paid operation ledger");
	if (value.actualUsd !== null) finiteNonnegative(value.actualUsd, "persisted actualUsd");
	if (value.status === "succeeded" && (!validRemoteId(value.remoteId) || !HEX_SHA256.test(value.artifactSha256) || value.actualUsd === null)) {
		throw new Error("Invalid paid operation ledger");
	}
	return value;
}

async function readLedger(path) {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		if (parsed?.version !== 1 || !parsed.operations || typeof parsed.operations !== "object" || Array.isArray(parsed.operations)) {
			throw new Error("Invalid paid operation ledger");
		}
		for (const [key, operation] of Object.entries(parsed.operations)) validateOperationRecord(key, operation);
		return parsed;
	} catch (error) {
		if (error?.code === "ENOENT") return { version: 1, operations: {} };
		throw error;
	}
}

async function syncDirectory(path) {
	let handle;
	try {
		handle = await open(path, "r");
		await handle.sync();
	} catch (error) {
		if (!["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(error?.code)) throw error;
	} finally {
		await handle?.close();
	}
}

async function atomicWrite(path, value) {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true });
	const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
	let handle;
	try {
		handle = await open(temporaryPath, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
		await handle.sync();
		await handle.close();
		handle = null;
		await rename(temporaryPath, path);
		await syncDirectory(directory);
	} finally {
		await handle?.close();
		await rm(temporaryPath, { force: true });
	}
}

function pidIsAlive(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return null;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "ESRCH" ? false : true;
	}
}

async function acquireReservation(lockPath, { waitMs, pollMs, signal }) {
	const token = randomUUID();
	const started = Date.now();
	await mkdir(dirname(lockPath), { recursive: true });
	for (;;) {
		signal?.throwIfAborted();
		try {
			await writeFile(lockPath, `${JSON.stringify({ version: 1, token, pid: process.pid, createdAt: new Date().toISOString() })}\n`, {
				encoding: "utf8", flag: "wx", mode: 0o600,
			});
			return token;
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
		}
		let owner;
		try {
			owner = JSON.parse(await readFile(lockPath, "utf8"));
		} catch (error) {
			if (error?.code === "ENOENT") continue;
			throw codedError("PAID_OPERATION_RESERVATION_UNCERTAIN", "Paid operation reservation ownership cannot be proven; refusing submission");
		}
		const alive = pidIsAlive(owner?.pid);
		if (alive === null) throw codedError("PAID_OPERATION_RESERVATION_UNCERTAIN", "Paid operation reservation ownership cannot be proven; refusing submission");
		if (alive === false) throw codedError("PAID_OPERATION_RESERVATION_STALE", "Paid operation reservation owner is not alive; refusing submission");
		if (Date.now() - started >= waitMs) throw codedError("PAID_OPERATION_RESERVATION_TIMEOUT", "Timed out waiting for the paid operation reservation");
		await delay(Math.min(pollMs, Math.max(1, waitMs - (Date.now() - started))), undefined, { signal });
	}
}

async function releaseReservation(lockPath, token) {
	let owner;
	try {
		owner = JSON.parse(await readFile(lockPath, "utf8"));
	} catch (error) {
		if (error?.code === "ENOENT") return;
		throw error;
	}
	if (owner?.token !== token || owner?.pid !== process.pid) return;
	await unlink(lockPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
}

function validateResult(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Paid operation must return a result object");
	if (!validRemoteId(value.remoteId)) throw new TypeError("Paid operation result remoteId is invalid");
	if (typeof value.artifactSha256 !== "string" || !HEX_SHA256.test(value.artifactSha256)) throw new TypeError("Paid operation result artifactSha256 is invalid");
	finiteNonnegative(value.actualUsd, "Paid operation result actualUsd");
	return { remoteId: value.remoteId, artifactSha256: value.artifactSha256, actualUsd: value.actualUsd };
}

function publicResult(record) {
	return { remoteIdHash: sha256(record.remoteId), artifactSha256: record.artifactSha256, actualUsd: record.actualUsd };
}

function uncertainError(kind) {
	return codedError("PAID_OPERATION_SUBMISSION_UNCERTAIN", `Refusing to resubmit uncertain ${kind} operation; reconcile provider state manually`);
}

export function createPaidOperationLedger(path, { lockWaitMs = 5_000, lockPollMs = 25 } = {}) {
	if (typeof path !== "string" || path.length === 0) throw new TypeError("A paid operation ledger path is required");
	finiteNonnegative(lockWaitMs, "lockWaitMs");
	finiteNonnegative(lockPollMs, "lockPollMs");
	const ledgerPath = resolve(path);
	const lockPath = `${ledgerPath}.lock`;
	let pending = Promise.resolve();
	const serialize = (operation) => {
		const result = pending.then(operation, operation);
		pending = result.then(() => undefined, () => undefined);
		return result;
	};

	return {
		path: ledgerPath,
		executeOnce(input) {
			return serialize(async () => {
				validateIdentity(input ?? {});
				input.signal?.throwIfAborted();
				const token = await acquireReservation(lockPath, {
					waitMs: lockWaitMs, pollMs: lockPollMs, signal: input.signal,
				});
				try {
					input.signal?.throwIfAborted();
					const ledger = await readLedger(ledgerPath);
					const existing = ledger.operations[input.requestKey];
					if (existing) {
						if (existing.provider !== input.provider || existing.kind !== input.kind) {
							throw codedError("PAID_OPERATION_IDENTITY_MISMATCH", "Paid operation request key is already bound to a different operation");
						}
						if (existing.status === "succeeded") return publicResult(existing);
						throw uncertainError(input.kind);
					}
					ledger.operations[input.requestKey] = {
						provider: input.provider,
						kind: input.kind,
						status: "submitting",
						estimateUsd: input.estimateUsd,
						ceilingUsd: input.ceilingUsd,
						remoteId: null,
						artifactSha256: null,
						actualUsd: null,
					};
					await atomicWrite(ledgerPath, ledger);
					try {
						const result = validateResult(await input.operation());
						ledger.operations[input.requestKey] = {
							...ledger.operations[input.requestKey], ...result, status: "succeeded",
						};
						await atomicWrite(ledgerPath, ledger);
						return publicResult(ledger.operations[input.requestKey]);
					} catch (error) {
						const failure = normalizeProviderFailure(error, input.provider, input.kind === "image-generation" ? "generate" : "grammar");
						if (failure.remoteId) {
							ledger.operations[input.requestKey].remoteId = failure.remoteId;
							await atomicWrite(ledgerPath, ledger);
							throw new FacadeProviderError(failure.code, failure.message, {
								provider: failure.provider,
								stage: failure.stage,
								status: failure.status,
								retryable: failure.retryable,
							});
						}
						if (failure.definitiveNonSubmission) {
							delete ledger.operations[input.requestKey];
							await atomicWrite(ledgerPath, ledger);
							throw failure;
						}
						throw uncertainError(input.kind);
					}
				} finally {
					await releaseReservation(lockPath, token);
				}
			});
		},
		async summary() {
			await pending;
			const ledger = await readLedger(ledgerPath);
			return {
				version: ledger.version,
				operations: Object.entries(ledger.operations).map(([key, operation]) => ({
					requestKey: key,
					provider: operation.provider,
					kind: operation.kind,
					status: operation.status,
					estimateUsd: operation.estimateUsd,
					ceilingUsd: operation.ceilingUsd,
					remoteIdHash: operation.remoteId ? sha256(operation.remoteId) : null,
					artifactSha256: operation.artifactSha256,
					actualUsd: operation.actualUsd,
				})),
			};
		},
	};
}
