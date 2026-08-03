import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { sha256 } from "../plugins/elevation-3d/lib/core.mjs";
import { resolveMaterialPalette } from "../plugins/elevation-3d/lib/material-palettes.mjs";
import { buildMultiElevationManifest, renderCompetitionElevations } from "../plugins/elevation-3d/lib/multi-elevation.mjs";
import { resolveElevation3dAssets } from "./helpers/elevation3d-assets.ts";

const assets = resolveElevation3dAssets({
	start: dirname(fileURLToPath(import.meta.url)),
	datasetOverride: process.env.ELEVATION3D_DATASET_ROOT,
	glbOverride: process.env.ELEVATION3D_SELECTED_GLB,
});
const massRoot = join(assets.datasetRoot, "candidates", "creative-013", "mass");
const stableRunRoot = join(dirname(assets.datasetRoot), "elevation-3d-e2e-results", "creative-013", "competition-all-views-20260803-001");

async function realInputs() {
	const [sourceMesh, floorGuides, facadePlanes, cameraManifest] = await Promise.all([
		readFile(join(massRoot, "mesh/indexed-mesh.json"), "utf8").then(JSON.parse),
		readFile(join(massRoot, "elevation-research/floor-guides.json"), "utf8").then(JSON.parse),
		readFile(join(massRoot, "elevation-research/facade-planes.json"), "utf8").then(JSON.parse),
		readFile(join(massRoot, "elevation-research/camera-poses.json"), "utf8").then(JSON.parse),
	]);
	const cameras = Object.fromEntries(["front", "back", "left", "right"].map((name) => [name, {
		name,
		identity: cameraManifest.identity,
		...cameraManifest.views[name],
	}]));
	return {
		runDir: stableRunRoot,
		glbPath: assets.selectedGlb,
		sourceMesh,
		floorGuides,
		facadePlanes,
		cameras,
		palette: resolveMaterialPalette("competition-warm"),
		candidateId: "creative-013",
	};
}

test("renders four accepted elevations from one selected GLB", { timeout: 600_000 }, async () => {
	const result = await renderCompetitionElevations(await realInputs());
	assert.deepEqual(Object.keys(result.views).sort(), ["back", "front", "left", "right"]);
	assert.equal(new Set(Object.values(result.views).map((view) => view.selected_glb_sha256)).size, 1);
	assert.equal(new Set(Object.values(result.views).map((view) => view.camera.px_per_m_x)).size, 1);
	for (const [name, view] of Object.entries(result.views)) {
		assert.equal(view.validation.accepted, true, `${name}: ${view.validation.codes.join(", ")}`);
		assert.deepEqual(await sharp(view.final_png.path).metadata().then(({ width, height }) => [width, height]), [2400, 2400]);
		assert.deepEqual([view.width, view.height], [2400, 2400]);
		assert.equal(view.camera.type, "orthographic");
		assert.deepEqual(view.displayed_dimensions.levels, [0, 3300, 6600, 9900]);
		for (const record of [view.final_png, view.presentation_base_png, view.annotations_svg, view.dimensions_json, view.base_manifest, view.render_manifest, view.validation_report, ...Object.values(view.diagnostics)]) {
			assert.equal(sha256(await readFile(record.path)), record.sha256, `${name}: ${record.path}`);
		}
	}
});

test("rejects a right elevation produced from a different selected GLB", () => {
	const view = (hash: string) => ({
		selected_glb_sha256: hash,
		width: 2400,
		height: 2400,
		validation: { accepted: true, codes: [], metrics: { canonical_svg_mismatch: false } },
		displayed_dimensions: { levels: [0, 3300, 6600, 9900] },
		base: { clipping: { applied: false } },
		diagnostics: {},
	});
	assert.throws(() => buildMultiElevationManifest({
		front: view("selected"),
		back: view("selected"),
		left: view("selected"),
		right: view("substituted"),
	}), /one selected GLB SHA-256/);
});

test("rejects incomplete cross-view levels and diagnostics", () => {
	const validView = {
		selected_glb_sha256: "selected",
		width: 2400,
		height: 2400,
		validation: { accepted: true, codes: [], metrics: { canonical_svg_mismatch: false } },
		displayed_dimensions: { levels: [0, 3300, 6600, 9900] },
		base: { clipping: { applied: false } },
		diagnostics: {
			material_id: { path: "material.png", sha256: "material" },
			depth: { path: "depth.png", sha256: "depth" },
			normal: { path: "normal.png", sha256: "normal" },
		},
	};
	const views = Object.fromEntries(["front", "back", "left", "right"].map((name) => [name, structuredClone(validView)]));
	views.left.displayed_dimensions.levels.pop();
	assert.throws(() => buildMultiElevationManifest(views), /same four levels/);
	views.left = structuredClone(validView);
	delete views.right.diagnostics.normal;
	assert.throws(() => buildMultiElevationManifest(views), /right normal diagnostic hash is not resolvable/);
});
