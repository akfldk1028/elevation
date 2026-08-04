import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { prepareRun } from "../plugins/elevation-3d/lib/core.mjs";
import { executeRun, resumeRun } from "../plugins/elevation-3d/lib/orchestrator.mjs";
import { resolveElevation3dAssets } from "./helpers/elevation3d-assets.ts";

const DATASET = resolveElevation3dAssets({ start: dirname(fileURLToPath(import.meta.url)), datasetOverride: process.env.ELEVATION3D_DATASET_ROOT, glbOverride: process.env.ELEVATION3D_SELECTED_GLB }).datasetRoot;
const dirs: string[] = [];
const brief = { summary_ko: "현대 교육시설", materials: ["벽돌"], window_rhythm: "층 정렬", ground_floor: "투명", roof: "평지붕", negative_constraints: ["형상 변경 금지"] };

afterEach(async () => Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

test("submits each provider once and resume only polls stored job IDs", async () => {
	const output = await mkdtemp(join(tmpdir(), "elevation3d-orchestrator-"));
	dirs.push(output);
	const plan = await prepareRun({ datasetRoot: DATASET, candidateId: "creative-004", facadeBrief: brief, outputRoot: output, runId: "test-run" });
	const calls = { hSubmit: 0, wSubmit: 0, hStatus: 0, wStatus: 0 };
	const deps = {
		hunyuan: {
			stageFile: async () => "https://cos.test/mass.obj?signature=x",
			submit: async () => { calls.hSubmit++; return { JobId: "h-1", RequestId: "hr-1" }; },
			status: async () => { calls.hStatus++; return { status: "running", files: [] }; },
		},
		wan: {
			submit: async () => { calls.wSubmit++; return { status: "pending", task_id: "w-1", images: [] }; },
			status: async () => { calls.wStatus++; return { status: "running", task_id: "w-1", images: [] }; },
		},
	};

	await executeRun({ planPath: join(plan.run_dir, "plan.json"), approvalId: plan.approval_id, confirmLive: true, approvedMaxCostCny: 6.1, deps });
	await resumeRun({ runDir: plan.run_dir, deps, wait: false });

	assert.deepEqual(calls, { hSubmit: 1, wSubmit: 1, hStatus: 1, wStatus: 1 });
	const state = JSON.parse(await readFile(join(plan.run_dir, "state.json"), "utf8"));
	assert.equal(state.strategies.hunyuan.job_id, "h-1");
	assert.equal(state.strategies.wan_projection.job_id, "w-1");
	assert.equal(JSON.stringify(state).includes("signature=x"), false);
});

test("does not submit either provider when one dependency is missing", async () => {
	const output = await mkdtemp(join(tmpdir(), "elevation3d-orchestrator-missing-"));
	dirs.push(output);
	const plan = await prepareRun({ datasetRoot: DATASET, candidateId: "creative-004", facadeBrief: brief, outputRoot: output, runId: "missing-run" });
	let submitted = 0;
	await assert.rejects(() => executeRun({ planPath: join(plan.run_dir, "plan.json"), approvalId: plan.approval_id, confirmLive: true, approvedMaxCostCny: 6.1, deps: { hunyuan: { submit: async () => submitted++ } } as any }), /both Hunyuan and Wan/);
	assert.equal(submitted, 0);
});
