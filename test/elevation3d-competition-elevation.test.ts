import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { renderCompetitionElevationBase } from "../plugins/elevation-3d/lib/competition-elevation.mjs";
import { sha256 } from "../plugins/elevation-3d/lib/core.mjs";
import { deriveElevationDimensions } from "../plugins/elevation-3d/lib/elevation-dimensions.mjs";
import { resolveMaterialPalette } from "../plugins/elevation-3d/lib/material-palettes.mjs";
import { resolveElevation3dAssets } from "./helpers/elevation3d-assets.ts";

const assets = resolveElevation3dAssets({
	start: dirname(fileURLToPath(import.meta.url)),
	datasetOverride: process.env.ELEVATION3D_DATASET_ROOT,
	glbOverride: process.env.ELEVATION3D_SELECTED_GLB,
});
const datasetMassRoot = join(assets.datasetRoot, "candidates", "creative-013", "mass");
const selectedGlbPath = assets.selectedGlb;
const temporaryRoots: string[] = [];

after(async () => Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true }))));

async function creative013Inputs() {
	const [sourceMesh, floorGuides, facadePlanes, cameras, glbBytes] = await Promise.all([
		readFile(`${datasetMassRoot}/mesh/indexed-mesh.json`, "utf8").then(JSON.parse),
		readFile(`${datasetMassRoot}/elevation-research/floor-guides.json`, "utf8").then(JSON.parse),
		readFile(`${datasetMassRoot}/elevation-research/facade-planes.json`, "utf8").then(JSON.parse),
		readFile(`${datasetMassRoot}/elevation-research/camera-poses.json`, "utf8").then(JSON.parse),
		readFile(selectedGlbPath),
	]);
	const camera = { name: "front", identity: cameras.identity, ...cameras.views.front };
	const dimensions = await deriveElevationDimensions({
		sourceMesh,
		floorGuides,
		facadePlanes,
		artifact: { path: selectedGlbPath, sha256: sha256(glbBytes) },
		view: camera,
	});
	return { sourceMesh, camera, dimensions, glbBytes };
}

test("renders the real creative-013 front with one orthographic pixel scale and nine-percent width margins", { timeout: 120_000 }, async () => {
	const runDir = await mkdtemp(join(tmpdir(), "elevation3d-competition-front-"));
	temporaryRoots.push(runDir);
	const inputs = await creative013Inputs();
	const palette = resolveMaterialPalette("competition-warm");
	const artifact = await renderCompetitionElevationBase({
		runDir,
		glbPath: selectedGlbPath,
		sourceMesh: inputs.sourceMesh,
		camera: inputs.camera,
		palette,
		dimensions: inputs.dimensions,
		view: "front",
	});

	assert.equal(artifact.width, 2400);
	assert.equal(artifact.height, 2400);
	assert.equal(artifact.camera.type, "orthographic");
	assert.ok(Math.abs(artifact.camera.px_per_m_x - artifact.camera.px_per_m_y) / artifact.camera.px_per_m_x <= 0.0025);
	assert.ok(artifact.content_bounds_px.min_x >= 192 && artifact.content_bounds_px.min_x <= 240);
	assert.ok(artifact.content_bounds_px.max_x >= 2159 && artifact.content_bounds_px.max_x <= 2207);
	const pixelAspect = (artifact.content_bounds_px.max_x - artifact.content_bounds_px.min_x + 1)
		/ (artifact.content_bounds_px.max_y - artifact.content_bounds_px.min_y + 1);
	const loadedAspect = (artifact.projected_bounds_m.max[0] - artifact.projected_bounds_m.min[0])
		/ (artifact.projected_bounds_m.max[1] - artifact.projected_bounds_m.min[1]);
	const exactMassAspect = (artifact.exact_mass_projected_bounds_m.max[0] - artifact.exact_mass_projected_bounds_m.min[0])
		/ (artifact.exact_mass_projected_bounds_m.max[1] - artifact.exact_mass_projected_bounds_m.min[1]);
	assert.ok(Math.abs(pixelAspect / loadedAspect - 1) <= 0.01, `unexpected loaded-scene content aspect ${pixelAspect}`);
	assert.ok(Math.abs(loadedAspect / 2.49712 - 1) <= 0.01, `unexpected loaded-scene world aspect ${loadedAspect}`);
	assert.ok(Math.abs(exactMassAspect / 2.460756 - 1) <= 0.001, `unexpected exact-MASS aspect ${exactMassAspect}`);
	assert.ok(artifact.projected_bounds_m.min[0] < artifact.exact_mass_projected_bounds_m.min[0]);
	assert.ok(artifact.projected_bounds_m.max[0] > artifact.exact_mass_projected_bounds_m.max[0]);
	assert.equal(artifact.clipping.applied, false);
	assert.equal(artifact.palette_sha256, palette.sha256);
	assert.equal(artifact.selected_glb_sha256, sha256(inputs.glbBytes));
	assert.match(artifact.viewer_config_sha256, /^[a-f0-9]{64}$/);
	assert.deepEqual(artifact.material_roles.slice().sort(), ["bronze", "concrete", "glass", "opaque"]);
	assert.deepEqual(artifact.line_pass, {
		internal_triangle_edges: false,
		per_primitive_edges: false,
		depth_silhouette: true,
	});
	assert.ok(artifact.diagnostics.background_fraction >= 0.55);
	assert.ok(artifact.diagnostics.dark_pixel_fraction <= 0.07);
	assert.ok(artifact.diagnostics.total_edge_density >= 0.01 && artifact.diagnostics.total_edge_density <= 0.035);
	assert.ok(artifact.diagnostics.strong_edge_density <= 0.015);
	assert.ok(artifact.diagnostics.same_material_seam_fraction <= 0.001);
	assert.equal(artifact.diagnostics.seam_diagnostics_source, "base+material-id+metric-depth+view-normal");
	assert.equal(artifact.diagnostics.seam_segments.connected_at_least_12px, 0);
	assert.equal(artifact.diagnostics.depth.encoding, "orthographic-linear-rgb24");
	assert.ok(artifact.diagnostics.depth.max_m > artifact.diagnostics.depth.min_m);
	assert.ok(artifact.diagnostics.depth.quantization_m < 0.0005);
	assert.ok(artifact.diagnostics.normal.non_background_pixels > 0);
	assert.ok(artifact.diagnostics.normal.channel_variance.some((value) => value > 0));
	const contentArea = (artifact.content_bounds_px.max_x - artifact.content_bounds_px.min_x + 1)
		* (artifact.content_bounds_px.max_y - artifact.content_bounds_px.min_y + 1);
	for (const role of ["concrete", "glass", "bronze", "opaque"]) {
		assert.ok(artifact.diagnostics.role_pixel_counts[role] >= contentArea * 0.002, `${role} is not visibly represented`);
	}
	assert.ok(artifact.diagnostics.palette_delta_e00.concrete_glass >= 10);
	assert.ok(artifact.diagnostics.palette_delta_e00.concrete_bronze >= 22);
	assert.ok(artifact.diagnostics.palette_delta_e00.glass_bronze >= 18);
	assert.ok(artifact.diagnostics.palette_delta_e00.concrete_opaque >= 18);
	assert.ok(artifact.annotation_lanes.level.min_x >= artifact.content_bounds_px.max_x + 48);

	for (const path of [artifact.path, artifact.diagnostic_paths.material_id, artifact.diagnostic_paths.depth, artifact.diagnostic_paths.normal]) {
		await stat(path);
		assert.deepEqual(await sharp(path).metadata().then(({ width, height }) => [width, height]), [2400, 2400]);
	}
});

test("competition render cancellation closes page, browser, and preview", { timeout: 120_000 }, async () => {
	const runDir = await mkdtemp(join(tmpdir(), "elevation3d-competition-abort-"));
	temporaryRoots.push(runDir);
	const inputs = await creative013Inputs();
	const controller = new AbortController();
	const calls: string[] = [];
	const page = {
		on: () => {},
		setViewport: async () => calls.push("viewport"),
		goto: async () => { calls.push("goto"); controller.abort(new DOMException("stop", "AbortError")); },
		waitForFunction: async () => calls.push("wait"),
		close: async () => calls.push("page.close"),
	};
	const browser = {
		newPage: async () => { calls.push("newPage"); return page; },
		close: async () => calls.push("browser.close"),
	};
	await assert.rejects(() => renderCompetitionElevationBase({
		runDir,
		glbPath: selectedGlbPath,
		sourceMesh: inputs.sourceMesh,
		camera: inputs.camera,
		palette: resolveMaterialPalette("competition-warm"),
		dimensions: inputs.dimensions,
		view: "front",
		signal: controller.signal,
		lifecycle: {
			startPreview: async () => "http://127.0.0.1:4180/viewer/",
			stopPreview: async () => calls.push("preview.stop"),
			launchBrowser: async () => browser,
		},
	}), { name: "AbortError" });
	assert.deepEqual(calls, ["newPage", "viewport", "goto", "wait", "page.close", "browser.close", "preview.stop"]);
});

test("rejects alternate views before starting the renderer", async () => {
	const inputs = await creative013Inputs();
	await assert.rejects(() => renderCompetitionElevationBase({
		runDir: "unused",
		glbPath: selectedGlbPath,
		sourceMesh: inputs.sourceMesh,
		camera: inputs.camera,
		palette: resolveMaterialPalette("competition-warm"),
		dimensions: inputs.dimensions,
		view: "right",
	}), /front view required/);
});
