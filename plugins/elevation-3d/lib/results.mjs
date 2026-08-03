import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import puppeteer from "puppeteer-core";
import { loadCandidatePackage, redactSecrets, sha256 } from "./core.mjs";
import { compareGeometry, readGeometry } from "./geometry.mjs";
import { startPreview, stopPreview } from "./preview.mjs";
import { buildViewerBundle } from "./viewer.mjs";

const VIEW_NAMES = ["front", "right", "back", "left", "top"];

export async function downloadUrl(url, destination) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Download failed (${response.status}) for ${new URL(url).origin}${new URL(url).pathname}`);
	await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

export async function captureCanvas(page, path) {
	const canvas = await page.$("canvas");
	if (!canvas) throw new Error("Viewer canvas not found");
	await canvas.screenshot({ path });
}

function safeExtension(file) {
	const byType = { GLB: ".glb", OBJ: ".obj", MTL: ".mtl", ZIP: ".zip", TEXTURE_IMAGE: ".png", IMAGE: ".png" };
	return byType[file.type] ?? (extname(new URL(file.url).pathname) || ".bin");
}

async function findChrome() {
	for (const path of [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"]) {
		if (!path) continue;
		try { await access(path); return path; } catch {}
	}
	throw new Error("Chrome or Edge executable not found; set CHROME_PATH");
}

export async function renderDrawings(runDir, strategies, {
	views = [...VIEW_NAMES, "axon"], port = 0, signal, lifecycle = {},
} = {}) {
	const start = lifecycle.startPreview ?? startPreview;
	const stop = lifecycle.stopPreview ?? stopPreview;
	const launch = lifecycle.launchBrowser ?? (async () => puppeteer.launch({
		executablePath: await findChrome(), headless: true, args: ["--disable-gpu-sandbox", "--no-sandbox"],
	}));
	let browser;
	let previewPort;
	try {
		signal?.throwIfAborted();
		const base = await start(runDir, port);
		previewPort = Number(new URL(base).port);
		signal?.throwIfAborted();
		browser = await launch();
		signal?.throwIfAborted();
		for (const strategy of strategies) {
			const dir = join(runDir, "drawings", strategy); await mkdir(dir, { recursive: true });
			for (const view of views) {
				signal?.throwIfAborted();
				const page = await browser.newPage();
				try {
					await page.setViewport({ width: 2048, height: 2048, deviceScaleFactor: 1 });
					await page.goto(`${base}?strategy=${strategy}&view=${view}`, { waitUntil: "networkidle0" });
					signal?.throwIfAborted();
					await page.waitForFunction(() => globalThis.__ELEVATION3D_READY__ === true, { timeout: 30_000 });
					signal?.throwIfAborted();
					await captureCanvas(page, join(dir, `${view}.png`));
					signal?.throwIfAborted();
				} finally {
					await page.close();
				}
			}
		}
	} finally {
		try { if (browser) await browser.close(); }
		finally { if (previewPort) await stop(previewPort); }
	}
}

export async function finalizeResults({ plan, state, downloader = downloadUrl, render = true }) {
	const input = await loadCandidatePackage(plan.dataset_root, plan.candidate_id);
	const hDir = join(plan.run_dir, "providers", "hunyuan"); const wDir = join(plan.run_dir, "textures", "wan");
	await Promise.all([mkdir(hDir, { recursive: true }), mkdir(wDir, { recursive: true })]);
	const outputs = { hunyuan_files: [], wan_views: [] };
	let hGlb;
	if (state.strategies.hunyuan?.status === "succeeded") {
		for (const [index, file] of (state.strategies.hunyuan.files ?? []).entries()) {
			const destination = join(hDir, `${String(index).padStart(2, "0")}-${file.type.toLowerCase()}${safeExtension(file)}`);
			await downloader(file.url, destination); outputs.hunyuan_files.push(destination);
			if (file.type === "GLB") hGlb = destination;
		}
		const geometryPath = hGlb ?? outputs.hunyuan_files.find((path) => extname(path).toLowerCase() === ".obj");
		if (!geometryPath) state.strategies.hunyuan = { ...state.strategies.hunyuan, status: "quarantined", geometry: { accepted: false, reasons: ["No GLB or OBJ result"] } };
		else {
			const geometry = compareGeometry(input.mesh, await readGeometry(geometryPath), 1e-5);
			state.strategies.hunyuan = { ...state.strategies.hunyuan, status: geometry.accepted ? "accepted" : "quarantined", geometry };
			await writeFile(join(plan.run_dir, "geometry-verification.json"), JSON.stringify(geometry, null, 2));
		}
	}
	if (state.strategies.wan_projection?.status === "succeeded") {
		const urls = state.strategies.wan_projection.images ?? [];
		for (let i = 0; i < Math.min(urls.length, 5); i++) { const destination = join(wDir, `${VIEW_NAMES[i]}.png`); await downloader(urls[i], destination); outputs.wan_views.push(destination); }
		state.strategies.wan_projection = { ...state.strategies.wan_projection, status: outputs.wan_views.length === 5 ? "accepted" : "partial", representation: "view-dependent-projection", coverage_pending_browser_review: true };
	}
	const viewerConfig = { schema_version: plan.schema_version, candidate_id: plan.candidate_id, geometry_hash: plan.identity.geometry_hash, mesh: input.mesh, cameras: input.cameras, strategies: { hunyuan: state.strategies.hunyuan?.status === "accepted" && hGlb ? { glb: `../${hGlb.slice(plan.run_dir.length + 1).replaceAll("\\", "/")}` } : {}, wan_projection: { textures: Object.fromEntries(outputs.wan_views.map((path, index) => [VIEW_NAMES[index], `../${path.slice(plan.run_dir.length + 1).replaceAll("\\", "/")}`])) } } };
	await buildViewerBundle({ runDir: plan.run_dir, config: viewerConfig });
	const accepted = [state.strategies.hunyuan?.status === "accepted" && hGlb ? "hunyuan" : null, state.strategies.wan_projection?.status === "accepted" ? "wan_projection" : null].filter(Boolean);
	if (render && accepted.length) await renderDrawings(plan.run_dir, accepted);
	state.state = accepted.length ? "completed" : state.strategies.hunyuan?.status === "quarantined" || state.strategies.wan_projection?.status === "partial" ? "partial" : "failed";
	const manifest = redactSecrets({ schema_version: plan.schema_version, run_id: plan.run_id, candidate_id: plan.candidate_id, identity: plan.identity, state: state.state, estimated_cost_cny: plan.estimated_cost_cny, strategies: state.strategies, outputs: { hunyuan_files: outputs.hunyuan_files.map((path) => path.slice(plan.run_dir.length + 1)), wan_views: outputs.wan_views.map((path) => path.slice(plan.run_dir.length + 1)), viewer: "viewer/index.html" } });
	await writeFile(join(plan.run_dir, "manifest.json"), JSON.stringify(manifest, null, 2));
	await writeFile(join(plan.run_dir, "state.json"), JSON.stringify(manifest, null, 2));
	return manifest;
}
