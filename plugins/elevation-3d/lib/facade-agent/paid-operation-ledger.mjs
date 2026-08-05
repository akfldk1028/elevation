import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sha256 } from "../core.mjs";
import { normalizeProviderFailure } from "./provider.mjs";
import { takeFacadeProviderRemoteIdForLedger } from "./provider-internal.mjs";

const ALLOWED_KINDS = new Set(["image-generation", "grammar-extraction"]);
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const submissionCapabilities = new WeakMap();

function issueSubmissionCapability(record) {
	const capability = Object.freeze(Object.create(null));
	submissionCapabilities.set(capability, Object.freeze({ ...record }));
	return capability;
}

function revokeSubmissionCapability(capability) {
	if (capability && typeof capability === "object") submissionCapabilities.delete(capability);
}

export function consumePaidOperationSubmissionCapability(capability, expected) {
	if (!capability || typeof capability !== "object") return false;
	const record = submissionCapabilities.get(capability);
	submissionCapabilities.delete(capability);
	return Boolean(record
		&& record.requestKey === expected?.requestKey
		&& record.provider === expected?.provider
		&& record.kind === expected?.kind);
}

function codedError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

function unsafePathError() {
	return codedError("PAID_OPERATION_PATH_UNSAFE", "Paid operation ledger path is outside its approved regular-file boundary");
}

function ledgerUncertainError() {
	return codedError("PAID_OPERATION_LEDGER_UNCERTAIN", "Paid operation ledger cannot be trusted; refusing submission");
}

function isContained(root, target) {
	const child = relative(root, target);
	return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function assertSafePathComponents(target, { leafKind = null, leafRequired = false } = {}) {
	const absolute = resolve(target);
	const root = parse(absolute).root;
	const components = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean);
	let current = root;
	for (let index = 0; index < components.length; index += 1) {
		current = resolve(current, components[index]);
		let stats;
		try { stats = await lstat(current); }
		catch (error) {
			if (error?.code === "ENOENT") return false;
			throw error;
		}
		if (stats.isSymbolicLink()) throw unsafePathError();
		const isLeaf = index === components.length - 1;
		if (!isLeaf && !stats.isDirectory()) throw unsafePathError();
		if (isLeaf && leafKind === "directory" && !stats.isDirectory()) throw unsafePathError();
		if (isLeaf && leafKind === "file" && !stats.isFile()) throw unsafePathError();
	}
	return true;
}

async function assertApprovedRoot(root) {
	if (!await assertSafePathComponents(root, { leafKind: "directory", leafRequired: true })) throw unsafePathError();
}

async function ensureSafeParent(root, target) {
	await assertApprovedRoot(root);
	const parent = dirname(target);
	await assertSafePathComponents(parent, { leafKind: "directory" });
	await mkdir(parent, { recursive: true });
	if (!await assertSafePathComponents(parent, { leafKind: "directory", leafRequired: true })) throw unsafePathError();
}

async function assertSafeSensitiveEntry(root, target) {
	await assertApprovedRoot(root);
	return assertSafePathComponents(target, { leafKind: "file" });
}

function finiteNonnegative(value, label) {
	if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be a finite nonnegative number`);
	return value;
}

function validateIdentity({ requestKey, provider, kind, ceilingUsd, estimateUsd, runCeilingUsd, kindCeilingUsd, operation }) {
	if (typeof requestKey !== "string" || !HEX_SHA256.test(requestKey)) throw new TypeError("requestKey must be a lowercase SHA-256 digest");
	if (typeof provider !== "string" || !PROVIDER.test(provider)) throw new TypeError("provider must be a safe identifier");
	if (!ALLOWED_KINDS.has(kind)) throw new TypeError("kind must be image-generation or grammar-extraction");
	finiteNonnegative(ceilingUsd, "ceilingUsd");
	finiteNonnegative(estimateUsd, "estimateUsd");
	if (typeof operation !== "function") throw new TypeError("operation must be a function");
	if (estimateUsd > ceilingUsd) throw codedError("PAID_OPERATION_BUDGET_EXCEEDED", "Estimated paid operation cost exceeds its approved ceiling");
	if (runCeilingUsd !== undefined) finiteNonnegative(runCeilingUsd, "runCeilingUsd");
	if (kindCeilingUsd !== undefined) finiteNonnegative(kindCeilingUsd, "kindCeilingUsd");
	if (runCeilingUsd !== undefined && ceilingUsd > runCeilingUsd) throw codedError("PAID_OPERATION_AGGREGATE_BUDGET_EXCEEDED", "Paid operation ceiling exceeds the approved run budget");
	if (kindCeilingUsd !== undefined && ceilingUsd > kindCeilingUsd) throw codedError("PAID_OPERATION_AGGREGATE_BUDGET_EXCEEDED", "Paid operation ceiling exceeds the approved kind budget");
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
	if (value.actualUsd !== null && value.actualUsd > value.ceilingUsd) throw new Error("Invalid paid operation ledger");
	if (value.status === "succeeded" && (!validRemoteId(value.remoteId) || !HEX_SHA256.test(value.artifactSha256) || value.actualUsd === null)) {
		throw new Error("Invalid paid operation ledger");
	}
	return value;
}

async function readLedger(path, approvedRoot) {
	try {
		await assertSafeSensitiveEntry(approvedRoot, path);
		const parsed = JSON.parse(await readFile(path, "utf8"));
		if (parsed?.version !== 1 || !parsed.operations || typeof parsed.operations !== "object" || Array.isArray(parsed.operations)) {
			throw new Error("Invalid paid operation ledger");
		}
		for (const [key, operation] of Object.entries(parsed.operations)) validateOperationRecord(key, operation);
		return parsed;
	} catch (error) {
		if (error?.code === "ENOENT") return { version: 1, operations: {} };
		if (error?.code === "PAID_OPERATION_PATH_UNSAFE") throw error;
		throw ledgerUncertainError();
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

async function atomicWrite(path, value, approvedRoot) {
	const directory = dirname(path);
	await ensureSafeParent(approvedRoot, path);
	await assertSafeSensitiveEntry(approvedRoot, path);
	const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
	let handle;
	try {
		handle = await open(temporaryPath, "wx", 0o600);
		if (!(await handle.stat()).isFile()) throw unsafePathError();
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
		await handle.sync();
		await handle.close();
		handle = null;
		await assertSafeSensitiveEntry(approvedRoot, path);
		if (!await assertSafePathComponents(temporaryPath, { leafKind: "file", leafRequired: true })) throw unsafePathError();
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

async function acquireReservation(lockPath, approvedRoot, { waitMs, pollMs, signal }) {
	const token = randomUUID();
	const started = Date.now();
	await ensureSafeParent(approvedRoot, lockPath);
	for (;;) {
		signal?.throwIfAborted();
		await assertSafeSensitiveEntry(approvedRoot, lockPath);
		try {
			await writeFile(lockPath, `${JSON.stringify({ version: 1, token, pid: process.pid, createdAt: new Date().toISOString() })}\n`, {
				encoding: "utf8", flag: "wx", mode: 0o600,
			});
			if (!await assertSafePathComponents(lockPath, { leafKind: "file", leafRequired: true })) throw unsafePathError();
			return token;
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
		}
		let owner;
		try {
			await assertSafeSensitiveEntry(approvedRoot, lockPath);
			owner = JSON.parse(await readFile(lockPath, "utf8"));
		} catch (error) {
			if (error?.code === "ENOENT") continue;
			throw codedError("PAID_OPERATION_RESERVATION_UNCERTAIN", "Paid operation reservation ownership cannot be proven; refusing submission");
		}
		if (owner?.version !== 1 || typeof owner?.token !== "string" || owner.token.length === 0) {
			throw codedError("PAID_OPERATION_RESERVATION_UNCERTAIN", "Paid operation reservation ownership cannot be proven; refusing submission");
		}
		const alive = pidIsAlive(owner.pid);
		if (alive === null) throw codedError("PAID_OPERATION_RESERVATION_UNCERTAIN", "Paid operation reservation ownership cannot be proven; refusing submission");
		if (alive === false) throw codedError("PAID_OPERATION_RESERVATION_STALE", "Paid operation reservation owner is not alive; refusing submission");
		if (Date.now() - started >= waitMs) throw codedError("PAID_OPERATION_RESERVATION_TIMEOUT", "Timed out waiting for the paid operation reservation");
		await delay(Math.min(pollMs, Math.max(1, waitMs - (Date.now() - started))), undefined, { signal });
	}
}

async function releaseReservation(lockPath, token, approvedRoot) {
	let owner;
	try {
		await assertSafeSensitiveEntry(approvedRoot, lockPath);
		owner = JSON.parse(await readFile(lockPath, "utf8"));
	} catch (error) {
		if (error?.code === "ENOENT") return;
		throw error;
	}
	if (owner?.token !== token || owner?.pid !== process.pid) return;
	await assertSafeSensitiveEntry(approvedRoot, lockPath);
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

function assertAggregateBudget(ledger, input) {
	if (input.runCeilingUsd === undefined && input.kindCeilingUsd === undefined) return;
	const operations = Object.values(ledger.operations);
	const runReserved = operations.reduce((sum, operation) => sum + operation.ceilingUsd, 0);
	const kindReserved = operations.filter((operation) => operation.kind === input.kind)
		.reduce((sum, operation) => sum + operation.ceilingUsd, 0);
	if (input.runCeilingUsd !== undefined && runReserved + input.ceilingUsd > input.runCeilingUsd + Number.EPSILON) {
		throw codedError("PAID_OPERATION_AGGREGATE_BUDGET_EXCEEDED", "Paid operation reservations exceed the approved run budget");
	}
	if (input.kindCeilingUsd !== undefined && kindReserved + input.ceilingUsd > input.kindCeilingUsd + Number.EPSILON) {
		throw codedError("PAID_OPERATION_AGGREGATE_BUDGET_EXCEEDED", "Paid operation reservations exceed the approved kind budget");
	}
}

function costSummary(operations) {
	const empty = () => ({ reserved_ceiling_usd: 0, estimated_usd: 0, actual_usd: 0 });
	const total = empty();
	const byKind = Object.fromEntries([...ALLOWED_KINDS].map((kind) => [kind, empty()]));
	for (const operation of operations) {
		for (const target of [total, byKind[operation.kind]]) {
			target.reserved_ceiling_usd += operation.ceilingUsd;
			target.estimated_usd += operation.estimateUsd;
			target.actual_usd += operation.actualUsd ?? 0;
		}
	}
	return { total, by_kind: byKind };
}

function uncertainError(kind) {
	return codedError("PAID_OPERATION_SUBMISSION_UNCERTAIN", `Refusing to resubmit uncertain ${kind} operation; reconcile provider state manually`);
}

export function createPaidOperationLedger(path, { approvedRoot, lockWaitMs = 5_000, lockPollMs = 25 } = {}) {
	if (typeof path !== "string" || path.length === 0) throw new TypeError("A paid operation ledger path is required");
	finiteNonnegative(lockWaitMs, "lockWaitMs");
	finiteNonnegative(lockPollMs, "lockPollMs");
	if (approvedRoot !== undefined && (typeof approvedRoot !== "string" || !isAbsolute(approvedRoot))) throw unsafePathError();
	if (approvedRoot === undefined && (!isAbsolute(path) || path.split(/[\\/]+/).includes(".."))) throw unsafePathError();
	const root = resolve(approvedRoot ?? dirname(resolve(path)));
	const ledgerPath = resolve(root, path);
	if (!isContained(root, ledgerPath)) throw unsafePathError();
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
				let token;
				try {
					token = await acquireReservation(lockPath, root, {
						waitMs: lockWaitMs, pollMs: lockPollMs, signal: input.signal,
					});
				} catch (error) {
					if (error?.code !== "PAID_OPERATION_RESERVATION_STALE") throw error;
					const staleLedger = await readLedger(ledgerPath, root);
					if (staleLedger.operations[input.requestKey]?.status === "submitting") throw uncertainError(input.kind);
					throw error;
				}
				try {
					input.signal?.throwIfAborted();
					const ledger = await readLedger(ledgerPath, root);
					const existing = ledger.operations[input.requestKey];
					if (existing) {
						if (existing.provider !== input.provider || existing.kind !== input.kind) {
							throw codedError("PAID_OPERATION_IDENTITY_MISMATCH", "Paid operation request key is already bound to a different operation");
						}
						if (existing.status === "succeeded") return publicResult(existing);
						throw uncertainError(input.kind);
					}
					assertAggregateBudget(ledger, input);
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
					await atomicWrite(ledgerPath, ledger, root);
					const submissionCapability = issueSubmissionCapability({
						requestKey: input.requestKey,
						provider: input.provider,
						kind: input.kind,
						estimateUsd: input.estimateUsd,
						ceilingUsd: input.ceilingUsd,
					});
					try {
						const result = validateResult(await input.operation(submissionCapability));
						if (result.actualUsd > input.ceilingUsd) {
							throw codedError("PAID_OPERATION_ACTUAL_BUDGET_EXCEEDED", "Paid operation actual cost exceeds its reserved ceiling");
						}
						ledger.operations[input.requestKey] = {
							...ledger.operations[input.requestKey], ...result, status: "succeeded",
						};
						await atomicWrite(ledgerPath, ledger, root);
						return publicResult(ledger.operations[input.requestKey]);
					} catch (error) {
						const internalRemoteId = takeFacadeProviderRemoteIdForLedger(error)
							?? (validRemoteId(error?.remoteId) ? error.remoteId : null);
						const failure = normalizeProviderFailure(error, input.provider, input.kind === "image-generation" ? "generate" : "grammar");
						takeFacadeProviderRemoteIdForLedger(failure);
						if (internalRemoteId) {
							ledger.operations[input.requestKey].remoteId = internalRemoteId;
							await atomicWrite(ledgerPath, ledger, root);
							throw failure;
						}
						if (failure.definitiveNonSubmission) {
							delete ledger.operations[input.requestKey];
							await atomicWrite(ledgerPath, ledger, root);
							throw failure;
						}
						throw uncertainError(input.kind);
					} finally {
						revokeSubmissionCapability(submissionCapability);
					}
				} finally {
					await releaseReservation(lockPath, token, root);
				}
			});
		},
		async summary() {
			await pending;
			const ledger = await readLedger(ledgerPath, root);
			const operations = Object.entries(ledger.operations).map(([key, operation]) => ({
				requestKey: key,
				provider: operation.provider,
				kind: operation.kind,
				status: operation.status,
				estimateUsd: operation.estimateUsd,
				ceilingUsd: operation.ceilingUsd,
				remoteIdHash: operation.remoteId ? sha256(operation.remoteId) : null,
				artifactSha256: operation.artifactSha256,
				actualUsd: operation.actualUsd,
			}));
			return {
				version: ledger.version,
				operations,
				costs: costSummary(Object.values(ledger.operations)),
			};
		},
	};
}
