import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { prepareRun } from "../plugins/elevation-3d/lib/core.mjs";
import { captureCanvas, finalizeResults, renderDrawings } from "../plugins/elevation-3d/lib/results.mjs";
import { resolveElevation3dAssets } from "./helpers/elevation3d-assets.ts";

const DATASET = resolveElevation3dAssets({ start: dirname(fileURLToPath(import.meta.url)), datasetOverride: process.env.ELEVATION3D_DATASET_ROOT, glbOverride: process.env.ELEVATION3D_SELECTED_GLB }).datasetRoot;
const brief = { summary_ko: "교육시설", materials: ["벽돌"], window_rhythm: "층 정렬", ground_floor: "유리", roof: "평지붕", negative_constraints: ["형상 변경 금지"] };

test("downloads terminal results, verifies geometry, and builds viewer", async () => {
	const output = await mkdtemp(join(tmpdir(), "elevation3d-results-"));
	try {
		const plan = await prepareRun({ datasetRoot: DATASET, candidateId: "creative-004", facadeBrief: brief, outputRoot: output, runId: "results-run" });
		const sourceObj = plan.source_obj;
		const sourcePng = plan.source_views.front;
		const downloader = async (url: string, destination: string) => copyFile(url.endsWith(".obj") ? sourceObj : sourcePng, destination);
		const state: any = { state: "verifying", strategies: { hunyuan: { status: "succeeded", files: [{ type: "OBJ", url: "https://x/result.obj" }] }, wan_projection: { status: "succeeded", images: Array.from({ length: 5 }, (_, i) => `https://x/${i}.png`) } } };
		const result = await finalizeResults({ plan, state, downloader, render: false });
		assert.equal(result.strategies.hunyuan.geometry.accepted, true);
		assert.equal(result.strategies.wan_projection.status, "accepted");
		await stat(join(plan.run_dir, "viewer", "index.html"));
		const manifest = JSON.parse(await readFile(join(plan.run_dir, "manifest.json"), "utf8"));
		assert.equal(manifest.state, "completed");
		assert.equal(manifest.outputs.wan_views.length, 5);
	} finally { await rm(output, { recursive: true, force: true }); }
});

test("captures the canvas through Puppeteer's ElementHandle API", async () => {
	const calls: any[] = [];
	const page = { $: async (selector: string) => selector === "canvas" ? { screenshot: async (options: any) => calls.push(options) } : null };
	await captureCanvas(page, "drawing.png");
	assert.deepEqual(calls, [{ path: "drawing.png" }]);
});

test("render cancellation closes the current page, browser, and preview before stopping views", async () => {
	const controller = new AbortController();
	const calls: string[] = [];
	const page = {
		setViewport: async () => calls.push("viewport"),
		goto: async () => { calls.push("goto"); controller.abort(new DOMException("stop", "AbortError")); },
		waitForFunction: async () => calls.push("wait"),
		close: async () => calls.push("page.close"),
	};
	const browser = {
		newPage: async () => { calls.push("newPage"); return page; },
		close: async () => calls.push("browser.close"),
	};
	await assert.rejects(() => renderDrawings("run", ["hunyuan"], {
		views: ["front", "right"],
		signal: controller.signal,
		lifecycle: {
			startPreview: async () => "http://127.0.0.1:4180/",
			stopPreview: async () => calls.push("preview.stop"),
			launchBrowser: async () => browser,
		},
	}), { name: "AbortError" });
	assert.deepEqual(calls, ["newPage", "viewport", "goto", "page.close", "browser.close", "preview.stop"]);
});
