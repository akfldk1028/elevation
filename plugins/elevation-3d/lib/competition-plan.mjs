import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { sha256, stableJson } from "./core.mjs";
import { validateCompetitionPlanTopArtifact, validateCompetitionPlanTopPair } from "./elevation-presentation-validation.mjs";
import { startPreview, stopPreview } from "./preview.mjs";
import { findChrome } from "./results.mjs";
import { buildViewerBundle } from "./viewer.mjs";

const OUTPUT_SIZE = 2400;

function validHorizontalTopAxes(axes) {
	const valid = (axis) => Array.isArray(axis) && axis.length === 3 && axis.every((value) => typeof value === "number" && Number.isFinite(value));
	if (!valid(axes?.horizontal) || !valid(axes?.vertical) || !valid(axes?.depth)) return false;
	const dot = (left, right) => left.reduce((sum, value, index) => sum + value * right[index], 0);
	const length = (axis) => Math.sqrt(dot(axis, axis));
	const [horizontal, vertical, depth] = [axes.horizontal, axes.vertical, axes.depth];
	const determinant = horizontal[0] * (vertical[1] * depth[2] - vertical[2] * depth[1])
		- horizontal[1] * (vertical[0] * depth[2] - vertical[2] * depth[0])
		+ horizontal[2] * (vertical[0] * depth[1] - vertical[1] * depth[0]);
	return [horizontal, vertical, depth].every((axis) => Math.abs(length(axis) - 1) <= 1e-6)
		&& Math.abs(dot(horizontal, vertical)) <= 1e-6
		&& Math.abs(dot(horizontal, depth)) <= 1e-6
		&& Math.abs(dot(vertical, depth)) <= 1e-6
		&& Math.abs(determinant - 1) <= 1e-6
		&& Math.abs(Math.abs(depth[2]) - 1) <= 1e-6
		&& Math.abs(horizontal[2]) <= 1e-6
		&& Math.abs(vertical[2]) <= 1e-6;
}

function assertInputs({ mode, cutElevationM, camera, palette, sourceMesh }) {
	if (mode !== "plan" && mode !== "top") throw new Error(`unsupported competition plan mode: ${mode}`);
	if (mode === "plan" && !Number.isFinite(cutElevationM)) throw new Error("plan cutElevationM must be finite");
	if (camera?.projection !== "orthographic" || camera?.name !== "top") throw new Error("orthographic top camera required");
	const axes = camera.projection_axes;
	if (!validHorizontalTopAxes(axes)) throw new Error("orthonormal right-handed horizontal top camera axes required");
	if (!palette?.sha256 || !palette?.roles) throw new Error("resolved material palette required");
	if (!sourceMesh?.identity?.geometry_hash || !Array.isArray(sourceMesh.vertices)) throw new Error("source exact-MASS mesh required");
}

function decodeDataUrl(dataUrl) {
	const match = /^data:image\/png;base64,(.+)$/s.exec(dataUrl);
	if (!match) throw new Error("competition plan renderer returned an invalid PNG data URL");
	return Buffer.from(match[1], "base64");
}

function contentBounds(raw, width, height) {
	const corners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]];
	const background = [0, 1, 2].map((channel) => Math.round(corners.reduce((sum, [x, y]) => sum + raw[(y * width + x) * 3 + channel], 0) / corners.length));
	let minX = width, minY = height, maxX = -1, maxY = -1, foreground = 0;
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		const offset = (y * width + x) * 3;
		if (Math.hypot(raw[offset] - background[0], raw[offset + 1] - background[1], raw[offset + 2] - background[2]) <= 10) continue;
		minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); foreground++;
	}
	if (maxX < 0) throw new Error("competition plan contains no foreground pixels");
	return { bounds: { min_x: minX, min_y: minY, max_x: maxX, max_y: maxY }, foreground_fraction: foreground / (width * height) };
}

async function writeBrowserPng(page, renderMode, path) {
	const dataUrl = await page.evaluate(async (mode) => globalThis.__ELEVATION3D_RENDER_MODE__(mode), renderMode);
	const bytes = decodeDataUrl(dataUrl);
	await writeFile(path, bytes);
	return bytes;
}

export { validateCompetitionPlanTopPair };

export async function renderCompetitionPlan({
	runDir, glbPath, sourceMesh, camera, palette, mode, cutElevationM, signal, lifecycle = {},
}) {
	assertInputs({ mode, cutElevationM, camera, palette, sourceMesh });
	const root = join(resolve(runDir), "views", mode);
	await mkdir(root, { recursive: true });
	const selectedBytes = await readFile(glbPath);
	const selectedGlbSha256 = sha256(selectedBytes);
	const exactBounds = { min: camera.projected_bounds_m[0], max: camera.projected_bounds_m[1] };
	const config = {
		schema_version: "arr.elevation3d.competition-viewer.v1",
		candidate_id: sourceMesh.identity.candidate_id,
		geometry_hash: sourceMesh.identity.geometry_hash,
		cameras: { views: { top: camera } },
		strategies: { hunyuan: { glb: "selected.glb" } },
		competition_plan: {
			mode,
			output_size: OUTPUT_SIZE,
			margin_ratio: 0.09,
			background: "#fafaf7",
			cut_elevation_m: mode === "plan" ? cutElevationM : null,
			exact_mass_projected_bounds_m: exactBounds,
			palette: { preset: palette.preset, sha256: palette.sha256, roles: palette.roles },
		},
	};
	const viewerConfigSha256 = sha256(stableJson(config));
	await buildViewerBundle({ runDir: root, config });
	await copyFile(glbPath, join(root, "viewer", "selected.glb"));
	const start = lifecycle.startPreview ?? startPreview;
	const stop = lifecycle.stopPreview ?? stopPreview;
	const launch = lifecycle.launchBrowser ?? (async () => puppeteer.launch({
		executablePath: await findChrome(), headless: true, args: ["--disable-gpu-sandbox", "--no-sandbox", "--use-angle=swiftshader"],
	}));
	let browser, page, previewPort;
	const pageErrors = [];
	try {
		signal?.throwIfAborted();
		const base = await start(root, 0);
		previewPort = Number(new URL(base).port);
		browser = await launch();
		page = await browser.newPage();
		page.on?.("pageerror", (error) => pageErrors.push(error.message));
		await page.setViewport({ width: OUTPUT_SIZE, height: OUTPUT_SIZE, deviceScaleFactor: 1 });
		await page.goto(`${base}?strategy=hunyuan&view=top&mode=competition-plan`, { waitUntil: "networkidle0" });
		await page.waitForFunction(() => globalThis.__ELEVATION3D_READY__ === true, { timeout: 60_000 });
		signal?.throwIfAborted();
		if (pageErrors.length) throw new Error(`competition plan viewer failed: ${pageErrors.join("; ")}`);
		const path = join(root, `${mode}.png`);
		const diagnosticPaths = {
			material_id: join(root, `${mode}-material-id.png`),
			depth: join(root, `${mode}-depth.png`),
			normal: join(root, `${mode}-normal.png`),
		};
		// Canvas render state is shared, so captures must remain sequential.
		const bytes = await writeBrowserPng(page, "base", path);
		const materialBytes = await writeBrowserPng(page, "material-id", diagnosticPaths.material_id);
		const depthBytes = await writeBrowserPng(page, "depth", diagnosticPaths.depth);
		const normalBytes = await writeBrowserPng(page, "normal", diagnosticPaths.normal);
		const browserArtifact = await page.evaluate(() => globalThis.__ELEVATION3D_ARTIFACT__);
		const decoded = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
		if (decoded.info.width !== OUTPUT_SIZE || decoded.info.height !== OUTPUT_SIZE) throw new Error("competition plan PNG size invalid");
		const measured = contentBounds(decoded.data, decoded.info.width, decoded.info.height);
		const diagnostics = {
			material_id: { path: diagnosticPaths.material_id, sha256: sha256(materialBytes) },
			depth: { path: diagnosticPaths.depth, sha256: sha256(depthBytes) },
			normal: { path: diagnosticPaths.normal, sha256: sha256(normalBytes) },
		};
		const manifest = {
			schema_version: "arr.elevation3d.competition-plan-top.v1",
			mode,
			selected_glb: { path: glbPath, sha256: selectedGlbSha256 },
			geometry_hash: sourceMesh.identity.geometry_hash,
			camera: browserArtifact.camera,
			projected_bounds_m: browserArtifact.projected_bounds_m,
			exact_mass_projected_bounds_m: exactBounds,
			content_bounds_px: measured.bounds,
			foreground_fraction: measured.foreground_fraction,
			cut: browserArtifact.cut,
			cut_line: browserArtifact.cut_line,
			overhead_context: browserArtifact.overhead_context,
			depth_priority: browserArtifact.depth_priority,
			annotations: { enabled: false, level_labels: [] },
			palette: { preset: palette.preset, sha256: palette.sha256 },
			material_roles: browserArtifact.material_roles,
			viewer_config_sha256: viewerConfigSha256,
			diagnostics,
		};
		const manifestPath = join(root, `${mode}-manifest.json`);
		await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
		const result = {
			path, sha256: sha256(bytes), width: decoded.info.width, height: decoded.info.height,
			manifest, diagnostics,
			manifest_record: { path: manifestPath, sha256: sha256(await readFile(manifestPath)) },
		};
		const validation = await validateCompetitionPlanTopArtifact({ artifact: result, sourceMesh, camera, selectedGlbPath: glbPath, mode, cutElevationM });
		const validationPath = join(root, `${mode}-validation.json`);
		await writeFile(validationPath, JSON.stringify(validation, null, 2));
		return { ...result, validation, validation_report: { path: validationPath, sha256: sha256(await readFile(validationPath)) } };
	} finally {
		try { if (page) await page.close(); }
		finally {
			try { if (browser) await browser.close(); }
			finally { if (previewPort) await stop(previewPort); }
		}
	}
}
