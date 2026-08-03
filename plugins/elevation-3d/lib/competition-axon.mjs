import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { sha256, stableJson } from "./core.mjs";
import { startPreview, stopPreview } from "./preview.mjs";
import { findChrome } from "./results.mjs";
import { buildViewerBundle } from "./viewer.mjs";

const OUTPUT_SIZE = 2400;
const VIEW_NAMES = ["axon", "opposite-axon"];
const ROLE_NAMES = ["concrete", "glass", "bronze", "opaque"];
const MIN_ROLE_COLOR_DISTANCE = 12;
const BUILDING_MARGIN_LIMITS = { minimum: 0.12, relevant_maximum: 0.21, letterbox_maximum: 0.35 };

function finiteVector(value) {
	return Array.isArray(value) && value.length === 3 && value.every((item) => Number.isFinite(item));
}

function cameraDepth(camera) {
	const vector = [camera.position[0] - camera.target[0], camera.position[1] - camera.target[1], 0];
	const length = Math.hypot(...vector);
	if (length < 1e-6) throw new Error(`${camera.name} camera requires a horizontal bearing`);
	return vector.map((value) => value / length);
}

function dot(left, right) {
	return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function assertInputs({ glbPath, palette, cameras, candidateId }) {
	if (!glbPath) throw new Error("selected GLB required");
	if (typeof candidateId !== "string" || !candidateId) throw new Error("candidate identity required");
	if (!palette?.sha256 || !palette?.preset || !palette?.roles) throw new Error("resolved material palette required");
	for (const role of ROLE_NAMES) {
		const record = palette.roles[role];
		if (!record || typeof record.axon_pbr !== "string" || !["roughness", "metalness", "opacity", "texture_intensity", "normal_intensity"].every((field) => Number.isFinite(record[field]))) {
			throw new Error(`resolved axon_pbr material role required: ${role}`);
		}
	}
	if (!cameras || Object.keys(cameras).sort().join("|") !== [...VIEW_NAMES].sort().join("|")) throw new Error("axon and opposite-axon cameras required");
	for (const name of VIEW_NAMES) {
		const camera = cameras[name];
		if (camera?.name !== name || camera?.projection !== "perspective" || !finiteVector(camera.position) || !finiteVector(camera.target) || !finiteVector(camera.up)) {
			throw new Error(`valid perspective ${name} camera required`);
		}
		if (!(camera.fov_degrees >= 20 && camera.fov_degrees <= 60)) throw new Error(`${name} camera FOV invalid`);
		cameraDepth(camera);
	}
	if (dot(cameraDepth(cameras.axon), cameraDepth(cameras["opposite-axon"])) >= -0.8) throw new Error("paired axon camera opposition must be below -0.8");
}

function decodeDataUrl(dataUrl) {
	const match = /^data:image\/png;base64,(.+)$/s.exec(dataUrl);
	if (!match) throw new Error("competition axon renderer returned an invalid PNG data URL");
	return Buffer.from(match[1], "base64");
}

function decodedImageMetrics(raw, width, height) {
	const corners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]];
	const background = [0, 1, 2].map((channel) => Math.round(corners.reduce((sum, [x, y]) => sum + raw[(y * width + x) * 3 + channel], 0) / corners.length));
	let minX = width, minY = height, maxX = -1, maxY = -1, foreground = 0, sum = 0, squareSum = 0;
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		const offset = (y * width + x) * 3;
		const luminance = 0.2126 * raw[offset] + 0.7152 * raw[offset + 1] + 0.0722 * raw[offset + 2];
		sum += luminance; squareSum += luminance ** 2;
		if (Math.hypot(raw[offset] - background[0], raw[offset + 1] - background[1], raw[offset + 2] - background[2]) <= 8) continue;
		minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); foreground++;
	}
	if (maxX < 0) throw new Error("competition axon contains no foreground pixels");
	const samples = width * height;
	return {
		content_bounds_px: { min_x: minX, min_y: minY, max_x: maxX, max_y: maxY },
		foreground_fraction: foreground / samples,
		background_rgb: background,
		mean_luminance: sum / samples,
		luminance_stddev: Math.sqrt(Math.max(0, squareSum / samples - (sum / samples) ** 2)),
	};
}

function roleAt(materialId, offset) {
	const [red, green, blue] = [materialId[offset], materialId[offset + 1], materialId[offset + 2]];
	return red > 200 && green < 80 && blue < 80 ? "concrete"
		: green > 200 && red < 80 && blue < 80 ? "glass"
			: blue > 200 && red < 80 && green < 80 ? "bronze"
				: red > 180 && green > 180 && blue < 80 ? "opaque" : null;
}

function trimmedChannelMean(histogram, count, trimRatio = 0.1) {
	let lowTrim = Math.floor(count * trimRatio), highTrim = lowTrim, retained = 0, sum = 0;
	for (let value = 0; value < histogram.length; value++) {
		let occurrences = histogram[value];
		const removed = Math.min(lowTrim, occurrences); lowTrim -= removed; occurrences -= removed;
		if (occurrences > 0) { retained += occurrences; sum += occurrences * value; }
	}
	for (let value = histogram.length - 1; value >= 0 && highTrim > 0; value--) {
		const removed = Math.min(highTrim, histogram[value]); highTrim -= removed; retained -= removed; sum -= removed * value;
	}
	return retained > 0 ? sum / retained : 0;
}

function rolePixelMetrics(base, materialId, width, height) {
	const metrics = Object.fromEntries(ROLE_NAMES.map((role) => [role, { visible_pixels: 0, histograms: Array.from({ length: 3 }, () => new Uint32Array(256)) }]));
	for (let offset = 0; offset < width * height * 3; offset += 3) {
		const role = roleAt(materialId, offset);
		if (!role) continue;
		metrics[role].visible_pixels++;
		for (let channel = 0; channel < 3; channel++) metrics[role].histograms[channel][base[offset + channel]]++;
	}
	return Object.fromEntries(ROLE_NAMES.map((role) => {
		const record = metrics[role];
		const meanRgb = record.histograms.map((histogram) => trimmedChannelMean(histogram, record.visible_pixels));
		return [role, {
			visible_pixels: record.visible_pixels, color_statistic: "10%-trimmed-mean-srgb8", trimmed_mean_rgb: meanRgb, mean_rgb: meanRgb,
			mean_luminance: 0.2126 * meanRgb[0] + 0.7152 * meanRgb[1] + 0.0722 * meanRgb[2],
			color_distance_to_black: Math.hypot(...meanRgb),
		}];
	}));
}

function colorSeparation(materialRoles) {
	const pairs = {};
	for (let leftIndex = 0; leftIndex < ROLE_NAMES.length; leftIndex++) for (let rightIndex = leftIndex + 1; rightIndex < ROLE_NAMES.length; rightIndex++) {
		const left = ROLE_NAMES[leftIndex], right = ROLE_NAMES[rightIndex];
		pairs[`${left}__${right}`] = Math.hypot(...materialRoles[left].trimmed_mean_rgb.map((value, channel) => value - materialRoles[right].trimmed_mean_rgb[channel]));
	}
	return {
		color_space: "srgb8-euclidean", statistic: "10%-trimmed-mean", threshold: MIN_ROLE_COLOR_DISTANCE,
		pairwise_distances: pairs, minimum_pairwise_distance: Math.min(...Object.values(pairs)),
	};
}

function buildingContentMetrics(materialId, width, height) {
	let minX = width, minY = height, maxX = -1, maxY = -1, pixels = 0;
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		const offset = (y * width + x) * 3;
		if (!roleAt(materialId, offset)) continue;
		minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); pixels++;
	}
	if (maxX < 0) throw new Error("competition axon material-ID contains no building pixels");
	const marginPixels = { left: minX, right: width - 1 - maxX, top: minY, bottom: height - 1 - maxY };
	const marginRatios = Object.fromEntries(Object.entries(marginPixels).map(([side, value]) => [side, value / (side === "left" || side === "right" ? width : height)]));
	return {
		source: "material-id-role-union", bounds_px: { min_x: minX, min_y: minY, max_x: maxX, max_y: maxY },
		building_pixels: pixels, margin_pixels: marginPixels, margin_ratios: marginRatios,
		relevant_margin_ratio: Math.min(...Object.values(marginRatios)), maximum_margin_ratio: Math.max(...Object.values(marginRatios)),
		fit_tolerance: { ...BUILDING_MARGIN_LIMITS },
		touches_frame: minX <= 0 || minY <= 0 || maxX >= width - 1 || maxY >= height - 1,
	};
}

export function measureCompetitionAxonPixels({ base, materialId, width, height }) {
	if (!(base instanceof Uint8Array) || !(materialId instanceof Uint8Array) || base.length !== width * height * 3 || materialId.length !== base.length) {
		throw new Error("competition axon RGB pixel buffers invalid");
	}
	const materialRoles = rolePixelMetrics(base, materialId, width, height);
	return {
		material_roles: materialRoles,
		material_color_separation: colorSeparation(materialRoles),
		building_content: buildingContentMetrics(materialId, width, height),
	};
}

export function validateCompetitionAxonManifest(manifest) {
	const codes = [];
	if (manifest.width !== OUTPUT_SIZE || manifest.height !== OUTPUT_SIZE) codes.push("OUTPUT_SIZE_INVALID");
	if (manifest.camera.type !== "perspective") codes.push("CAMERA_PROJECTION_INVALID");
	const margins = Object.values(manifest.building_content?.margin_ratios ?? {});
	if (margins.length !== 4 || margins.some((value) => !Number.isFinite(value) || value < BUILDING_MARGIN_LIMITS.minimum)
		|| manifest.building_content.relevant_margin_ratio > BUILDING_MARGIN_LIMITS.relevant_maximum
		|| manifest.building_content.maximum_margin_ratio > BUILDING_MARGIN_LIMITS.letterbox_maximum
		|| manifest.building_content.touches_frame) codes.push("WHITE_SPACE_INVALID");
	if (manifest.clipping.clipped) codes.push("GLB_CLIPPED");
	if (manifest.context.intersects_building || manifest.context.authoritative) codes.push("CONTEXT_INTERSECTION");
	if (ROLE_NAMES.some((role) => !(manifest.material_roles[role]?.visible_pixels > 0))) codes.push("MATERIAL_ROLE_COLLAPSE");
	if (!(manifest.material_color_separation?.minimum_pairwise_distance >= MIN_ROLE_COLOR_DISTANCE)) codes.push("MATERIAL_ROLE_COLLAPSE");
	if (ROLE_NAMES.some((role) => manifest.material_roles[role]?.visible_pixels > 0 && manifest.material_roles[role].mean_luminance <= 20)) codes.push("PBR_COLOR_INVALID");
	return { schema_version: "arr.elevation3d.competition-axon-validation.v1", accepted: codes.length === 0, codes };
}

async function renderView({ runDir, glbPath, palette, cameras, candidateId, view, selectedGlbSha256, signal, lifecycle }) {
	const root = join(resolve(runDir), "views", view);
	await mkdir(root, { recursive: true });
	const config = {
		schema_version: "arr.elevation3d.competition-viewer.v1",
		candidate_id: candidateId,
		cameras: { views: cameras },
		strategies: { hunyuan: { glb: "selected.glb" } },
		competition_axon: {
			view, output_size: OUTPUT_SIZE, margin_ratio: 0.15, background: "#fafaf7",
			palette: { schema_version: palette.schema_version, preset: palette.preset, sha256: palette.sha256, roles: palette.roles },
			lighting: {
				environment: { type: "room-pmrem", intensity: 0.55 },
				hemisphere: { sky: "#ffffff", ground: "#d8d1c5", intensity: 1.15 },
				sun: { color: "#fff8ec", intensity: 2.4, position: [24, -18, 34], shadow_map_size: 2048, radius: 5 },
				contact_shadow: { bounded: true, opacity: 0.22 },
			},
			context: { group_identity: "competition-axon-context", authoritative: false },
		},
	};
	const viewerConfigSha256 = sha256(stableJson(config));
	await buildViewerBundle({ runDir: root, config });
	await copyFile(glbPath, join(root, "viewer", "selected.glb"));
	const start = lifecycle.startPreview ?? startPreview;
	const stop = lifecycle.stopPreview ?? stopPreview;
	const launch = lifecycle.launchBrowser ?? (async () => puppeteer.launch({
		executablePath: await findChrome(), headless: true, args: ["--disable-gpu-sandbox", "--no-sandbox", "--use-angle=swiftshader"],
	}));
	let browser, page, previewPort;
	const pageErrors = [];
	try {
		signal?.throwIfAborted();
		const base = await start(root, 0);
		previewPort = Number(new URL(base).port);
		browser = await launch();
		page = await browser.newPage();
		page.on?.("pageerror", (error) => pageErrors.push(error.message));
		await page.setViewport({ width: OUTPUT_SIZE, height: OUTPUT_SIZE, deviceScaleFactor: 1 });
		await page.goto(`${base}?strategy=hunyuan&view=${encodeURIComponent(view)}&mode=competition-axon`, { waitUntil: "networkidle0" });
		await page.waitForFunction(() => globalThis.__ELEVATION3D_READY__ === true, { timeout: 60_000 });
		signal?.throwIfAborted();
		if (pageErrors.length) throw new Error(`competition axon viewer failed: ${pageErrors.join("; ")}`);
		const baseUrl = await page.evaluate(async () => globalThis.__ELEVATION3D_RENDER_MODE__("base"));
		const materialUrl = await page.evaluate(async () => globalThis.__ELEVATION3D_RENDER_MODE__("material-id"));
		const bytes = decodeDataUrl(baseUrl), materialBytes = decodeDataUrl(materialUrl);
		const path = join(root, `${view}.png`), materialPath = join(root, `${view}-material-id.png`);
		await Promise.all([writeFile(path, bytes), writeFile(materialPath, materialBytes)]);
		const [decoded, decodedMaterial] = await Promise.all([
			sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
			sharp(materialBytes).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
		]);
		if (decoded.info.width !== OUTPUT_SIZE || decoded.info.height !== OUTPUT_SIZE) throw new Error("competition axon PNG size invalid");
		const browserArtifact = await page.evaluate(() => globalThis.__ELEVATION3D_ARTIFACT__);
		const imageMetrics = decodedImageMetrics(decoded.data, decoded.info.width, decoded.info.height);
		const pixelEvidence = measureCompetitionAxonPixels({ base: decoded.data, materialId: decodedMaterial.data, width: decodedMaterial.info.width, height: decodedMaterial.info.height });
		const materialRoles = Object.fromEntries(ROLE_NAMES.map((role) => [role, { ...palette.roles[role], geometry_vertices: browserArtifact.material_roles[role].geometry_vertices, ...pixelEvidence.material_roles[role] }]));
		const manifest = {
			schema_version: "arr.elevation3d.competition-axon.v1", view, candidate_id: candidateId,
			selected_glb: { path: resolve(glbPath), sha256: selectedGlbSha256 }, selected_glb_sha256: selectedGlbSha256,
			palette: { preset: palette.preset, sha256: palette.sha256 }, viewer_config_sha256: viewerConfigSha256,
			width: decoded.info.width, height: decoded.info.height, camera: browserArtifact.camera,
			loaded_bounds: browserArtifact.loaded_bounds, content_bounds_px: imageMetrics.content_bounds_px,
			decoded_image_metrics: imageMetrics, clipping: browserArtifact.clipping, lights: browserArtifact.lights,
			context: browserArtifact.context, material_roles: materialRoles, material_color_separation: pixelEvidence.material_color_separation,
			building_content: pixelEvidence.building_content,
			diagnostics: { material_id: { path: materialPath, sha256: sha256(materialBytes) } },
		};
		const validation = validateCompetitionAxonManifest(manifest);
		const manifestPath = join(root, `${view}-manifest.json`), validationPath = join(root, `${view}-validation.json`);
		await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
		await writeFile(validationPath, JSON.stringify(validation, null, 2));
		return {
			path, sha256: sha256(bytes), width: manifest.width, height: manifest.height,
			selected_glb_sha256: selectedGlbSha256, camera: manifest.camera, loaded_bounds: manifest.loaded_bounds,
			content_bounds_px: manifest.content_bounds_px, building_content: manifest.building_content, decoded_image_metrics: imageMetrics, clipping: manifest.clipping,
			lights: manifest.lights, context: manifest.context, material_roles: materialRoles, diagnostics: manifest.diagnostics,
			manifest, validation,
			manifest_record: { path: manifestPath, sha256: sha256(await readFile(manifestPath)) },
			validation_report: { path: validationPath, sha256: sha256(await readFile(validationPath)) },
		};
	} finally {
		try { if (page) await page.close(); }
		finally {
			try { if (browser) await browser.close(); }
			finally { if (previewPort) await stop(previewPort); }
		}
	}
}

export async function renderCompetitionAxons({ runDir, glbPath, palette, cameras, candidateId, signal, lifecycle = {} }) {
	assertInputs({ glbPath, palette, cameras, candidateId });
	const selectedGlbSha256 = sha256(await readFile(glbPath));
	const views = {};
	for (const view of VIEW_NAMES) {
		signal?.throwIfAborted();
		views[view] = await renderView({ runDir, glbPath, palette, cameras, candidateId, view, selectedGlbSha256, signal, lifecycle });
	}
	const oppositionDot = dot(views.axon.camera.depth, views["opposite-axon"].camera.depth);
	const codes = [];
	if (oppositionDot >= -0.8) codes.push("CAMERA_OPPOSITION_INVALID");
	if (views.axon.selected_glb_sha256 !== views["opposite-axon"].selected_glb_sha256) codes.push("SELECTED_GLB_MISMATCH");
	if (views.axon.manifest.palette.sha256 !== views["opposite-axon"].manifest.palette.sha256) codes.push("PALETTE_MISMATCH");
	if (views.axon.sha256 === views["opposite-axon"].sha256) codes.push("OPPOSITE_VIEW_NOT_DISTINCT");
	for (const view of VIEW_NAMES) if (!views[view].validation.accepted) codes.push(`${view.toUpperCase()}_REJECTED`);
	const validation = { schema_version: "arr.elevation3d.competition-axon-pair-validation.v1", accepted: codes.length === 0, codes, metrics: { camera_depth_dot: oppositionDot } };
	const pairManifest = {
		schema_version: "arr.elevation3d.competition-axon-pair.v1", candidate_id: candidateId,
		selected_glb: { path: resolve(glbPath), sha256: selectedGlbSha256 }, palette: { preset: palette.preset, sha256: palette.sha256 },
		views: Object.fromEntries(VIEW_NAMES.map((name) => [name, { path: views[name].path, sha256: views[name].sha256, manifest: views[name].manifest_record, validation: views[name].validation_report }])),
		camera_depth_dot: oppositionDot,
	};
	const pairManifestPath = join(resolve(runDir), "paired-axon-manifest.json"), pairValidationPath = join(resolve(runDir), "paired-axon-validation.json");
	await writeFile(pairManifestPath, JSON.stringify(pairManifest, null, 2));
	await writeFile(pairValidationPath, JSON.stringify(validation, null, 2));
	return {
		views, validation,
		manifest_record: { path: pairManifestPath, sha256: sha256(await readFile(pairManifestPath)) },
		validation_report: { path: pairValidationPath, sha256: sha256(await readFile(pairValidationPath)) },
	};
}
