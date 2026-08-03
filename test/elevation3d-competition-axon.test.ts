import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { renderCompetitionAxons } from "../plugins/elevation-3d/lib/competition-axon.mjs";
import { sha256 } from "../plugins/elevation-3d/lib/core.mjs";
import { resolveMaterialPalette } from "../plugins/elevation-3d/lib/material-palettes.mjs";
import { resolveElevation3dAssets } from "./helpers/elevation3d-assets.ts";

const assets = resolveElevation3dAssets({
	start: dirname(fileURLToPath(import.meta.url)),
	datasetOverride: process.env.ELEVATION3D_DATASET_ROOT,
	glbOverride: process.env.ELEVATION3D_SELECTED_GLB,
});
const runDir = join(dirname(assets.datasetRoot), "elevation-3d-e2e-results", "creative-013", "competition-all-views-20260803-001");
const cameras = {
	axon: { name: "axon", projection: "perspective", position: [38, -38, 42.55], target: [0, 0, 4.95], up: [0, 0, 1], fov_degrees: 32 },
	"opposite-axon": { name: "opposite-axon", projection: "perspective", position: [-38, 38, 42.55], target: [0, 0, 4.95], up: [0, 0, 1], fov_degrees: 32 },
};

function dot(left: number[], right: number[]) {
	return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

test("renders opposing presentation cameras from one GLB", { timeout: 180_000 }, async () => {
	const palette = resolveMaterialPalette("competition-warm");
	const result = await renderCompetitionAxons({
		runDir,
		glbPath: assets.selectedGlb,
		palette,
		cameras,
		candidateId: "creative-013",
	});
	assert.deepEqual(Object.keys(result.views).sort(), ["axon", "opposite-axon"]);
	assert.equal(result.views.axon.selected_glb_sha256, result.views["opposite-axon"].selected_glb_sha256);
	assert.equal(result.views.axon.selected_glb_sha256, sha256(await readFile(assets.selectedGlb)));
	assert.ok(dot(result.views.axon.camera.depth, result.views["opposite-axon"].camera.depth) < -0.8);
	assert.notEqual(result.views.axon.sha256, result.views["opposite-axon"].sha256);
	for (const [name, view] of Object.entries(result.views)) {
		assert.deepEqual(await sharp(view.path).metadata().then(({ width, height }) => [width, height]), [2400, 2400]);
		assert.match(view.path, new RegExp(`views[\\\\/]${name.replace("-", "[-]")}[\\\\/]${name}\\.png$`));
		assert.equal(view.validation.accepted, true, `${name}: ${view.validation.codes.join(", ")}`);
		assert.equal(view.camera.type, "perspective");
		assert.ok(view.camera.fov_degrees >= 28 && view.camera.fov_degrees <= 36);
		assert.ok(view.camera.margin_ratio >= 0.12 && view.camera.margin_ratio <= 0.18);
		assert.equal(view.clipping.clipped, false);
		assert.equal(view.context.intersects_building, false);
		assert.equal(view.context.authoritative, false);
		assert.equal(view.context.group_identity, "competition-axon-context");
		assert.equal(view.lights.contact_shadow.bounded, true);
		assert.deepEqual(Object.keys(view.material_roles).sort(), ["bronze", "concrete", "glass", "opaque"]);
		for (const [role, record] of Object.entries(view.material_roles)) {
			assert.equal(record.axon_pbr, palette.roles[role].axon_pbr);
			assert.equal(record.roughness, palette.roles[role].roughness);
			assert.equal(record.metalness, palette.roles[role].metalness);
			assert.equal(record.opacity, palette.roles[role].opacity);
			assert.equal(record.texture_intensity, palette.roles[role].texture_intensity);
			assert.equal(record.normal_intensity, palette.roles[role].normal_intensity);
			assert.ok(record.visible_pixels > 0, `${name} ${role} collapsed`);
			assert.ok(record.mean_luminance > 20, `${name} ${role} rendered black`);
			assert.ok(record.color_distance_to_black > 30, `${name} ${role} lost its PBR color`);
		}
		for (const record of [view, view.manifest_record, view.validation_report, view.diagnostics.material_id]) {
			assert.equal(sha256(await readFile(record.path)), record.sha256);
		}
	}
	assert.equal(result.validation.accepted, true);
	assert.deepEqual(result.validation.codes, []);
});

test("rejects paired camera bearings that are not sufficiently opposed", async () => {
	await assert.rejects(() => renderCompetitionAxons({
		runDir,
		glbPath: assets.selectedGlb,
		palette: resolveMaterialPalette("competition-warm"),
		cameras: { axon: cameras.axon, "opposite-axon": { ...cameras.axon, name: "opposite-axon" } },
		candidateId: "creative-013",
	}), /camera opposition must be below -0\.8/);
});
