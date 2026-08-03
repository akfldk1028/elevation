import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { renderCompetitionPlan, validateCompetitionPlanTopPair } from "../plugins/elevation-3d/lib/competition-plan.mjs";
import { sha256 } from "../plugins/elevation-3d/lib/core.mjs";
import { resolveMaterialPalette } from "../plugins/elevation-3d/lib/material-palettes.mjs";
import { resolveElevation3dAssets } from "./helpers/elevation3d-assets.ts";

const assets = resolveElevation3dAssets({
	start: dirname(fileURLToPath(import.meta.url)),
	datasetOverride: process.env.ELEVATION3D_DATASET_ROOT,
	glbOverride: process.env.ELEVATION3D_SELECTED_GLB,
});
const massRoot = join(assets.datasetRoot, "candidates", "creative-013", "mass");
const stableRunRoot = join(dirname(assets.datasetRoot), "elevation-3d-e2e-results", "creative-013", "competition-all-views-20260803-001");

async function realInputs() {
	const [sourceMesh, cameras] = await Promise.all([
		readFile(join(massRoot, "mesh/indexed-mesh.json"), "utf8").then(JSON.parse),
		readFile(join(massRoot, "elevation-research/camera-poses.json"), "utf8").then(JSON.parse),
	]);
	return {
		runDir: stableRunRoot,
		glbPath: assets.selectedGlb,
		sourceMesh,
		camera: { name: "top", identity: cameras.identity, ...cameras.views.top },
		palette: resolveMaterialPalette("competition-warm"),
	};
}

test("plan is a declared cut and top is an uncut roof projection", { timeout: 600_000 }, async () => {
	const inputs = await realInputs();
	const plan = await renderCompetitionPlan({ ...inputs, mode: "plan", cutElevationM: 1.2 });
	const top = await renderCompetitionPlan({ ...inputs, mode: "top" });

	assert.deepEqual(plan.manifest.cut, { enabled: true, elevation_m: 1.2, plane_world: [0, 0, 1, -1.2] });
	assert.deepEqual(top.manifest.cut, { enabled: false, elevation_m: null, plane_world: null });
	assert.notEqual(plan.sha256, top.sha256);
	assert.equal(plan.manifest.selected_glb.sha256, top.manifest.selected_glb.sha256);
	assert.equal(plan.manifest.selected_glb.sha256, sha256(await readFile(assets.selectedGlb)));
	assert.equal(plan.manifest.geometry_hash, inputs.sourceMesh.identity.geometry_hash);
	assert.equal(top.manifest.geometry_hash, inputs.sourceMesh.identity.geometry_hash);
	assert.deepEqual(plan.manifest.camera.projection_axes, inputs.camera.projection_axes);
	assert.deepEqual(top.manifest.camera.projection_axes, inputs.camera.projection_axes);
	assert.equal(plan.manifest.camera.type, "orthographic");
	assert.equal(top.manifest.camera.type, "orthographic");
	assert.equal(plan.manifest.camera.px_per_m_x, plan.manifest.camera.px_per_m_y);
	assert.equal(top.manifest.camera.px_per_m_x, top.manifest.camera.px_per_m_y);
	assert.equal(plan.manifest.camera.px_per_m_x, top.manifest.camera.px_per_m_x);
	assert.deepEqual(plan.manifest.annotations, { enabled: false, level_labels: [] });
	assert.deepEqual(top.manifest.annotations, { enabled: false, level_labels: [] });
	assert.ok(plan.manifest.cut_line.segment_count > 0);
	assert.ok(plan.manifest.cut_line.width_px >= 3);
	assert.equal(top.manifest.cut_line.segment_count, 0);
	for (const artifact of [plan, top]) {
		assert.deepEqual(await sharp(artifact.path).metadata().then(({ width, height }) => [width, height]), [2400, 2400]);
		assert.deepEqual([artifact.width, artifact.height], [2400, 2400]);
		assert.equal(artifact.validation.accepted, true, artifact.validation.codes.join(", "));
		assert.ok(artifact.validation.metrics.same_material_seam_fraction <= 0.001);
		assert.equal(artifact.validation.metrics.seam_segments.connected_at_least_12px, 0);
		assert.ok(artifact.manifest.content_bounds_px.min_x < 300);
		assert.ok(artifact.manifest.content_bounds_px.max_x > 2100);
		for (const diagnostic of Object.values(artifact.diagnostics)) {
			assert.equal(sha256(await readFile(diagnostic.path)), diagnostic.sha256);
			assert.deepEqual(await sharp(diagnostic.path).metadata().then(({ width, height }) => [width, height]), [2400, 2400]);
		}
		assert.equal(sha256(await readFile(artifact.manifest_record.path)), artifact.manifest_record.sha256);
		assert.equal(sha256(await readFile(artifact.validation_report.path)), artifact.validation_report.sha256);
	}

	const pair = await validateCompetitionPlanTopPair({ plan, top, sourceMesh: inputs.sourceMesh, camera: inputs.camera, selectedGlbPath: assets.selectedGlb });
	assert.equal(pair.accepted, true, pair.codes.join(", "));
});

test("pair validation rejects relabeled top pixels and elevation-only annotations", async () => {
	const inputs = await realInputs();
	const selectedGlbSha256 = sha256(await readFile(assets.selectedGlb));
	const common = {
		sha256: "a".repeat(64),
		width: 2400,
		height: 2400,
		manifest: {
			selected_glb: { path: assets.selectedGlb, sha256: selectedGlbSha256 },
			geometry_hash: inputs.sourceMesh.identity.geometry_hash,
			camera: { type: "orthographic", projection_axes: inputs.camera.projection_axes, px_per_m_x: 80, px_per_m_y: 80 },
			projected_bounds_m: inputs.camera.projected_bounds_m,
			exact_mass_projected_bounds_m: inputs.camera.projected_bounds_m,
			content_bounds_px: { min_x: 220, min_y: 700, max_x: 2180, max_y: 1700 },
			annotations: { enabled: false, level_labels: [] },
		},
	};
	const plan = structuredClone(common);
	plan.manifest.mode = "plan";
	plan.manifest.cut = { enabled: true, elevation_m: 1.2, plane_world: [0, 0, 1, -1.2] };
	const top = structuredClone(common);
	top.manifest.mode = "top";
	top.manifest.cut = { enabled: false, elevation_m: null, plane_world: null };
	let report = await validateCompetitionPlanTopPair({ plan, top, sourceMesh: inputs.sourceMesh, camera: inputs.camera, selectedGlbPath: assets.selectedGlb });
	assert.ok(report.codes.includes("PLAN_TOP_PIXELS_IDENTICAL"));
	top.sha256 = "b".repeat(64);
	top.manifest.annotations = { enabled: true, level_labels: ["EL. +0.000"] };
	report = await validateCompetitionPlanTopPair({ plan, top, sourceMesh: inputs.sourceMesh, camera: inputs.camera, selectedGlbPath: assets.selectedGlb });
	assert.ok(report.codes.includes("PLAN_TOP_LEVEL_ANNOTATION_LEAKAGE"));
});

test("rejects non-unit top camera axes before rendering and in pair validation", async () => {
	const inputs = await realInputs();
	const malformedCamera = structuredClone(inputs.camera);
	malformedCamera.projection_axes = {
		horizontal: [2, 0, 0],
		vertical: [0, 2, 0],
		depth: [0, 0, 1],
	};
	await assert.rejects(
		() => renderCompetitionPlan({ ...inputs, camera: malformedCamera, mode: "top" }),
		/orthonormal right-handed horizontal top camera axes required/,
	);
	const selectedGlbSha256 = sha256(await readFile(assets.selectedGlb));
	const artifact = (mode: "plan" | "top", hash: string) => ({
		sha256: hash,
		width: 2400,
		height: 2400,
		manifest: {
			mode,
			selected_glb: { path: assets.selectedGlb, sha256: selectedGlbSha256 },
			geometry_hash: inputs.sourceMesh.identity.geometry_hash,
			camera: { type: "orthographic", projection_axes: malformedCamera.projection_axes, px_per_m_x: 80, px_per_m_y: 80 },
			exact_mass_projected_bounds_m: { min: malformedCamera.projected_bounds_m[0], max: malformedCamera.projected_bounds_m[1] },
			cut: mode === "plan" ? { enabled: true, elevation_m: 1.2, plane_world: [0, 0, 1, -1.2] } : { enabled: false, elevation_m: null, plane_world: null },
			annotations: { enabled: false, level_labels: [] },
		},
	});
	const report = await validateCompetitionPlanTopPair({
		plan: artifact("plan", "a".repeat(64)),
		top: artifact("top", "b".repeat(64)),
		sourceMesh: inputs.sourceMesh,
		camera: malformedCamera,
		selectedGlbPath: assets.selectedGlb,
	});
	assert.ok(report.codes.includes("PLAN_TOP_CAMERA_INVALID"));
});
