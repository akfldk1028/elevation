import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { renderAllViews, validateAllViewsRun, verifyPersistedAllViewsArtifacts } from "../plugins/elevation-3d/lib/all-views.mjs";
import { sha256 } from "../plugins/elevation-3d/lib/core.mjs";
import { deriveDeliveryCameras } from "../plugins/elevation-3d/lib/final-delivery.mjs";
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

test("derived axon cameras retain opposite horizontal depth headings", async () => {
	const input = await realInputs();
	const cameras = deriveDeliveryCameras({ mesh: input.sourceMesh, cameras: { identity: input.cameras.front.identity, views: input.cameras } });
	const horizontalDepth = (camera: any) => {
		const vector = [camera.target[0] - camera.position[0], camera.target[1] - camera.position[1]];
		const length = Math.hypot(...vector);
		return vector.map((value) => value / length);
	};
	const axon = horizontalDepth(cameras.axon);
	const opposite = horizontalDepth(cameras["opposite-axon"]);
	assert.ok(axon[0] * opposite[0] + axon[1] * opposite[1] < -0.8);
});

test("packages one inspectable GLB and eight accepted views", { timeout: 600_000 }, async () => {
	const run = await renderAllViews(await realInputs());
	assert.deepEqual(Object.keys(run.views).sort(), ["axon", "back", "front", "left", "opposite-axon", "plan", "right", "top"]);
	assert.equal(new Set(Object.values(run.views).map((view) => view.selected_glb_sha256)).size, 1);
	assert.equal(run.validation.accepted, true, run.validation.codes.join(", "));
	assert.equal(run.manifest.schema_version, "arr.elevation3d.all-views.v1");
	assert.equal(run.manifest.selected_glb.path, "enriched.glb");
	assert.equal(run.manifest.selected_glb.sha256, sha256(await readFile(join(runDir, "enriched.glb"))));
	assert.equal(run.manifest.viewer.path, "viewer/index.html");
	assert.deepEqual(run.manifest.palette, { preset: "competition-warm", sha256: resolveMaterialPalette("competition-warm").sha256 });
	assert.deepEqual(Object.keys(run.manifest.verified_evidence.views).sort(), Object.keys(run.views).sort());
	const viewerConfig = JSON.parse(await readFile(join(runDir, "viewer", "config.json"), "utf8"));
	assert.deepEqual(Object.keys(viewerConfig.cameras.views).sort(), Object.keys(run.views).sort());
	assert.equal(viewerConfig.cameras.views.plan.cut.elevation_m, 1.2);
	assert.equal(viewerConfig.cameras.views.top.cut.enabled, false);
	for (const view of Object.values(run.views)) {
		assert.deepEqual(await sharp(view.path).metadata().then(({ width, height }) => [width, height]), [2400, 2400]);
		assert.equal(view.selected_glb_sha256, run.manifest.selected_glb.sha256);
	}
});

test("rejects cross-view substitution, duplicates, and invalid viewer geometry", async () => {
	const names = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];
	const views = Object.fromEntries(names.map((name, index) => [name, {
		path: `${name}.png`, sha256: String(index).padStart(64, "a"), width: 2400, height: 2400,
		selected_glb_sha256: "b".repeat(64), palette: { preset: "competition-warm", sha256: "c".repeat(64) }, validation: { accepted: true, codes: [] },
		camera: name === "axon" ? { depth: [1, 0, 0] } : name === "opposite-axon" ? { depth: [-1, 0, 0] } : {},
	}]));
	const cameraViews = {
		front: { type: "orthographic", projection_axes: { horizontal: [1, 0, 0], vertical: [0, 0, 1], depth: [0, -1, 0] }, cut: { enabled: false, elevation_m: null } },
		back: { type: "orthographic", projection_axes: { horizontal: [-1, 0, 0], vertical: [0, 0, 1], depth: [0, 1, 0] }, cut: { enabled: false, elevation_m: null } },
		left: { type: "orthographic", projection_axes: { horizontal: [0, -1, 0], vertical: [0, 0, 1], depth: [-1, 0, 0] }, cut: { enabled: false, elevation_m: null } },
		right: { type: "orthographic", projection_axes: { horizontal: [0, 1, 0], vertical: [0, 0, 1], depth: [1, 0, 0] }, cut: { enabled: false, elevation_m: null } },
		plan: { type: "orthographic", projection_axes: { horizontal: [1, 0, 0], vertical: [0, 1, 0], depth: [0, 0, 1] }, cut: { enabled: true, elevation_m: 1.2 } },
		top: { type: "orthographic", projection_axes: { horizontal: [1, 0, 0], vertical: [0, 1, 0], depth: [0, 0, 1] }, cut: { enabled: false, elevation_m: null } },
		axon: { type: "perspective", depth: [1, 0, 0] },
		"opposite-axon": { type: "perspective", depth: [-1, 0, 0] },
	};
	const controlEvidence = Object.fromEntries(["orbit", "pan", "zoom", "reset", "fullscreen", "view-buttons", "palette-selector", "glb-download"].map((name) => [name, true]));
	const valid = { views, selectedGlbSha256: "b".repeat(64), palette: { preset: "competition-warm", sha256: "c".repeat(64) }, viewer: {
		evidence: { schema_version: "arr.elevation3d.viewer-evidence.v1", html: { sha256: "h" }, app: { sha256: "a" }, config: { sha256: "c" }, controls: controlEvidence },
		config: { strategies: { hunyuan: { glb: "../enriched.glb" } }, cameras: { views: cameraViews }, all_views: { selected_glb: { path: "../enriched.glb", sha256: "b".repeat(64) } } },
	} };
	const validReport = validateAllViewsRun(valid);
	assert.equal(validReport.accepted, true, validReport.codes.join(", "));
	for (const mutate of [
		(value) => { delete value.views.back; },
		(value) => { value.views.right.sha256 = value.views.left.sha256; },
		(value) => { value.views.right.selected_glb_sha256 = "d".repeat(64); },
		(value) => { value.views.right.palette.preset = "competition-neutral"; },
		(value) => { value.views.top.width = 1200; },
		(value) => { value.views.top.sha256 = value.views.plan.sha256; },
		(value) => { value.views["opposite-axon"].camera.depth = [1, 0, 0]; },
		(value) => { value.views.front.validation.accepted = false; },
		(value) => { delete value.viewer.evidence; value.viewer.controls = Object.keys(controlEvidence); },
		(value) => { value.viewer.evidence.controls.fullscreen = false; },
		(value) => { value.viewer.config.cameras.views = {}; },
		(value) => { value.viewer.config.mesh = { vertices: [] }; },
		(value) => { value.viewer.config.strategies.hunyuan.glb = "../alternate.glb"; },
	]) {
		const changed = structuredClone(valid); mutate(changed);
		assert.equal(validateAllViewsRun(changed).accepted, false);
	}
});

async function copyPackagedEvidence() {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-all-views-evidence-"));
	const manifest = JSON.parse(await readFile(join(runDir, "all-views-manifest.json"), "utf8"));
	for (const view of Object.values(manifest.views)) for (const record of [view, view.manifest, view.validation_report]) {
		const destination = join(root, record.path); await mkdir(dirname(destination), { recursive: true });
		await copyFile(join(runDir, record.path), destination);
	}
	await writeFile(join(root, "all-views-manifest.json"), JSON.stringify(manifest, null, 2));
	return { root, manifest };
}

test("rejects a substituted 2400 PNG when manifest and accepted validation remain stale", async () => {
	const fixture = await copyPackagedEvidence();
	try {
		await copyFile(join(fixture.root, fixture.manifest.views.left.path), join(fixture.root, fixture.manifest.views.right.path));
		await assert.rejects(() => verifyPersistedAllViewsArtifacts({ runDir: fixture.root }), /right image SHA-256 does not match verified evidence|right manifest image SHA-256/);
	} finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("rejects a rehashed persisted manifest carrying a mixed palette identity", async () => {
	const fixture = await copyPackagedEvidence();
	try {
		const record = fixture.manifest.views.right.manifest;
		const manifestPath = join(fixture.root, record.path);
		const persisted = JSON.parse(await readFile(manifestPath, "utf8"));
		const neutral = resolveMaterialPalette("competition-neutral");
		persisted.palette = { preset: neutral.preset, sha256: neutral.sha256 };
		persisted.provenance.palette_sha256 = neutral.sha256;
		await writeFile(manifestPath, JSON.stringify(persisted, null, 2));
		record.sha256 = sha256(await readFile(manifestPath));
		delete fixture.manifest.verified_evidence;
		await writeFile(join(fixture.root, "all-views-manifest.json"), JSON.stringify(fixture.manifest, null, 2));
		await assert.rejects(() => verifyPersistedAllViewsArtifacts({ runDir: fixture.root }), /all views must use one persisted palette identity/);
	} finally { await rm(fixture.root, { recursive: true, force: true }); }
});
