import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
	assert.deepEqual(result.palette, { preset: "competition-warm", sha256: resolveMaterialPalette("competition-warm").sha256 });
	for (const [name, view] of Object.entries(result.views)) {
		assert.equal(view.validation.accepted, true, `${name}: ${view.validation.codes.join(", ")}`);
		assert.deepEqual(await sharp(view.final_png.path).metadata().then(({ width, height }) => [width, height]), [2400, 2400]);
		assert.deepEqual([view.width, view.height], [2400, 2400]);
		assert.equal(view.camera.type, "orthographic");
		assert.deepEqual(view.palette, result.palette);
		assert.deepEqual(view.displayed_dimensions.levels, [0, 3300, 6600, 9900]);
		for (const record of [view.final_png, view.presentation_base_png, view.annotations_svg, view.dimensions_json, view.base_manifest, view.render_manifest, view.validation_report, ...Object.values(view.diagnostics)]) {
			assert.equal(sha256(await readFile(record.path)), record.sha256, `${name}: ${record.path}`);
		}
	}
});

async function verifiedViews() {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-cross-view-"));
	const diagnostics = {};
	for (const name of ["front", "back", "left", "right"]) {
		diagnostics[name] = {};
		for (const diagnostic of ["material_id", "depth", "normal"]) {
			const path = join(root, `${name}-${diagnostic}.png`);
			await writeFile(path, Buffer.from(`${name}:${diagnostic}:persisted-pixels`));
			diagnostics[name][diagnostic] = { path, sha256: sha256(await readFile(path)) };
		}
	}
	const palette = { preset: "competition-warm", sha256: "palette-warm-sha256" };
	const view = (name: string, hash = "selected") => ({
		selected_glb_sha256: hash,
		palette,
		width: 2400,
		height: 2400,
		validation: { accepted: true, codes: [], metrics: { canonical_svg_mismatch: false } },
		displayed_dimensions: { levels: [0, 3300, 6600, 9900] },
		base: { clipping: { applied: false } },
		diagnostics: diagnostics[name],
	});
	return { root, views: Object.fromEntries(["front", "back", "left", "right"].map((name) => [name, view(name)])) };
}

test("rejects a right elevation produced from a different selected GLB", async () => {
	const fixture = await verifiedViews();
	try {
		fixture.views.right.selected_glb_sha256 = "substituted";
		await assert.rejects(() => buildMultiElevationManifest(fixture.views), /one selected GLB SHA-256/);
	} finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("rejects incomplete cross-view levels and missing persisted diagnostics", async () => {
	const fixture = await verifiedViews();
	try {
		fixture.views.left.displayed_dimensions.levels.pop();
		await assert.rejects(() => buildMultiElevationManifest(fixture.views), /same four levels/);
		fixture.views.left.displayed_dimensions.levels = [0, 3300, 6600, 9900];
		await unlink(fixture.views.right.diagnostics.normal.path);
		await assert.rejects(() => buildMultiElevationManifest(fixture.views), /right normal diagnostic file is not resolvable/);
	} finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("rejects hash-tampered persisted diagnostics", async () => {
	const fixture = await verifiedViews();
	try {
		await writeFile(fixture.views.back.diagnostics.depth.path, Buffer.from("tampered persisted pixels"));
		await assert.rejects(() => buildMultiElevationManifest(fixture.views), /back depth diagnostic SHA-256 does not match/);
	} finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("rejects mixed resolved palettes", async () => {
	const fixture = await verifiedViews();
	try {
		fixture.views.right.palette = { preset: "competition-neutral", sha256: "palette-neutral-sha256" };
		await assert.rejects(() => buildMultiElevationManifest(fixture.views), /one resolved palette SHA-256/);
	} finally { await rm(fixture.root, { recursive: true, force: true }); }
});
