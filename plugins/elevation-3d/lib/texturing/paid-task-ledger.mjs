import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function stable(value) {
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
	}
	return value;
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

export function texturingRequestKey(input) {
	return sha256(JSON.stringify(stable(input)));
}

async function readLedger(path) {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		if (parsed?.version !== 1 || !parsed.requests || typeof parsed.requests !== "object") throw new Error("Invalid paid task ledger");
		return parsed;
	} catch (error) {
		if (error?.code === "ENOENT") return { version: 1, requests: {} };
		throw error;
	}
}

async function atomicWrite(path, value) {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
	try {
		await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

function codedError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

function pidIsAlive(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return null;
	try { process.kill(pid, 0); return true; }
	catch (error) { return error?.code === "ESRCH" ? false : true; }
}

async function acquireReservation(lockPath, { waitMs, pollMs, signal }) {
	const token = randomUUID(), started = Date.now();
	await mkdir(dirname(lockPath), { recursive: true });
	for (;;) {
		signal?.throwIfAborted();
		try {
			await writeFile(lockPath, `${JSON.stringify({ version: 1, token, pid: process.pid, created_at: new Date().toISOString() })}\n`, { flag: "wx", encoding: "utf8" });
			return token;
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
		}
		let owner;
		try { owner = JSON.parse(await readFile(lockPath, "utf8")); }
		catch (error) {
			if (error?.code === "ENOENT") continue;
			throw codedError("PAID_TASK_RESERVATION_UNCERTAIN", "Paid task reservation owner cannot be proven; refusing submission");
		}
		const alive = pidIsAlive(owner?.pid);
		if (alive === false) {
			throw codedError("PAID_TASK_RESERVATION_STALE", "Paid task reservation owner is not alive; refusing submission");
		}
		if (Date.now() - started >= waitMs) throw codedError("PAID_TASK_RESERVATION_TIMEOUT", "Timed out waiting for the paid task reservation");
		await delay(Math.min(pollMs, Math.max(1, waitMs - (Date.now() - started))), undefined, { signal });
	}
}

async function releaseReservation(lockPath, token) {
	let owner;
	try { owner = JSON.parse(await readFile(lockPath, "utf8")); }
	catch (error) { if (error?.code === "ENOENT") return; throw error; }
	if (owner?.token !== token || owner?.pid !== process.pid) return;
	await unlink(lockPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
}

export function createPaidTaskLedger(path, { lockWaitMs = 5_000, lockPollMs = 25 } = {}) {
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
		getOrSubmitTask({ key, kind, submit, signal }) {
			return serialize(async () => {
				if (!key || !["import", "texture"].includes(kind)) throw new TypeError("A request key and paid task kind are required");
				const token = await acquireReservation(lockPath, { waitMs: lockWaitMs, pollMs: lockPollMs, signal });
				try {
					signal?.throwIfAborted();
					const ledger = await readLedger(ledgerPath);
					const existing = ledger.requests[key]?.tasks?.[kind];
					if (existing?.taskId) return existing.taskId;
					if (existing?.status === "submitting") throw codedError("PAID_TASK_SUBMISSION_UNCERTAIN", `Refusing to resubmit uncertain ${kind} task; reconcile provider state manually`);
					const request = ledger.requests[key] ?? { tasks: {} };
					request.tasks[kind] = { taskId: null, status: "submitting", consumedCredits: null };
					ledger.requests[key] = request;
					await atomicWrite(ledgerPath, ledger);
					const taskId = await submit();
					if (typeof taskId !== "string" || taskId.length === 0) throw new Error("Provider did not return a task ID");
					request.tasks[kind] = { taskId, status: "submitted", consumedCredits: null };
					await atomicWrite(ledgerPath, ledger);
					return taskId;
				} finally { await releaseReservation(lockPath, token); }
			});
		},
		recordStatus({ key, kind, status, consumedCredits = null, signal }) {
			return serialize(async () => {
				const token = await acquireReservation(lockPath, { waitMs: lockWaitMs, pollMs: lockPollMs, signal });
				try {
					const ledger = await readLedger(ledgerPath);
					const task = ledger.requests[key]?.tasks?.[kind];
					if (!task) throw new Error(`Cannot update missing ${kind} task`);
					task.status = status;
					task.consumedCredits = consumedCredits;
					await atomicWrite(ledgerPath, ledger);
				} finally { await releaseReservation(lockPath, token); }
			});
		},
		async summary() {
			await pending;
			const ledger = await readLedger(ledgerPath);
			const tasks = [];
			for (const [requestKey, request] of Object.entries(ledger.requests)) {
				for (const [kind, task] of Object.entries(request.tasks ?? {})) tasks.push({
					requestKey,
					kind,
					taskHash: task.taskId ? sha256(task.taskId) : null,
					status: task.status,
					consumedCredits: task.consumedCredits,
				});
			}
			return { version: ledger.version, tasks };
		},
	};
}
