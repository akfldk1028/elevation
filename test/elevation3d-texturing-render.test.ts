import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import sharp from "sharp";
import { deriveExpectedCameraContract, loadPresentationBaseline, renderEmbeddedPbrViews, validateEmbeddedPbrRender } from "../plugins/elevation-3d/lib/texturing/render-validator.mjs";
import { renderStyleHash, resolvePbrRenderStyle } from "../plugins/elevation-3d/lib/texturing/render-style.mjs";

const names = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];
const selectedGlbSha256 = "a".repeat(64);
const temporaryRoots: string[] = [];

after(async () => Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function canonicalJson(value: any): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	return JSON.stringify(value);
}

function contractHash(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function serializedCameraHash(value: any): string {
	const normalize = (input: any): any => {
		if (typeof input === "number") return Number.isFinite(input) ? Math.round(input * 1e9) / 1e9 : null;
		if (Array.isArray(input)) return input.map(normalize);
		if (input && typeof input === "object") return Object.fromEntries(Object.keys(input).sort().map((key) => [key, normalize(input[key])]));
		return input;
	};
	return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

function cameraContract(name: string) {
	const orthographic = names.slice(0, 6).includes(name);
	const orthographicPositions: Record<string, number[]> = {
		front: [0, 40, 5], back: [0, -40, 5], left: [40, 0, 5], right: [-40, 0, 5], plan: [0, 0, 45], top: [0, 0, 45],
	};
	const axes: Record<string, any> = {
		front: { horizontal: [1, 0, 0], vertical: [0, 0, 1], depth: [0, -1, 0] },
		back: { horizontal: [-1, 0, 0], vertical: [0, 0, 1], depth: [0, 1, 0] },
		left: { horizontal: [0, -1, 0], vertical: [0, 0, 1], depth: [-1, 0, 0] },
		right: { horizontal: [0, 1, 0], vertical: [0, 0, 1], depth: [1, 0, 0] },
		plan: { horizontal: [1, 0, 0], vertical: [0, 1, 0], depth: [0, 0, 1] },
		top: { horizontal: [1, 0, 0], vertical: [0, 1, 0], depth: [0, 0, 1] },
	};
	return {
		type: orthographic ? "orthographic" : "perspective",
		position: orthographic ? orthographicPositions[name] : [40, -40, 45],
		target: [0, 0, 5], up: orthographic ? axes[name].vertical : [0, 0, 1],
		perspective: orthographic ? null : { fov: 32, near: 1, far: 200, aspect: 1 },
		orthographic: orthographic ? { left: -15, right: 15, top: 15, bottom: -15, near: 0.1, far: 300, zoom: 1 } : null,
		configured: { projection_axes: orthographic ? axes[name] : null, depth: orthographic ? null : [0.707, -0.707, 0] },
		clipping: name === "plan" ? { enabled: true, elevation_m: 1.2, plane_world: [0, 0, 1, -1.2] } : { enabled: false, elevation_m: null, plane_world: null },
	};
}

function cameraPresets() {
	return Object.fromEntries(names.map((name) => {
		const contract = cameraContract(name);
		return [name, contract.type === "orthographic" ? {
			type: "orthographic", projection_axes: contract.configured.projection_axes, frustum: { ...contract.orthographic, zoom: undefined }, cut: contract.clipping,
		} : {
			type: "perspective", position: contract.position, target: contract.target, up: contract.up,
			fov_degrees: contract.perspective.fov, near: contract.perspective.near, far: contract.perspective.far,
			aspect: contract.perspective.aspect, depth: contract.configured.depth, cut: contract.clipping,
		}];
	}));
}

function validViews() {
	return Object.fromEntries(names.map((name, index) => {
		const contract = cameraContract(name);
		return [name, {
		selectedGlbSha256,
		sha256: String(index).padStart(64, "0"),
		settledHashes: [String(index).padStart(64, "0"), String(index).padStart(64, "0")],
		foregroundFraction: 0.2,
		silhouetteIou: 1,
		projectedExtentDelta: 0,
		baselineProjectedExtentDelta: 0,
		cameraType: names.slice(0, 6).includes(name) ? "orthographic" : "perspective",
		pbrPixelDelta: names.includes("axon") ? 2 : names.includes("opposite-axon") ? 2 : null,
		cameraEvidence: { expected: contract, actual: structuredClone(contract), expected_hash: contractHash(contract), actual_hash: contractHash(contract) },
	}];
	}));
}

function validPresentationEvidence() {
	return Object.fromEntries(names.map((name) => [name, {
		building: { sampleCount: 100, luminanceP05: 40, luminanceP95: 210 },
		background: { sampleCount: 500, deltaP95: 0, luminanceVariance: 0 },
		contactShadow: { detected: name === "axon" || name === "opposite-axon", areaFraction: 0.04, insideBuildingPixels: 0 },
		materialSeparation: { luminanceSpread: 55, chromaSpread: 35 },
	}]));
}

function validSemanticRoleEvidence() {
	const roles = Object.fromEntries(["concrete", "glass", "bronze", "opaque"].map((role, index) => [role, {
		pixelCount: 100, meanColor: [40 + index * 45, 55 + index * 35, 70 + index * 25], meanLuminance: 55 + index * 35,
	}]));
	const pairwise: Record<string, unknown> = {};
	const roleNames = Object.keys(roles);
	for (let left = 0; left < roleNames.length; left++) for (let right = left + 1; right < roleNames.length; right++) {
		pairwise[`${roleNames[left]}:${roleNames[right]}`] = { colorDistance: 30, luminanceDistance: 20 };
	}
	return Object.fromEntries(names.map((name) => [name, { roles: structuredClone(roles), pairwise: structuredClone(pairwise) }]));
}

function validSemanticGeometryEvidence() {
	return {
		concrete: { meshCount: 313, vertexCount: 25157, triangleCount: 3748, attributionSources: { "object.userData.material": 312, "material.name": 1 } },
		glass: { meshCount: 971, vertexCount: 19343, triangleCount: 10528, attributionSources: { "object.userData.material": 971 } },
		bronze: { meshCount: 519, vertexCount: 12208, triangleCount: 6104, attributionSources: { "object.userData.material": 519 } },
		opaque: { meshCount: 340, vertexCount: 7832, triangleCount: 3916, attributionSources: { "object.userData.material": 340 } },
	};
}

test("embedded PBR render validation requires one stable GLB across eight distinct views", () => {
	const views = validViews();
	assert.deepEqual(validateEmbeddedPbrRender({ views, selectedGlbSha256, consoleErrors: [], materialMode: "embedded-pbr" }), {
		accepted: true,
		status: "accepted",
		codes: [],
	});
	views.back.selectedGlbSha256 = "b".repeat(64);
	views.axon.settledHashes[1] = "f".repeat(64);
	views.axon.pbrPixelDelta = 0;
	assert.deepEqual(validateEmbeddedPbrRender({ views, selectedGlbSha256, consoleErrors: ["texture failed"], materialMode: "procedural-preview" }).codes.sort(), [
		"CONSOLE_ERROR",
		"MATERIAL_MODE_INVALID",
		"RENDER_UNSTABLE",
		"SELECTED_GLB_MISMATCH",
		"PBR_EVIDENCE_MISSING",
	].sort());
});

test("competition daylight reports require style, contact shadow, and presentation range evidence", () => {
	const views = validViews();
	const style = resolvePbrRenderStyle();
	const renderStyleSha256 = renderStyleHash(style);
	const presentationEvidence = validPresentationEvidence();
	assert.deepEqual(validateEmbeddedPbrRender({
		views, selectedGlbSha256, consoleErrors: [], materialMode: "embedded-pbr",
		renderStyle: style, renderStyleSha256, presentationEvidence, semanticRoleEvidence: validSemanticRoleEvidence(),
	}), { accepted: true, status: "accepted", codes: [] });
	presentationEvidence.axon.contactShadow.detected = false;
	assert.ok(validateEmbeddedPbrRender({
		views, selectedGlbSha256, consoleErrors: [], materialMode: "embedded-pbr",
		renderStyle: style, renderStyleSha256, presentationEvidence, semanticRoleEvidence: validSemanticRoleEvidence(),
	}).codes.includes("PBR_CONTACT_SHADOW_MISSING"));
	presentationEvidence.axon.contactShadow.detected = true;
	presentationEvidence.front.building.luminanceP95 = 255;
	assert.ok(validateEmbeddedPbrRender({
		views, selectedGlbSha256, consoleErrors: [], materialMode: "embedded-pbr",
		renderStyle: style, renderStyleSha256, presentationEvidence, semanticRoleEvidence: validSemanticRoleEvidence(),
	}).codes.includes("PBR_PRESENTATION_RANGE_INVALID"));
	assert.ok(validateEmbeddedPbrRender({
		views, selectedGlbSha256, consoleErrors: [], materialMode: "embedded-pbr",
		renderStyle: style, renderStyleSha256: "f".repeat(64), presentationEvidence, semanticRoleEvidence: validSemanticRoleEvidence(),
	}).codes.includes("PBR_RENDER_STYLE_INVALID"));
});

test("competition daylight validation rejects a failed PMREM environment while retaining diagnostics", () => {
	const style = resolvePbrRenderStyle();
	const result = validateEmbeddedPbrRender({
		views: validViews(), selectedGlbSha256, consoleErrors: [], materialMode: "embedded-pbr",
		renderStyle: style, renderStyleSha256: renderStyleHash(style), presentationEvidence: validPresentationEvidence(), semanticRoleEvidence: validSemanticRoleEvidence(),
		presentationEnvironment: { status: "failed", code: "PBR_ENVIRONMENT_FAILED", message: "target failed [REDACTED]" },
	});
	assert.equal(result.accepted, false);
	assert.ok(result.codes.includes("PBR_ENVIRONMENT_FAILED"));
});

test("competition daylight validation rejects every camera and plan-cut identity class", () => {
	const style = resolvePbrRenderStyle();
	const validate = (views: any) => validateEmbeddedPbrRender({
		views, selectedGlbSha256, consoleErrors: [], materialMode: "embedded-pbr",
		renderStyle: style, renderStyleSha256: renderStyleHash(style), presentationEvidence: validPresentationEvidence(), semanticRoleEvidence: validSemanticRoleEvidence(),
	});
	assert.equal(validate(validViews()).accepted, true);
	for (const [label, name, mutate] of [
		["type", "front", (value: any) => { value.type = "perspective"; }],
		["position", "front", (value: any) => { value.position[0] += 0.01; }],
		["target", "front", (value: any) => { value.target[1] += 0.01; }],
		["up", "front", (value: any) => { value.up[2] = 0.99; }],
		["perspective", "axon", (value: any) => { value.perspective.fov = 33; }],
		["orthographic", "front", (value: any) => { value.orthographic.zoom = 1.01; }],
		["projection axes", "front", (value: any) => { value.configured.projection_axes.depth[1] = -0.9; }],
		["configured depth", "axon", (value: any) => { value.configured.depth[0] = 0.6; }],
		["plan cut", "plan", (value: any) => { value.clipping.plane_world[3] = -1.21; }],
		["top cut", "top", (value: any) => { value.clipping.enabled = true; value.clipping.elevation_m = 1.2; value.clipping.plane_world = [0, 0, 1, -1.2]; }],
	] as const) {
		const views: any = validViews();
		mutate(views[name].cameraEvidence.actual);
		views[name].cameraEvidence.actual_hash = contractHash(views[name].cameraEvidence.actual);
		const result = validate(views);
		assert.ok(result.codes.includes("CAMERA_IDENTITY_MISMATCH"), `${label} tamper must be rejected`);
	}
	const nonfinite: any = validViews();
	nonfinite.front.cameraEvidence.expected.position[0] = Number.NaN;
	nonfinite.front.cameraEvidence.actual.position[0] = Number.NaN;
	nonfinite.front.cameraEvidence.expected_hash = contractHash(nonfinite.front.cameraEvidence.expected);
	nonfinite.front.cameraEvidence.actual_hash = contractHash(nonfinite.front.cameraEvidence.actual);
	assert.ok(validate(nonfinite).codes.includes("CAMERA_IDENTITY_MISMATCH"), "matching non-finite contracts must be rejected");
	for (const name of names.filter((view) => view !== "plan")) {
		const clipped: any = validViews();
		for (const side of ["expected", "actual"] as const) {
			clipped[name].cameraEvidence[side].clipping = { enabled: true, elevation_m: 1.2, plane_world: [0, 0, 1, -1.2] };
			clipped[name].cameraEvidence[`${side}_hash`] = contractHash(clipped[name].cameraEvidence[side]);
		}
		assert.ok(validate(clipped).codes.includes("CAMERA_IDENTITY_MISMATCH"), `${name} must be explicitly uncut`);
	}
});

test("expected camera contract is derived from persisted preset and bounds without a runtime camera", () => {
	assert.deepEqual(deriveExpectedCameraContract({
		name: "front",
		preset: {
			type: "orthographic", projection_axes: { horizontal: [1, 0, 0], vertical: [0, 0, 1], depth: [0, -1, 0] },
			frustum: { left: -15, right: 15, top: 15, bottom: -15, near: 0.1, far: 300 },
			cut: { enabled: false, elevation_m: null, plane_world: null },
		},
		buildingBounds: { center: [2, 3, 5], radius: 10 },
	}), {
		type: "orthographic", position: [2, 43, 5], target: [2, 3, 5], up: [0, 0, 1], perspective: null,
		orthographic: { left: -15, right: 15, top: 15, bottom: -15, near: 0.1, far: 300, zoom: 1 },
		configured: { projection_axes: { horizontal: [1, 0, 0], vertical: [0, 0, 1], depth: [0, -1, 0] }, depth: null },
		clipping: { enabled: false, elevation_m: null, plane_world: null },
	});
});

test("camera identity tolerates only sub-nanometre serialization drift", () => {
	const style = resolvePbrRenderStyle();
	const validate = (views: any) => validateEmbeddedPbrRender({
		views, selectedGlbSha256, consoleErrors: [], materialMode: "embedded-pbr",
		renderStyle: style, renderStyleSha256: renderStyleHash(style), presentationEvidence: validPresentationEvidence(), semanticRoleEvidence: validSemanticRoleEvidence(),
	});
	const serializationDrift: any = validViews();
	serializationDrift["opposite-axon"].cameraEvidence.expected.position[1] = 42.038736009056;
	serializationDrift["opposite-axon"].cameraEvidence.actual.position[1] = 42.038736009055;
	serializationDrift["opposite-axon"].cameraEvidence.expected_hash = serializedCameraHash(serializationDrift["opposite-axon"].cameraEvidence.expected);
	serializationDrift["opposite-axon"].cameraEvidence.actual_hash = serializedCameraHash(serializationDrift["opposite-axon"].cameraEvidence.actual);
	assert.equal(validate(serializationDrift).accepted, true);

	const meaningfulTamper: any = structuredClone(serializationDrift);
	meaningfulTamper["opposite-axon"].cameraEvidence.actual.position[1] += 0.000001;
	meaningfulTamper["opposite-axon"].cameraEvidence.actual_hash = serializedCameraHash(meaningfulTamper["opposite-axon"].cameraEvidence.actual);
	assert.ok(validate(meaningfulTamper).codes.includes("CAMERA_IDENTITY_MISMATCH"));
});

test("presentation gates do not alter existing geometry, camera, PBR, or stability failures", () => {
	const views = validViews();
	views.front.silhouetteIou = 0.9;
	views.back.baselineProjectedExtentDelta = 0.1;
	views.left.cameraType = "perspective";
	views.axon.pbrPixelDelta = 0;
	views.right.settledHashes[1] = "f".repeat(64);
	const codes = validateEmbeddedPbrRender({ views, selectedGlbSha256, consoleErrors: [], materialMode: "embedded-pbr" }).codes;
	for (const code of ["SILHOUETTE_MISMATCH", "PROCEDURAL_BASELINE_MISMATCH", "CAMERA_PROJECTION_INVALID", "PBR_EVIDENCE_MISSING", "RENDER_UNSTABLE"]) {
		assert.ok(codes.includes(code), `${code} must remain unchanged`);
	}
});

test("renderer readiness failures preserve the browser error that prevented evidence", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-render-readiness-"));
	temporaryRoots.push(root);
	const glbPath = join(root, "textured.glb");
	await writeFile(glbPath, Buffer.from("unchanged textured glb"));
	const listeners: Record<string, Function> = {};
	const page = {
		on: (name: string, callback: Function) => { listeners[name] = callback; },
		setViewport: async () => {},
		goto: async () => { listeners.pageerror?.(new Error("fixture viewer startup failed")); },
		waitForFunction: async () => { throw new Error("fixture readiness timeout"); },
		close: async () => {},
	};
	const browser = { newPage: async () => page, close: async () => {} };
	await assert.rejects(() => renderEmbeddedPbrViews({
		glbPath, runDir: join(root, "render"), candidateId: "creative-020", cameras: cameraPresets(), outputSize: 100,
		lifecycle: { startPreview: async () => "http://127.0.0.1:4173/", stopPreview: async () => {}, launchBrowser: async () => browser },
	}), /fixture viewer startup failed/);
});

async function presentationPng(viewIndex: number, diagnostic = false, presentation = true) {
	const width = 100, height = 100;
	const data = Buffer.alloc(width * height * 3, 0);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		const offset = (y * width + x) * 3;
		let color = [250, 250, 247];
		if (x >= 10 && x <= 89 && y >= 5 && y <= 84) {
			const light = 105;
			const roleColors = [[80, 110, 140], [140, 180, 200], [90, 65, 40], [170, 150, 125]];
			const variation = ((x + y + viewIndex) % 5) * 2;
			color = diagnostic ? [light, light, light] : roleColors[Math.min(3, Math.floor((x - 10) / 20))].map((value) => value + variation);
		} else if (presentation && y === 85 && x >= 20 && x <= 39) {
			const light = 212 - Math.floor((x - 20) / 3) * 3;
			color = [light, light, light];
		}
		if (!diagnostic && x === 50 && y === 50) color = [80 + viewIndex, 120, 60];
		data[offset] = color[0]; data[offset + 1] = color[1]; data[offset + 2] = color[2];
	}
	return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function semanticRoleMaskPng() {
	const width = 100, height = 100;
	const data = Buffer.alloc(width * height * 3);
	const ids = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
	for (let y = 5; y <= 84; y++) for (let x = 10; x <= 89; x++) {
		data.set(ids[Math.min(3, Math.floor((x - 10) / 20))], (y * width + x) * 3);
	}
	return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

test("legacy semantic reuse requires exact GLB, dimensions, cameras, cuts, bounds, hashes, and containment", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "legacy-presentation-binding-"));
	temporaryRoots.push(root);
	const png = await presentationPng(0, true, false);
	const cameras = Object.fromEntries(names.map((name) => [name, { name, contract: cameraContract(name) }]));
	const currentViews = Object.fromEntries(names.map((name) => [name, {
		width: 100, height: 100, projectedBoundsPx: { minX: 10, minY: 5, maxX: 89, maxY: 84 },
	}]));
	const report: any = {
		schema_version: "arr.elevation3d.embedded-pbr-render.v1",
		selected_glb: { sha256: selectedGlbSha256 }, validation: { accepted: true }, views: {},
	};
	await mkdir(join(root, "viewer"), { recursive: true });
	await writeFile(join(root, "viewer", "config.json"), JSON.stringify({ cameras: { views: cameras } }));
	for (const name of names) {
		const directory = join(root, "views", name);
		await mkdir(directory, { recursive: true });
		const path = join(directory, `${name}.png`);
		await writeFile(path, png);
		report.views[name] = {
			path, sha256: createHash("sha256").update(png).digest("hex"), selectedGlbSha256,
			projectedBoundsPx: { minX: 10, minY: 5, maxX: 89, maxY: 84 },
		};
	}
	const persist = async () => writeFile(join(root, "render-validation.json"), JSON.stringify(report));
	await persist();
	const binding = { selectedGlbSha256, cameras, currentViews };
	const ready = await loadPresentationBaseline(root, binding);
	assert.equal(ready.status, "legacy_reanalyzed");
	assert.equal(ready.binding.selected_glb_sha256, selectedGlbSha256);
	assert.deepEqual(Object.keys(ready.binding.views), names);

	for (const [label, mutate, reason] of [
		["GLB", () => { report.selected_glb.sha256 = "b".repeat(64); }, "baseline_legacy_glb_mismatch"],
		["size", () => { currentViews.front.width = 101; }, "baseline_legacy_size_mismatch"],
		["camera", async () => { const config = JSON.parse(await readFile(join(root, "viewer", "config.json"), "utf8")); config.cameras.views.front.contract.position[0] += 1; await writeFile(join(root, "viewer", "config.json"), JSON.stringify(config)); }, "baseline_legacy_camera_mismatch"],
		["cut", async () => { const config = JSON.parse(await readFile(join(root, "viewer", "config.json"), "utf8")); config.cameras.views.top.contract.clipping = { enabled: true, elevation_m: 1.2, plane_world: [0, 0, 1, -1.2] }; await writeFile(join(root, "viewer", "config.json"), JSON.stringify(config)); }, "baseline_legacy_camera_mismatch"],
		["bounds", () => { report.views.left.projectedBoundsPx.minX += 1; }, "baseline_legacy_bounds_mismatch"],
		["hash", () => { report.views.right.sha256 = "c".repeat(64); }, "baseline_legacy_hash_invalid"],
		["containment", () => { report.views.back.path = join(root, "..", "outside.png"); }, "baseline_legacy_path_invalid"],
	] as const) await t.test(`${label} mismatch is not compared`, async () => {
		const reportSnapshot = structuredClone(report), currentSnapshot = structuredClone(currentViews);
		const configSnapshot = await readFile(join(root, "viewer", "config.json"));
		try {
			await mutate(); await persist();
			assert.equal((await loadPresentationBaseline(root, binding)).reason, reason);
		} finally {
			Object.assign(report, reportSnapshot); Object.assign(currentViews, currentSnapshot);
			await writeFile(join(root, "viewer", "config.json"), configSnapshot); await persist();
		}
	});
});

test("real rendered-pbr-v6 binds all eight legacy views to the accepted GLB and camera contract", async () => {
	const root = "D:/Data/50_ELE/elevation-3d-e2e-results/autonomous/creative-013/tripo-pbr-v1-20260804";
	const legacyDir = join(root, "rendered-pbr-v6"), canonicalDir = join(root, "rendered-pbr-v7-competition-daylight");
	const [legacyReport, canonicalReport, baselineConfig] = await Promise.all([
		readFile(join(legacyDir, "render-validation.json"), "utf8").then(JSON.parse),
		readFile(join(canonicalDir, "render-validation.json"), "utf8").then(JSON.parse),
		readFile(join(legacyDir, "viewer", "config.json"), "utf8").then(JSON.parse),
	]);
	const currentViews: Record<string, any> = {};
	for (const name of names) {
		const metadata = await sharp(canonicalReport.views[name].path).metadata();
		currentViews[name] = { width: metadata.width, height: metadata.height, projectedBoundsPx: canonicalReport.views[name].projectedBoundsPx };
	}
	const baseline = await loadPresentationBaseline(legacyDir, {
		selectedGlbSha256: canonicalReport.selected_glb.sha256, cameras: baselineConfig.cameras.views, currentViews,
	});
	assert.equal(baseline.status, "legacy_reanalyzed", JSON.stringify(baseline));
	assert.equal(baseline.binding.selected_glb_sha256, legacyReport.selected_glb.sha256);
	assert.equal(Object.keys(baseline.binding.views).length, 8);
	assert.ok(Object.values(baseline.binding.views).every((view: any) => view.containment === "lexical_and_realpath" && view.transform.type === "identity"));
});

async function writeProceduralBaseline(root: string) {
	const views: Record<string, unknown> = {};
	for (const name of names) {
		const manifestPath = join("views", name, "view.json");
		await mkdir(join(root, "views", name), { recursive: true });
		await writeFile(join(root, manifestPath), JSON.stringify({
			building_content: { bounds_px: { min_x: 10, min_y: 0, max_x: 89, max_y: 79 } },
		}));
		views[name] = { width: 100, height: 100, manifest: { path: manifestPath } };
	}
	await writeFile(join(root, "all-views-manifest.json"), JSON.stringify({ views }));
}

test("render-only v2 delivery persists resolved style, per-view evidence, baseline comparison, and final hashes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-render-artifacts-"));
	temporaryRoots.push(root);
	const runDir = join(root, "render");
	const baselineRunDir = join(root, "procedural");
	const presentationBaselineRunDir = join(root, "v6");
	const glbPath = join(root, "textured.glb");
	await mkdir(presentationBaselineRunDir, { recursive: true });
	await writeFile(glbPath, Buffer.from("unchanged textured glb"));
	await writeProceduralBaseline(baselineRunDir);
	await writeFile(join(presentationBaselineRunDir, "render-validation.json"), JSON.stringify({
		schema_version: "arr.elevation3d.embedded-pbr-render.v1",
		validation: { accepted: true }, presentation_evidence: validPresentationEvidence(),
	}));
	const textured = await Promise.all(names.map((_, index) => presentationPng(index)));
	const geometryTextured = await Promise.all(names.map((_, index) => presentationPng(index, false, false)));
	const diagnostic = await Promise.all(names.map((_, index) => presentationPng(index, true, false)));
	const roleMask = await semanticRoleMaskPng();
	const cameras = cameraPresets();
	let activeView = "axon", embeddedMaps = true, presentationVisible = true, tamperRuntimeCamera = false;
	const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString("base64")}`;
	const page = {
		on: () => {}, setViewport: async () => {}, goto: async () => {}, waitForFunction: async () => {}, close: async () => {},
		evaluate: async (callback: Function, argument?: string) => {
			const source = callback.toString();
			if (source.includes("activateView")) { activeView = argument!; return; }
			if (source.includes("const first =")) return [dataUrl(textured[names.indexOf(activeView)]), dataUrl(textured[names.indexOf(activeView)])];
			if (source.includes("__ELEVATION3D_VIEWER_STATE__")) {
				const contract = cameraContract(activeView);
				if (tamperRuntimeCamera && activeView === "front") contract.position[0] += 1;
				return {
				camera: {
					type: names.slice(0, 6).includes(activeView) ? "orthographic" : "perspective",
					contract, expected_contract: structuredClone(contract),
				},
				building_bounds: { center: [0, 0, 5], radius: 10 },
				presentation: { style: { id: "competition-daylight-v1", hash: renderStyleHash(resolvePbrRenderStyle()) }, view: activeView },
			}; }
			if (source.includes("setEmbeddedMaps(false)")) { embeddedMaps = false; return; }
			if (source.includes("setEmbeddedMaps(true)")) { embeddedMaps = true; return; }
			if (source.includes("setPresentationObjectsVisible(false)")) { presentationVisible = false; return; }
			if (source.includes("setPresentationObjectsVisible(true)")) { presentationVisible = true; return; }
			if (source.includes("presentationEvidence")) return { style: { id: "competition-daylight-v1" }, view: activeView };
			if (source.includes("semanticRoleGeometry")) return validSemanticGeometryEvidence();
			if (source.includes("semanticRolePng")) return dataUrl(roleMask);
			if (source.includes("embeddedPbrEvidence")) return { embedded_maps: true };
			if (source.includes("settledPng")) return dataUrl(embeddedMaps
				? (presentationVisible ? textured[names.indexOf(activeView)] : geometryTextured[names.indexOf(activeView)])
				: diagnostic[names.indexOf(activeView)]);
			throw new Error(`unexpected browser callback: ${source}`);
		},
	};
	const browser = { newPage: async () => page, close: async () => {} };
	const report = await renderEmbeddedPbrViews({
		glbPath, runDir, candidateId: "creative-013", cameras, baselineRunDir, presentationBaselineRunDir,
		outputSize: 100,
		lifecycle: { startPreview: async () => "http://127.0.0.1:4173/", stopPreview: async () => {}, launchBrowser: async () => browser },
	});

	assert.equal(report.schema_version, "arr.elevation3d.embedded-pbr-render.v2");
	assert.equal(report.provider_calls, 0); assert.equal(report.credits_consumed, 0);
	assert.equal(report.validation.accepted, true, JSON.stringify({ validation: report.validation, cameraEvidence: Object.fromEntries(names.map((name) => [name, report.views[name].cameraEvidence])) }));
	assert.equal(report.views.axon.baselineProjectedExtentDelta, 0, "raster layout offsets must not be treated as projected-geometry extent drift");
	assert.equal(report.semantic_role_evidence.front.roles.concrete.pixelCount, 1600);
	assert.equal(report.semantic_role_evidence.front.roles.bronze.visibility.geometryTriangles, 6104);
	assert.equal(report.semantic_role_evidence.front.roles.bronze.coverageFraction, 0.25);
	assert.equal(Object.keys(report.semantic_role_evidence.axon.pairwise).length, 6);
	assert.match(report.views.front.semanticRoleMaskSha256, /^[a-f0-9]{64}$/);
	const style = JSON.parse(await readFile(join(runDir, "render-style.json"), "utf8"));
	assert.equal(style.id, "competition-daylight-v1");
	const viewerConfig = JSON.parse(await readFile(join(runDir, "viewer", "config.json"), "utf8"));
	assert.deepEqual(viewerConfig.all_views.render_style, style);
	assert.equal(viewerConfig.all_views.render_style_sha256, renderStyleHash(style));
	const evidence = JSON.parse(await readFile(join(runDir, "presentation-evidence.json"), "utf8"));
	assert.deepEqual(Object.keys(evidence.views), names);
	assert.equal(evidence.views.front.browser.view, "front");
	assert.equal(evidence.views.front.image.image.width, 100);
	const comparison = JSON.parse(await readFile(join(runDir, "baseline-comparison.json"), "utf8"));
	assert.equal(comparison.status, "compared");
	assert.deepEqual(Object.keys(comparison.views), names);
	for (const artifact of ["render-style.json", "presentation-evidence.json", "baseline-comparison.json", "render-validation.json", "contact-sheet.png"]) {
		await access(join(runDir, artifact));
	}
	for (const name of names) await access(join(runDir, "views", name, `${name}.png`));
	for (const record of Object.values(report.artifacts) as any[]) assert.match(record.sha256, /^[a-f0-9]{64}$/);
	const persistedBytes = await readFile(join(runDir, "render-validation.json"));
	assert.deepEqual(JSON.parse(persistedBytes.toString("utf8")), report);
	assert.equal(
		(await readFile(join(runDir, "render-validation.sha256"), "utf8")).trim(),
		createHash("sha256").update(persistedBytes).digest("hex"),
	);

	await t.test("runtime camera self-reference cannot bless a tampered camera", async () => {
		tamperRuntimeCamera = true;
		const tampered = await renderEmbeddedPbrViews({
			glbPath, runDir: join(root, "render-camera-tampered"), candidateId: "creative-013", cameras, baselineRunDir, outputSize: 100,
			lifecycle: { startPreview: async () => "http://127.0.0.1:4173/", stopPreview: async () => {}, launchBrowser: async () => browser },
		});
		tamperRuntimeCamera = false;
		assert.ok(tampered.validation.codes.includes("CAMERA_IDENTITY_MISMATCH"));
	});

	await t.test("legacy v6 PNGs are reanalyzed and must pass the improvement decision", async () => {
		const legacyDir = join(root, "legacy-v6");
		const legacyViews: Record<string, any> = {};
		const glbSha256 = createHash("sha256").update("unchanged textured glb").digest("hex");
		await mkdir(join(legacyDir, "viewer"), { recursive: true });
		await writeFile(join(legacyDir, "viewer", "config.json"), JSON.stringify({ cameras: { views: cameras } }));
		for (const name of names) {
			const directory = join(legacyDir, "views", name);
			await mkdir(directory, { recursive: true });
			const path = join(directory, `${name}.png`);
			const bytes = await presentationPng(0, true, false);
			await writeFile(path, bytes);
			legacyViews[name] = { path, sha256: createHash("sha256").update(bytes).digest("hex"), selectedGlbSha256: glbSha256, projectedBoundsPx: { minX: 10, minY: 5, maxX: 89, maxY: 84 } };
		}
		await writeFile(join(legacyDir, "render-validation.json"), JSON.stringify({
			schema_version: "arr.elevation3d.embedded-pbr-render.v1", selected_glb: { sha256: glbSha256 }, validation: { accepted: true }, views: legacyViews,
		}));
		const legacyCompared = await renderEmbeddedPbrViews({
			glbPath, runDir: join(root, "render-legacy-v6"), candidateId: "creative-013", cameras, baselineRunDir,
			presentationBaselineRunDir: legacyDir, outputSize: 100,
			lifecycle: { startPreview: async () => "http://127.0.0.1:4173/", stopPreview: async () => {}, launchBrowser: async () => browser },
		});
		assert.equal(legacyCompared.baseline_comparison.status, "compared_legacy_reanalyzed", JSON.stringify(legacyCompared.baseline_comparison));
		assert.equal(legacyCompared.baseline_comparison.legacy_semantic_roles.axon.roles.bronze.pixelCount, 1600);
		assert.equal(legacyCompared.baseline_comparison.decision.views.axon.semanticMaterialScore.improved, true);
		assert.equal(legacyCompared.baseline_comparison.decision.accepted, true, JSON.stringify(legacyCompared.baseline_comparison.decision));
		assert.equal(legacyCompared.validation.accepted, true, JSON.stringify(legacyCompared.validation));

		legacyViews.front.path = "https://example.invalid/front.png?signature=secret";
		await writeFile(join(legacyDir, "render-validation.json"), JSON.stringify({ schema_version: "arr.elevation3d.embedded-pbr-render.v1", selected_glb: { sha256: glbSha256 }, validation: { accepted: true }, views: legacyViews }));
		const invalid = await renderEmbeddedPbrViews({
			glbPath, runDir: join(root, "render-legacy-invalid"), candidateId: "creative-013", cameras, baselineRunDir,
			presentationBaselineRunDir: legacyDir, outputSize: 100,
			lifecycle: { startPreview: async () => "http://127.0.0.1:4173/", stopPreview: async () => {}, launchBrowser: async () => browser },
		});
		assert.equal(invalid.baseline_comparison.reason, "baseline_legacy_path_invalid");
	});

	for (const [label, baselineReport, reason] of [
		["missing", null, "baseline_missing"],
		["rejected", { schema_version: "arr.elevation3d.embedded-pbr-render.v1", validation: { accepted: false }, presentation_evidence: validPresentationEvidence() }, "baseline_not_accepted"],
		["empty evidence", { schema_version: "arr.elevation3d.embedded-pbr-render.v1", validation: { accepted: true }, presentation_evidence: {} }, "baseline_evidence_incomplete"],
		["incomplete evidence", { schema_version: "arr.elevation3d.embedded-pbr-render.v1", validation: { accepted: true }, presentation_evidence: { front: validPresentationEvidence().front } }, "baseline_evidence_incomplete"],
	] as const) await t.test(`${label} v6 presentation baseline is not compared`, async () => {
		const baselineDir = join(root, `v6-${label.replaceAll(" ", "-")}`);
		if (baselineReport) {
			await mkdir(baselineDir, { recursive: true });
			await writeFile(join(baselineDir, "render-validation.json"), JSON.stringify(baselineReport));
		}
		const withoutBaseline = await renderEmbeddedPbrViews({
			glbPath, runDir: join(root, `render-${label.replaceAll(" ", "-")}`), candidateId: "creative-013", cameras, baselineRunDir,
			presentationBaselineRunDir: baselineDir, outputSize: 100,
			lifecycle: { startPreview: async () => "http://127.0.0.1:4173/", stopPreview: async () => {}, launchBrowser: async () => browser },
		});
		assert.equal(withoutBaseline.baseline_comparison.status, "not_compared");
		assert.equal(withoutBaseline.baseline_comparison.reason, reason);
		assert.equal(withoutBaseline.validation.accepted, true, JSON.stringify(withoutBaseline.validation));
	});

	await t.test("explicit canonical promotion requires successful legacy comparison", async () => {
		const missingBaseline = join(root, "v6-required-missing");
		const required = await renderEmbeddedPbrViews({
			glbPath, runDir: join(root, "render-required-missing"), candidateId: "creative-013", cameras, baselineRunDir,
			presentationBaselineRunDir: missingBaseline, requirePresentationBaselineComparison: true, outputSize: 100,
			lifecycle: { startPreview: async () => "http://127.0.0.1:4173/", stopPreview: async () => {}, launchBrowser: async () => browser },
		});
		assert.equal(required.baseline_comparison.status, "not_compared");
		assert.ok(required.validation.codes.includes("PBR_BASELINE_COMPARISON_REQUIRED"));
		assert.equal(required.validation.accepted, false);
	});
});
