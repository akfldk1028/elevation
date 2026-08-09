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

function exactUsdMicros(value, label) {
	finiteNonnegative(value, label);
	const micros = Math.round(value * 1_000_000);
	if (!Number.isSafeInteger(micros) || Math.abs(micros / 1_000_000 - value) > Number.EPSILON) throw new TypeError(`${label} must use at most six decimal places`);
	return micros;
}

function legacyUsdMicros(value, label) {
	finiteNonnegative(value, label);
	const micros = Math.round(value * 1_000_000);
	if (!Number.isSafeInteger(micros)) throw new TypeError(`${label} exceeds the supported amount`);
	return micros;
}

function legacyCeilingApportionment(entries) {
	const allocations = entries.map(([requestKey, value]) => {
		finiteNonnegative(value?.ceilingUsd, "persisted ceilingUsd");
		finiteNonnegative(value?.estimateUsd, "persisted estimateUsd");
		if (value.estimateUsd > value.ceilingUsd) throw new Error("Invalid paid operation ledger");
		if (value.actualUsd !== null) finiteNonnegative(value.actualUsd, "persisted actualUsd");
		if (value.actualUsd !== null && value.actualUsd > value.ceilingUsd) throw new Error("Invalid paid operation ledger");
		const scaled = value.ceilingUsd * 1_000_000;
		const floor = Math.floor(scaled);
		if (!Number.isSafeInteger(floor)) throw new TypeError("persisted ceilingUsd exceeds the supported amount");
		const estimateMicros = legacyUsdMicros(value.estimateUsd, "persisted estimateUsd");
		const actualMicros = value.actualUsd === null ? null : legacyUsdMicros(value.actualUsd, "persisted actualUsd");
		const dependentRoundingCost = Number(estimateMicros > floor) + Number(actualMicros !== null && actualMicros > floor);
		return { requestKey, floor, fraction: scaled - floor, dependentRoundingCost };
	});
	const stableAllocations = [...allocations].sort((left, right) => left.requestKey < right.requestKey ? -1 : left.requestKey > right.requestKey ? 1 : 0);
	let floorTotal = 0, fractionTotal = 0, fractionCompensation = 0;
	for (const allocation of stableAllocations) {
		floorTotal += allocation.floor;
		if (!Number.isSafeInteger(floorTotal)) throw new TypeError("persisted aggregate ceilingUsd exceeds the supported amount");
		const adjustedFraction = allocation.fraction - fractionCompensation;
		const nextFractionTotal = fractionTotal + adjustedFraction;
		fractionCompensation = (nextFractionTotal - fractionTotal) - adjustedFraction;
		fractionTotal = nextFractionTotal;
	}
	const roundUpCount = Math.round(fractionTotal);
	if (!Number.isSafeInteger(roundUpCount) || roundUpCount < 0 || roundUpCount > allocations.length) {
		throw new TypeError("persisted aggregate ceilingUsd cannot be apportioned safely");
	}
	if (!Number.isSafeInteger(floorTotal + roundUpCount)) throw new TypeError("persisted aggregate ceilingUsd exceeds the supported amount");
	allocations.sort((left, right) => right.dependentRoundingCost - left.dependentRoundingCost
		|| right.fraction - left.fraction
		|| (left.requestKey < right.requestKey ? -1 : left.requestKey > right.requestKey ? 1 : 0));
	const roundUps = new Set(allocations.slice(0, roundUpCount).map(({ requestKey }) => requestKey));
	return new Map(allocations.map(({ requestKey, floor }) => [requestKey, floor + Number(roundUps.has(requestKey))]));
}

function legacyFieldApportionment(entries, usdKey, label, ceilings, { nullable = false } = {}) {
	const allocations = [];
	const result = new Map();
	for (const [requestKey, value] of entries) {
		const raw = value[usdKey];
		if (nullable && raw === null) {
			result.set(requestKey, null);
			continue;
		}
		finiteNonnegative(raw, label);
		const scaled = raw * 1_000_000;
		const floor = Math.floor(scaled);
		if (!Number.isSafeInteger(floor)) throw new TypeError(`${label} exceeds the supported amount`);
		const capacity = ceilings.get(requestKey) - floor;
		if (!Number.isSafeInteger(capacity) || capacity < 0) throw new Error("Invalid paid operation ledger");
		allocations.push({ requestKey, floor, fraction: scaled - floor, capacity });
	}
	const stableAllocations = [...allocations].sort((left, right) => left.requestKey < right.requestKey ? -1 : left.requestKey > right.requestKey ? 1 : 0);
	let floorTotal = 0, fractionTotal = 0, fractionCompensation = 0;
	for (const allocation of stableAllocations) {
		floorTotal += allocation.floor;
		if (!Number.isSafeInteger(floorTotal)) throw new TypeError(`persisted aggregate ${usdKey} exceeds the supported amount`);
		const adjustedFraction = allocation.fraction - fractionCompensation;
		const nextFractionTotal = fractionTotal + adjustedFraction;
		fractionCompensation = (nextFractionTotal - fractionTotal) - adjustedFraction;
		fractionTotal = nextFractionTotal;
	}
	const roundUpCount = Math.round(fractionTotal);
	const candidates = allocations.filter(({ capacity }) => capacity > 0)
		.sort((left, right) => right.fraction - left.fraction
			|| (left.requestKey < right.requestKey ? -1 : left.requestKey > right.requestKey ? 1 : 0));
	if (!Number.isSafeInteger(roundUpCount) || roundUpCount < 0 || roundUpCount > candidates.length
		|| !Number.isSafeInteger(floorTotal + roundUpCount)) {
		throw new TypeError(`persisted aggregate ${usdKey} cannot be apportioned safely`);
	}
	const roundUps = new Set(candidates.slice(0, roundUpCount).map(({ requestKey }) => requestKey));
	for (const { requestKey, floor } of allocations) result.set(requestKey, floor + Number(roundUps.has(requestKey)));
	return result;
}

function exactMicros(value, label) {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a nonnegative safe integer`);
	return value;
}

function moneyMicros(input, microsKey, usdKey, label, { required = true } = {}) {
	const fromMicros = input[microsKey] === undefined ? undefined : exactMicros(input[microsKey], microsKey);
	const fromUsd = input[usdKey] === undefined ? undefined : exactUsdMicros(input[usdKey], usdKey);
	if (fromMicros !== undefined && fromUsd !== undefined && fromMicros !== fromUsd) throw new TypeError(`${label} micro-dollar and USD values must match`);
	const value = fromMicros ?? fromUsd;
	if (required && value === undefined) throw new TypeError(`${label} is required`);
	return value;
}

function validateIdentity(input) {
	const { requestKey, provider, kind, operation } = input;
	if (typeof requestKey !== "string" || !HEX_SHA256.test(requestKey)) throw new TypeError("requestKey must be a lowercase SHA-256 digest");
	if (typeof provider !== "string" || !PROVIDER.test(provider)) throw new TypeError("provider must be a safe identifier");
	if (!ALLOWED_KINDS.has(kind)) throw new TypeError("kind must be image-generation or grammar-extraction");
	const ceilingMicros = moneyMicros(input, "ceilingMicros", "ceilingUsd", "ceiling");
	const estimateMicros = moneyMicros(input, "estimateMicros", "estimateUsd", "estimate");
	const runCeilingMicros = moneyMicros(input, "runCeilingMicros", "runCeilingUsd", "run ceiling", { required: false });
	const kindCeilingMicros = moneyMicros(input, "kindCeilingMicros", "kindCeilingUsd", "kind ceiling", { required: false });
	if (typeof operation !== "function") throw new TypeError("operation must be a function");
	if (estimateMicros > ceilingMicros) throw codedError("PAID_OPERATION_BUDGET_EXCEEDED", "Estimated paid operation cost exceeds its approved ceiling");
	if (runCeilingMicros !== undefined && ceilingMicros > runCeilingMicros) throw codedError("PAID_OPERATION_AGGREGATE_BUDGET_EXCEEDED", "Paid operation ceiling exceeds the approved run budget");
	if (kindCeilingMicros !== undefined && ceilingMicros > kindCeilingMicros) throw codedError("PAID_OPERATION_AGGREGATE_BUDGET_EXCEEDED", "Paid operation ceiling exceeds the approved kind budget");
	return { ...input, requestKey, provider, kind, operation, ceilingMicros, estimateMicros, runCeilingMicros, kindCeilingMicros };
}

function validRemoteId(value) {
	return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\r\n\0]/.test(value);
}

function validateOperationRecord(requestKey, value, version, legacyMoney) {
	if (!HEX_SHA256.test(requestKey) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid paid operation ledger");
	if (typeof value.provider !== "string" || !PROVIDER.test(value.provider) || !ALLOWED_KINDS.has(value.kind)) throw new Error("Invalid paid operation ledger");
	if (!new Set(["submitting", "succeeded"]).has(value.status)) throw new Error("Invalid paid operation ledger");
	const estimateMicros = version === 1 ? legacyMoney.estimateMicros : exactMicros(value.estimateMicros, "persisted estimateMicros");
	const ceilingMicros = version === 1 ? legacyMoney.ceilingMicros : exactMicros(value.ceilingMicros, "persisted ceilingMicros");
	if (estimateMicros > ceilingMicros) throw new Error("Invalid paid operation ledger");
	if (value.remoteId !== null && !validRemoteId(value.remoteId)) throw new Error("Invalid paid operation ledger");
	if (value.artifactSha256 !== null && (typeof value.artifactSha256 !== "string" || !HEX_SHA256.test(value.artifactSha256))) throw new Error("Invalid paid operation ledger");
	const rawActual = version === 1 ? value.actualUsd : value.actualMicros;
	const actualMicros = version === 1 ? legacyMoney.actualMicros
		: rawActual === null ? null : exactMicros(rawActual, "persisted actualMicros");
	if (actualMicros !== null && actualMicros > ceilingMicros) throw new Error("Invalid paid operation ledger");
	if (value.status === "succeeded" && (!validRemoteId(value.remoteId) || !HEX_SHA256.test(value.artifactSha256) || actualMicros === null)) {
		throw new Error("Invalid paid operation ledger");
	}
	return {
		provider: value.provider, kind: value.kind, status: value.status,
		estimateMicros, ceilingMicros, remoteId: value.remoteId,
		artifactSha256: value.artifactSha256, actualMicros,
	};
}

async function readLedger(path, approvedRoot) {
	try {
		await assertSafeSensitiveEntry(approvedRoot, path);
		const parsed = JSON.parse(await readFile(path, "utf8"));
		if (![1, 2].includes(parsed?.version) || !parsed.operations || typeof parsed.operations !== "object" || Array.isArray(parsed.operations)) {
			throw new Error("Invalid paid operation ledger");
		}
		const entries = Object.entries(parsed.operations);
		const legacyCeilings = parsed.version === 1 ? legacyCeilingApportionment(entries) : null;
		const legacyEstimates = parsed.version === 1
			? legacyFieldApportionment(entries, "estimateUsd", "persisted estimateUsd", legacyCeilings)
			: null;
		const legacyActuals = parsed.version === 1
			? legacyFieldApportionment(entries, "actualUsd", "persisted actualUsd", legacyCeilings, { nullable: true })
			: null;
		const operations = Object.fromEntries(entries
			.map(([key, operation]) => [key, validateOperationRecord(key, operation, parsed.version, {
				estimateMicros: legacyEstimates?.get(key), ceilingMicros: legacyCeilings?.get(key), actualMicros: legacyActuals?.get(key),
			})]));
		return { version: 2, operations };
	} catch (error) {
		if (error?.code === "ENOENT") return { version: 2, operations: {} };
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
	const actualMicros = moneyMicros(value, "actualMicros", "actualUsd", "Paid operation result actual cost");
	return { remoteId: value.remoteId, artifactSha256: value.artifactSha256, actualMicros };
}

function publicResult(record) {
	return {
		remoteIdHash: sha256(record.remoteId), artifactSha256: record.artifactSha256,
		actualMicros: record.actualMicros, actualUsd: record.actualMicros / 1_000_000,
	};
}

function assertAggregateBudget(ledger, input) {
	if (input.runCeilingMicros === undefined && input.kindCeilingMicros === undefined) return;
	const operations = Object.values(ledger.operations);
	const runReserved = operations.reduce((sum, operation) => sum + operation.ceilingMicros, 0);
	const kindReserved = operations.filter((operation) => operation.kind === input.kind)
		.reduce((sum, operation) => sum + operation.ceilingMicros, 0);
	if (input.runCeilingMicros !== undefined && runReserved + input.ceilingMicros > input.runCeilingMicros) {
		throw codedError("PAID_OPERATION_AGGREGATE_BUDGET_EXCEEDED", "Paid operation reservations exceed the approved run budget");
	}
	if (input.kindCeilingMicros !== undefined && kindReserved + input.ceilingMicros > input.kindCeilingMicros) {
		throw codedError("PAID_OPERATION_AGGREGATE_BUDGET_EXCEEDED", "Paid operation reservations exceed the approved kind budget");
	}
}

function costSummary(operations) {
	const empty = () => ({ reserved_ceiling_micros: 0, estimated_micros: 0, actual_micros: 0 });
	const total = empty();
	const byKind = Object.fromEntries([...ALLOWED_KINDS].map((kind) => [kind, empty()]));
	for (const operation of operations) {
		for (const target of [total, byKind[operation.kind]]) {
			target.reserved_ceiling_micros += operation.ceilingMicros;
			target.estimated_micros += operation.estimateMicros;
			target.actual_micros += operation.actualMicros ?? 0;
		}
	}
	for (const target of [total, ...Object.values(byKind)]) {
		target.reserved_ceiling_usd = target.reserved_ceiling_micros / 1_000_000;
		target.estimated_usd = target.estimated_micros / 1_000_000;
		target.actual_usd = target.actual_micros / 1_000_000;
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
				const normalizedInput = validateIdentity(input ?? {});
				normalizedInput.signal?.throwIfAborted();
				let token;
				try {
					token = await acquireReservation(lockPath, root, {
						waitMs: lockWaitMs, pollMs: lockPollMs, signal: normalizedInput.signal,
					});
				} catch (error) {
					if (error?.code !== "PAID_OPERATION_RESERVATION_STALE") throw error;
					const staleLedger = await readLedger(ledgerPath, root);
					if (staleLedger.operations[normalizedInput.requestKey]?.status === "submitting") throw uncertainError(normalizedInput.kind);
					throw error;
				}
				try {
					normalizedInput.signal?.throwIfAborted();
					const ledger = await readLedger(ledgerPath, root);
					const existing = ledger.operations[normalizedInput.requestKey];
					if (existing) {
						if (existing.provider !== normalizedInput.provider || existing.kind !== normalizedInput.kind) {
							throw codedError("PAID_OPERATION_IDENTITY_MISMATCH", "Paid operation request key is already bound to a different operation");
						}
						if (existing.status === "succeeded") return publicResult(existing);
						throw uncertainError(normalizedInput.kind);
					}
					assertAggregateBudget(ledger, normalizedInput);
					ledger.operations[normalizedInput.requestKey] = {
						provider: normalizedInput.provider,
						kind: normalizedInput.kind,
						status: "submitting",
						estimateMicros: normalizedInput.estimateMicros,
						ceilingMicros: normalizedInput.ceilingMicros,
						remoteId: null,
						artifactSha256: null,
						actualMicros: null,
					};
					await atomicWrite(ledgerPath, ledger, root);
					const submissionCapability = issueSubmissionCapability({
						requestKey: normalizedInput.requestKey,
						provider: normalizedInput.provider,
						kind: normalizedInput.kind,
						estimateMicros: normalizedInput.estimateMicros,
						ceilingMicros: normalizedInput.ceilingMicros,
					});
					try {
						const result = validateResult(await normalizedInput.operation(submissionCapability));
						if (result.actualMicros > normalizedInput.ceilingMicros) {
							throw codedError("PAID_OPERATION_ACTUAL_BUDGET_EXCEEDED", "Paid operation actual cost exceeds its reserved ceiling");
						}
						ledger.operations[normalizedInput.requestKey] = {
							...ledger.operations[normalizedInput.requestKey], ...result, status: "succeeded",
						};
						await atomicWrite(ledgerPath, ledger, root);
						return publicResult(ledger.operations[normalizedInput.requestKey]);
					} catch (error) {
						const internalRemoteId = takeFacadeProviderRemoteIdForLedger(error)
							?? (validRemoteId(error?.remoteId) ? error.remoteId : null);
						const failure = normalizeProviderFailure(error, normalizedInput.provider, normalizedInput.kind === "image-generation" ? "generate" : "grammar");
						takeFacadeProviderRemoteIdForLedger(failure);
						if (internalRemoteId) {
							ledger.operations[normalizedInput.requestKey].remoteId = internalRemoteId;
							await atomicWrite(ledgerPath, ledger, root);
							throw failure;
						}
						if (failure.definitiveNonSubmission) {
							delete ledger.operations[normalizedInput.requestKey];
							await atomicWrite(ledgerPath, ledger, root);
							throw failure;
						}
						throw uncertainError(normalizedInput.kind);
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
				estimateMicros: operation.estimateMicros,
				ceilingMicros: operation.ceilingMicros,
				estimateUsd: operation.estimateMicros / 1_000_000,
				ceilingUsd: operation.ceilingMicros / 1_000_000,
				remoteIdHash: operation.remoteId ? sha256(operation.remoteId) : null,
				artifactSha256: operation.artifactSha256,
				actualMicros: operation.actualMicros,
				actualUsd: operation.actualMicros === null ? null : operation.actualMicros / 1_000_000,
			}));
			return {
				version: ledger.version,
				operations,
				costs: costSummary(Object.values(ledger.operations)),
			};
		},
	};
}
