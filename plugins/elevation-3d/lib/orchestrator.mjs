import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertExecutionApproved, redactSecrets } from "./core.mjs";
import { resolvePreparedImages } from "./images.mjs";
import { buildHunyuanRequest, createHunyuanProvider } from "./providers/hunyuan.mjs";
import { buildWanRequest, createWanProvider } from "./providers/wan.mjs";
import { finalizeResults } from "./results.mjs";

async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function writeJson(path, value) { await writeFile(path, JSON.stringify(redactSecrets(value), null, 2)); }

async function dependencies(deps) {
	if (deps) {
		if (!deps.hunyuan || !deps.wan) throw new Error("both Hunyuan and Wan dependencies must be available before submission");
		return deps;
	}
	const [hunyuan, wan] = await Promise.all([createHunyuanProvider(), Promise.resolve(createWanProvider())]);
	return { hunyuan, wan };
}

export async function executeRun({ planPath, approvalId, confirmLive, approvedMaxCostCny, deps }) {
	const plan = await readJson(resolve(planPath));
	assertExecutionApproved(plan, { approvalId, confirmLive, approvedMaxCostCny });
	const providers = await dependencies(deps);
	const statePath = join(plan.run_dir, "state.json");
	const state = await readJson(statePath);
	if (typeof state.strategies.hunyuan === "object" || typeof state.strategies.wan_projection === "object") throw new Error("Run already submitted; use elevation_3d_resume");
	const providerDir = join(plan.run_dir, "providers");
	await mkdir(providerDir, { recursive: true });
	const cosKey = `elevation-3d/${plan.run_id}/mass.obj`;
	const [fileUrl, images] = await Promise.all([providers.hunyuan.stageFile(plan.source_obj, cosKey), resolvePreparedImages(plan)]);
	const hRequest = buildHunyuanRequest({ fileUrl, prompt: plan.prompts.hunyuan_zh, plan });
	const wRequest = buildWanRequest({ images, prompt: plan.prompts.wan_en, plan });
	await Promise.all([writeJson(join(providerDir, "hunyuan-request.json"), hRequest), writeJson(join(providerDir, "wan-request.json"), wRequest)]);
	const [hResult, wResult] = await Promise.allSettled([providers.hunyuan.submit(hRequest), providers.wan.submit(wRequest)]);
	state.state = "submitted";
	state.approved_max_cost_cny = approvedMaxCostCny;
	state.strategies.hunyuan = hResult.status === "fulfilled" ? { status: "submitted", job_id: hResult.value.JobId, request_id: hResult.value.RequestId, cos_key: cosKey } : { status: "failed", message: String(hResult.reason?.message ?? hResult.reason) };
	state.strategies.wan_projection = wResult.status === "fulfilled" ? { status: wResult.value.status, job_id: wResult.value.task_id } : { status: "failed", message: String(wResult.reason?.message ?? wResult.reason) };
	await writeJson(statePath, state);
	return state;
}

export async function resumeRun({ runDir, deps, wait = false }) {
	const dir = resolve(runDir);
	const providers = await dependencies(deps);
	const statePath = join(dir, "state.json");
	const state = await readJson(statePath);
	const poll = async () => {
		const jobs = [];
		if (state.strategies.hunyuan?.job_id && state.strategies.hunyuan.status !== "failed") jobs.push(providers.hunyuan.status(state.strategies.hunyuan.job_id).then((value) => { state.strategies.hunyuan = { ...state.strategies.hunyuan, ...value }; }));
		if (state.strategies.wan_projection?.job_id && state.strategies.wan_projection.status !== "failed") jobs.push(providers.wan.status(state.strategies.wan_projection.job_id).then((value) => { state.strategies.wan_projection = { ...state.strategies.wan_projection, ...value }; }));
		await Promise.all(jobs);
		const statuses = [state.strategies.hunyuan?.status, state.strategies.wan_projection?.status];
		state.state = statuses.every((x) => ["succeeded", "failed"].includes(x)) ? (statuses.includes("succeeded") ? "verifying" : "failed") : "running";
		await writeJson(statePath, state);
	};
	do {
		await poll();
		if (state.state === "verifying") {
			const plan = await readJson(join(dir, "plan.json"));
			const result = await finalizeResults({ plan, state });
			if (state.strategies.hunyuan?.cos_key && providers.hunyuan.cleanup) await providers.hunyuan.cleanup(state.strategies.hunyuan.cos_key);
			return result;
		}
		if (!wait || state.state !== "running") break;
		await new Promise((resolve) => setTimeout(resolve, 10_000));
	} while (true);
	return state;
}
