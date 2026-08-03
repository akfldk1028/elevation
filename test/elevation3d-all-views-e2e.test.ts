import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { renderAllViews, validateAllViewsRun } from "../plugins/elevation-3d/lib/all-views.mjs";
import { sha256 } from "../plugins/elevation-3d/lib/core.mjs";
import { resolveMaterialPalette } from "../plugins/elevation-3d/lib/material-palettes.mjs";
import { resolveElevation3dAssets } from "./helpers/elevation3d-assets.ts";

const assets = resolveElevation3dAssets({
	start: dirname(fileURLToPath(import.meta.url)),
	datasetOverride: process.env.ELEVATION3D_DATASET_ROOT,
	glbOverride: process.env.ELEVATION3D_SELECTED_GLB,
});
const massRoot = join(assets.datasetRoot, "candidates", "creative-013", "mass");
const runDir = join(dirname(assets.datasetRoot), "elevation-3d-e2e-results", "creative-013", "competition-all-views-20260803-001");

async function realInputs() {
	const [sourceMesh, floorGuides, facadePlanes, cameraManifest] = await Promise.all([
		readFile(join(massRoot, "mesh/indexed-mesh.json"), "utf8").then(JSON.parse),
		readFile(join(massRoot, "elevation-research/floor-guides.json"), "utf8").then(JSON.parse),
		readFile(join(massRoot, "elevation-research/facade-planes.json"), "utf8").then(JSON.parse),
		readFile(join(massRoot, "elevation-research/camera-poses.json"), "utf8").then(JSON.parse),
	]);
	const elevations = Object.fromEntries(["front", "back", "left", "right"].map((name) => [name, {
		name, identity: cameraManifest.identity, ...cameraManifest.views[name],
	}]));
	return {
		runDir,
		glbPath: assets.selectedGlb,
		sourceMesh,
		floorGuides,
		facadePlanes,
		cameras: {
			...elevations,
			top: { name: "top", identity: cameraManifest.identity, ...cameraManifest.views.top },
			axon: { name: "axon", projection: "perspective", position: [38, -38, 42.55], target: [0, 0, 4.95], up: [0, 0, 1], fov_degrees: 32 },
			"opposite-axon": { name: "opposite-axon", projection: "perspective", position: [-38, 38, 42.55], target: [0, 0, 4.95], up: [0, 0, 1], fov_degrees: 32 },
		},
		palette: resolveMaterialPalette("competition-warm"),
		candidateId: "creative-013",
		cutElevationM: 1.2,
	};
}

test("packages one inspectable GLB and eight accepted views", { timeout: 600_000 }, async () => {
	const run = await renderAllViews(await realInputs());
	assert.deepEqual(Object.keys(run.views).sort(), ["axon", "back", "front", "left", "opposite-axon", "plan", "right", "top"]);
	assert.equal(new Set(Object.values(run.views).map((view) => view.selected_glb_sha256)).size, 1);
	assert.equal(run.validation.accepted, true, run.validation.codes.join(", "));
	assert.equal(run.manifest.schema_version, "arr.elevation3d.all-views.v1");
	assert.equal(run.manifest.selected_glb.path, "enriched.glb");
	assert.equal(run.manifest.selected_glb.sha256, sha256(await readFile(join(runDir, "enriched.glb"))));
	assert.equal(run.manifest.viewer.path, "viewer/index.html");
	for (const view of Object.values(run.views)) {
		assert.deepEqual(await sharp(view.path).metadata().then(({ width, height }) => [width, height]), [2400, 2400]);
		assert.equal(view.selected_glb_sha256, run.manifest.selected_glb.sha256);
	}
});

test("rejects cross-view substitution, duplicates, and invalid viewer geometry", async () => {
	const names = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];
	const views = Object.fromEntries(names.map((name, index) => [name, {
		path: `${name}.png`, sha256: String(index).padStart(64, "a"), width: 2400, height: 2400,
		selected_glb_sha256: "b".repeat(64), validation: { accepted: true, codes: [] },
		camera: name === "axon" ? { depth: [1, 0, 0] } : name === "opposite-axon" ? { depth: [-1, 0, 0] } : {},
	}]));
	const valid = { views, selectedGlbSha256: "b".repeat(64), paletteSha256: "c".repeat(64), viewer: {
		controls: ["orbit", "pan", "zoom", "reset", "view-buttons", "palette-selector", "glb-download"],
		config: { strategies: { hunyuan: { glb: "../enriched.glb" } }, all_views: { selected_glb: { path: "../enriched.glb", sha256: "b".repeat(64) } } },
	} };
	assert.equal(validateAllViewsRun(valid).accepted, true);
	for (const mutate of [
		(value) => { delete value.views.back; },
		(value) => { value.views.right.sha256 = value.views.left.sha256; },
		(value) => { value.views.right.selected_glb_sha256 = "d".repeat(64); },
		(value) => { value.views.top.width = 1200; },
		(value) => { value.views.top.sha256 = value.views.plan.sha256; },
		(value) => { value.views["opposite-axon"].camera.depth = [1, 0, 0]; },
		(value) => { value.views.front.validation.accepted = false; },
		(value) => { value.viewer.controls.pop(); },
		(value) => { value.viewer.config.mesh = { vertices: [] }; },
		(value) => { value.viewer.config.strategies.hunyuan.glb = "../alternate.glb"; },
	]) {
		const changed = structuredClone(valid); mutate(changed);
		assert.equal(validateAllViewsRun(changed).accepted, false);
	}
});
