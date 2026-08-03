import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { measureCompetitionAxonPixels, renderCompetitionAxons, validateCompetitionAxonManifest } from "../plugins/elevation-3d/lib/competition-axon.mjs";
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

const roleIds = { concrete: [255, 0, 0], glass: [0, 255, 0], bronze: [0, 0, 255], opaque: [255, 255, 0] };

function syntheticPixels({ width = 100, height = 100, bounds = { min_x: 15, min_y: 15, max_x: 84, max_y: 84 }, colors = {} } = {}) {
	const base = Buffer.alloc(width * height * 3, 250), materialId = Buffer.alloc(width * height * 3);
	const roles = Object.keys(roleIds);
	for (let y = bounds.min_y; y <= bounds.max_y; y++) for (let x = bounds.min_x; x <= bounds.max_x; x++) {
		const role = roles[Math.min(roles.length - 1, Math.floor((x - bounds.min_x) / Math.max(1, bounds.max_x - bounds.min_x + 1) * roles.length))];
		const offset = (y * width + x) * 3;
		const rgb = colors[role] ?? [128, 128, 128];
		for (let channel = 0; channel < 3; channel++) { base[offset + channel] = rgb[channel]; materialId[offset + channel] = roleIds[role][channel]; }
	}
	return { base, materialId, width, height };
}

function syntheticManifest(measured, width: number, height: number) {
	return {
		width, height,
		camera: { type: "perspective", margin_ratio: 0.15 },
		clipping: { clipped: false }, context: { intersects_building: false, authoritative: false },
		material_roles: measured.material_roles,
		material_color_separation: measured.material_color_separation,
		building_content: measured.building_content,
	};
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
		assert.equal(view.building_content.source, "material-id-role-union");
		assert.equal(view.building_content.touches_frame, false);
		assert.ok(Object.values(view.building_content.margin_ratios).every((margin) => margin >= 0.12));
		assert.ok(view.building_content.relevant_margin_ratio <= 0.21);
		assert.ok(view.building_content.maximum_margin_ratio <= 0.35);
		assert.equal(Object.keys(view.manifest.material_color_separation.pairwise_distances).length, 6);
		assert.ok(view.manifest.material_color_separation.minimum_pairwise_distance >= view.manifest.material_color_separation.threshold);
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
			assert.equal(record.color_statistic, "10%-trimmed-mean-srgb8");
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

test("rejects nonblack material-role color collapse despite intact material IDs", () => {
	const pixels = syntheticPixels();
	const measured = measureCompetitionAxonPixels(pixels);
	const report = validateCompetitionAxonManifest(syntheticManifest(measured, pixels.width, pixels.height));
	assert.equal(measured.material_roles.concrete.mean_luminance, 128);
	assert.ok(Object.values(measured.material_roles).every((role) => role.visible_pixels > 0));
	assert.ok(report.codes.includes("MATERIAL_ROLE_COLLAPSE"));
});

test("rejects a tiny building fit from actual material-ID bounds", () => {
	const pixels = syntheticPixels({
		bounds: { min_x: 40, min_y: 40, max_x: 59, max_y: 59 },
		colors: { concrete: [210, 200, 185], glass: [155, 185, 195], bronze: [90, 60, 40], opaque: [60, 65, 70] },
	});
	const measured = measureCompetitionAxonPixels(pixels);
	const report = validateCompetitionAxonManifest(syntheticManifest(measured, pixels.width, pixels.height));
	assert.ok(report.codes.includes("WHITE_SPACE_INVALID"));
});
