import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { renderCompetitionElevation } from "../plugins/elevation-3d/lib/competition-elevation.mjs";
import { sha256 } from "../plugins/elevation-3d/lib/core.mjs";
import { deriveElevationDimensions } from "../plugins/elevation-3d/lib/elevation-dimensions.mjs";
import { resolveMaterialPalette } from "../plugins/elevation-3d/lib/material-palettes.mjs";
import { validateCompetitionElevation } from "../plugins/elevation-3d/lib/elevation-presentation-validation.mjs";
import { resolveElevation3dAssets } from "./helpers/elevation3d-assets.ts";

const assets = resolveElevation3dAssets({ start: dirname(fileURLToPath(import.meta.url)), datasetOverride: process.env.ELEVATION3D_DATASET_ROOT, glbOverride: process.env.ELEVATION3D_SELECTED_GLB });
const massRoot = join(assets.datasetRoot, "candidates", "creative-013", "mass");
const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function inputs() {
	const [sourceMesh, floorGuides, facadePlanes, cameras, glbBytes] = await Promise.all([
		readFile(join(massRoot, "mesh/indexed-mesh.json"), "utf8").then(JSON.parse),
		readFile(join(massRoot, "elevation-research/floor-guides.json"), "utf8").then(JSON.parse),
		readFile(join(massRoot, "elevation-research/facade-planes.json"), "utf8").then(JSON.parse),
		readFile(join(massRoot, "elevation-research/camera-poses.json"), "utf8").then(JSON.parse),
		readFile(assets.selectedGlb),
	]);
	const camera = { name: "front", identity: cameras.identity, ...cameras.views.front };
	const dimensions = await deriveElevationDimensions({ sourceMesh, floorGuides, facadePlanes, artifact: { path: assets.selectedGlb, sha256: sha256(glbBytes) }, view: camera });
	return { sourceMesh, floorGuides, facadePlanes, camera, dimensions };
}

test("renders and accepts a dimensioned creative-013 front with complete provenance", { timeout: 180_000 }, async () => {
	const runDir = await mkdtemp(join(tmpdir(), "elevation3d-final-front-")); roots.push(runDir);
	const input = await inputs();
	const palette = resolveMaterialPalette("competition-warm");
	const artifacts = await renderCompetitionElevation({ runDir, glbPath: assets.selectedGlb, ...input, palette, view: "front", candidateId: "creative-013" });
	assert.deepEqual(await sharp(artifacts.final_png.path).metadata().then(({ width, height }) => [width, height]), [2400, 2400]);
	assert.equal(artifacts.validation.accepted, true);
	assert.deepEqual(artifacts.validation.codes, []);
	assert.deepEqual(artifacts.displayed_dimensions.levels, [0, 3300, 6600, 9900]);
	assert.deepEqual(artifacts.displayed_dimensions.floor_intervals, [3300, 3300, 3300]);
	assert.equal(artifacts.displayed_dimensions.overall_height, 9900);
	assert.equal(artifacts.presentation.authored_dark_geometry.invalid_pixels, 0);
	assert.ok(artifacts.presentation.authored_dark_geometry.valid_pixels > 0);
	for (const record of [artifacts.final_png, artifacts.annotations_svg, artifacts.dimensions_json, artifacts.render_manifest, artifacts.validation_report]) {
		assert.equal(sha256(await readFile(record.path)), record.sha256);
	}
});

test("rejects a one-millimetre dimension tamper and visible seam overload", async () => {
	const input = await inputs();
	const report = await validateCompetitionElevation({
		artifacts: {
			base: { width: 2400, height: 2400, selected_glb_sha256: input.dimensions.selected_glb_sha256, camera: { ...input.camera, type: "orthographic", px_per_m_x: 80, px_per_m_y: 80 }, content_bounds_px: { min_x: 216, min_y: 800, max_x: 2183, max_y: 1599 }, diagnostics: { total_edge_density: 0.06, strong_edge_density: 0.04, same_material_seam_fraction: 0.002, seam_segments: { connected_at_least_12px: 2 }, role_pixel_counts: { concrete: 1, glass: 1, bronze: 1, opaque: 1 } } },
			dimensions: { ...input.dimensions, overall_height: { ...input.dimensions.overall_height, display_mm: 9901 } },
			annotation: { overlaps_content: false, overlaps_annotations: false, min_page_clearance_px: 48 },
		},
		sourceMesh: input.sourceMesh, facadePlanes: input.facadePlanes, floorGuides: input.floorGuides,
		view: input.camera, selectedGlbPath: assets.selectedGlb,
	});
	assert.equal(report.accepted, false);
	assert.ok(report.codes.includes("DIMENSION_MISMATCH"));
	assert.ok(report.codes.includes("LINE_DENSITY_EXCEEDED"));
	assert.ok(report.codes.includes("TRIANGULATION_VISIBLE"));
});
