import { copyFile, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { sha256 } from "../core.mjs";
import { findChrome } from "../results.mjs";
import { startPreview, stopPreview } from "../preview.mjs";
import { buildViewerBundle } from "../viewer.mjs";
import { analyzePresentationPng, analyzeSemanticRolePng, comparePresentationEvidence, evaluatePresentationImprovement, validatePresentationEvidence, validateSemanticRoleEvidence } from "./render-style-evidence.mjs";
import { renderStyleHash, resolvePbrRenderStyle } from "./render-style.mjs";

const VIEW_NAMES = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];

function normalizeCameraValue(value) {
	if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 1e12) / 1e12 : null;
	if (Array.isArray(value)) return value.map(normalizeCameraValue);
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeCameraValue(value[key])]));
	return value;
}

function cameraContractHash(contract) {
	return sha256(Buffer.from(JSON.stringify(normalizeCameraValue(contract))));
}

function cameraNumbersFinite(value) {
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(cameraNumbersFinite);
	if (value && typeof value === "object") return Object.values(value).every(cameraNumbersFinite);
	return true;
}

export function deriveExpectedCameraContract({ name, preset, buildingBounds }) {
	const clipping = preset.cut ?? { enabled: false, elevation_m: null, plane_world: null };
	if (preset.type === "perspective") return normalizeCameraValue({
		type: "perspective", position: preset.position, target: preset.target, up: preset.up,
		perspective: { fov: preset.fov_degrees, near: preset.near, far: preset.far, aspect: preset.aspect }, orthographic: null,
		configured: { projection_axes: null, depth: preset.depth ?? null }, clipping,
	});
	if (preset.type !== "orthographic") throw new Error(`unsupported camera preset: ${name}`);
	const center = buildingBounds.center;
	const rawDepth = preset.projection_axes.depth;
	const length = Math.hypot(...rawDepth);
	const depth = rawDepth.map((value) => value / length);
	const direction = name === "plan" || name === "top" ? 1 : -1;
	const position = center.map((value, index) => value + direction * depth[index] * buildingBounds.radius * 4);
	return normalizeCameraValue({
		type: "orthographic", position, target: preset.target ?? center, up: preset.projection_axes.vertical,
		perspective: null, orthographic: { ...preset.frustum, zoom: 1 },
		configured: { projection_axes: preset.projection_axes, depth: null }, clipping,
	});
}

function validCameraIdentity(views) {
	if (!VIEW_NAMES.every((name) => views?.[name]?.cameraEvidence)) return false;
	for (const name of VIEW_NAMES) {
		const evidence = views[name].cameraEvidence;
		if (!cameraNumbersFinite(evidence.expected) || !cameraNumbersFinite(evidence.actual)) return false;
		const expected = normalizeCameraValue(evidence.expected);
		const actual = normalizeCameraValue(evidence.actual);
		if (cameraContractHash(expected) !== evidence.expected_hash || cameraContractHash(actual) !== evidence.actual_hash) return false;
		if (JSON.stringify(expected) !== JSON.stringify(actual)) return false;
	}
	for (const name of VIEW_NAMES) {
		const actual = normalizeCameraValue(views[name].cameraEvidence.actual.clipping);
		const required = name === "plan"
			? { elevation_m: 1.2, enabled: true, plane_world: [0, 0, 1, -1.2] }
			: { elevation_m: null, enabled: false, plane_world: null };
		if (JSON.stringify(actual) !== JSON.stringify(required)) return false;
	}
	return true;
}

export function validateEmbeddedPbrRender({
	views, selectedGlbSha256, consoleErrors, materialMode,
	renderStyle, renderStyleSha256, presentationEvidence, presentationEnvironment, semanticRoleEvidence, baselineComparison,
	requirePresentationBaselineComparison = false,
}) {
	const codes = [];
	const records = VIEW_NAMES.map((name) => views?.[name]).filter(Boolean);
	if (records.length !== VIEW_NAMES.length) codes.push("VIEWS_INCOMPLETE");
	if (records.some((record) => record.selectedGlbSha256 !== selectedGlbSha256)) codes.push("SELECTED_GLB_MISMATCH");
	if (new Set(records.map((record) => record.sha256)).size !== records.length) codes.push("VIEWS_DUPLICATE");
	if (records.some((record) => new Set(record.settledHashes ?? []).size !== 1)) codes.push("RENDER_UNSTABLE");
	if (records.some((record) => !(record.foregroundFraction > 0.01 && record.foregroundFraction < 0.9))) codes.push("CAMERA_FRAMING_INVALID");
	if (records.some((record) => !(record.silhouetteIou >= 0.985) || !(record.projectedExtentDelta <= 0.005))) codes.push("SILHOUETTE_MISMATCH");
	if (records.some((record) => !(record.baselineProjectedExtentDelta <= 0.03))) codes.push("PROCEDURAL_BASELINE_MISMATCH");
	if (VIEW_NAMES.slice(0, 6).some((name) => views?.[name]?.cameraType !== "orthographic")
		|| VIEW_NAMES.slice(6).some((name) => views?.[name]?.cameraType !== "perspective")) codes.push("CAMERA_PROJECTION_INVALID");
	if (["axon", "opposite-axon"].some((name) => !(views?.[name]?.pbrPixelDelta >= 0.5))) codes.push("PBR_EVIDENCE_MISSING");
	if ((consoleErrors ?? []).length > 0) codes.push("CONSOLE_ERROR");
	if (materialMode !== "embedded-pbr") codes.push("MATERIAL_MODE_INVALID");
	if (renderStyle !== undefined || renderStyleSha256 !== undefined || presentationEvidence !== undefined) {
		codes.push(...validatePresentationEvidence({ views: presentationEvidence, style: renderStyle, styleHash: renderStyleSha256 }).codes);
		if (!validCameraIdentity(views)) codes.push("CAMERA_IDENTITY_MISMATCH");
		codes.push(...validateSemanticRoleEvidence({ views: semanticRoleEvidence }).codes);
	}
	if (presentationEnvironment?.status === "failed") codes.push("PBR_ENVIRONMENT_FAILED");
	if (baselineComparison?.status === "compared_legacy_reanalyzed" && baselineComparison.decision?.accepted !== true) {
		codes.push("PBR_BASELINE_IMPROVEMENT_MISSING");
	}
	if (requirePresentationBaselineComparison
		&& !(baselineComparison?.status === "compared_legacy_reanalyzed" && baselineComparison.decision?.accepted === true)) {
		codes.push("PBR_BASELINE_COMPARISON_REQUIRED");
	}
	const unique = [...new Set(codes)];
	return { accepted: unique.length === 0, status: unique.length === 0 ? "accepted" : "rejected", codes: unique };
}

function decodePng(dataUrl) {
	const match = /^data:image\/png;base64,(.+)$/s.exec(dataUrl);
	if (!match) throw new Error("viewer returned an invalid PNG data URL");
	return Buffer.from(match[1], "base64");
}

async function compareRenderEvidence(texturedBytes, diagnosticBytes) {
	const [textured, diagnostic] = await Promise.all([
		sharp(texturedBytes).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
		sharp(diagnosticBytes).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
	]);
	const backgrounds = [textured, diagnostic].map(({ data }) => [data[0], data[1], data[2]]);
	const bounds = [{ minX: textured.info.width, minY: textured.info.height, maxX: -1, maxY: -1 }, { minX: textured.info.width, minY: textured.info.height, maxX: -1, maxY: -1 }];
	let texturedCount = 0, intersection = 0, union = 0, pixelDifference = 0;
	for (let pixel = 0; pixel < textured.info.width * textured.info.height; pixel += 1) {
		const offset = pixel * 3, x = pixel % textured.info.width, y = Math.floor(pixel / textured.info.width);
		const flags = [textured, diagnostic].map(({ data }, image) => Math.hypot(data[offset] - backgrounds[image][0], data[offset + 1] - backgrounds[image][1], data[offset + 2] - backgrounds[image][2]) > 2);
		if (flags[0]) texturedCount++;
		if (flags[0] && flags[1]) intersection++;
		if (flags[0] || flags[1]) {
			union++;
			pixelDifference += (Math.abs(textured.data[offset] - diagnostic.data[offset]) + Math.abs(textured.data[offset + 1] - diagnostic.data[offset + 1]) + Math.abs(textured.data[offset + 2] - diagnostic.data[offset + 2])) / 3;
		}
		for (let image = 0; image < 2; image++) if (flags[image]) {
			bounds[image].minX = Math.min(bounds[image].minX, x); bounds[image].maxX = Math.max(bounds[image].maxX, x);
			bounds[image].minY = Math.min(bounds[image].minY, y); bounds[image].maxY = Math.max(bounds[image].maxY, y);
		}
	}
	const extentDelta = Math.max(...["minX", "minY", "maxX", "maxY"].map((field) => Math.abs(bounds[0][field] - bounds[1][field]))) / textured.info.width;
	return {
		foregroundFraction: texturedCount / (textured.info.width * textured.info.height),
		silhouetteIou: union > 0 ? intersection / union : 0,
		projectedExtentDelta: extentDelta,
		pbrPixelDelta: union > 0 ? pixelDifference / union : 0,
		projectedBoundsPx: bounds[1],
	};
}

async function loadProceduralBaseline(runDir) {
	if (!runDir) return null;
	const root = resolve(runDir);
	const manifest = JSON.parse(await readFile(join(root, "all-views-manifest.json"), "utf8"));
	const result = {};
	for (const name of VIEW_NAMES) {
		const view = manifest.views?.[name];
		const detailedPath = view?.manifest?.path ? join(root, view.manifest.path) : null;
		const detailed = detailedPath ? JSON.parse(await readFile(detailedPath, "utf8")) : null;
		const bounds = detailed?.building_content?.bounds_px ?? detailed?.content_bounds_px ?? view?.validation?.metrics?.content_bounds_px;
		if (!bounds || !(view.width > 0) || !(view.height > 0)) throw new Error(`Procedural baseline extent is missing for ${name}`);
		result[name] = {
			minX: bounds.min_x / view.width, minY: bounds.min_y / view.height,
			maxX: bounds.max_x / view.width, maxY: bounds.max_y / view.height,
		};
	}
	return result;
}

function baselineExtentDelta(bounds, width, height, baseline) {
	if (!baseline) return Infinity;
	const normalized = { minX: bounds.minX / width, minY: bounds.minY / height, maxX: bounds.maxX / width, maxY: bounds.maxY / height };
	return Math.max(...Object.keys(normalized).map((key) => Math.abs(normalized[key] - baseline[key])));
}

async function writeJsonAtomic(path, value) {
	const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
	const temporaryPath = `${path}.${process.pid}.tmp`;
	await writeFile(temporaryPath, bytes);
	await rename(temporaryPath, path);
	return { path, sha256: sha256(bytes) };
}

async function writeTextAtomic(path, value) {
	const temporaryPath = `${path}.${process.pid}.tmp`;
	await writeFile(temporaryPath, value);
	await rename(temporaryPath, path);
}

export async function loadPresentationBaseline(runDir, binding = {}) {
	if (!runDir) return { status: "not_compared", reason: "baseline_not_requested", run_dir: null, views: {} };
	const root = resolve(runDir);
	let report;
	try {
		report = JSON.parse(await readFile(join(root, "render-validation.json"), "utf8"));
	} catch (error) {
		if (error?.code === "ENOENT") return { status: "not_compared", reason: "baseline_missing", run_dir: root, views: {} };
		throw error;
	}
	if (!["arr.elevation3d.embedded-pbr-render.v1", "arr.elevation3d.embedded-pbr-render.v2"].includes(report.schema_version)) {
		return { status: "not_compared", reason: "baseline_schema_invalid", run_dir: root, views: {} };
	}
	if (report.schema_version === "arr.elevation3d.embedded-pbr-render.v1"
		&& report.validation?.accepted === true && !report.presentation_evidence) {
		try {
			const realRoot = await realpath(root);
			if (!/^[a-f0-9]{64}$/i.test(report.selected_glb?.sha256)
				|| report.selected_glb.sha256.toLowerCase() !== binding.selectedGlbSha256?.toLowerCase()) throw new Error("glb");
			const baselineConfig = JSON.parse(await readFile(join(realRoot, "viewer", "config.json"), "utf8"));
			if (JSON.stringify(normalizeCameraValue(baselineConfig.cameras?.views)) !== JSON.stringify(normalizeCameraValue(binding.cameras))) throw new Error("camera");
			const views = {}, pngs = {}, boundViews = {};
			for (const name of VIEW_NAMES) {
				const record = report.views?.[name];
				if (record?.selectedGlbSha256 !== binding.selectedGlbSha256) throw new Error("glb");
				const specified = record?.path;
				if (typeof specified !== "string" || /^[a-z]+:\/\//i.test(specified) || specified.includes("?")) throw new Error("path");
				const candidate = resolve(specified);
				const lexicalRelative = relative(root, candidate);
				if (lexicalRelative.startsWith("..") || isAbsolute(lexicalRelative)) throw new Error("path");
				const realCandidate = await realpath(candidate);
				const realRelative = relative(realRoot, realCandidate);
				if (realRelative.startsWith("..") || isAbsolute(realRelative)) throw new Error("path");
				const bytes = await readFile(realCandidate);
				if (!/^[a-f0-9]{64}$/i.test(record.sha256) || sha256(bytes) !== record.sha256.toLowerCase()) throw new Error("hash");
				const metadata = await sharp(bytes).metadata();
				const current = binding.currentViews?.[name];
				if (metadata.width !== current?.width || metadata.height !== current?.height) throw new Error("size");
				const bounds = record.projectedBoundsPx;
				if (!bounds || ![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)) throw new Error("bounds");
				if (JSON.stringify(normalizeCameraValue(bounds)) !== JSON.stringify(normalizeCameraValue(current?.projectedBoundsPx))) throw new Error("alignment");
				views[name] = await analyzePresentationPng({ png: bytes, buildingBounds: bounds, background: "#fafaf7" });
				pngs[name] = bytes;
				boundViews[name] = {
					png_sha256: record.sha256.toLowerCase(), width: metadata.width, height: metadata.height,
					camera_sha256: cameraContractHash(binding.cameras?.[name] ?? null), projected_bounds_px: normalizeCameraValue(bounds),
					transform: { type: "identity" }, containment: "lexical_and_realpath",
				};
			}
			return { status: "legacy_reanalyzed", run_dir: realRoot, views, pngs, binding: {
				schema_version: "arr.elevation3d.legacy-presentation-binding.v1",
				selected_glb_sha256: binding.selectedGlbSha256, cameras_sha256: cameraContractHash(binding.cameras), views: boundViews,
			} };
		} catch (error) {
			const reasons = {
				path: "baseline_legacy_path_invalid", hash: "baseline_legacy_hash_invalid", glb: "baseline_legacy_glb_mismatch",
				size: "baseline_legacy_size_mismatch", camera: "baseline_legacy_camera_mismatch", alignment: "baseline_legacy_bounds_mismatch",
			};
			return { status: "not_compared", reason: reasons[error?.message] ?? "baseline_legacy_evidence_invalid", run_dir: root, views: {} };
		}
	}
	if (report.validation?.accepted !== true || !report.presentation_evidence) {
		return { status: "not_compared", reason: "baseline_not_accepted", run_dir: root, views: {} };
	}
	const complete = VIEW_NAMES.every((name) => {
		const evidence = report.presentation_evidence[name];
		return evidence && [
			evidence.materialSeparation?.luminanceSpread, evidence.materialSeparation?.chromaSpread,
			evidence.background?.deltaP95, evidence.background?.luminanceVariance,
		].every(Number.isFinite);
	});
	if (!complete) return { status: "not_compared", reason: "baseline_evidence_incomplete", run_dir: root, views: {} };
	return { status: "ready", run_dir: root, views: report.presentation_evidence };
}

export async function renderEmbeddedPbrViews({
	glbPath, runDir, candidateId, cameras, baselineRunDir, outputSize = 1600, signal, lifecycle = {},
	renderStyleId = "competition-daylight-v1", renderStyleOverrides, presentationBaselineRunDir,
	requirePresentationBaselineComparison = false, canonicalSelection,
} = {}) {
	const root = resolve(runDir);
	await mkdir(root, { recursive: true });
	const glbBytes = await readFile(resolve(glbPath));
	const selectedGlbSha256 = sha256(glbBytes);
	const proceduralBaseline = await loadProceduralBaseline(baselineRunDir);
	const renderStyle = resolvePbrRenderStyle({ ...(renderStyleOverrides ?? {}), id: renderStyleId });
	const renderStyleSha256 = renderStyleHash(renderStyle);
	const styleArtifact = await writeJsonAtomic(join(root, "render-style.json"), renderStyle);
	const config = {
		schema_version: "arr.elevation3d.embedded-pbr-viewer.v1",
		candidate_id: candidateId,
		strategies: { hunyuan: { glb: "../textured.glb" } },
		cameras: { views: cameras },
		all_views: {
			material_mode: "embedded-pbr",
			selected_glb: { path: "../textured.glb", sha256: selectedGlbSha256 },
			render_style: renderStyle, render_style_sha256: renderStyleSha256,
			palettes: {}, views: {}, validation: { accepted: true, codes: [] }, artifacts: [],
		},
	};
	await buildViewerBundle({ runDir: root, config });
	await copyFile(resolve(glbPath), join(root, "textured.glb"));
	const start = lifecycle.startPreview ?? startPreview;
	const stop = lifecycle.stopPreview ?? stopPreview;
	const launch = lifecycle.launchBrowser ?? (async () => puppeteer.launch({
		executablePath: await findChrome(), headless: true,
		args: ["--disable-gpu-sandbox", "--no-sandbox", "--use-angle=swiftshader"],
	}));
	let browser, page, previewPort;
	const consoleErrors = [];
	try {
		signal?.throwIfAborted();
		const base = await start(root, 0);
		previewPort = Number(new URL(base).port);
		browser = await launch();
		page = await browser.newPage();
		page.on("pageerror", (error) => consoleErrors.push(error.message));
		page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
		await page.setViewport({ width: outputSize, height: outputSize, deviceScaleFactor: 1 });
		await page.goto(`${base}?strategy=hunyuan`, { waitUntil: "networkidle0" });
		await page.waitForFunction(() => globalThis.__ELEVATION3D_READY__ === true, { timeout: 60_000 });
		const views = {};
		const presentationEvidence = {};
		const semanticRoleEvidence = {}, semanticRoleMasks = {};
		const semanticGeometryEvidence = await page.evaluate(() => globalThis.__ELEVATION3D_TEST_CONTROLS__.semanticRoleGeometry());
		for (const name of VIEW_NAMES) {
			signal?.throwIfAborted();
			await page.evaluate((view) => globalThis.__ELEVATION3D_TEST_CONTROLS__.activateView(view), name);
			const [firstUrl, secondUrl] = await page.evaluate(async () => {
				const first = await globalThis.__ELEVATION3D_TEST_CONTROLS__.settledPng();
				const second = await globalThis.__ELEVATION3D_TEST_CONTROLS__.settledPng();
				return [first, second];
			});
			const first = decodePng(firstUrl), second = decodePng(secondUrl);
			const browserState = await page.evaluate(() => globalThis.__ELEVATION3D_VIEWER_STATE__);
			const expectedCameraContract = deriveExpectedCameraContract({ name, preset: cameras[name], buildingBounds: browserState.building_bounds });
			const browserPresentation = await page.evaluate(() => globalThis.__ELEVATION3D_TEST_CONTROLS__.presentationEvidence());
			const semanticRoleMask = decodePng(await page.evaluate(() => globalThis.__ELEVATION3D_TEST_CONTROLS__.semanticRolePng()));
			semanticRoleMasks[name] = semanticRoleMask;
			await page.evaluate(() => globalThis.__ELEVATION3D_TEST_CONTROLS__.setPresentationObjectsVisible(false));
			let geometryTextured, diagnostic;
			try {
				geometryTextured = decodePng(await page.evaluate(async () => globalThis.__ELEVATION3D_TEST_CONTROLS__.settledPng()));
				await page.evaluate(() => globalThis.__ELEVATION3D_TEST_CONTROLS__.setEmbeddedMaps(false));
				diagnostic = decodePng(await page.evaluate(async () => globalThis.__ELEVATION3D_TEST_CONTROLS__.settledPng()));
			} finally {
				await page.evaluate(() => globalThis.__ELEVATION3D_TEST_CONTROLS__.setEmbeddedMaps(true));
				await page.evaluate(() => globalThis.__ELEVATION3D_TEST_CONTROLS__.setPresentationObjectsVisible(true));
			}
			const evidence = await compareRenderEvidence(geometryTextured, diagnostic);
			const directory = join(root, "views", name);
			await mkdir(directory, { recursive: true });
			const path = join(directory, `${name}.png`);
			const semanticRoleMaskPath = join(directory, `${name}-semantic-roles.png`);
			await writeFile(path, second);
			await writeFile(semanticRoleMaskPath, semanticRoleMask);
			const presentationBounds = proceduralBaseline?.[name] ? {
				minX: proceduralBaseline[name].minX * outputSize, minY: proceduralBaseline[name].minY * outputSize,
				maxX: proceduralBaseline[name].maxX * outputSize, maxY: proceduralBaseline[name].maxY * outputSize,
			} : evidence.projectedBoundsPx;
			const imagePresentation = await analyzePresentationPng({
				png: await readFile(path), buildingBounds: presentationBounds, background: renderStyle.background,
			});
			presentationEvidence[name] = { browser: browserPresentation ?? browserState.presentation, image: imagePresentation };
			semanticRoleEvidence[name] = await analyzeSemanticRolePng({ finalPng: second, roleMaskPng: semanticRoleMask, geometry: semanticGeometryEvidence });
			views[name] = {
				path, sha256: sha256(second), settledHashes: [sha256(first), sha256(second)], selectedGlbSha256,
				width: outputSize, height: outputSize,
				semanticRoleMaskPath, semanticRoleMaskSha256: sha256(semanticRoleMask),
				cameraType: browserState.camera.type,
				cameraEvidence: {
					expected: expectedCameraContract,
					actual: normalizeCameraValue(browserState.camera.contract),
					expected_hash: cameraContractHash(expectedCameraContract),
					actual_hash: cameraContractHash(browserState.camera.contract),
				},
				...evidence,
				baselineProjectedExtentDelta: baselineExtentDelta(evidence.projectedBoundsPx, outputSize, outputSize, proceduralBaseline?.[name]),
			};
		}
		const pbrEvidence = await page.evaluate(() => globalThis.__ELEVATION3D_TEST_CONTROLS__.embeddedPbrEvidence());
		const imageEvidence = Object.fromEntries(VIEW_NAMES.map((name) => [name, presentationEvidence[name].image]));
		const presentationArtifact = await writeJsonAtomic(join(root, "presentation-evidence.json"), {
			schema_version: "arr.elevation3d.presentation-evidence.v1", render_style_id: renderStyle.id,
			render_style_sha256: renderStyleSha256, views: presentationEvidence, semantic_roles: semanticRoleEvidence,
		});
		const semanticRoleArtifact = await writeJsonAtomic(join(root, "semantic-role-evidence.json"), {
			schema_version: "arr.elevation3d.semantic-role-evidence.v1", views: semanticRoleEvidence,
		});
		const baseline = await loadPresentationBaseline(presentationBaselineRunDir, { selectedGlbSha256, cameras, currentViews: views });
		const baselineSemanticRoleEvidence = baseline.status === "legacy_reanalyzed" ? Object.fromEntries(await Promise.all(VIEW_NAMES.map(async (name) => [
			name, await analyzeSemanticRolePng({ finalPng: baseline.pngs[name], roleMaskPng: semanticRoleMasks[name], geometry: semanticGeometryEvidence }),
		]))) : null;
		const comparableBaseline = baseline.status === "ready" || baseline.status === "legacy_reanalyzed";
		const comparisonViews = comparableBaseline
			? Object.fromEntries(VIEW_NAMES.map((name) => [name, comparePresentationEvidence(imageEvidence[name], baseline.views[name])])) : {};
		const baselineComparison = comparableBaseline ? {
			schema_version: "arr.elevation3d.presentation-baseline-comparison.v1",
			status: baseline.status === "legacy_reanalyzed" ? "compared_legacy_reanalyzed" : "compared",
			baseline_run_dir: baseline.run_dir,
			views: comparisonViews,
			...(baseline.status === "legacy_reanalyzed" ? {
				binding: baseline.binding,
				legacy_semantic_roles: baselineSemanticRoleEvidence,
				decision: evaluatePresentationImprovement({ current: imageEvidence, baseline: baseline.views, semantic: semanticRoleEvidence, baselineSemantic: baselineSemanticRoleEvidence }),
			} : {}),
		} : {
			schema_version: "arr.elevation3d.presentation-baseline-comparison.v1", status: baseline.status,
			reason: baseline.reason, baseline_run_dir: baseline.run_dir, views: {},
		};
		const baselineArtifact = await writeJsonAtomic(join(root, "baseline-comparison.json"), baselineComparison);
		const validation = validateEmbeddedPbrRender({
			views, selectedGlbSha256, consoleErrors, materialMode: "embedded-pbr",
			renderStyle, renderStyleSha256, presentationEvidence: imageEvidence,
			presentationEnvironment: presentationEvidence.front?.browser?.environment,
			semanticRoleEvidence,
			baselineComparison,
			requirePresentationBaselineComparison,
		});
		const thumbnails = await Promise.all(VIEW_NAMES.map((name) => sharp(views[name].path).resize(500, 500).png().toBuffer()));
		const contactSheetPath = join(root, "contact-sheet.png");
		await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#fafaf7" } })
			.composite(thumbnails.map((input, index) => ({ input, left: (index % 4) * 500, top: Math.floor(index / 4) * 500 })))
			.png().toFile(contactSheetPath);
		const report = {
			schema_version: "arr.elevation3d.embedded-pbr-render.v2",
			selected_glb: { path: resolve(glbPath), sha256: selectedGlbSha256 }, material_mode: "embedded-pbr", views,
			procedural_baseline: { run_dir: baselineRunDir ? resolve(baselineRunDir) : null, compared_views: proceduralBaseline ? VIEW_NAMES : [] },
			render_style: renderStyle, render_style_sha256: renderStyleSha256,
			presentation_environment: presentationEvidence.front?.browser?.environment ?? null,
			presentation_evidence: imageEvidence, baseline_comparison: baselineComparison,
			semantic_role_evidence: semanticRoleEvidence,
			console_errors: consoleErrors,
			pbr_evidence: pbrEvidence,
			provider_calls: 0, credits_consumed: 0,
			...(canonicalSelection ? { canonical_selection: canonicalSelection } : {}),
			contact_sheet: { path: contactSheetPath, sha256: sha256(await readFile(contactSheetPath)) }, validation,
			artifacts: {
				render_style: styleArtifact, presentation_evidence: presentationArtifact, semantic_role_evidence: semanticRoleArtifact, baseline_comparison: baselineArtifact,
				contact_sheet: { path: contactSheetPath, sha256: sha256(await readFile(contactSheetPath)) },
				...Object.fromEntries(VIEW_NAMES.map((name) => [`view_${name}`, { path: views[name].path, sha256: views[name].sha256 }])),
				...Object.fromEntries(VIEW_NAMES.map((name) => [`semantic_role_mask_${name}`, { path: views[name].semanticRoleMaskPath, sha256: views[name].semanticRoleMaskSha256 }])),
			},
		};
		const reportArtifact = await writeJsonAtomic(join(root, "render-validation.json"), report);
		await writeTextAtomic(join(root, "render-validation.sha256"), `${reportArtifact.sha256}\n`);
		return report;
	} finally {
		await page?.close().catch(() => {});
		await browser?.close().catch(() => {});
		if (previewPort) await stop(previewPort).catch(() => {});
	}
}
