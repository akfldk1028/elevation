import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, test } from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";

import { loadCandidatePackage, sha256 } from "../plugins/elevation-3d/lib/core.mjs";
import { deriveExpectedCameraContract, presentationCameraPresets, technicalCameraAuthorityFromGlb } from "../plugins/elevation-3d/lib/camera-authority.mjs";
import { buildEnrichedScene, writeEnrichedGlb } from "../plugins/elevation-3d/lib/enrichment.mjs";
import { deliverSelectedAllViews, FinalDeliveryError } from "../plugins/elevation-3d/lib/final-delivery.mjs";
import { GeneratedStageError, runElevation3d } from "../plugins/elevation-3d/lib/unified-flow.mjs";
import * as unifiedFlow from "../plugins/elevation-3d/lib/unified-flow.mjs";

const temporaryRoots: string[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
	process.chdir(originalCwd);
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeJson(path: string, value: unknown) {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-flow-"));
	temporaryRoots.push(root);
	const candidateId = "creative-013";
	const candidateRoot = join(root, "dataset", "candidates", candidateId);
	const massRoot = join(candidateRoot, "mass");
	const researchRoot = join(massRoot, "elevation-research");
	const mesh = {
		identity: { geometry_hash: "geometry-sha256" },
		vertices: [
			[-2, -1, 0], [2, -1, 0], [2, 1, 0], [-2, 1, 0],
			[-2, -1, 3], [2, -1, 3], [2, 1, 3], [-2, 1, 3],
		],
		triangles: [
			[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
			[0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
			[2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
		],
	};
	const top = {
		projection: "orthographic",
		projected_bounds_m: [[-2, -1], [2, 1]],
		projection_axes: { depth: [0, 0, 1], horizontal: [1, 0, 0], vertical: [0, 1, 0] },
	};
	const cameras = {
		views: {
			front: { ...top, projection_axes: { depth: [0, -1, 0], horizontal: [1, 0, 0], vertical: [0, 0, 1] } },
			right: { ...top, projection_axes: { depth: [1, 0, 0], horizontal: [0, 1, 0], vertical: [0, 0, 1] } },
			back: { ...top, projection_axes: { depth: [0, 1, 0], horizontal: [-1, 0, 0], vertical: [0, 0, 1] } },
			left: { ...top, projection_axes: { depth: [-1, 0, 0], horizontal: [0, -1, 0], vertical: [0, 0, 1] } },
			top,
			axon: { ...top, projection_axes: { depth: [0.6, -0.6, 0.5], horizontal: [0.7, 0.7, 0], vertical: [-0.35, 0.35, 0.85] } },
		},
	};
	const floorGuides = { floor_guides_m: [0, 3] };
	const facadePlanes = {
		facade_planes: [
			{ view: "front", origin: [-2, -1, 0], normal: [0, -1, 0], extent_m: [4, 3] },
			{ view: "right", origin: [2, -1, 0], normal: [1, 0, 0], extent_m: [2, 3] },
			{ view: "back", origin: [2, 1, 0], normal: [0, 1, 0], extent_m: [4, 3] },
			{ view: "left", origin: [-2, 1, 0], normal: [-1, 0, 0], extent_m: [2, 3] },
		],
	};
	await writeJson(join(candidateRoot, "candidate.json"), { candidate_id: candidateId });
	await writeJson(join(massRoot, "manifest.json"), {
		identity: { candidate_id: candidateId, geometry_hash: "geometry-sha256" },
		artifacts: {},
	});
	await writeJson(join(massRoot, "mesh", "indexed-mesh.json"), mesh);
	await writeJson(join(researchRoot, "camera-poses.json"), cameras);
	await writeJson(join(researchRoot, "floor-guides.json"), floorGuides);
	await writeJson(join(researchRoot, "facade-planes.json"), facadePlanes);
	await writeJson(join(researchRoot, "surface-normals.json"), { surface_normals: [] });

	const assetRoot = join(root, "memory", "elevation-3d", "assets", candidateId);
	const approvedImage = join(assetRoot, "approved.png");
	const imageBytes = Buffer.from("approved facade image");
	await mkdir(assetRoot, { recursive: true });
	await writeFile(approvedImage, imageBytes);
	await writeJson(join(assetRoot, "approved-design-v1.json"), {
		image_path: "approved.png",
		image_sha256: createHash("sha256").update(imageBytes).digest("hex"),
		facade_grammar: {
			bay_width_m: 2,
			frame_depth_m: 0.18,
			mullion_depth_m: 0.08,
			glazing_recess_m: 0.12,
			parapet_height_m: 0.35,
		},
	});
	return {
		root,
		candidateId,
		datasetRoot: join(root, "dataset"),
		outputRoot: join(root, "output"),
		mesh,
	};
}

function acceptedDeps(sourceMesh: Awaited<ReturnType<typeof fixture>>["mesh"]) {
	return {
		enrich: async ({ outputPath }: { outputPath: string }) => ({
			path: outputPath,
			sha256: "a".repeat(64),
			base_primitive: { positions: sourceMesh.vertices, indices: sourceMesh.triangles },
			bounds: { min: [-2.18, -1.18, 0], max: [2.18, 1.18, 3] },
		}),
		render: async ({ runDir }: { runDir: string }) => Object.fromEntries(
			["plan", "front", "back", "left", "right", "top", "axon"].map((name) => [name, join(runDir, `${name}.png`)]),
		),
		validate: async ({ artifact, requiredDrawings }: any) => ({
			accepted: true,
			codes: [],
			metrics: {},
			artifacts: { glb: artifact.path, drawings: requiredDrawings },
		}),
		deliver: async ({ runDir }: any) => automaticDelivery(runDir),
	};
}

const DELIVERY_VIEW_NAMES = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];

async function meshGlbBytes(mesh: { vertices: number[][]; triangles: number[][] }) {
	const document = new Document(), buffer = document.createBuffer();
	const positions = document.createAccessor("positions", buffer).setType("VEC3").setArray(new Float32Array(mesh.vertices.flat()));
	const indices = document.createAccessor("indices", buffer).setType("SCALAR").setArray(new Uint16Array(mesh.triangles.flat()));
	const primitive = document.createPrimitive().setAttribute("POSITION", positions).setIndices(indices);
	document.createScene("Scene").addChild(document.createNode("exact-mass").setMesh(document.createMesh("exact-mass").addPrimitive(primitive)));
	return Buffer.from(await new NodeIO().writeBinary(document));
}

function acceptedFinalDeliveryDeps() {
	const calls = { render: [] as any[], browser: [] as any[] };
	return {
		calls,
		renderAllViews: async (args: any) => {
			calls.render.push(args);
			await mkdir(args.runDir, { recursive: true });
			await copyFile(args.glbPath, join(args.runDir, "enriched.glb"));
			const viewer: Record<string, any> = {};
			for (const [key, name] of [["html", "index.html"], ["app", "app.js"], ["config", "config.json"]] as const) {
				const bytes = Buffer.from(`fixture-${key}`), path = join(args.runDir, "viewer", name);
				await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes);
				viewer[key] = { path: `viewer/${name}`, sha256: sha256(bytes) };
			}
			const technicalCameras = (await technicalCameraAuthorityFromGlb({
				bytes: await readFile(args.glbPath), cameras: args.cameras,
			})).cameras;
			const views: Record<string, any> = {};
			for (const [index, name] of DELIVERY_VIEW_NAMES.entries()) {
				const directory = join(args.runDir, "views", name); await mkdir(directory, { recursive: true });
				const image = Buffer.from(`view-${index}`), detail = Buffer.from(`manifest-${index}`), validation = Buffer.from(`validation-${index}`);
				await writeFile(join(directory, `${name}.png`), image);
				await writeFile(join(directory, `${name}-manifest.json`), detail);
				await writeFile(join(directory, `${name}-validation.json`), validation);
				views[name] = {
					path: join(directory, `${name}.png`), sha256: sha256(image), selected_glb_sha256: sha256(await readFile(args.glbPath)),
					camera: technicalCameras[name],
					manifest: { path: `views/${name}/${name}-manifest.json`, sha256: sha256(detail) },
					validation_report: { path: `views/${name}/${name}-validation.json`, sha256: sha256(validation) },
				};
			}
			const manifest = {
				schema_version: "arr.elevation3d.all-views.v1", selected_glb: { path: "enriched.glb", sha256: sha256(await readFile(args.glbPath)) },
				viewer: { path: "viewer/index.html" }, verified_evidence: { viewer }, views,
			};
			const manifestBytes = Buffer.from(JSON.stringify(manifest)), validationBytes = Buffer.from(JSON.stringify({ accepted: true, codes: [] }));
			await writeFile(join(args.runDir, "all-views-manifest.json"), manifestBytes); await writeFile(join(args.runDir, "validation.json"), validationBytes);
			return {
				manifest, manifest_record: { path: join(args.runDir, "all-views-manifest.json"), sha256: sha256(manifestBytes) },
				validation: { accepted: true, codes: [], path: join(args.runDir, "validation.json"), sha256: sha256(validationBytes) }, views,
			};
		},
		verifyAllViewsViewer: async (args: any) => {
			calls.browser.push(args);
			const rendered = calls.render.at(-1);
			const vertices = rendered.sourceMesh.vertices;
			const min = [0, 1, 2].map((axis) => Math.min(...vertices.map((point: number[]) => point[axis])));
			const max = [0, 1, 2].map((axis) => Math.max(...vertices.map((point: number[]) => point[axis])));
			const center = min.map((value, axis) => (value + max[axis]) / 2);
			const size = max.map((value, axis) => value - min[axis]);
			const radius = Math.max(Math.hypot(...size) * 0.75, 1);
			const bounds = { center, radius };
			const technicalCameras = (await technicalCameraAuthorityFromGlb({
				bytes: await readFile(rendered.glbPath), cameras: rendered.cameras,
			})).cameras;
			const browserCameras = presentationCameraPresets(technicalCameras);
			const screenshots = { initial: join(args.runDir, "browser-verification", "initial.png"), interacted: join(args.runDir, "browser-verification", "interacted.png") };
			await mkdir(join(args.runDir, "browser-verification"), { recursive: true });
			await writeFile(screenshots.initial, "initial"); await writeFile(screenshots.interacted, "interacted");
			const result = {
				console_errors: [], glb_load_count: 1, activated_views: [...DELIVERY_VIEW_NAMES],
				camera_presets: Object.fromEntries(DELIVERY_VIEW_NAMES.map((name) => [name, deriveExpectedCameraContract({ name, preset: browserCameras[name], buildingBounds: bounds })])),
				camera_building_bounds: Object.fromEntries(DELIVERY_VIEW_NAMES.map((name) => [name, bounds])),
				material_stability: { transparent_depth_writers: 0, facade_detail_meshes: 10, polygon_offset_facade_details: 10, deterministic_render_order: true },
				settled_frames_identical: true, settled_frame_hashes: ["c".repeat(64), "c".repeat(64), "c".repeat(64)], blocked_external_requests: [],
				screenshots,
			};
			const path = join(args.runDir, "browser-verification", "browser-verification.json"), bytes = Buffer.from(JSON.stringify(result));
			await writeFile(path, bytes);
			return { ...result, path, sha256: sha256(bytes) };
		},
	};
}

test("delivers one normalized eight-view package and browser verification from an accepted GLB", async () => {
	const item = await fixture();
	const input = await loadCandidatePackage(item.datasetRoot, item.candidateId);
	const deps = acceptedFinalDeliveryDeps();
	const artifactPath = join(item.outputRoot, "accepted", "enriched.glb");
	const artifactBytes = await meshGlbBytes(item.mesh);
	await mkdir(dirname(artifactPath), { recursive: true });
	await writeFile(artifactPath, artifactBytes);
	const delivery = await deliverSelectedAllViews({
		runDir: join(item.outputRoot, "accepted"), candidateId: item.candidateId,
		artifact: { path: artifactPath, sha256: sha256(artifactBytes) }, input, deps,
	});

	assert.deepEqual(Object.keys(delivery.views).sort(), [...DELIVERY_VIEW_NAMES].sort());
	assert.equal(delivery.validation.accepted, true);
	assert.deepEqual(delivery.browser_verification.console_errors, []);
	assert.equal(delivery.invocations.render_all_views, 1);
	assert.equal(delivery.invocations.browser_verification, 1);
	assert.equal(deps.calls.render.length, 1);
	assert.equal(deps.calls.browser.length, 1);
	assert.equal(deps.calls.render[0].cutElevationM, 1.2);
	assert.equal(deps.calls.render[0].palette.preset, "competition-warm");
	assert.equal(deps.calls.render[0].cameras.axon.projection, "perspective");
	assert.equal(deps.calls.render[0].cameras["opposite-axon"].projection, "perspective");
	assert.ok(deps.calls.render[0].cameras.axon.position[0] > deps.calls.render[0].cameras["opposite-axon"].position[0]);
	assert.equal(delivery.memory_record.manifest.sha256.length, 64);
});

test("rejects invalid package and browser evidence and propagates cancellation", async () => {
	const item = await fixture();
	const input = await loadCandidatePackage(item.datasetRoot, item.candidateId);
	const rejectedBytes = await meshGlbBytes(item.mesh);
	const base = { runDir: join(item.outputRoot, "rejected"), candidateId: item.candidateId, artifact: { path: join(item.outputRoot, "rejected", "enriched.glb"), sha256: sha256(rejectedBytes) }, input };
	await mkdir(dirname(base.artifact.path), { recursive: true });
	await writeFile(base.artifact.path, rejectedBytes);
	for (const [mutation, code] of [
		[(deps: any) => { deps.renderAllViews = async () => ({ validation: { accepted: false, codes: ["BAD"] }, views: {} }); }, "ALL_VIEWS_REJECTED"],
		[(deps: any) => { deps.verifyAllViewsViewer = async () => ({ console_errors: ["boom"], glb_load_count: 1 }); }, "BROWSER_VERIFICATION_REJECTED"],
	] as const) {
		const deps = acceptedFinalDeliveryDeps(); mutation(deps);
		await assert.rejects(() => deliverSelectedAllViews({ ...base, deps }), (error: any) => {
			assert.equal(error instanceof FinalDeliveryError, true); assert.equal(error.code, code); return true;
		});
	}
	const controller = new AbortController(); controller.abort(new DOMException("stop delivery", "AbortError"));
	await assert.rejects(() => deliverSelectedAllViews({ ...base, signal: controller.signal, deps: acceptedFinalDeliveryDeps() }), { name: "AbortError" });
	const missingTop = structuredClone(input); delete missingTop.cameras.views.top;
	await assert.rejects(() => deliverSelectedAllViews({ ...base, input: missingTop, deps: acceptedFinalDeliveryDeps() }), (error: any) => {
		assert.equal(error instanceof FinalDeliveryError, true); assert.equal(error.code, "CAMERA_INPUT_INVALID"); return true;
	});
});

test("rejects coherently altered technical browser cameras derived from reported rather than selected-GLB bounds", async () => {
	const item = await fixture();
	const input = await loadCandidatePackage(item.datasetRoot, item.candidateId);
	const deps = acceptedFinalDeliveryDeps();
	const verify = deps.verifyAllViewsViewer;
	deps.verifyAllViewsViewer = async (args: any) => {
		const report: any = await verify(args);
		const rendered = deps.calls.render.at(-1);
		const technicalCameras = (await technicalCameraAuthorityFromGlb({
			bytes: await readFile(rendered.glbPath), cameras: rendered.cameras,
		})).cameras;
		const browserCameras = presentationCameraPresets(technicalCameras);
		const alteredBounds = { center: [10, 0, 1.5], radius: 20 };
		report.camera_building_bounds = Object.fromEntries(DELIVERY_VIEW_NAMES.map((name) => [name, alteredBounds]));
		report.camera_presets = Object.fromEntries(DELIVERY_VIEW_NAMES.map((name) => [name,
			deriveExpectedCameraContract({ name, preset: browserCameras[name], buildingBounds: alteredBounds })]));
		return report;
	};
	const artifactPath = join(item.outputRoot, "coherent-camera", "enriched.glb"), artifactBytes = await meshGlbBytes(item.mesh);
	await mkdir(dirname(artifactPath), { recursive: true }); await writeFile(artifactPath, artifactBytes);
	await assert.rejects(() => deliverSelectedAllViews({
		runDir: join(item.outputRoot, "coherent-camera"), candidateId: item.candidateId,
		artifact: { path: artifactPath, sha256: sha256(artifactBytes) }, input, deps,
	}), (error: any) => error?.code === "BROWSER_VERIFICATION_REJECTED");
});

test("rejects a coherently re-fitted technical axon camera that drifts from deterministic candidate authority", async () => {
	const item = await fixture();
	const input = await loadCandidatePackage(item.datasetRoot, item.candidateId);
	const deps = acceptedFinalDeliveryDeps();
	const render = deps.renderAllViews, verify = deps.verifyAllViewsViewer;
	let tamperedCamera: any;
	deps.renderAllViews = async (args: any) => {
		const result: any = await render(args);
		const camera = structuredClone(result.manifest.views.axon.camera);
		camera.position = camera.target.map((value: number, axis: number) => value + 2 * (camera.position[axis] - value));
		tamperedCamera = camera;
		result.manifest.views.axon.camera = camera;
		result.views.axon.camera = camera;
		return result;
	};
	deps.verifyAllViewsViewer = async (args: any) => {
		const report: any = await verify(args);
		const preset = { ...tamperedCamera, cut: { enabled: false, elevation_m: null, plane_world: null } };
		report.camera_presets.axon = deriveExpectedCameraContract({
			name: "axon", preset, buildingBounds: report.camera_building_bounds.axon,
		});
		return report;
	};
	const artifactPath = join(item.outputRoot, "coherent-fit-drift", "enriched.glb"), artifactBytes = await meshGlbBytes(item.mesh);
	await mkdir(dirname(artifactPath), { recursive: true }); await writeFile(artifactPath, artifactBytes);
	await assert.rejects(() => deliverSelectedAllViews({
		runDir: join(item.outputRoot, "coherent-fit-drift"), candidateId: item.candidateId,
		artifact: { path: artifactPath, sha256: sha256(artifactBytes) }, input, deps,
	}), (error: any) => error?.code === "ALL_VIEWS_REJECTED");
});

test("rejects a pre-existing technical-delivery junction before renderer or outside writes", async (context) => {
	const item = await fixture();
	const input = await loadCandidatePackage(item.datasetRoot, item.candidateId);
	const runDir = join(item.outputRoot, "junction-run");
	const deliveryParent = join(runDir, "providers", "fixture-provider");
	const deliveryRoot = join(deliveryParent, "delivery");
	const outside = join(item.root, "outside-delivery");
	await mkdir(deliveryParent, { recursive: true });
	await mkdir(outside, { recursive: true });
	try { await symlink(outside, deliveryRoot, process.platform === "win32" ? "junction" : "dir"); }
	catch (error: any) {
		if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) return context.skip("directory links unavailable");
		throw error;
	}
	const deps = acceptedFinalDeliveryDeps();
	await assert.rejects(() => deliverSelectedAllViews({
		runDir, deliveryRoot, candidateId: item.candidateId,
		artifact: { path: join(runDir, "selected.glb"), sha256: "a".repeat(64) }, input, deps,
	}), (error: any) => error instanceof FinalDeliveryError && error.code === "DELIVERY_PATH_INVALID");
	assert.equal(deps.calls.render.length, 0);
	assert.equal(deps.calls.browser.length, 0);
	assert.deepEqual(await readdir(outside), []);
});

function automaticDelivery(runDir: string) {
	const deliveryRoot = join(runDir, "delivery");
	return {
		schema_version: "arr.elevation3d.final-delivery.v1",
		run_dir: deliveryRoot,
		manifest: { schema_version: "arr.elevation3d.all-views.v1" },
		validation: { accepted: true, codes: [] },
		viewer: { path: join(deliveryRoot, "viewer", "index.html") },
		browser_verification: { path: join(deliveryRoot, "browser-verification", "browser-verification.json"), console_errors: [] },
		views: Object.fromEntries(DELIVERY_VIEW_NAMES.map((name, index) => [name, {
			path: join(deliveryRoot, "views", name, `${name}.png`), sha256: String(index).padStart(64, "f"),
		}])),
		memory_record: {
			schema_version: "arr.elevation3d.final-delivery-memory.v1",
			manifest: { path: join(deliveryRoot, "all-views-manifest.json"), sha256: "d".repeat(64) },
			validation: { path: join(deliveryRoot, "validation.json"), sha256: "e".repeat(64) },
			viewer: { path: join(deliveryRoot, "viewer", "index.html"), config_sha256: "1".repeat(64) },
			browser_verification: { path: join(deliveryRoot, "browser-verification", "browser-verification.json"), sha256: "b".repeat(64) },
			views: Object.fromEntries(DELIVERY_VIEW_NAMES.map((name, index) => [name, {
				path: join(deliveryRoot, "views", name, `${name}.png`), sha256: String(index).padStart(64, "f"),
			}])),
		},
	};
}

test("runs final delivery before selecting and remembering an enriched success", async () => {
	const item = await fixture(); process.chdir(item.root);
	const deps: any = acceptedDeps(item.mesh);
	const deliveryCalls: any[] = [];
	deps.deliver = async (args: any) => {
		deliveryCalls.push(args);
		await assert.rejects(access(join(args.runDir, "final.json")), /ENOENT/);
		await assert.rejects(access(join(item.root, "memory", "elevation-3d", "unified-runs.jsonl")), /ENOENT/);
		return automaticDelivery(args.runDir);
	};
	const result = await runElevation3d({ candidateId: item.candidateId, datasetRoot: item.datasetRoot, outputRoot: item.outputRoot, runId: "automatic-delivery", deps });
	assert.equal(deliveryCalls.length, 1);
	assert.equal(result.delivery.validation.accepted, true);
	assert.deepEqual(Object.keys(result.delivery.views).sort(), [...DELIVERY_VIEW_NAMES].sort());
	const final = await readJson(join(result.run_dir, "final.json"));
	assert.equal(final.selected, "v001");
	assert.equal(final.delivery.manifest.sha256, "d".repeat(64));
	const memory = JSON.parse((await readFile(join(item.root, "memory", "elevation-3d", "unified-runs.jsonl"), "utf8")).trim());
	assert.equal(memory.final.delivery.manifest.sha256, "d".repeat(64));
});

test("optional texturing runs only after procedural delivery and preserves it on provider rejection", async () => {
	const item = await fixture();
	process.chdir(item.root);
	const deps: any = acceptedDeps(item.mesh);
	const referenceImage = join(item.root, "approved-texture.png");
	await writeFile(referenceImage, Buffer.from("approved-reference"));
	const calls: string[] = [];
	const proceduralDeliver = deps.deliver;
	deps.deliver = async (args: any) => { calls.push("procedural"); return proceduralDeliver(args); };
	deps.textureDeliver = async (args: any) => {
		calls.push("texturing");
		assert.equal(args.acceptedGlb.endsWith("enriched.glb"), true);
		assert.equal(args.referenceImage, referenceImage);
		assert.equal(args.confirmLive, true);
		assert.equal(args.proceduralDelivery.endsWith("delivery"), true);
		return { status: "rejected", failure: { code: "PROVIDER_GEOMETRY_MISMATCH" }, proceduralDelivery: args.proceduralDelivery };
	};
	deps.renderTextured = async () => { throw new Error("rejected texturing must not render"); };
	const result = await runElevation3d({
		candidateId: item.candidateId, datasetRoot: item.datasetRoot, outputRoot: item.outputRoot, runId: "optional-texturing-rejected",
		texturing: { enabled: true, confirmLive: true, referenceImage, maxCredits: 15 }, deps,
	});
	assert.deepEqual(calls, ["procedural", "texturing"]);
	assert.equal(result.delivery.validation.accepted, true);
	assert.equal(result.texturing.status, "rejected");
	const final = await readJson(join(result.run_dir, "final.json"));
	assert.equal(final.selected, "v001");
	assert.equal(final.texturing.failureCode, "PROVIDER_GEOMETRY_MISMATCH");
	assert.equal(final.texturing.retryDecision, "no-auto-retry");
});

test("optional texturing exceptions and rejected render gates cannot block procedural success", async () => {
	for (const mode of ["throw", "render-rejected"] as const) {
		const item = await fixture(); process.chdir(item.root);
		const deps: any = acceptedDeps(item.mesh);
		const referenceImage = join(item.root, `reference-${mode}.png`); await writeFile(referenceImage, Buffer.from("reference"));
		if (mode === "throw") {
			deps.textureDeliver = async () => { const error: any = new Error("provider unavailable"); error.code = "TRIPO_API_ERROR"; throw error; };
		} else {
			deps.deliver = async ({ runDir }: any) => {
				const result = automaticDelivery(runDir);
				await mkdir(join(result.run_dir, "viewer"), { recursive: true });
				await writeFile(join(result.run_dir, "viewer", "config.json"), JSON.stringify({ cameras: { views: {} } }));
				return result;
			};
			deps.textureDeliver = async ({ resultDir }: any) => ({ status: "accepted", outputGlb: join(resultDir, "final", "textured.glb"), outputSha256: "a".repeat(64), actualCredits: 10, geometry: { accepted: true }, material: { status: "accepted" }, transfer: { status: "accepted" } });
			deps.renderTextured = async () => ({ validation: { accepted: false, status: "rejected", codes: ["PBR_EVIDENCE_MISSING"] } });
		}
		const result = await runElevation3d({ candidateId: item.candidateId, datasetRoot: item.datasetRoot, outputRoot: item.outputRoot, runId: `optional-${mode}`, texturing: { enabled: true, confirmLive: true, referenceImage }, deps });
		assert.equal(result.delivery.validation.accepted, true);
		assert.equal(result.texturing.status, "rejected");
		assert.equal((await readJson(join(result.run_dir, "final.json"))).selected, "v001");
	}
});

test("optional texturing forwards only render style to the v7 renderer without changing provider arguments", async () => {
	const item = await fixture(); process.chdir(item.root);
	const deps: any = acceptedDeps(item.mesh);
	const referenceImage = join(item.root, "reference-v7.png"); await writeFile(referenceImage, Buffer.from("reference"));
	let providerArgs: any, renderArgs: any;
	deps.deliver = async ({ runDir }: any) => {
		const result = automaticDelivery(runDir);
		await mkdir(join(result.run_dir, "viewer"), { recursive: true });
		await writeFile(join(result.run_dir, "viewer", "config.json"), JSON.stringify({ cameras: { views: { front: { projection: "orthographic" } } } }));
		return result;
	};
	deps.textureDeliver = async (args: any) => {
		providerArgs = args;
		return { status: "accepted", outputGlb: join(args.resultDir, "final", "textured.glb"), outputSha256: "a".repeat(64), actualCredits: 10, geometry: { accepted: true }, material: { status: "accepted" }, transfer: { status: "accepted" } };
	};
	deps.renderTextured = async (args: any) => { renderArgs = args; return { validation: { accepted: true, status: "accepted", codes: [] } }; };
	await runElevation3d({
		candidateId: item.candidateId, datasetRoot: item.datasetRoot, outputRoot: item.outputRoot, runId: "optional-v7-style",
		texturing: { enabled: true, confirmLive: true, referenceImage, maxCredits: 11, seed: 47, dryRun: true, renderStyleId: "competition-daylight-v1" }, deps,
	});
	assert.equal(providerArgs.provider, "tripo");
	assert.equal(providerArgs.referenceImage, referenceImage);
	assert.equal(providerArgs.confirmLive, true); assert.equal(providerArgs.maxCredits, 11); assert.equal(providerArgs.seed, 47); assert.equal(providerArgs.dryRun, true);
	assert.equal(Object.hasOwn(providerArgs, "renderStyleId"), false);
	assert.equal(renderArgs.renderStyleId, "competition-daylight-v1");
	assert.match(renderArgs.runDir, /rendered-pbr-v7-competition-daylight$/);
	assert.deepEqual(renderArgs.cameras, { front: { projection: "orthographic" } });
});

test("blocks and remembers a final-delivery rejection without claiming enriched success", async () => {
	const item = await fixture(); process.chdir(item.root);
	const deps: any = acceptedDeps(item.mesh);
	deps.deliver = async () => { throw new FinalDeliveryError({ code: "BROWSER_VERIFICATION_REJECTED", message: "flicker evidence rejected", evidence: { transparent_depth_writers: 1 } }); };
	await assert.rejects(
		() => runElevation3d({ candidateId: item.candidateId, datasetRoot: item.datasetRoot, outputRoot: item.outputRoot, runId: "delivery-blocked", deps }),
		(error: any) => { assert.equal(error.code, "BROWSER_VERIFICATION_REJECTED"); return true; },
	);
	const runDir = join(item.outputRoot, item.candidateId, "delivery-blocked");
	const final = await readJson(join(runDir, "final.json"));
	assert.equal(final.selected, "blocked");
	assert.equal(final.delivery_failure.code, "BROWSER_VERIFICATION_REJECTED");
	assert.equal((await readJson(join(runDir, "delivery-failure.json"))).code, "BROWSER_VERIFICATION_REJECTED");
	const memory = JSON.parse((await readFile(join(item.root, "memory", "elevation-3d", "unified-runs.jsonl"), "utf8")).trim());
	assert.equal(memory.final.selected, "blocked");
	assert.equal(memory.final.delivery_failure.code, "BROWSER_VERIFICATION_REJECTED");
});

test("blocks a delivery whose memory record escapes the run directory", async () => {
	const item = await fixture(); process.chdir(item.root);
	const deps: any = acceptedDeps(item.mesh);
	deps.deliver = async (args: any) => {
		const delivery = automaticDelivery(args.runDir);
		delivery.memory_record.viewer.path = join(item.root, "outside-viewer.html");
		return delivery;
	};
	await assert.rejects(
		() => runElevation3d({ candidateId: item.candidateId, datasetRoot: item.datasetRoot, outputRoot: item.outputRoot, runId: "delivery-path-blocked", deps }),
		/must remain within the run directory/,
	);
	const runDir = join(item.outputRoot, item.candidateId, "delivery-path-blocked");
	const final = await readJson(join(runDir, "final.json"));
	assert.equal(final.selected, "blocked");
	assert.equal(final.delivery_failure.code, "FINAL_DELIVERY_FAILED");
});

test("cancellation during final delivery records cancelled and never claims success", async () => {
	const item = await fixture(); process.chdir(item.root);
	const controller = new AbortController();
	const deps: any = acceptedDeps(item.mesh);
	deps.deliver = async () => {
		controller.abort(new DOMException("stop final delivery", "AbortError"));
		controller.signal.throwIfAborted();
	};
	await assert.rejects(
		() => runElevation3d({ candidateId: item.candidateId, datasetRoot: item.datasetRoot, outputRoot: item.outputRoot, runId: "delivery-cancelled", signal: controller.signal, deps }),
		{ name: "AbortError" },
	);
	const runDir = join(item.outputRoot, item.candidateId, "delivery-cancelled");
	assert.equal((await readJson(join(runDir, "final.json"))).selected, "cancelled");
	await assert.rejects(access(join(runDir, "delivery-failure.json")), /ENOENT/);
});

function validationDeps(
	sourceMesh: Awaited<ReturnType<typeof fixture>>["mesh"],
	failures: Record<string, string[]>,
) {
	const enrichCalls: Array<{ versionId: string; safeFallback: boolean }> = [];
	const validateCalls: string[] = [];
	const deliveryCalls: any[] = [];
	return {
		enrichCalls,
		validateCalls,
		deliveryCalls,
		enrich: async ({ outputPath, versionId, safeFallback }: {
			outputPath: string;
			versionId: string;
			safeFallback: boolean;
		}) => {
			enrichCalls.push({ versionId, safeFallback });
			return {
				path: outputPath,
				sha256: "a".repeat(64),
				base_primitive: { positions: sourceMesh.vertices, indices: sourceMesh.triangles },
				bounds: { min: [-2.18, -1.18, 0], max: [2.18, 1.18, 3] },
			};
		},
		render: async ({ runDir }: { runDir: string }) => Object.fromEntries(
			["plan", "front", "back", "left", "right", "top", "axon"].map((name) => [name, join(runDir, `${name}.png`)]),
		),
		validate: async ({ versionId, artifact, requiredDrawings }: any) => {
			validateCalls.push(versionId);
			const codes = failures[versionId] ?? [];
			return {
				accepted: codes.length === 0,
				codes,
				metrics: { version_id: versionId },
				artifacts: { glb: artifact.path, drawings: requiredDrawings },
			};
		},
		deliver: async (args: any) => { deliveryCalls.push(args); return automaticDelivery(args.runDir); },
	};
}

const drawingNames = ["plan", "front", "back", "left", "right", "top", "axon"];

async function renderRealFiles({ runDir, glbPath }: { runDir: string; glbPath: string }) {
	const viewerDir = join(runDir, "viewer");
	const drawingDir = join(runDir, "drawings", "hunyuan");
	await mkdir(viewerDir, { recursive: true });
	await mkdir(drawingDir, { recursive: true });
	const configPath = join(viewerDir, "config.json");
	await writeJson(configPath, { strategies: { hunyuan: { glb: `../${relative(runDir, glbPath).replaceAll("\\", "/")}` } } });
	const configHash = sha256(await readFile(configPath));
	let glbHash = "0".repeat(64);
	try { glbHash = sha256(await readFile(glbPath)); } catch {}
	const png = await sharp({
		create: { width: 2, height: 3, channels: 4, background: { r: 40, g: 80, b: 120, alpha: 1 } },
	}).png().toBuffer();
	const drawings: Record<string, string> = {};
	const provenanceDrawings: Record<string, unknown> = {};
	for (const name of drawingNames) {
		const path = join(drawingDir, `${name}.png`);
		await writeFile(path, png);
		drawings[name] = path;
		provenanceDrawings[name] = {
			path: relative(runDir, path).replaceAll("\\", "/"),
			sha256: sha256(png),
			width: 2,
			height: 3,
			glb_sha256: glbHash,
			viewer_config_sha256: configHash,
		};
	}
	await writeJson(join(runDir, "drawing-provenance.json"), {
		schema_version: "arr.elevation3d.drawing-provenance.v1",
		selected_glb: { path: relative(runDir, glbPath).replaceAll("\\", "/"), sha256: glbHash },
		viewer_config: { path: "viewer/config.json", sha256: configHash },
		drawings: provenanceDrawings,
	});
	return drawings;
}

function realFileDeps(defects: Record<string, "missing-glb" | "corrupt-glb" | "missing-drawing" | "corrupt-drawing">) {
	const calls: string[] = [];
	return {
		calls,
		enrich: async (args: any) => {
			calls.push(`enrich:${args.versionId}`);
			const artifact = await writeEnrichedGlb(buildEnrichedScene({
				mesh: args.sourceMesh,
				floorGuides: args.floorGuides,
				facadePlanes: args.facadePlanes,
				grammar: args.grammar,
				safeFallback: args.safeFallback,
			}), args.outputPath);
			if (defects[args.versionId] === "missing-glb") await rm(artifact.path);
			if (defects[args.versionId] === "corrupt-glb") {
				await writeFile(artifact.path, Buffer.from("not a glb"));
				artifact.sha256 = sha256(await readFile(artifact.path));
			}
			return artifact;
		},
		render: async (args: any) => {
			calls.push(`render:${args.versionId}`);
			const drawings = await renderRealFiles(args);
			if (defects[args.versionId] === "missing-drawing") await rm(drawings.top);
			if (defects[args.versionId] === "corrupt-drawing") await writeFile(drawings.top, Buffer.from("not a png"));
			return drawings;
		},
		deliver: async ({ runDir }: any) => automaticDelivery(runDir),
	};
}

async function readJson(path: string) {
	return JSON.parse(await readFile(path, "utf8"));
}

async function checkpointDeps(sourceMesh: Awaited<ReturnType<typeof fixture>>["mesh"], options: {
	rejectValidation?: boolean;
	renderError?: boolean;
	abortAfterRender?: AbortController;
} = {}) {
	return {
		enrich: async ({ outputPath }: any) => {
			const bytes = Buffer.from("checkpoint-glb");
			await writeFile(outputPath, bytes);
			return {
				path: outputPath,
				sha256: sha256(bytes),
				metrics: { bytes: bytes.length },
				base_primitive: { positions: sourceMesh.vertices, indices: sourceMesh.triangles },
				bounds: { min: [-2, -1, 0], max: [2, 1, 3] },
			};
		},
		render: async (args: any) => {
			if (options.renderError) throw new Error("renderer stopped after GLB");
			const drawings = await renderRealFiles(args);
			options.abortAfterRender?.abort(new DOMException("stop after render", "AbortError"));
			return drawings;
		},
		validate: async ({ artifact, requiredDrawings }: any) => {
			const provenance = await readJson(join(dirname(artifact.path), "drawing-provenance.json"));
			return {
				accepted: !options.rejectValidation,
				codes: options.rejectValidation ? ["POLICY_REJECTED"] : [],
				metrics: { inspected: true },
				artifacts: {
					glb: artifact.path,
					glb_sha256: artifact.sha256,
					drawings: Object.fromEntries(Object.entries(provenance.drawings).map(([name, entry]: any) => [name, {
						...entry, path: requiredDrawings[name],
					}])),
					provenance: join(dirname(artifact.path), "drawing-provenance.json"),
				},
			};
		},
		deliver: async ({ runDir }: any) => automaticDelivery(runDir),
	};
}

test("selects v001 when enrichment and all gates pass", async () => {
	const input = await fixture();
	process.chdir(input.root);
	const result = await runElevation3d({
		candidateId: input.candidateId,
		datasetRoot: input.datasetRoot,
		outputRoot: input.outputRoot,
		runId: "success",
		deps: acceptedDeps(input.mesh),
	});

	assert.equal(result.selected_version, "v001");
	assert.equal(result.attempts, 1);
	assert.equal(result.fallback, false);
	assert.equal((await readJson(join(result.run_dir, "final.json"))).selected, "v001");
	assert.equal((await readJson(join(result.run_dir, "versions", "v001", "version.json"))).status, "passed");
	const persistedValidation = await readJson(join(result.run_dir, "versions", "v001", "validation.json"));
	assert.equal(persistedValidation.accepted, true);
	assert.deepEqual(persistedValidation.codes, []);
	assert.match(persistedValidation.artifacts.glb, /versions[\\/]v001[\\/]enriched\.glb$/);
	assert.deepEqual(Object.keys(persistedValidation.artifacts.drawings).sort(), [
		"axon", "back", "front", "left", "plan", "right", "top",
	]);
});

test("applies exactly one bounded correction and selects v002", async () => {
	const input = await fixture();
	process.chdir(input.root);
	const deps: any = validationDeps(input.mesh, { v001: ["DETAIL_BOUNDS_EXCEEDED"] });
	const deliveryCalls: any[] = [];
	deps.deliver = async (args: any) => { deliveryCalls.push(args); return automaticDelivery(args.runDir); };
	const result = await runElevation3d({
		candidateId: input.candidateId,
		datasetRoot: input.datasetRoot,
		outputRoot: input.outputRoot,
		runId: "retry",
		deps,
	});

	assert.equal(result.selected_version, "v002");
	assert.equal(result.attempts, 2);
	assert.equal(result.fallback, false);
	assert.equal(deliveryCalls.length, 1);
	assert.equal(result.delivery.validation.accepted, true);
	assert.deepEqual(deps.validateCalls, ["v001", "v002"]);
	assert.deepEqual((await readJson(join(result.run_dir, "versions", "v001", "failure.json"))).codes, [
		"DETAIL_BOUNDS_EXCEEDED",
	]);
	const corrected = await readJson(join(result.run_dir, "versions", "v002", "grammar.json"));
	assert.equal(corrected.frame_depth_m, 0.09);
	assert.equal(corrected.mullion_depth_m, 0.04);
	assert.equal((await readJson(join(result.run_dir, "versions", "v002", "version.json"))).status, "passed");
});

test("quarantines both failures and selects a rendered and validated exact-mass fallback", async () => {
	const input = await fixture();
	process.chdir(input.root);
	const deps: any = validationDeps(input.mesh, {
		v001: ["DETAIL_BOUNDS_EXCEEDED"],
		v002: ["PRIMITIVE_BUDGET_EXCEEDED"],
	});
	const deliveryCalls: any[] = [];
	deps.deliver = async (args: any) => { deliveryCalls.push(args); return automaticDelivery(args.runDir); };
	const result = await runElevation3d({
		candidateId: input.candidateId,
		datasetRoot: input.datasetRoot,
		outputRoot: input.outputRoot,
		runId: "fallback",
		deps,
	});

	assert.equal(result.selected_version, "fallback");
	assert.equal(result.attempts, 2);
	assert.equal(result.fallback, true);
	assert.equal(result.delivery, null);
	assert.equal(result.delivery_status, "not_applicable_fallback");
	assert.equal(deliveryCalls.length, 0);
	assert.deepEqual(deps.validateCalls, ["v001", "v002", "fallback"]);
	assert.deepEqual(deps.enrichCalls, [
		{ versionId: "v001", safeFallback: false },
		{ versionId: "v002", safeFallback: false },
		{ versionId: "fallback", safeFallback: true },
	]);
	assert.equal((await readJson(join(result.run_dir, "versions", "v001", "failure.json"))).codes.length > 0, true);
	assert.equal((await readJson(join(result.run_dir, "versions", "v002", "failure.json"))).codes.length > 0, true);
	assert.equal((await readJson(join(result.run_dir, "final.json"))).selected, "fallback");
	assert.equal((await readJson(join(result.run_dir, "versions", "fallback", "version.json"))).status, "passed");
	const memoryLines = (await readFile(join(input.root, "memory", "elevation-3d", "unified-runs.jsonl"), "utf8"))
		.trim().split(/\r?\n/);
	assert.equal(memoryLines.length, 1);
	assert.equal(JSON.parse(memoryLines[0]).final.selected, "fallback");
});

test("retries a generated base-integrity defect once without changing grammar", async () => {
	const input = await fixture();
	process.chdir(input.root);
	const deps = validationDeps(input.mesh, { v001: ["BASE_GEOMETRY_CHANGED"] });
	const result = await runElevation3d({
		candidateId: input.candidateId,
		datasetRoot: input.datasetRoot,
		outputRoot: input.outputRoot,
		runId: "base-corruption",
		deps,
	});

	assert.equal(result.selected_version, "v002");
	assert.deepEqual(deps.validateCalls, ["v001", "v002"]);
	assert.deepEqual(deps.enrichCalls, [
		{ versionId: "v001", safeFallback: false },
		{ versionId: "v002", safeFallback: false },
	]);
	assert.deepEqual(
		await readJson(join(result.run_dir, "versions", "v002", "grammar.json")),
		await readJson(join(result.run_dir, "versions", "v001", "grammar.json")),
	);
});

test("retries one explicitly typed renderer-stage failure", async () => {
	const input = await fixture();
	process.chdir(input.root);
	const deps = validationDeps(input.mesh, {});
	const renderCalls: string[] = [];
	const render = deps.render;
	deps.render = async (args: any) => {
		renderCalls.push(args.versionId);
		if (args.versionId === "v001") throw new GeneratedStageError({
			stage: "render",
			code: "DRAWING_RENDER_FAILED",
			message: "renderer could not produce drawings",
		});
		return render(args);
	};

	const result = await runElevation3d({
		candidateId: input.candidateId,
		datasetRoot: input.datasetRoot,
		outputRoot: input.outputRoot,
		runId: "typed-render",
		deps,
	});

	assert.equal(result.selected_version, "v002");
	assert.deepEqual(renderCalls, ["v001", "v002"]);
	const failure = await readJson(join(result.run_dir, "versions", "v001", "failure.json"));
	assert.equal(failure.stage, "render");
	assert.deepEqual(failure.codes, ["DRAWING_RENDER_FAILED"]);
	assert.equal(failure.retryable, true);
});

test("default stage wrappers type only recognized filesystem and renderer failures", async () => {
	for (const [stage, error, expectedCode] of [
		["enrich", Object.assign(new Error("disk full"), { code: "ENOSPC", errno: -28, syscall: "write" }), "GLB_EXPORT_FAILED"],
		["enrich", Object.assign(new Error("access denied"), { code: "EACCES", errno: -13, syscall: "open" }), "GLB_EXPORT_FAILED"],
		["render", Object.assign(new Error("browser timed out"), { name: "TimeoutError" }), "DRAWING_RENDER_FAILED"],
		["render", Object.assign(new Error("browser protocol failed"), { name: "ProtocolError" }), "DRAWING_RENDER_FAILED"],
	] as const) {
		await assert.rejects(
			() => unifiedFlow.executeDefaultStage(stage, async () => { throw error; }),
			(caught: Error & { code?: string; cause?: unknown; stage?: string }) => {
				assert.equal(caught instanceof GeneratedStageError, true);
				assert.equal(caught.stage, stage);
				assert.equal(caught.code, expectedCode);
				assert.equal(caught.cause, error);
				return true;
			},
		);
	}
});

test("default stage wrappers preserve programming and unclassified exceptions", async () => {
	const assertion = Object.assign(new Error("assertion failed"), { name: "AssertionError", code: "ERR_ASSERTION" });
	for (const [stage, error] of [
		["enrich", new ReferenceError("missing binding")],
		["render", new RangeError("bad index")],
		["enrich", assertion],
		["enrich", Object.assign(new Error("forged access code"), { code: "EACCES" })],
		["render", new Error("unclassified renderer bug")],
		["validate", new SyntaxError("validator programming error")],
	] as const) {
		await assert.rejects(
			() => unifiedFlow.executeDefaultStage(stage, async () => { throw error; }),
			(caught) => {
				assert.equal(caught, error);
				return true;
			},
		);
	}
});

test("rejects mistyped stage-code pairs and never retries a forged pair", async () => {
	assert.throws(
		() => new GeneratedStageError({ stage: "render", code: "GLB_EXPORT_FAILED" }),
		/stage.*code|allowed/i,
	);
	const input = await fixture();
	process.chdir(input.root);
	const deps = validationDeps(input.mesh, {});
	const renderCalls: string[] = [];
	const forged = Object.assign(Object.create(GeneratedStageError.prototype), {
		name: "GeneratedStageError",
		message: "forged stage-code pair",
		stage: "render",
		code: "GLB_EXPORT_FAILED",
		evidence: {},
	});
	deps.render = async ({ versionId }: any) => {
		renderCalls.push(versionId);
		throw forged;
	};
	const runDir = join(input.outputRoot, input.candidateId, "forged-stage-code");

	await assert.rejects(
		() => runElevation3d({
			candidateId: input.candidateId,
			datasetRoot: input.datasetRoot,
			outputRoot: input.outputRoot,
			runId: "forged-stage-code",
			deps,
		}),
		(error: Error & { code?: string }) => {
			assert.equal(error.code, "RUN_BLOCKED");
			return true;
		},
	);
	assert.deepEqual(renderCalls, ["v001"]);
	const failure = await readJson(join(runDir, "versions", "v001", "failure.json"));
	assert.deepEqual(failure.codes, ["RENDER_FAILED"]);
	assert.equal(failure.retryable, false);
});

test("blocks an unknown validation report code without v002 or fallback", async () => {
	const input = await fixture();
	process.chdir(input.root);
	const deps = validationDeps(input.mesh, { v001: ["UNKNOWN_OUTPUT_DEFECT"] });
	const runDir = join(input.outputRoot, input.candidateId, "unknown-report");

	await assert.rejects(
		() => runElevation3d({
			candidateId: input.candidateId,
			datasetRoot: input.datasetRoot,
			outputRoot: input.outputRoot,
			runId: "unknown-report",
			deps,
		}),
		(error: Error & { code?: string }) => {
			assert.equal(error.code, "RUN_BLOCKED");
			assert.match(error.message, /UNKNOWN_OUTPUT_DEFECT/);
			return true;
		},
	);
	assert.deepEqual(deps.validateCalls, ["v001"]);
	assert.deepEqual(deps.enrichCalls, [{ versionId: "v001", safeFallback: false }]);
	assert.equal((await readJson(join(runDir, "final.json"))).selected, "blocked");
	const memoryLines = (await readFile(join(input.root, "memory", "elevation-3d", "unified-runs.jsonl"), "utf8"))
		.trim().split(/\r?\n/);
	assert.equal(memoryLines.length, 1);
});

for (const [defect, expectedCode] of [
	["missing-glb", "ARTIFACT_MISSING"],
	["corrupt-glb", "GLB_INVALID"],
	["missing-drawing", "DRAWING_MISSING"],
	["corrupt-drawing", "DRAWING_INVALID"],
] as const) {
	test(`re-exports and rerenders v002 after a real ${defect} defect`, async () => {
		const input = await fixture();
		process.chdir(input.root);
		const deps = realFileDeps({ v001: defect });
		const result = await runElevation3d({
			candidateId: input.candidateId,
			datasetRoot: input.datasetRoot,
			outputRoot: input.outputRoot,
			runId: `real-${defect}`,
			deps,
		});

		assert.equal(result.selected_version, "v002");
		assert.deepEqual(deps.calls, ["enrich:v001", "render:v001", "enrich:v002", "render:v002"]);
		const failure = await readJson(join(result.run_dir, "versions", "v001", "failure.json"));
		assert.equal(failure.retryable, true);
		assert.equal(failure.codes.includes(expectedCode), true);
		assert.equal((await readJson(join(result.run_dir, "versions", "v002", "validation.json"))).accepted, true);
	});
}

test("strictly validates and selects an exact-base fallback after two real generated defects", async () => {
	const input = await fixture();
	process.chdir(input.root);
	const deps = realFileDeps({ v001: "corrupt-glb", v002: "corrupt-drawing" });
	const result = await runElevation3d({
		candidateId: input.candidateId,
		datasetRoot: input.datasetRoot,
		outputRoot: input.outputRoot,
		runId: "real-fallback",
		deps,
	});

	assert.equal(result.selected_version, "fallback");
	assert.equal(result.attempts, 2);
	assert.equal(result.fallback, true);
	assert.deepEqual(deps.calls, [
		"enrich:v001", "render:v001",
		"enrich:v002", "render:v002",
		"enrich:fallback", "render:fallback",
	]);
	assert.equal((await readJson(join(result.run_dir, "versions", "v001", "failure.json"))).codes.includes("GLB_INVALID"), true);
	assert.equal((await readJson(join(result.run_dir, "versions", "v002", "failure.json"))).codes.includes("DRAWING_INVALID"), true);
	const validation = await readJson(join(result.run_dir, "versions", "fallback", "validation.json"));
	assert.equal(validation.accepted, true);
	assert.deepEqual(validation.codes, []);
	const document = await new NodeIO().read(result.artifact.path);
	assert.equal(document.getRoot().listMeshes().length, 1);
	assert.deepEqual(document.getRoot().listMaterials().map((material) => material.getName()), ["concrete"]);
	assert.equal((await readJson(join(result.run_dir, "final.json"))).selected, "fallback");
	const memoryLines = (await readFile(join(input.root, "memory", "elevation-3d", "unified-runs.jsonl"), "utf8"))
		.trim().split(/\r?\n/);
	assert.equal(memoryLines.length, 1);
	assert.equal(JSON.parse(memoryLines[0]).final.selected, "fallback");
});

test("persists blocked and throws when strict fallback validation fails", async () => {
	const input = await fixture();
	process.chdir(input.root);
	const deps = realFileDeps({
		v001: "corrupt-glb",
		v002: "corrupt-drawing",
		fallback: "missing-drawing",
	});
	const runDir = join(input.outputRoot, input.candidateId, "rejected-fallback");

	await assert.rejects(
		() => runElevation3d({
			candidateId: input.candidateId,
			datasetRoot: input.datasetRoot,
			outputRoot: input.outputRoot,
			runId: "rejected-fallback",
			deps,
		}),
		(error: Error & { code?: string }) => {
			assert.equal(error.code, "RUN_BLOCKED");
			assert.match(error.message, /DRAWING_MISSING/);
			return true;
		},
	);
	assert.deepEqual(deps.calls, [
		"enrich:v001", "render:v001",
		"enrich:v002", "render:v002",
		"enrich:fallback", "render:fallback",
	]);
	const fallbackFailure = await readJson(join(runDir, "versions", "fallback", "failure.json"));
	assert.equal(fallbackFailure.codes.includes("DRAWING_MISSING"), true);
	assert.equal(fallbackFailure.retryable, false);
	assert.equal((await readJson(join(runDir, "final.json"))).selected, "blocked");
	const memoryLines = (await readFile(join(input.root, "memory", "elevation-3d", "unified-runs.jsonl"), "utf8"))
		.trim().split(/\r?\n/);
	assert.equal(memoryLines.length, 1);
	assert.equal(JSON.parse(memoryLines[0]).final.selected, "blocked");
});

for (const failureStage of ["enrich", "render", "validate"] as const) {
	test(`blocks an unexpected ${failureStage} exception after v001 and preserves its cause`, async () => {
		const input = await fixture();
		process.chdir(input.root);
		const calls: string[] = [];
		const fault = Object.assign(new Error(`${failureStage} programming fault`), { code: "EACCES" });
		const deps = {
			enrich: async ({ outputPath, versionId }: { outputPath: string; versionId: string }) => {
				calls.push(`enrich:${versionId}`);
				if (failureStage === "enrich") throw fault;
				return {
					path: outputPath,
					sha256: "a".repeat(64),
					base_primitive: { positions: input.mesh.vertices, indices: input.mesh.triangles },
					bounds: { min: [-2.18, -1.18, 0], max: [2.18, 1.18, 3] },
				};
			},
			render: async ({ runDir, versionId }: { runDir: string; versionId: string }) => {
				calls.push(`render:${versionId}`);
				if (failureStage === "render") throw fault;
				return Object.fromEntries(
					["plan", "front", "back", "left", "right", "top", "axon"]
						.map((name) => [name, join(runDir, `${name}.png`)]),
				);
			},
			validate: async ({ versionId }: { versionId: string }) => {
				calls.push(`validate:${versionId}`);
				if (failureStage === "validate") throw fault;
				return { accepted: true, codes: [], metrics: {}, artifacts: {} };
			},
		};
		const runId = `throw-${failureStage}`;
		const runDir = join(input.outputRoot, input.candidateId, runId);

		await assert.rejects(
			() => runElevation3d({
				candidateId: input.candidateId,
				datasetRoot: input.datasetRoot,
				outputRoot: input.outputRoot,
				runId,
				deps,
			}),
			(error: Error & { cause?: unknown; code?: string }) => {
				assert.equal(error.code, "RUN_BLOCKED");
				assert.equal(error.cause, fault);
				return true;
			},
		);
		const expectedCalls = failureStage === "enrich"
			? ["enrich:v001"]
			: failureStage === "render"
				? ["enrich:v001", "render:v001"]
				: ["enrich:v001", "render:v001", "validate:v001"];
		assert.deepEqual(calls, expectedCalls);
		const failure = await readJson(join(runDir, "versions", "v001", "failure.json"));
		assert.equal(failure.stage, failureStage);
		assert.deepEqual(failure.codes, [{ enrich: "ENRICHMENT_FAILED", render: "RENDER_FAILED", validate: "VALIDATION_FAILED" }[failureStage]]);
		assert.equal(failure.retryable, false);
		assert.equal((await readJson(join(runDir, "final.json"))).selected, "blocked");
		const memoryLines = (await readFile(join(input.root, "memory", "elevation-3d", "unified-runs.jsonl"), "utf8"))
			.trim().split(/\r?\n/);
		assert.equal(memoryLines.length, 1);
	});
}

test("blocks an untrusted approved-image hash without attempting or falling back", async () => {
	const input = await fixture();
	process.chdir(input.root);
	const metadataPath = join(input.root, "memory", "elevation-3d", "assets", input.candidateId, "approved-design-v1.json");
	const metadata = await readJson(metadataPath);
	await writeJson(metadataPath, { ...metadata, image_sha256: "0".repeat(64) });
	const deps = validationDeps(input.mesh, {});

	await assert.rejects(
		() => runElevation3d({
			candidateId: input.candidateId,
			datasetRoot: input.datasetRoot,
			outputRoot: input.outputRoot,
			runId: "blocked",
			deps,
		}),
		(error: Error & { code?: string; retryable?: boolean }) => {
			assert.equal(error.code, "RUN_BLOCKED");
			assert.equal(error.retryable, false);
			assert.match(error.message, /approved image hash mismatch/i);
			return true;
		},
	);
	assert.deepEqual(deps.enrichCalls, []);
	await assert.rejects(() => readFile(join(input.root, "memory", "elevation-3d", "unified-runs.jsonl")), /ENOENT/);
});

test("blocks an incomplete trusted camera package before creating a run", async () => {
	const input = await fixture();
	process.chdir(input.root);
	const cameraPath = join(
		input.datasetRoot, "candidates", input.candidateId, "mass", "elevation-research", "camera-poses.json",
	);
	const cameras = await readJson(cameraPath);
	delete cameras.views.top;
	await writeJson(cameraPath, cameras);

	await assert.rejects(
		() => runElevation3d({
			candidateId: input.candidateId,
			datasetRoot: input.datasetRoot,
			outputRoot: input.outputRoot,
			runId: "missing-camera",
			deps: acceptedDeps(input.mesh),
		}),
		(error: Error & { code?: string; stage?: string }) => {
			assert.equal(error.code, "RUN_BLOCKED");
			assert.equal(error.stage, "input");
			assert.match(error.message, /camera/i);
			return true;
		},
	);
	await assert.rejects(() => access(input.outputRoot), /ENOENT/);
});

test("rejects unsafe agent identifiers before dataset access or output writes", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-unsafe-agent-id-"));
	temporaryRoots.push(root);
	const outputRoot = join(root, "output");
	for (const identifiers of [
		{ candidateId: "../outside", runId: "safe-run" },
		{ candidateId: "creative-013", runId: "../outside" },
	]) {
		await assert.rejects(
			() => runElevation3d({
				...identifiers,
				datasetRoot: join(root, "missing-dataset"),
				outputRoot,
			}),
			/safe path segment/i,
		);
	}
	await assert.rejects(() => access(outputRoot), /ENOENT/);
});

test("honors abort before input loading without creating a run", async () => {
	const input = await fixture();
	process.chdir(input.root);
	const controller = new AbortController();
	controller.abort(new DOMException("stop now", "AbortError"));
	await assert.rejects(() => runElevation3d({
		candidateId: input.candidateId,
		datasetRoot: input.datasetRoot,
		outputRoot: input.outputRoot,
		runId: "abort-before",
		signal: controller.signal,
		deps: acceptedDeps(input.mesh),
	}), { name: "AbortError" });
	await assert.rejects(() => access(input.outputRoot), /ENOENT/);
});

test("abort during render persists one cancelled v001 and never retries", async () => {
	const input = await fixture();
	process.chdir(input.root);
	const controller = new AbortController();
	const calls: string[] = [];
	const deps = acceptedDeps(input.mesh);
	deps.render = async ({ versionId }: any) => {
		calls.push(`render:${versionId}`);
		controller.abort(new DOMException("render cancelled", "AbortError"));
		return {};
	};
	await assert.rejects(() => runElevation3d({
		candidateId: input.candidateId,
		datasetRoot: input.datasetRoot,
		outputRoot: input.outputRoot,
		runId: "abort-render",
		signal: controller.signal,
		deps,
	}), { name: "AbortError" });
	assert.deepEqual(calls, ["render:v001"]);
	const runDir = join(input.outputRoot, input.candidateId, "abort-render");
	assert.equal((await readJson(join(runDir, "versions", "v001", "version.json"))).status, "cancelled");
	assert.equal((await readJson(join(runDir, "final.json"))).selected, "cancelled");
	await assert.rejects(() => access(join(runDir, "versions", "v002")), /ENOENT/);
	const event = JSON.parse(await readFile(join(input.root, "memory", "elevation-3d", "unified-runs.jsonl"), "utf8"));
	assert.deepEqual(event.versions.map((version: any) => [version.id, version.status]), [["v001", "cancelled"]]);
});

test("validation rejection retains GLB, drawings, provenance, and rejected report", async () => {
	const input = await fixture();
	process.chdir(input.root);
	const deps = await checkpointDeps(input.mesh, { rejectValidation: true });
	await assert.rejects(() => runElevation3d({
		candidateId: input.candidateId,
		datasetRoot: input.datasetRoot,
		outputRoot: input.outputRoot,
		runId: "checkpoint-rejected",
		deps,
	}), /POLICY_REJECTED/);
	const event = JSON.parse(await readFile(join(input.root, "memory", "elevation-3d", "unified-runs.jsonl"), "utf8"));
	const history = event.versions[0];
	assert.equal(history.status, "failed");
	assert.match(history.artifacts.glb.path, /^versions\/v001\/enriched\.glb$/);
	assert.match(history.artifacts.glb.sha256, /^[a-f0-9]{64}$/);
	assert.deepEqual(history.artifacts.glb.metrics, { bytes: 14 });
	assert.equal(Object.keys(history.artifacts.drawings).length, 7);
	assert.equal(Object.values(history.artifacts.drawings).every((drawing: any) => /^[a-f0-9]{64}$/.test(drawing.sha256)), true);
	assert.match(history.artifacts.provenance.path, /^versions\/v001\/drawing-provenance\.json$/);
	assert.match(history.artifacts.provenance.sha256, /^[a-f0-9]{64}$/);
	assert.equal(history.validation.accepted, false);
	assert.deepEqual(history.validation.codes, ["POLICY_REJECTED"]);
	assert.deepEqual(history.validation.metrics, { inspected: true });
	assert.match(history.artifacts.validation_report.sha256, /^[a-f0-9]{64}$/);
});

test("render failure retains the completed enrichment checkpoint", async () => {
	const input = await fixture();
	process.chdir(input.root);
	const deps = await checkpointDeps(input.mesh, { renderError: true });
	await assert.rejects(() => runElevation3d({
		candidateId: input.candidateId,
		datasetRoot: input.datasetRoot,
		outputRoot: input.outputRoot,
		runId: "checkpoint-render-failure",
		deps,
	}), { code: "RUN_BLOCKED" });
	const event = JSON.parse(await readFile(join(input.root, "memory", "elevation-3d", "unified-runs.jsonl"), "utf8"));
	assert.equal(event.versions[0].failure.stage, "render");
	assert.match(event.versions[0].artifacts.glb.path, /^versions\/v001\/enriched\.glb$/);
	assert.match(event.versions[0].artifacts.glb.sha256, /^[a-f0-9]{64}$/);
	assert.deepEqual(event.versions[0].artifacts.glb.metrics, { bytes: 14 });
	assert.deepEqual(event.versions[0].artifacts.drawings, {});
});

test("abort after enrichment retains GLB and abort after rendering also retains drawing evidence", async () => {
	for (const stage of ["enrich", "render"] as const) {
		const input = await fixture();
		process.chdir(input.root);
		const controller = new AbortController();
		const deps: any = await checkpointDeps(input.mesh, stage === "render" ? { abortAfterRender: controller } : {});
		if (stage === "enrich") deps.render = async () => {
			controller.abort(new DOMException("stop after enrich", "AbortError"));
			controller.signal.throwIfAborted();
		};
		await assert.rejects(() => runElevation3d({
			candidateId: input.candidateId,
			datasetRoot: input.datasetRoot,
			outputRoot: input.outputRoot,
			runId: `checkpoint-abort-${stage}`,
			signal: controller.signal,
			deps,
		}), { name: "AbortError" });
		const event = JSON.parse(await readFile(join(input.root, "memory", "elevation-3d", "unified-runs.jsonl"), "utf8"));
		assert.match(event.versions[0].artifacts.glb.sha256, /^[a-f0-9]{64}$/);
		assert.equal(Object.keys(event.versions[0].artifacts.drawings).length, stage === "render" ? 7 : 0);
		assert.equal(event.versions[0].status, "cancelled");
	}
});

async function productionRenderAbort(mode: "first-view" | "provenance") {
	const input = await fixture();
	process.chdir(input.root);
	const controller = new AbortController();
	const calls: string[] = [];
	const png = await sharp({ create: { width: 2, height: 3, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer();
	let captures = 0;
	const page = {
		setViewport: async () => {}, goto: async () => {}, waitForFunction: async () => {},
		$: async () => ({ screenshot: async ({ path }: { path: string }) => {
			await writeFile(path, png);
			captures++;
			if (mode === "first-view" && captures === 1) controller.abort(new DOMException("stop after first view", "AbortError"));
		} }),
		close: async () => calls.push("page.close"),
	};
	const browser = { newPage: async () => page, close: async () => calls.push("browser.close") };
	const enrich = async ({ outputPath }: any) => {
		const bytes = Buffer.from("production-render-glb");
		await writeFile(outputPath, bytes);
		return { path: outputPath, sha256: sha256(bytes), metrics: { bytes: bytes.length } };
	};
	const safetyTimer = setTimeout(() => {
		if (!controller.signal.aborted) controller.abort(new DOMException("render test safety timeout", "AbortError"));
	}, 2_000);
	try {
	await assert.rejects(() => runElevation3d({
		candidateId: input.candidateId, datasetRoot: input.datasetRoot, outputRoot: input.outputRoot,
		runId: `production-render-abort-${mode}`, signal: controller.signal,
		deps: {
			enrich,
			validate: async () => { throw new Error("validation must not run after render abort"); },
			renderLifecycle: {
				startPreview: async () => "http://127.0.0.1:4181/",
				stopPreview: async () => calls.push("preview.stop"),
				launchBrowser: async () => browser,
			},
			onRenderProgress: async (event: any) => {
				if (mode === "provenance" && event.type === "provenance") {
					controller.abort(new DOMException("stop after provenance", "AbortError"));
				}
			},
		},
	}), { name: "AbortError" });
	} finally {
		clearTimeout(safetyTimer);
	}
	const runDir = join(input.outputRoot, input.candidateId, `production-render-abort-${mode}`);
	const event = JSON.parse(await readFile(join(input.root, "memory", "elevation-3d", "unified-runs.jsonl"), "utf8"));
	return { calls, captures, event, runDir };
}

test("production renderer checkpoints a completed view before observing its abort", async () => {
	const { calls, captures, event, runDir } = await productionRenderAbort("first-view");
	assert.equal(captures, 1);
	assert.deepEqual(Object.keys(event.versions[0].artifacts.drawings), ["plan"]);
	assert.match(event.versions[0].artifacts.drawings.plan.sha256, /^[a-f0-9]{64}$/);
	assert.deepEqual(event.versions[0].artifacts.drawings.plan.metrics, { width: 2, height: 3 });
	assert.equal(event.versions[0].status, "cancelled");
	assert.equal(calls.filter((call) => call === "page.close").length, 1);
	assert.deepEqual(calls.slice(-2), ["browser.close", "preview.stop"]);
	await assert.rejects(() => access(join(runDir, "versions", "v002")), /ENOENT/);
});

test("production renderer checkpoints provenance before an observer-triggered abort", async () => {
	const { calls, captures, event, runDir } = await productionRenderAbort("provenance");
	assert.equal(captures, 7);
	assert.equal(Object.keys(event.versions[0].artifacts.drawings).length, 7);
	assert.match(event.versions[0].artifacts.provenance.sha256, /^[a-f0-9]{64}$/);
	assert.equal(event.versions[0].status, "cancelled");
	assert.deepEqual(calls.slice(-2), ["browser.close", "preview.stop"]);
	await assert.rejects(() => access(join(runDir, "versions", "fallback")), /ENOENT/);
});
