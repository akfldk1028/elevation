import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { renderAllViews } from "./all-views.mjs";
import { browserCameraMatchesCandidate, cameraValuesEqual, presentationCameraPresets, technicalCameraAuthorityFromGlb } from "./camera-authority.mjs";
import { assertNoReparseTree, prepareSafeDirectory, safeRead } from "./facade-agent/path-safety.mjs";
import { resolveMaterialPalette } from "./material-palettes.mjs";
import { verifyAllViewsViewer } from "./results.mjs";
import { sha256 } from "./core.mjs";

const VIEW_NAMES = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];
const ORTHOGRAPHIC_NAMES = ["front", "right", "back", "left", "top"];

function isAbort(error, signal) {
	return signal?.aborted || error?.name === "AbortError";
}

function throwIfAborted(signal) {
	signal?.throwIfAborted();
}

export class FinalDeliveryError extends Error {
	constructor({ code, message, cause, evidence }) {
		super(message, { cause });
		this.name = "FinalDeliveryError";
		this.stage = "delivery";
		this.code = code;
		this.evidence = evidence ?? {};
	}
}

function fail(code, message, evidence, cause) {
	throw new FinalDeliveryError({ code, message, evidence, cause });
}

function sourceBounds(mesh) {
	if (!Array.isArray(mesh?.vertices) || !mesh.vertices.length) fail("CAMERA_INPUT_INVALID", "source mesh vertices are required for delivery cameras");
	const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
	for (const point of mesh.vertices) {
		if (!Array.isArray(point) || point.length !== 3 || point.some((value) => !Number.isFinite(value))) fail("CAMERA_INPUT_INVALID", "source mesh contains an invalid vertex");
		for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], point[axis]); max[axis] = Math.max(max[axis], point[axis]); }
	}
	const size = max.map((value, axis) => value - min[axis]);
	const center = max.map((value, axis) => (value + min[axis]) / 2);
	return { min, max, size, center };
}

export function deriveDeliveryCameras(input) {
	const identity = input.cameras?.identity ?? input.identity;
	const views = input.cameras?.views;
	if (!views) fail("CAMERA_INPUT_INVALID", "candidate camera views are required");
	const cameras = {};
	for (const name of ORTHOGRAPHIC_NAMES) {
		const source = views[name];
		if (source?.projection !== "orthographic" || !source.projection_axes) fail("CAMERA_INPUT_INVALID", `orthographic ${name} camera is required`);
		cameras[name] = { ...structuredClone(source), name, identity: structuredClone(identity) };
	}
	const bounds = sourceBounds(input.mesh);
	const span = Math.max(...bounds.size, 1);
	const target = [...bounds.center];
	const position = [target[0] + span * 1.6, target[1] - span * 1.6, target[2] + span * 1.55];
	const opposite = [target[0] - span * 1.6, target[1] + span * 1.6, target[2] + span * 1.55];
	cameras.axon = { name: "axon", projection: "perspective", position, target, up: [0, 0, 1], fov_degrees: 32 };
	cameras["opposite-axon"] = { name: "opposite-axon", projection: "perspective", position: opposite, target, up: [0, 0, 1], fov_degrees: 32 };
	return cameras;
}

function exactNames(value) {
	return Object.keys(value ?? {}).sort().join("|") === [...VIEW_NAMES].sort().join("|");
}

function browserAccepted(report, cameras, buildingBounds) {
	const stability = report?.material_stability;
	const authoritative = presentationCameraPresets(cameras);
	return Array.isArray(report?.console_errors) && report.console_errors.length === 0
		&& Array.isArray(report.blocked_external_requests) && report.blocked_external_requests.length === 0
		&& report.glb_load_count === 1
		&& [...new Set(report.activated_views ?? [])].sort().join("|") === [...VIEW_NAMES].sort().join("|")
		&& exactNames(report.camera_presets)
		&& exactNames(report.camera_building_bounds)
		&& VIEW_NAMES.every((name) => cameraValuesEqual(report.camera_building_bounds[name], buildingBounds))
		&& VIEW_NAMES.every((name) => browserCameraMatchesCandidate({
			name, preset: authoritative[name], buildingBounds, actual: report.camera_presets[name],
		}))
		&& stability?.transparent_depth_writers === 0
		&& stability?.facade_detail_meshes > 0
		&& stability?.polygon_offset_facade_details === stability.facade_detail_meshes
		&& stability?.deterministic_render_order === true
		&& report.settled_frames_identical === true
		&& Array.isArray(report.settled_frame_hashes)
		&& report.settled_frame_hashes.length === 3
		&& new Set(report.settled_frame_hashes).size === 1;
}

function rootedRef(root, value) {
	return value?.path ? { path: isAbsolute(value.path) ? value.path : join(root, value.path), sha256: value.sha256 } : null;
}

function browserCameraEvidence(report, cameras, buildingBounds) {
	let authoritative;
	try { authoritative = presentationCameraPresets(cameras); }
	catch { return Object.fromEntries(VIEW_NAMES.map((name) => [name, false])); }
	return Object.fromEntries(VIEW_NAMES.map((name) => [name, browserCameraMatchesCandidate({
		name, preset: authoritative[name], buildingBounds, actual: report?.camera_presets?.[name],
	}) && cameraValuesEqual(report?.camera_building_bounds?.[name], buildingBounds)]));
}

function technicalCamerasAccepted(run, expectedCameras) {
	if (!exactNames(run?.manifest?.views)) return false;
	return VIEW_NAMES.every((name) => cameraValuesEqual(run.manifest.views[name]?.camera, expectedCameras?.[name]));
}

async function memoryRecord(run, browser, deliveryRoot) {
	const selectedPath = join(deliveryRoot, run.manifest.selected_glb.path);
	const screenshots = browser.screenshot_artifacts ?? Object.fromEntries(await Promise.all(Object.entries(browser.screenshots ?? {}).map(async ([key, value]) => {
		const path = typeof value === "string" ? value : value.path;
		return [key, { path, sha256: value?.sha256 ?? sha256(await readFile(path)) }];
	})));
	return {
		schema_version: "arr.elevation3d.final-delivery-memory.v1",
		selected_glb: { path: selectedPath, sha256: sha256(await readFile(selectedPath)) },
		manifest: run.manifest_record,
		validation: { path: run.validation.path, sha256: run.validation.sha256 },
		viewer: Object.fromEntries(["html", "app", "config"].map((key) => [key, rootedRef(deliveryRoot, run.manifest.verified_evidence?.viewer?.[key])])),
		browser_verification: {
			path: browser.path, sha256: browser.sha256,
			screenshots,
		},
		views: Object.fromEntries(VIEW_NAMES.map((name) => [name, {
			image: { path: run.views[name].path, sha256: run.views[name].sha256 },
			manifest: rootedRef(deliveryRoot, run.manifest.views[name].manifest),
			validation: rootedRef(deliveryRoot, run.manifest.views[name].validation_report),
			selected_glb_sha256: run.views[name].selected_glb_sha256,
		}])),
	};
}

export async function deliverSelectedAllViews({ runDir, deliveryRoot: deliveryRootInput, candidateId, artifact, validation, validationReceipt, input, signal, lifecycle, deps = {} }) {
	throwIfAborted(signal);
	const absoluteRunDir = resolve(runDir);
	const deliveryRoot = deliveryRootInput ? resolve(deliveryRootInput) : join(absoluteRunDir, "delivery");
	const deliveryChild = relative(absoluteRunDir, deliveryRoot);
	if (!deliveryChild || deliveryChild === ".." || deliveryChild.startsWith(`..${sep}`) || isAbsolute(deliveryChild)) {
		fail("DELIVERY_PATH_INVALID", "delivery root must remain beneath the run directory");
	}
	try { await prepareSafeDirectory(absoluteRunDir, deliveryRoot, "delivery root"); await assertNoReparseTree(deliveryRoot); }
	catch (error) { fail("DELIVERY_PATH_INVALID", "delivery root contains a link or reparse point", {}, error); }
	const cameras = deriveDeliveryCameras(input);
	const render = deps.renderAllViews ?? renderAllViews;
	const verify = deps.verifyAllViewsViewer ?? verifyAllViewsViewer;
	let run;
	try {
		run = await render({
			runDir: deliveryRoot,
			glbPath: artifact.path,
			sourceMesh: input.mesh,
			floorGuides: input.floor_guides,
			facadePlanes: input.facade_planes,
			facadeSegmentAuthority: input.facade_segment_authority,
			facadeValidation: validation,
			facadeValidationReceipt: validationReceipt?.path ? { ...validationReceipt, path: join(resolve(runDir), validationReceipt.path) } : null,
			cameras,
			palette: resolveMaterialPalette("competition-warm"),
			candidateId,
			cutElevationM: 1.2,
			signal,
			lifecycle,
		});
	} catch (error) {
		if (isAbort(error, signal)) throw signal?.reason ?? error;
		fail("ALL_VIEWS_FAILED", "all-view rendering failed", {}, error);
	}
	try { await assertNoReparseTree(deliveryRoot); }
	catch (error) { fail("DELIVERY_PATH_INVALID", "renderer created an unsafe delivery path", {}, error); }
	throwIfAborted(signal);
	if (!run?.validation?.accepted || !exactNames(run.views)) {
		fail("ALL_VIEWS_REJECTED", "all-view package validation rejected", {
			codes: run?.validation?.codes ?? [], views: Object.keys(run?.views ?? {}),
		});
	}
	let buildingBounds, expectedTechnicalCameras;
	try {
		const selectedPath = join(deliveryRoot, run.manifest.selected_glb.path);
		const selectedBytes = await safeRead(deliveryRoot, selectedPath, "contained technical selected GLB");
		if (sha256(selectedBytes) !== artifact.sha256 || sha256(selectedBytes) !== run.manifest.selected_glb.sha256) {
			fail("ALL_VIEWS_REJECTED", "contained technical selected GLB differs from selected authority");
		}
		const authority = await technicalCameraAuthorityFromGlb({ bytes: selectedBytes, cameras });
		buildingBounds = authority.building_bounds;
		expectedTechnicalCameras = authority.cameras;
	} catch (error) {
		if (error instanceof FinalDeliveryError) throw error;
		fail("ALL_VIEWS_REJECTED", "contained technical selected GLB camera authority is unavailable", {}, error);
	}
	if (!technicalCamerasAccepted(run, expectedTechnicalCameras)) {
		fail("ALL_VIEWS_REJECTED", "all-view package differs from the deterministic candidate camera fit", {
			camera_authority: Object.fromEntries(VIEW_NAMES.map((name) => [name,
				cameraValuesEqual(run.manifest.views[name]?.camera, expectedTechnicalCameras[name])])),
		});
	}
	const technicalCameras = Object.fromEntries(VIEW_NAMES.map((name) => [name, run.manifest.views[name].camera]));
	let browser;
	try {
		await assertNoReparseTree(deliveryRoot);
		browser = await verify({ runDir: deliveryRoot, signal });
	} catch (error) {
		if (isAbort(error, signal)) throw signal?.reason ?? error;
		fail("BROWSER_VERIFICATION_FAILED", "all-view browser verification failed", {}, error);
	}
	try { await assertNoReparseTree(deliveryRoot); }
	catch (error) { fail("DELIVERY_PATH_INVALID", "browser verification created an unsafe delivery path", {}, error); }
	throwIfAborted(signal);
	if (!browserAccepted(browser, technicalCameras, buildingBounds)) fail("BROWSER_VERIFICATION_REJECTED", "all-view browser evidence rejected", {
		console_errors: browser?.console_errors ?? [],
		glb_load_count: browser?.glb_load_count,
		activated_views: browser?.activated_views ?? [],
		material_stability: browser?.material_stability,
		settled_frames_identical: browser?.settled_frames_identical,
		camera_authority: browserCameraEvidence(browser, technicalCameras, buildingBounds),
	});
	return {
		schema_version: "arr.elevation3d.final-delivery.v1",
		run_dir: deliveryRoot,
		manifest: run.manifest,
		validation: run.validation,
		viewer: { path: join(deliveryRoot, run.manifest.viewer.path) },
		browser_verification: browser,
		views: run.views,
		memory_record: await memoryRecord(run, browser, deliveryRoot),
		invocations: { render_all_views: 1, browser_verification: 1 },
	};
}
