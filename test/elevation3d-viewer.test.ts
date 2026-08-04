import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startPreview, stopPreview } from "../plugins/elevation-3d/lib/preview.mjs";
import { buildViewerBundle } from "../plugins/elevation-3d/lib/viewer.mjs";
import { verifyAllViewsViewer } from "../plugins/elevation-3d/lib/results.mjs";
import { resolveMaterialPalette } from "../plugins/elevation-3d/lib/material-palettes.mjs";
import { resolveElevation3dAssets } from "./helpers/elevation3d-assets.ts";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const assets = resolveElevation3dAssets({ start: dirname(fileURLToPath(import.meta.url)), datasetOverride: process.env.ELEVATION3D_DATASET_ROOT, glbOverride: process.env.ELEVATION3D_SELECTED_GLB });

test("builds a standalone Three.js viewer bundle with locked cameras", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-viewer-"));
	try {
		await buildViewerBundle({ runDir: root, config: { candidate_id: "fixture", geometry_hash: "hash", mesh: { vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], triangles: [[0, 1, 2]] }, cameras: { views: { front: { view_matrix4: [[1,0,0,0],[0,0,1,0],[0,-1,0,0],[0,0,0,1]], projected_bounds_m: [[-1,0],[1,1]] } } }, strategies: {} } });
		await stat(join(root, "viewer", "index.html"));
		await stat(join(root, "viewer", "app.js"));
		const config = JSON.parse(await readFile(join(root, "viewer", "config.json"), "utf8"));
		assert.equal(config.geometry_hash, "hash");
		assert.ok(config.cameras.views.front.view_matrix4);
		assert.match(await readFile(join(root, "viewer", "app.js"), "utf8"), /THREE/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("builds a competition viewer config with one selected GLB and no alternate mesh geometry", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-competition-viewer-"));
	try {
		await buildViewerBundle({
			runDir: root,
			config: {
				candidate_id: "fixture",
				cameras: { views: { front: { projection_axes: { horizontal: [1, 0, 0], vertical: [0, 0, 1], depth: [0, -1, 0] } } } },
				strategies: { hunyuan: { glb: "selected.glb" } },
				competition_elevation: { view: "front", output_size: 2400 },
			},
		});
		const config = JSON.parse(await readFile(join(root, "viewer", "config.json"), "utf8"));
		assert.equal(config.mesh, undefined);
		assert.equal(config.strategies.hunyuan.glb, "selected.glb");
		assert.equal(config.competition_elevation.view, "front");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("serves viewer assets from the returned preview URL", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-preview-"));
	const port = 44000 + Math.floor(Math.random() * 1000);
	try {
		await buildViewerBundle({ runDir: root, config: { candidate_id: "fixture", mesh: { vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], triangles: [[0, 1, 2]] }, cameras: { views: {} }, strategies: {} } });
		const base = await startPreview(root, port);
		assert.equal(base, `http://127.0.0.1:${port}/viewer/`);
		assert.equal((await fetch(base)).status, 200);
		assert.equal((await fetch(new URL("app.js", base))).status, 200);
		assert.equal((await fetch(new URL("config.json", base))).status, 200);
	} finally {
		await stopPreview(port);
		await rm(root, { recursive: true, force: true });
	}
});

test("assigns isolated ephemeral ports and stops previews independently", async () => {
	const roots = await Promise.all([
		mkdtemp(join(tmpdir(), "elevation3d-preview-a-")),
		mkdtemp(join(tmpdir(), "elevation3d-preview-b-")),
	]);
	let ports: number[] = [];
	try {
		await Promise.all(roots.map(async (root, index) => {
			await mkdir(join(root, "viewer"), { recursive: true });
			await writeFile(join(root, "viewer", "index.html"), `preview-${index}`);
		}));
		const urls = await Promise.all(roots.map((root) => startPreview(root, 0)));
		ports = urls.map((url) => Number(new URL(url).port));
		assert.notEqual(ports[0], ports[1]);
		await stopPreview(ports[0]);
		await assert.rejects(fetch(urls[0]));
		assert.equal(await (await fetch(urls[1])).text(), "preview-1");
		await stopPreview(ports[1]);
		await assert.rejects(fetch(urls[1]));
	} finally {
		await Promise.all([...new Set(ports)].map((port) => stopPreview(port)));
		await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	}
});

test("interactive all-views viewer loads one GLB and exposes controls without reload", { timeout: 120_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-all-views-viewer-"));
	try {
		const palettes = Object.fromEntries(["warm", "neutral", "stone"].map((name) => [name, resolveMaterialPalette(`competition-${name}`)]));
		const names = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];
		const orthographic = (depth, vertical = [0, 0, 1]) => ({ type: "orthographic", projection_axes: { horizontal: [1, 0, 0], vertical, depth }, frustum: { left: -15, right: 15, top: 15, bottom: -15, near: 0.1, far: 300 } });
		const cameraViews = {
			front: orthographic([0, -1, 0]), back: orthographic([0, 1, 0]), left: orthographic([-1, 0, 0]), right: orthographic([1, 0, 0]),
			plan: { ...orthographic([0, 0, 1], [0, 1, 0]), cut: { enabled: true, elevation_m: 1.2, plane_world: [0, 0, 1, -1.2] } },
			top: { ...orthographic([0, 0, 1], [0, 1, 0]), cut: { enabled: false, elevation_m: null, plane_world: null } },
			axon: { type: "perspective", position: [40, -40, 45], target: [0, 0, 5], up: [0, 0, 1], fov_degrees: 32, near: 1, far: 200, depth: [0.707, -0.707, 0] },
			"opposite-axon": { type: "perspective", position: [-40, 40, 45], target: [0, 0, 5], up: [0, 0, 1], fov_degrees: 32, near: 1, far: 200, depth: [-0.707, 0.707, 0] },
		};
		await buildViewerBundle({ runDir: root, config: {
			candidate_id: "creative-013", strategies: { hunyuan: { glb: "../enriched.glb" } }, cameras: { views: cameraViews },
			all_views: { selected_glb: { path: "../enriched.glb", sha256: "a".repeat(64) }, palettes, views: Object.fromEntries(names.map((name) => [name, {}])), validation: { accepted: true, codes: [] }, artifacts: [] },
		} });
		await copyFile(assets.selectedGlb, join(root, "enriched.glb"));
		const verification = await verifyAllViewsViewer({ runDir: root });
		assert.deepEqual(verification.activated_views.sort(), names.sort());
		assert.deepEqual(verification.activated_palettes.sort(), ["neutral", "stone", "warm"]);
		assert.equal(verification.validation_badge, "Accepted");
		assert.match(verification.glb_download, /enriched\.glb$/);
		assert.equal(verification.glb_load_count, 1);
		assert.equal(verification.rotated, true); assert.equal(verification.zoomed, true);
		assert.equal(verification.fullscreen_control, true); assert.ok(verification.fullscreen_requests >= 1);
		assert.equal(verification.camera_presets.front.type, "orthographic");
		assert.notDeepEqual(verification.camera_presets.front.position, verification.camera_presets.back.position);
		assert.equal(verification.camera_presets.plan.clipping.enabled, true);
		assert.equal(verification.camera_presets.plan.clipping.elevation_m, 1.2);
		assert.equal(verification.camera_presets.top.clipping.enabled, false);
		assert.equal(verification.camera_presets.axon.type, "perspective");
		assert.ok(verification.camera_presets.axon.depth.reduce((sum, value, index) => sum + value * verification.camera_presets["opposite-axon"].depth[index], 0) < -0.8);
		assert.equal(verification.material_stability.transparent_depth_writers, 0);
		assert.equal(verification.material_stability.facade_detail_meshes > 0, true);
		assert.equal(
			verification.material_stability.polygon_offset_facade_details,
			verification.material_stability.facade_detail_meshes,
		);
		assert.equal(verification.material_stability.deterministic_render_order, true);
		assert.equal(verification.settled_frames_identical, true);
		assert.equal(new Set(verification.settled_frame_hashes).size, 1);
		assert.deepEqual(verification.console_errors, []);
		await stat(verification.screenshots.initial);
		await stat(verification.screenshots.interacted);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
