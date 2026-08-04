import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { sha256 } from "../core.mjs";
import { findChrome } from "../results.mjs";
import { startPreview, stopPreview } from "../preview.mjs";
import { buildViewerBundle } from "../viewer.mjs";

const VIEW_NAMES = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];

export function validateEmbeddedPbrRender({ views, selectedGlbSha256, consoleErrors, materialMode }) {
	const codes = [];
	const records = VIEW_NAMES.map((name) => views?.[name]).filter(Boolean);
	if (records.length !== VIEW_NAMES.length) codes.push("VIEWS_INCOMPLETE");
	if (records.some((record) => record.selectedGlbSha256 !== selectedGlbSha256)) codes.push("SELECTED_GLB_MISMATCH");
	if (new Set(records.map((record) => record.sha256)).size !== records.length) codes.push("VIEWS_DUPLICATE");
	if (records.some((record) => new Set(record.settledHashes ?? []).size !== 1)) codes.push("RENDER_UNSTABLE");
	if (records.some((record) => !(record.foregroundFraction > 0.01 && record.foregroundFraction < 0.9))) codes.push("CAMERA_FRAMING_INVALID");
	if ((consoleErrors ?? []).length > 0) codes.push("CONSOLE_ERROR");
	if (materialMode !== "embedded-pbr") codes.push("MATERIAL_MODE_INVALID");
	const unique = [...new Set(codes)];
	return { accepted: unique.length === 0, status: unique.length === 0 ? "accepted" : "rejected", codes: unique };
}

function decodePng(dataUrl) {
	const match = /^data:image\/png;base64,(.+)$/s.exec(dataUrl);
	if (!match) throw new Error("viewer returned an invalid PNG data URL");
	return Buffer.from(match[1], "base64");
}

async function foregroundFraction(bytes) {
	const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
	const background = [data[0], data[1], data[2]];
	let foreground = 0;
	for (let offset = 0; offset < data.length; offset += 3) {
		if (Math.hypot(data[offset] - background[0], data[offset + 1] - background[1], data[offset + 2] - background[2]) > 8) foreground += 1;
	}
	return foreground / (info.width * info.height);
}

export async function renderEmbeddedPbrViews({ glbPath, runDir, candidateId, cameras, outputSize = 1600, signal, lifecycle = {} } = {}) {
	const root = resolve(runDir);
	await mkdir(root, { recursive: true });
	const glbBytes = await readFile(resolve(glbPath));
	const selectedGlbSha256 = sha256(glbBytes);
	const config = {
		schema_version: "arr.elevation3d.embedded-pbr-viewer.v1",
		candidate_id: candidateId,
		strategies: { hunyuan: { glb: "../textured.glb" } },
		cameras: { views: cameras },
		all_views: {
			material_mode: "embedded-pbr",
			selected_glb: { path: "../textured.glb", sha256: selectedGlbSha256 },
			palettes: {}, views: {}, validation: { accepted: true, codes: [] }, artifacts: [],
		},
	};
	await buildViewerBundle({ runDir: root, config });
	await copyFile(resolve(glbPath), join(root, "textured.glb"));
	const start = lifecycle.startPreview ?? startPreview;
	const stop = lifecycle.stopPreview ?? stopPreview;
	const launch = lifecycle.launchBrowser ?? (async () => puppeteer.launch({
		executablePath: await findChrome(), headless: true,
		args: ["--disable-gpu-sandbox", "--no-sandbox", "--use-angle=swiftshader"],
	}));
	let browser, page, previewPort;
	const consoleErrors = [];
	try {
		signal?.throwIfAborted();
		const base = await start(root, 0);
		previewPort = Number(new URL(base).port);
		browser = await launch();
		page = await browser.newPage();
		page.on("pageerror", (error) => consoleErrors.push(error.message));
		page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
		await page.setViewport({ width: outputSize, height: outputSize, deviceScaleFactor: 1 });
		await page.goto(`${base}?strategy=hunyuan`, { waitUntil: "networkidle0" });
		await page.waitForFunction(() => globalThis.__ELEVATION3D_READY__ === true, { timeout: 60_000 });
		const views = {};
		for (const name of VIEW_NAMES) {
			signal?.throwIfAborted();
			await page.evaluate((view) => globalThis.__ELEVATION3D_TEST_CONTROLS__.activateView(view), name);
			const [firstUrl, secondUrl] = await page.evaluate(async () => {
				const first = await globalThis.__ELEVATION3D_TEST_CONTROLS__.settledPng();
				const second = await globalThis.__ELEVATION3D_TEST_CONTROLS__.settledPng();
				return [first, second];
			});
			const first = decodePng(firstUrl), second = decodePng(secondUrl);
			const directory = join(root, "views", name);
			await mkdir(directory, { recursive: true });
			const path = join(directory, `${name}.png`);
			await writeFile(path, second);
			views[name] = {
				path, sha256: sha256(second), settledHashes: [sha256(first), sha256(second)], selectedGlbSha256,
				foregroundFraction: await foregroundFraction(second),
			};
		}
		const validation = validateEmbeddedPbrRender({ views, selectedGlbSha256, consoleErrors, materialMode: "embedded-pbr" });
		const thumbnails = await Promise.all(VIEW_NAMES.map((name) => sharp(views[name].path).resize(500, 500).png().toBuffer()));
		const contactSheetPath = join(root, "contact-sheet.png");
		await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#fafaf7" } })
			.composite(thumbnails.map((input, index) => ({ input, left: (index % 4) * 500, top: Math.floor(index / 4) * 500 })))
			.png().toFile(contactSheetPath);
		const report = {
			schema_version: "arr.elevation3d.embedded-pbr-render.v1",
			selected_glb: { path: resolve(glbPath), sha256: selectedGlbSha256 }, material_mode: "embedded-pbr", views,
			console_errors: consoleErrors,
			contact_sheet: { path: contactSheetPath, sha256: sha256(await readFile(contactSheetPath)) }, validation,
		};
		await writeFile(join(root, "render-validation.json"), `${JSON.stringify(report, null, 2)}\n`);
		return report;
	} finally {
		await page?.close().catch(() => {});
		await browser?.close().catch(() => {});
		if (previewPort) await stop(previewPort).catch(() => {});
	}
}
