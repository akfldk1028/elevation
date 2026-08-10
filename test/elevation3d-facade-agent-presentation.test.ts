import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";

import { deliverFacadeFinalPresentation as deliverPresentationBoundary } from "../plugins/elevation-3d/lib/facade-agent/final-presentation.mjs";
import { readContentAddressedJson, verifyFacadeArtifactClosure } from "../plugins/elevation-3d/lib/facade-agent/artifact-closure.mjs";
import { facadeCandidateHash } from "../plugins/elevation-3d/lib/facade-agent/candidate-authority.mjs";
import { technicalCameraAuthorityFromGlb } from "../plugins/elevation-3d/lib/camera-authority.mjs";
import { stableJson } from "../plugins/elevation-3d/lib/core.mjs";
import { rehydrateVerifiedFacadeValidationAuthority } from "../plugins/elevation-3d/lib/enrichment-validation.mjs";
import { deriveDeliveryCameras } from "../plugins/elevation-3d/lib/final-delivery.mjs";
import { cameraContractHash, deriveExpectedCameraContract, presentationCameraPresets } from "../plugins/elevation-3d/lib/texturing/render-validator.mjs";

const VIEW_NAMES = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];

function sha256(value: string | Buffer) {
	return createHash("sha256").update(value).digest("hex");
}

function candidate() {
	const views = {
		front: { projection: "orthographic", projected_bounds_m: [[0, 0], [10, 12]], projection_axes: { depth: [0, -1, 0], horizontal: [1, 0, 0], vertical: [0, 0, 1] } },
		right: { projection: "orthographic", projected_bounds_m: [[0, 0], [8, 12]], projection_axes: { depth: [1, 0, 0], horizontal: [0, 1, 0], vertical: [0, 0, 1] } },
		back: { projection: "orthographic", projected_bounds_m: [[-10, 0], [0, 12]], projection_axes: { depth: [0, 1, 0], horizontal: [-1, 0, 0], vertical: [0, 0, 1] } },
		left: { projection: "orthographic", projected_bounds_m: [[-8, 0], [0, 12]], projection_axes: { depth: [-1, 0, 0], horizontal: [0, -1, 0], vertical: [0, 0, 1] } },
		top: { projection: "orthographic", projected_bounds_m: [[0, 0], [10, 8]], projection_axes: { depth: [0, 0, 1], horizontal: [1, 0, 0], vertical: [0, 1, 0] } },
	};
	return {
		candidate: { candidate_id: "creative-020" }, identity: { geometry_hash: "fixture-geometry" },
		mesh: { vertices: [[0, 0, 0], [10, 0, 0], [0, 8, 12]] },
		cameras: { identity: { source: "fixture" }, views },
	};
}

function deliverFacadeFinalPresentation(options: Record<string, any>) {
	return deliverPresentationBoundary({
		provider: "local-fixture", candidateSha256: facadeCandidateHash(candidate()), selectedVersion: "v001",
		...options,
	});
}

function authoritativeCamera(name: string) {
	const source = candidate().cameras.views as Record<string, any>;
	const perspective = name === "axon" ? { position: [24.2, -15.2, 24.6], target: [5, 4, 6] }
		: name === "opposite-axon" ? { position: [-14.2, 23.2, 24.6], target: [5, 4, 6] } : null;
	if (perspective) {
		const unit = (values: number[]) => { const length = Math.hypot(...values); return values.map((value) => value / length); };
		const cross = (left: number[], right: number[]) => [left[1] * right[2] - left[2] * right[1], left[2] * right[0] - left[0] * right[2], left[0] * right[1] - left[1] * right[0]];
		const forward = unit(perspective.target.map((value, index) => value - perspective.position[index]));
		const right = unit(cross(forward, [0, 0, 1]));
		return { type: "perspective", ...perspective, up: unit(cross(right, forward)), fov_degrees: 32, near: 0.1, far: 100, aspect: 1 };
	}
	const preset = source[name === "plan" ? "top" : name];
	return {
		type: "orthographic", projection_axes: structuredClone(preset.projection_axes),
		frustum: { left: -10, right: 10, top: 10, bottom: -10, near: 0.1, far: 100 },
	};
}

async function png(index: number) {
	return sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 20 + index, g: 40 + index, b: 60 + index } } }).png().toBuffer();
}

function candidateBuildingBounds() {
	const vertices = candidate().mesh.vertices;
	const min = [0, 1, 2].map((axis) => Math.min(...vertices.map((point) => point[axis])));
	const max = [0, 1, 2].map((axis) => Math.max(...vertices.map((point) => point[axis])));
	const size = max.map((value, axis) => value - min[axis]);
	return { center: max.map((value, axis) => (value + min[axis]) / 2), radius: Math.max(Math.hypot(...size) * 0.75, 1) };
}

async function candidateGlbBytes() {
	const document = new Document(), buffer = document.createBuffer();
	const positions = document.createAccessor("positions", buffer).setType("VEC3")
		.setArray(new Float32Array(candidate().mesh.vertices.flat()));
	const indices = document.createAccessor("indices", buffer).setType("SCALAR").setArray(new Uint16Array([0, 1, 2]));
	const primitive = document.createPrimitive().setAttribute("POSITION", positions).setIndices(indices);
	const node = document.createNode("exact-mass").setMesh(document.createMesh("exact-mass").addPrimitive(primitive));
	document.createScene("Scene").addChild(node);
	return Buffer.from(await new NodeIO().writeBinary(document));
}

async function writeAcceptedTechnicalDelivery(runDir: string, glbPath: string, glbSha256: string) {
	const root = join(runDir, "technical-delivery");
	const views: Record<string, any> = {};
	const detailPaths: Record<string, string> = {};
	const memoryViews: Record<string, any> = {};
	await mkdir(root, { recursive: true });
	await copyFile(glbPath, join(root, "enriched.glb"));
	const technicalCameras = (await technicalCameraAuthorityFromGlb({
		bytes: await readFile(glbPath), cameras: deriveDeliveryCameras(candidate()),
	})).cameras as Record<string, any>;
	for (const [index, name] of VIEW_NAMES.entries()) {
		const relativePath = join("views", name, `${name}-manifest.json`);
		const validationRelativePath = join("views", name, `${name}-validation.json`);
		const imageRelativePath = join("views", name, `${name}.png`);
		const path = join(root, relativePath), validationPath = join(root, validationRelativePath), imagePath = join(root, imageRelativePath);
		await mkdir(join(root, "views", name), { recursive: true });
		const type = ["axon", "opposite-axon"].includes(name) ? "perspective" : "orthographic";
		const camera = technicalCameras[name];
		const detail = {
			schema_version: type === "perspective" ? "arr.elevation3d.competition-axon.v1"
				: ["plan", "top"].includes(name) ? "arr.elevation3d.competition-plan-top.v1" : "arr.elevation3d.competition-elevation.v1",
			...(["plan", "top"].includes(name) ? { mode: name } : { view: name }),
			selected_glb_sha256: glbSha256, camera,
			cut: name === "plan" ? { enabled: true, elevation_m: 1.2, plane_world: [0, 0, 1, -1.2] }
				: { enabled: false, elevation_m: null, plane_world: null },
			content_bounds_px: { min_x: 10, min_y: 10, max_x: 89, max_y: 89 },
		};
		const bytes = Buffer.from(JSON.stringify(detail)), imageBytes = await png(index);
		const validation = { schema_version: "fixture-view-validation.v1", accepted: true, codes: [], metrics: { content_bounds_px: detail.content_bounds_px } };
		const validationBytes = Buffer.from(JSON.stringify(validation));
		await writeFile(path, bytes);
		await writeFile(validationPath, validationBytes);
		await writeFile(imagePath, imageBytes);
		detailPaths[name] = path;
		views[name] = {
			path: imageRelativePath, sha256: sha256(imageBytes), width: 2, height: 2, selected_glb_sha256: glbSha256, camera,
			validation, manifest: { path: relativePath, sha256: sha256(bytes) }, validation_report: { path: validationRelativePath, sha256: sha256(validationBytes) },
		};
		memoryViews[name] = {
			path: imagePath, sha256: sha256(imageBytes), manifest: { path, sha256: sha256(bytes) },
			validation: { path: validationPath, sha256: sha256(validationBytes) }, selected_glb_sha256: glbSha256,
		};
	}
	await mkdir(join(root, "viewer"), { recursive: true });
	const viewerArtifacts: Record<string, any> = {};
	for (const [key, file, content] of [["html", "index.html", "<html>viewer</html>"], ["app", "app.js", "globalThis.viewer=true;"], ["config", "config.json", JSON.stringify({ cameras: { views: technicalCameras } })]] as const) {
		const path = join(root, "viewer", file), bytes = Buffer.from(content);
		await writeFile(path, bytes); viewerArtifacts[key] = { path: join("viewer", file), sha256: sha256(bytes) };
	}
	await mkdir(join(root, "browser-verification"), { recursive: true });
	const screenshots: Record<string, any> = {};
	for (const [key, file, bytes] of [["initial", "viewer-initial.png", await png(20)], ["interacted", "viewer-interacted.png", await png(21)]] as const) {
		const path = join(root, "browser-verification", file); await writeFile(path, bytes); screenshots[key] = { path, sha256: sha256(bytes) };
	}
	const browserReport = {
		schema_version: "arr.elevation3d.browser-verification.v1", page_loaded: true, activated_views: VIEW_NAMES,
		camera_presets: technicalCameras, screenshots,
		console_errors: [], blocked_external_requests: [], glb_load_count: 1,
	};
	const browserPath = join(root, "browser-verification", "browser-verification.json"), browserBytes = Buffer.from(JSON.stringify(browserReport));
	await writeFile(browserPath, browserBytes);
	const validation = { schema_version: "arr.elevation3d.all-views-validation.v1", accepted: true, codes: [] };
	const validationPath = join(root, "validation.json"), validationBytes = Buffer.from(JSON.stringify(validation));
	await writeFile(validationPath, validationBytes);
	const manifest = {
		schema_version: "arr.elevation3d.all-views.v1", selected_glb: { path: "enriched.glb", sha256: glbSha256 },
		views, verified_evidence: { viewer: viewerArtifacts }, viewer: { path: "viewer/index.html", config_sha256: viewerArtifacts.config.sha256 }, validation,
	};
	const manifestPath = join(root, "all-views-manifest.json");
	const manifestBytes = Buffer.from(JSON.stringify(manifest));
	await writeFile(manifestPath, manifestBytes);
	return {
		delivery: {
			run_dir: root, manifest, validation, views,
			memory_record: {
				schema_version: "arr.elevation3d.final-delivery-memory.v1",
				selected_glb: { path: join(root, "enriched.glb"), sha256: glbSha256 },
				manifest: { path: manifestPath, sha256: sha256(manifestBytes) }, validation: { path: validationPath, sha256: sha256(validationBytes) },
				viewer: Object.fromEntries(Object.entries(viewerArtifacts).map(([key, ref]: [string, any]) => [key, { path: join(root, ref.path), sha256: ref.sha256 }])),
				browser_verification: { path: browserPath, sha256: sha256(browserBytes), screenshots }, views: memoryViews,
			},
		},
		manifestPath, detailPaths,
	};
}

function claimDifferentTechnicalGlb(delivery: any, glbSha256: string) {
	const changed = structuredClone(delivery);
	changed.manifest.selected_glb.sha256 = glbSha256;
	return changed;
}

function fakeAcceptedPbrRenderer(calls: any[], glbSha256: string, overrides: Record<string, unknown> = {}) {
	const { identicalMasks = false, ...reportOverrides } = overrides as Record<string, any>;
	return async (options: any) => {
		calls.push(options);
		const presentationCameras = presentationCameraPresets(options.cameras);
		const buildingBounds = candidateBuildingBounds();
		await mkdir(join(options.runDir, "viewer"), { recursive: true });
		await copyFile(options.glbPath, join(options.runDir, "textured.glb"));
		const viewerArtifacts: Record<string, any> = {};
		for (const [key, file, content] of [["html", "index.html", "<html>presentation</html>"], ["app", "app.js", "globalThis.presentation=true;"], ["config", "config.json", JSON.stringify({ cameras: { views: options.cameras } })]] as const) {
			const path = join(options.runDir, "viewer", file), bytes = Buffer.from(content); await writeFile(path, bytes); viewerArtifacts[key] = { path, sha256: sha256(bytes) };
		}
		const artifacts: Record<string, any> = {}, views: Record<string, any> = {};
		for (const [index, name] of VIEW_NAMES.entries()) {
			const directory = join(options.runDir, "views", name); await mkdir(directory, { recursive: true });
			const bytes = await png(40 + index), maskBytes = await png(identicalMasks ? 60 : 60 + index);
			const path = join(directory, `${name}.png`), maskPath = join(directory, `${name}-semantic-roles.png`);
			await writeFile(path, bytes); await writeFile(maskPath, maskBytes);
			const expectedCamera = deriveExpectedCameraContract({ name, preset: presentationCameras[name], buildingBounds });
			const cameraEvidence = {
				building_bounds: buildingBounds,
				expected: expectedCamera, actual: structuredClone(expectedCamera),
				expected_hash: cameraContractHash(expectedCamera), actual_hash: cameraContractHash(expectedCamera),
			};
			views[name] = { path, sha256: sha256(bytes), semanticRoleMaskPath: maskPath, semanticRoleMaskSha256: sha256(maskBytes), selectedGlbSha256: glbSha256, cameraEvidence };
			artifacts[`view_${name}`] = { path, sha256: sha256(bytes) };
			artifacts[`semantic_role_mask_${name}`] = { path: maskPath, sha256: sha256(maskBytes) };
		}
		for (const [key, file, value] of [
			["render_style", "render-style.json", { id: "competition-daylight-v1" }],
			["presentation_evidence", "presentation-evidence.json", { schema_version: "arr.elevation3d.presentation-evidence.v1", views: Object.fromEntries(VIEW_NAMES.map((name) => [name, { accepted: true }])) }],
			["semantic_role_evidence", "semantic-role-evidence.json", { schema_version: "arr.elevation3d.semantic-role-evidence.v1", views: Object.fromEntries(VIEW_NAMES.map((name) => [name, { accepted: true }])) }],
			["baseline_comparison", "baseline-comparison.json", { schema_version: "arr.elevation3d.presentation-baseline-comparison.v1", status: "not_compared", views: {} }],
		] as const) {
			const path = join(options.runDir, file), bytes = Buffer.from(JSON.stringify(value)); await writeFile(path, bytes); artifacts[key] = { path, sha256: sha256(bytes) };
		}
		const contactSheetBytes = await png(80), contactSheetPath = join(options.runDir, "contact-sheet.png");
		await writeFile(contactSheetPath, contactSheetBytes); artifacts.contact_sheet = { path: contactSheetPath, sha256: sha256(contactSheetBytes) };
		const report: any = {
			schema_version: "arr.elevation3d.embedded-pbr-render.v2",
			selected_glb: { path: options.glbPath, sha256: glbSha256 }, browser_loaded_glb: { path: join(options.runDir, "textured.glb"), sha256: glbSha256 },
			views, material_mode: "embedded-pbr", render_style: { id: "competition-daylight-v1" }, render_style_sha256: "a".repeat(64),
			presentation_environment: { status: "ready" }, pbr_evidence: { material_count: 4, base_color_maps: 2, normal_maps: 2, metallic_roughness_maps: 2 },
			presentation_evidence: Object.fromEntries(VIEW_NAMES.map((name) => [name, { accepted: true }])), semantic_role_evidence: Object.fromEntries(VIEW_NAMES.map((name) => [name, { accepted: true }])),
			canonical_selection: options.canonicalSelection,
			camera_authority: { views: presentationCameras, sha256: cameraContractHash(presentationCameras) },
			validation: { accepted: true, codes: [] }, provider_calls: 0, credits_consumed: 0,
			contact_sheet: artifacts.contact_sheet, artifacts, viewer: viewerArtifacts, ...reportOverrides,
		};
		const reportPath = join(options.runDir, "render-validation.json"); await writeFile(reportPath, JSON.stringify(report));
		return report;
	};
}

async function fixture() {
	const runDir = await mkdtemp(join(tmpdir(), "elevation3d-facade-presentation-"));
	const glbPath = join(runDir, "enriched.glb");
	const glbBytes = await candidateGlbBytes();
	await writeFile(glbPath, glbBytes);
	const receiptPath = join(runDir, "facade-validation.json");
	const receiptValue = {
		schema_version: "arr.elevation3d.facade-validation-receipt.v1",
		provider: "local-fixture", version_id: "v001", artifact_sha256: sha256(glbBytes),
		validation: { accepted: true, codes: [] },
	};
	const receiptBytes = Buffer.from(JSON.stringify(receiptValue, null, 2));
	await writeFile(receiptPath, receiptBytes);
	const technical = await writeAcceptedTechnicalDelivery(runDir, glbPath, sha256(glbBytes));
	return {
		runDir, glbPath, glbSha256: sha256(glbBytes), receiptPath, receiptSha256: sha256(receiptBytes),
		receiptContentSha256: sha256(stableJson(receiptValue)), technicalDelivery: technical.delivery,
		technicalManifestPath: technical.manifestPath, technicalDetailPaths: technical.detailPaths,
	};
}

function authoritativeValidation(glbSha256: string) {
	const metrics = { canonical_surface_match: 1, segment_authority_match: true };
	const artifacts = { provenance: "drawing-provenance.json" };
	const authority = {
		provider: "local-fixture", candidateId: "creative-020",
		bindings: { glb_sha256: glbSha256, grammar_sha256: "a".repeat(64) },
		grammar: { system: "brick-punched-window-v1" }, metrics, visualScore: 92,
	};
	const validation = rehydrateVerifiedFacadeValidationAuthority({ accepted: true, codes: [], metrics, artifacts }, authority);
	return { validation, authority, normalized: { accepted: true, codes: [], retryable: false, metrics, artifacts } };
}

async function replaceValidationReceipt(f: any, validation: any, validationAuthority: any) {
	const value = {
		schema_version: "arr.elevation3d.facade-validation-receipt.v1",
		provider: "local-fixture", version_id: "v001", artifact_sha256: f.glbSha256,
		validation, validation_authority: validationAuthority,
	};
	const bytes = Buffer.from(JSON.stringify(value, null, 2));
	await writeFile(f.receiptPath, bytes);
	return { path: f.receiptPath, sha256: sha256(bytes), receipt_sha256: sha256(stableJson(value)) };
}

test("renders one validated facade GLB into a bound final presentation", async () => {
	const f = await fixture();
	try {
		const calls: any[] = [];
		const result = await deliverFacadeFinalPresentation({
			runDir: f.runDir, presentationRoot: join(f.runDir, "final-presentation"), candidateId: "creative-020",
			artifact: { path: f.glbPath, sha256: f.glbSha256 },
			validation: { accepted: true, codes: [] },
			validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 },
			technicalDelivery: f.technicalDelivery, input: candidate(),
			deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, f.glbSha256) },
		});
		assert.equal(calls.length, 1);
		assert.equal(calls[0].glbPath, f.glbPath);
		assert.equal(calls[0].runDir, resolve(f.runDir, "final-presentation"));
		assert.equal(calls[0].renderStyleId, "competition-daylight-v1");
		assert.equal(calls[0].proceduralBaseline.manifest.sha256, f.technicalDelivery.memory_record.manifest.sha256);
		assert.equal(calls[0].proceduralBaseline.views.front.camera.type, "orthographic");
		assert.equal(result.schema_version, "arr.elevation3d.facade-final-presentation.v1");
		assert.equal(result.selected_glb.sha256, f.glbSha256);
		assert.equal(result.render.selected_glb.sha256, f.glbSha256);
		assert.equal(result.memory_record.presentation.sha256.length, 64);
		assert.equal(result.receipt.sha256, f.receiptSha256);
		assert.deepEqual(Object.keys(result.render.views).sort(), [...VIEW_NAMES].sort());
		const durable = JSON.parse(await readFile(result.memory_record.presentation.path, "utf8"));
		assert.equal(durable.selected_glb.sha256, f.glbSha256);
		assert.equal(durable.memory_record.presentation, null);
		assert.notDeepEqual(durable.memory_record, result.memory_record);
		assert.equal(result.memory_record.artifact_closure.sha256.length, 64);
	} finally { await rm(f.runDir, { recursive: true, force: true }); }
});

test("artifact closure permits distinct semantic-role mask files with identical valid pixels", async () => {
	const f = await fixture();
	try {
		const calls: any[] = [];
		const result = await deliverFacadeFinalPresentation({
			runDir: f.runDir, presentationRoot: join(f.runDir, "equal-mask-pixels"), candidateId: "creative-020",
			provider: "local-fixture", candidateSha256: facadeCandidateHash(candidate()), selectedVersion: "v001",
			artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
			validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 },
			technicalDelivery: f.technicalDelivery, input: candidate(),
			deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, f.glbSha256, { identicalMasks: true }) },
		});
		const closure = JSON.parse(await readFile(join(f.runDir, result.memory_record.artifact_closure.path), "utf8"));
		assert.equal(new Set(Object.values(closure.presentation.views).map((view: any) => view.semantic_role_mask.path)).size, 8);
		assert.equal(new Set(Object.values(closure.presentation.views).map((view: any) => view.semantic_role_mask.sha256)).size, 1);
	} finally { await rm(f.runDir, { recursive: true, force: true }); }
});

test("content-addressed JSON parses the one immutable buffer that it hashes", async () => {
	const runDir = resolve(tmpdir(), "elevation3d-content-addressed-json");
	let reads = 0;
	const original = Buffer.from(JSON.stringify({ accepted: true, selected_glb: "a".repeat(64) }));
	const mutated = Buffer.from(JSON.stringify({ accepted: false, selected_glb: "b".repeat(64) }));
	const result = await readContentAddressedJson({
		runDir,
		value: { path: "authority.json", sha256: sha256(original) },
		label: "authority",
		readBytes: async () => (++reads === 1 ? original : mutated),
	});
	assert.equal(reads, 1);
	assert.equal(result.value.accepted, true);
	assert.equal(result.ref.sha256, sha256(original));
});

test("content-addressed JSON rejects a wrong claimed hash after one read", async () => {
	const runDir = resolve(tmpdir(), "elevation3d-content-addressed-json");
	let reads = 0;
	const bytes = Buffer.from(JSON.stringify({ accepted: true }));
	await assert.rejects(() => readContentAddressedJson({
		runDir,
		value: { path: "authority.json", sha256: "0".repeat(64) },
		label: "authority",
		readBytes: async () => { reads += 1; return bytes; },
	}), (error: any) => error?.code === "FACADE_PRESENTATION_ARTIFACT_CLOSURE_INVALID");
	assert.equal(reads, 1);
});

test("content-addressed JSON rejects invalid JSON after one read", async () => {
	const runDir = resolve(tmpdir(), "elevation3d-content-addressed-json");
	let reads = 0;
	const bytes = Buffer.from("not-json");
	await assert.rejects(() => readContentAddressedJson({
		runDir,
		value: { path: "authority.json", sha256: sha256(bytes) },
		label: "authority",
		readBytes: async () => { reads += 1; return bytes; },
	}), (error: any) => error?.code === "FACADE_PRESENTATION_ARTIFACT_CLOSURE_INVALID");
	assert.equal(reads, 1);
});

test("production artifact-closure verification reads each semantic JSON leaf exactly once", async () => {
	const f = await fixture();
	try {
		const result = await deliverFacadeFinalPresentation({
			runDir: f.runDir, presentationRoot: join(f.runDir, "single-read-verification"), candidateId: "creative-020",
			provider: "local-fixture", candidateSha256: facadeCandidateHash(candidate()), selectedVersion: "v001",
			artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
			validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 },
			technicalDelivery: f.technicalDelivery, input: candidate(),
			deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer([], f.glbSha256) },
		});
		const closurePath = join(f.runDir, result.memory_record.artifact_closure.path);
		const closure = JSON.parse(await readFile(closurePath, "utf8"));
		const targets = new Map([
			[resolve(f.runDir, closure.technical.manifest.path), "technical manifest"],
			[resolve(f.runDir, closure.presentation.manifest.path), "presentation wrapper"],
			[resolve(f.runDir, closure.presentation.report.path), "presentation report"],
		]);
		const reads = new Map([...targets.keys()].map((path) => [path, 0]));
		const originalReadFile = readFile;
		(fs.promises as any).readFile = async (...args: any[]) => {
			const path = resolve(String(args[0]));
			if (reads.has(path)) reads.set(path, reads.get(path)! + 1);
			return (originalReadFile as any)(...args);
		};
		syncBuiltinESMExports();
		try {
			await verifyFacadeArtifactClosure({ runDir: f.runDir, reference: result.memory_record.artifact_closure });
		} finally {
			(fs.promises as any).readFile = originalReadFile;
			syncBuiltinESMExports();
		}
		assert.deepEqual(
			Object.fromEntries([...targets].map(([path, label]) => [label, reads.get(path)])),
			{ "technical manifest": 1, "presentation wrapper": 1, "presentation report": 1 },
		);
	} finally { await rm(f.runDir, { recursive: true, force: true }); }
});

test("artifact closure rejects a rehashed technical detail manifest that points outside the contained delivery", async () => {
	const f = await fixture();
	try {
		const technicalDelivery = structuredClone(f.technicalDelivery);
		const detail = JSON.parse(await readFile(f.technicalDetailPaths.axon, "utf8"));
		detail.selected_glb = { path: resolve(f.runDir, "..", "outside.glb"), sha256: f.glbSha256 };
		const detailBytes = Buffer.from(JSON.stringify(detail));
		await writeFile(f.technicalDetailPaths.axon, detailBytes);
		technicalDelivery.manifest.views.axon.manifest.sha256 = sha256(detailBytes);
		const manifestBytes = Buffer.from(JSON.stringify(technicalDelivery.manifest));
		await writeFile(f.technicalManifestPath, manifestBytes);
		technicalDelivery.memory_record.manifest.sha256 = sha256(manifestBytes);

		await assert.rejects(() => deliverFacadeFinalPresentation({
			runDir: f.runDir, presentationRoot: join(f.runDir, "escaped-detail-glb"), candidateId: "creative-020",
			provider: "local-fixture", candidateSha256: facadeCandidateHash(candidate()), selectedVersion: "v001",
			artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
			validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 },
			technicalDelivery, input: candidate(),
			deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer([], f.glbSha256) },
		}), (error: any) => error?.code === "FACADE_PRESENTATION_ARTIFACT_CLOSURE_INVALID");
	} finally { await rm(f.runDir, { recursive: true, force: true }); }
});

test("a local artifact-closure failure rolls back its wrapper so the exact presentation can retry", async () => {
	const f = await fixture();
	const presentationRoot = join(f.runDir, "closure-retry");
	const options = {
		runDir: f.runDir, presentationRoot, candidateId: "creative-020",
		provider: "local-fixture", candidateSha256: facadeCandidateHash(candidate()), selectedVersion: "v001",
		artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
		validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 },
		technicalDelivery: f.technicalDelivery, input: candidate(),
	};
	try {
		await assert.rejects(() => deliverFacadeFinalPresentation({
			...options, deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer([], f.glbSha256, { artifacts: {} }) },
		}), (error: any) => error?.code === "FACADE_PRESENTATION_ARTIFACT_CLOSURE_INVALID");
		await assert.rejects(() => readFile(join(presentationRoot, "final-presentation.json")), (error: any) => error?.code === "ENOENT");
		const result = await deliverFacadeFinalPresentation({
			...options, deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer([], f.glbSha256) },
		});
		assert.equal(result.memory_record.artifact_closure.sha256.length, 64);
	} finally { await rm(f.runDir, { recursive: true, force: true }); }
});

test("rejects unauthenticated technical baseline paths, hashes, and cameras before rendering", async (t) => {
	for (const [name, code, tamper] of [
		["escaped manifest path", "FACADE_PRESENTATION_PATH_INVALID", async (f: any, delivery: any) => {
			delivery.memory_record.manifest.path = resolve(f.runDir, "..", "outside-all-views-manifest.json");
		}],
		["manifest hash", "FACADE_PRESENTATION_TECHNICAL_BINDING_MISMATCH", async (_f: any, delivery: any) => {
			delivery.memory_record.manifest.sha256 = "0".repeat(64);
		}],
		["detailed camera", "FACADE_PRESENTATION_TECHNICAL_BINDING_MISMATCH", async (f: any) => {
			const detail = JSON.parse(await readFile(f.technicalDetailPaths.front, "utf8"));
			detail.camera.frustum.left -= 1;
			await writeFile(f.technicalDetailPaths.front, JSON.stringify(detail));
		}],
	] as const) await t.test(name, async () => {
		const f = await fixture();
		try {
			const technicalDelivery = structuredClone(f.technicalDelivery);
			await tamper(f, technicalDelivery);
			const calls: any[] = [];
			await assert.rejects(() => deliverFacadeFinalPresentation({
				runDir: f.runDir, presentationRoot: join(f.runDir, `tampered-${name.replaceAll(" ", "-")}`), candidateId: "creative-020",
				artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
				validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 },
				technicalDelivery, input: candidate(),
				deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, f.glbSha256) },
			}), (error: any) => error?.code === code);
			assert.equal(calls.length, 0);
		} finally { await rm(f.runDir, { recursive: true, force: true }); }
	});
});

test("rejects a coherently tampered technical camera against candidate authority", async () => {
	const f = await fixture();
	try {
		const technicalDelivery = structuredClone(f.technicalDelivery);
		const detail = JSON.parse(await readFile(f.technicalDetailPaths.front, "utf8"));
		detail.camera.projection_axes.depth = [0, 1, 0];
		const detailBytes = Buffer.from(JSON.stringify(detail));
		await writeFile(f.technicalDetailPaths.front, detailBytes);
		technicalDelivery.manifest.views.front.camera = structuredClone(detail.camera);
		technicalDelivery.manifest.views.front.manifest.sha256 = sha256(detailBytes);
		const manifestBytes = Buffer.from(JSON.stringify(technicalDelivery.manifest));
		await writeFile(f.technicalManifestPath, manifestBytes);
		technicalDelivery.memory_record.manifest.sha256 = sha256(manifestBytes);
		const calls: any[] = [];

		await assert.rejects(() => deliverFacadeFinalPresentation({
			runDir: f.runDir, presentationRoot: join(f.runDir, "coherent-camera-tamper"), candidateId: "creative-020",
			provider: "local-fixture", candidateSha256: facadeCandidateHash(candidate()),
			artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
			validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 },
			technicalDelivery, input: candidate(), deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, f.glbSha256) },
		}), (error: any) => error?.code === "FACADE_PRESENTATION_TECHNICAL_BINDING_MISMATCH");
		assert.equal(calls.length, 0);
	} finally { await rm(f.runDir, { recursive: true, force: true }); }
});

test("rejects a coherently re-fitted durable technical axon before presentation", async () => {
	const f = await fixture();
	try {
		const technicalDelivery = structuredClone(f.technicalDelivery);
		const detail = JSON.parse(await readFile(f.technicalDetailPaths.axon, "utf8"));
		detail.camera.position = detail.camera.target.map((value: number, axis: number) => value + 2 * (detail.camera.position[axis] - value));
		const detailBytes = Buffer.from(JSON.stringify(detail));
		await writeFile(f.technicalDetailPaths.axon, detailBytes);
		technicalDelivery.manifest.views.axon.camera = structuredClone(detail.camera);
		technicalDelivery.manifest.views.axon.manifest.sha256 = sha256(detailBytes);
		const manifestBytes = Buffer.from(JSON.stringify(technicalDelivery.manifest));
		await writeFile(f.technicalManifestPath, manifestBytes);
		technicalDelivery.memory_record.manifest.sha256 = sha256(manifestBytes);
		const calls: any[] = [];

		await assert.rejects(() => deliverFacadeFinalPresentation({
			runDir: f.runDir, presentationRoot: join(f.runDir, "coherent-fitted-axon"), candidateId: "creative-020",
			provider: "local-fixture", candidateSha256: facadeCandidateHash(candidate()),
			artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
			validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 },
			technicalDelivery, input: candidate(), deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, f.glbSha256) },
		}), (error: any) => error?.code === "FACADE_PRESENTATION_TECHNICAL_BINDING_MISMATCH");
		assert.equal(calls.length, 0);
	} finally { await rm(f.runDir, { recursive: true, force: true }); }
});

test("binds presentation to the selected provider and preflight candidate identity", async (context) => {
	for (const mismatch of ["provider", "candidate"] as const) await context.test(mismatch, async () => {
		const f = await fixture();
		try {
			const calls: any[] = [];
			await assert.rejects(() => deliverFacadeFinalPresentation({
				runDir: f.runDir, presentationRoot: join(f.runDir, `mismatch-${mismatch}`),
				candidateId: mismatch === "candidate" ? "creative-021" : "creative-020",
				provider: mismatch === "provider" ? "other-provider" : "local-fixture",
				candidateSha256: facadeCandidateHash(candidate()), artifact: { path: f.glbPath, sha256: f.glbSha256 },
				validation: { accepted: true, codes: [] },
				validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 },
				technicalDelivery: f.technicalDelivery, input: candidate(), deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, f.glbSha256) },
			}), (error: any) => error?.code === "FACADE_PRESENTATION_AUTHORITY_MISMATCH");
			assert.equal(calls.length, 0);
		} finally { await rm(f.runDir, { recursive: true, force: true }); }
	});
});

test("requires explicit upstream provider, candidate hash, and selected version authority", async (context) => {
	for (const field of ["provider", "candidateSha256", "selectedVersion"] as const) await context.test(field, async () => {
		const f = await fixture();
		try {
			const args: Record<string, any> = {
				runDir: f.runDir, presentationRoot: join(f.runDir, `missing-${field}`), candidateId: "creative-020",
				provider: "local-fixture", candidateSha256: facadeCandidateHash(candidate()), selectedVersion: "v001",
				artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
				validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 },
				technicalDelivery: f.technicalDelivery, input: candidate(),
				deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer([], f.glbSha256) },
			};
			delete args[field];
			await assert.rejects(() => deliverPresentationBoundary(args), (error: any) => error?.code === "FACADE_PRESENTATION_AUTHORITY_MISMATCH");
		} finally { await rm(f.runDir, { recursive: true, force: true }); }
	});
});

test("rejects a renderer whose applied browser camera differs from candidate authority", async () => {
	const f = await fixture();
	try {
		const calls: any[] = [];
		const renderer = async (options: any) => {
			const report: any = await fakeAcceptedPbrRenderer(calls, f.glbSha256)(options);
			report.views.front.cameraEvidence.actual.configured.projection_axes.depth = [0, 1, 0];
			await writeFile(join(options.runDir, "render-validation.json"), JSON.stringify(report));
			return report;
		};
		await assert.rejects(() => deliverFacadeFinalPresentation({
			runDir: f.runDir, presentationRoot: join(f.runDir, "wrong-applied-camera"), candidateId: "creative-020",
			provider: "local-fixture", candidateSha256: facadeCandidateHash(candidate()),
			artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
			validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 },
			technicalDelivery: f.technicalDelivery, input: candidate(), deps: { renderEmbeddedPbrViews: renderer },
		}), (error: any) => error?.code === "FACADE_PRESENTATION_RENDER_REJECTED");
		assert.equal(calls.length, 1);
	} finally { await rm(f.runDir, { recursive: true, force: true }); }
});

test("rejects coherently rehashed camera evidence derived from renderer-supplied building bounds", async () => {
	const f = await fixture();
	try {
		const renderer = async (options: any) => {
			const report: any = await fakeAcceptedPbrRenderer([], f.glbSha256)(options);
			const name = "front", evidence = report.views[name].cameraEvidence;
			evidence.building_bounds = { center: [6, 4, 6], radius: evidence.building_bounds.radius + 1 };
			evidence.expected = deriveExpectedCameraContract({ name, preset: report.camera_authority.views[name], buildingBounds: evidence.building_bounds });
			evidence.actual = structuredClone(evidence.expected);
			evidence.expected_hash = cameraContractHash(evidence.expected);
			evidence.actual_hash = cameraContractHash(evidence.actual);
			await writeFile(join(options.runDir, "render-validation.json"), JSON.stringify(report));
			return report;
		};
		await assert.rejects(() => deliverFacadeFinalPresentation({
			runDir: f.runDir, presentationRoot: join(f.runDir, "coherent-building-bounds-camera"), candidateId: "creative-020",
			artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
			validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 },
			technicalDelivery: f.technicalDelivery, input: candidate(), deps: { renderEmbeddedPbrViews: renderer },
		}), (error: any) => error?.code === "FACADE_PRESENTATION_RENDER_REJECTED");
	} finally { await rm(f.runDir, { recursive: true, force: true }); }
});

test("rejects a self-certified renderer result without the durable presentation artifact set", async () => {
	const f = await fixture();
	try {
		const calls: any[] = [];
		await assert.rejects(() => deliverFacadeFinalPresentation({
			runDir: f.runDir, presentationRoot: join(f.runDir, "shallow-render"), candidateId: "creative-020",
			provider: "local-fixture", candidateSha256: facadeCandidateHash(candidate()),
			artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
			validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 },
			technicalDelivery: f.technicalDelivery, input: candidate(),
			deps: { renderEmbeddedPbrViews: async (options: any) => {
				calls.push(options);
				const cameras = presentationCameraPresets(options.cameras);
				const buildingBounds = candidateBuildingBounds();
				const camera = (name: string) => {
					const expected = deriveExpectedCameraContract({ name, preset: cameras[name], buildingBounds });
					return { building_bounds: buildingBounds, expected, actual: structuredClone(expected), expected_hash: cameraContractHash(expected), actual_hash: cameraContractHash(expected) };
				};
				return {
					schema_version: "arr.elevation3d.embedded-pbr-render.v2", selected_glb: { sha256: f.glbSha256 },
					views: Object.fromEntries(VIEW_NAMES.map((name) => [name, { selectedGlbSha256: f.glbSha256, sha256: sha256(name), cameraEvidence: camera(name) }])),
					canonical_selection: options.canonicalSelection, camera_authority: { views: cameras, sha256: cameraContractHash(cameras) },
					material_mode: "embedded-pbr", render_style: { id: "competition-daylight-v1" },
					pbr_evidence: { material_count: 4, base_color_maps: 2, normal_maps: 2, metallic_roughness_maps: 2 },
					validation: { accepted: true, codes: [] }, provider_calls: 0, credits_consumed: 0,
				};
			} },
		}), (error: any) => error?.code === "FACADE_PRESENTATION_ARTIFACT_CLOSURE_INVALID");
		assert.equal(calls.length, 1);
	} finally { await rm(f.runDir, { recursive: true, force: true }); }
});

test("accepts a normalized receipt for its authoritative runtime validation and rejects semantic drift", async () => {
	const acceptedFixture = await fixture();
	try {
		const authoritative = authoritativeValidation(acceptedFixture.glbSha256);
		const receipt = await replaceValidationReceipt(acceptedFixture, authoritative.normalized, authoritative.authority);
		const calls: any[] = [];
		await deliverFacadeFinalPresentation({
			runDir: acceptedFixture.runDir, presentationRoot: join(acceptedFixture.runDir, "authoritative-presentation"), candidateId: "creative-020",
			artifact: { path: acceptedFixture.glbPath, sha256: acceptedFixture.glbSha256 }, validation: authoritative.validation,
			validationReceipt: receipt, technicalDelivery: acceptedFixture.technicalDelivery, input: candidate(),
			deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, acceptedFixture.glbSha256) },
		});
		assert.equal(calls.length, 1);
	} finally { await rm(acceptedFixture.runDir, { recursive: true, force: true }); }

	const mismatchedFixture = await fixture();
	try {
		const authoritative = authoritativeValidation(mismatchedFixture.glbSha256);
		const mismatchedValidation = {
			...authoritative.normalized,
			metrics: { ...authoritative.normalized.metrics, canonical_surface_match: 0 },
		};
		const receipt = await replaceValidationReceipt(mismatchedFixture, mismatchedValidation, authoritative.authority);
		const calls: any[] = [];
		await assert.rejects(() => deliverFacadeFinalPresentation({
			runDir: mismatchedFixture.runDir, presentationRoot: join(mismatchedFixture.runDir, "mismatched-presentation"), candidateId: "creative-020",
			artifact: { path: mismatchedFixture.glbPath, sha256: mismatchedFixture.glbSha256 }, validation: authoritative.validation,
			validationReceipt: receipt, technicalDelivery: mismatchedFixture.technicalDelivery, input: candidate(),
			deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, mismatchedFixture.glbSha256) },
		}), (error: any) => error?.code === "FACADE_PRESENTATION_VALIDATION_RECEIPT_INVALID");
		assert.equal(calls.length, 0);
	} finally { await rm(mismatchedFixture.runDir, { recursive: true, force: true }); }
});

test("rejects unsafe presentation inputs before invoking the renderer", async () => {
	const scenarios = [
		["tampered GLB", "FACADE_PRESENTATION_GLB_HASH_MISMATCH", (f: any) => ({ artifact: { path: f.glbPath, sha256: "0".repeat(64) } })],
		["rejected facade validation", "FACADE_PRESENTATION_VALIDATION_REQUIRED", (_f: any) => ({ validation: { accepted: false, codes: ["REJECTED"] } })],
		["different technical GLB", "FACADE_PRESENTATION_TECHNICAL_BINDING_MISMATCH", (f: any) => ({ technicalDelivery: claimDifferentTechnicalGlb(f.technicalDelivery, "1".repeat(64)) })],
		["rejected PBR report", "FACADE_PRESENTATION_RENDER_REJECTED", (_f: any) => ({ render: { validation: { accepted: false } } })],
		["renderer reports provider calls", "FACADE_PRESENTATION_REMOTE_ACTIVITY", (_f: any) => ({ render: { provider_calls: 1 } })],
	] as const;
	for (const [name, code, change] of scenarios) {
		const f = await fixture();
		try {
			const calls: any[] = [];
			const renderOverride = (change(f) as any).render;
			const resultOverride = renderOverride ? { ...renderOverride } : {};
			const args: any = {
				runDir: f.runDir, presentationRoot: join(f.runDir, "final-presentation"), candidateId: "creative-020",
				artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
				validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 }, technicalDelivery: f.technicalDelivery, input: candidate(),
				deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, f.glbSha256, resultOverride) },
			};
			Object.assign(args, change(f));
			await assert.rejects(() => deliverFacadeFinalPresentation(args), (error: any) => error?.code === code, name);
			assert.equal(calls.length, code === "FACADE_PRESENTATION_RENDER_REJECTED" || code === "FACADE_PRESENTATION_REMOTE_ACTIVITY" ? 1 : 0, name);
		} finally { await rm(f.runDir, { recursive: true, force: true }); }
	}
});

test("rejects presentation roots that escape the run directory", async () => {
	const f = await fixture();
	try {
		const calls: any[] = [];
		await assert.rejects(() => deliverFacadeFinalPresentation({
			runDir: f.runDir, presentationRoot: resolve(f.runDir, "..", "escape"), candidateId: "creative-020",
			artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
			validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 }, technicalDelivery: f.technicalDelivery, input: candidate(),
			deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, f.glbSha256) },
		}), (error: any) => error?.code === "FACADE_PRESENTATION_PATH_INVALID");
		assert.equal(calls.length, 0);
	} finally { await rm(f.runDir, { recursive: true, force: true }); }
});

test("rejects a reparse-point presentation root", async (context) => {
	const f = await fixture();
	try {
		const outside = await mkdtemp(join(tmpdir(), "elevation3d-facade-presentation-outside-"));
		const link = join(f.runDir, "linked-presentation");
		try { await symlink(outside, link, process.platform === "win32" ? "junction" : "dir"); }
		catch (error: any) { await rm(outside, { recursive: true, force: true }); if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) return context.skip("directory links unavailable"); throw error; }
		try {
			const calls: any[] = [];
			await assert.rejects(() => deliverFacadeFinalPresentation({
				runDir: f.runDir, presentationRoot: link, candidateId: "creative-020",
				artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
				validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 }, technicalDelivery: f.technicalDelivery, input: candidate(),
				deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, f.glbSha256) },
			}), (error: any) => error?.code === "FACADE_PRESENTATION_PATH_INVALID");
			assert.equal(calls.length, 0);
		} finally { await rm(outside, { recursive: true, force: true }); }
	} finally { await rm(f.runDir, { recursive: true, force: true }); }
});

test("fails closed when the validation receipt is missing or tampered", async () => {
	const f = await fixture();
	try {
		const calls: any[] = [];
		await rm(f.receiptPath);
		await assert.rejects(() => deliverFacadeFinalPresentation({
			runDir: f.runDir, presentationRoot: join(f.runDir, "missing-receipt"), candidateId: "creative-020",
			artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
			validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 }, technicalDelivery: f.technicalDelivery, input: candidate(),
			deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, f.glbSha256) },
		}), (error: any) => error?.code === "FACADE_PRESENTATION_VALIDATION_RECEIPT_INVALID");
		assert.equal(calls.length, 0);

		await writeFile(f.receiptPath, "tampered receipt");
		await assert.rejects(() => deliverFacadeFinalPresentation({
			runDir: f.runDir, presentationRoot: join(f.runDir, "tampered-receipt"), candidateId: "creative-020",
			artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
			validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 }, technicalDelivery: f.technicalDelivery, input: candidate(),
			deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, f.glbSha256) },
		}), (error: any) => error?.code === "FACADE_PRESENTATION_VALIDATION_RECEIPT_INVALID");
		assert.equal(calls.length, 0);
	} finally { await rm(f.runDir, { recursive: true, force: true }); }
});

test("fails closed when the local renderer mutates the selected GLB", async () => {
	const f = await fixture();
	try {
		const calls: any[] = [];
		await assert.rejects(() => deliverFacadeFinalPresentation({
			runDir: f.runDir, presentationRoot: join(f.runDir, "mutated-glb"), candidateId: "creative-020",
			artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
			validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 }, technicalDelivery: f.technicalDelivery, input: candidate(),
			deps: { renderEmbeddedPbrViews: async (options: any) => {
				calls.push(options);
				await writeFile(options.glbPath, "mutated-by-renderer");
				return await fakeAcceptedPbrRenderer([], f.glbSha256)(options);
			} },
		}), (error: any) => error?.code === "FACADE_PRESENTATION_GLB_MUTATED");
		assert.equal(calls.length, 1);
	} finally { await rm(f.runDir, { recursive: true, force: true }); }
});

test("fails closed instead of overwriting an existing final presentation", async () => {
	const f = await fixture();
	try {
		const presentationRoot = join(f.runDir, "existing-presentation");
		await mkdir(presentationRoot);
		await writeFile(join(presentationRoot, "final-presentation.json"), JSON.stringify({ selected_glb: { sha256: "0".repeat(64) } }));
		const calls: any[] = [];
		await assert.rejects(() => deliverFacadeFinalPresentation({
			runDir: f.runDir, presentationRoot, candidateId: "creative-020",
			artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
			validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 }, technicalDelivery: f.technicalDelivery, input: candidate(),
			deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, f.glbSha256) },
		}), (error: any) => error?.code === "FACADE_PRESENTATION_OUTPUT_EXISTS");
		assert.equal(calls.length, 0);
	} finally { await rm(f.runDir, { recursive: true, force: true }); }
});
