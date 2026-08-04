import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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
	const temporaryPath = `${path}.tmp-${process.pid}`;
	try {
		await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

export function createPaidTaskLedger(path) {
	const ledgerPath = resolve(path);
	let pending = Promise.resolve();
	const serialize = (operation) => {
		const result = pending.then(operation, operation);
		pending = result.then(() => undefined, () => undefined);
		return result;
	};
	return {
		path: ledgerPath,
		getOrSubmitTask({ key, kind, submit }) {
			return serialize(async () => {
				if (!key || !["import", "texture"].includes(kind)) throw new TypeError("A request key and paid task kind are required");
				const ledger = await readLedger(ledgerPath);
				const existing = ledger.requests[key]?.tasks?.[kind];
				if (existing?.taskId) return existing.taskId;
				if (existing?.status === "submitting") {
					const error = new Error(`Refusing to resubmit uncertain ${kind} task; reconcile provider state manually`);
					error.code = "PAID_TASK_SUBMISSION_UNCERTAIN";
					throw error;
				}
				const request = ledger.requests[key] ?? { tasks: {} };
				request.tasks[kind] = { taskId: null, status: "submitting", consumedCredits: null };
				ledger.requests[key] = request;
				await atomicWrite(ledgerPath, ledger);
				const taskId = await submit();
				if (typeof taskId !== "string" || taskId.length === 0) throw new Error("Provider did not return a task ID");
				request.tasks[kind] = { taskId, status: "submitted", consumedCredits: null };
				await atomicWrite(ledgerPath, ledger);
				return taskId;
			});
		},
		recordStatus({ key, kind, status, consumedCredits = null }) {
			return serialize(async () => {
				const ledger = await readLedger(ledgerPath);
				const task = ledger.requests[key]?.tasks?.[kind];
				if (!task) throw new Error(`Cannot update missing ${kind} task`);
				task.status = status;
				task.consumedCredits = consumedCredits;
				await atomicWrite(ledgerPath, ledger);
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
