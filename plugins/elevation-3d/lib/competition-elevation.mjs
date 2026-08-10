import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { sha256, stableJson } from "./core.mjs";
import { startPreview, stopPreview } from "./preview.mjs";
import { findChrome } from "./results.mjs";
import { buildViewerBundle } from "./viewer.mjs";
import { buildElevationAnnotations } from "./elevation-annotations.mjs";
import { validateCompetitionElevation } from "./elevation-presentation-validation.mjs";
import { atomicCopy, atomicWrite, prepareSafeDirectory } from "./facade-agent/path-safety.mjs";

const OUTPUT_SIZE = 2400;
const ELEVATION_VIEWS = new Set(["front", "back", "left", "right"]);

function assertInputs({ view, camera, palette, dimensions }) {
	if (!ELEVATION_VIEWS.has(view)) throw new Error(`unsupported elevation view: ${view}`);
	if (camera?.projection !== "orthographic") throw new Error(`orthographic ${view} camera required`);
	if (dimensions?.view !== view) throw new Error(`${view} dimension manifest required`);
	if (!palette?.sha256 || !palette?.roles) throw new Error("resolved material palette required");
}

function decodeDataUrl(dataUrl) {
	const match = /^data:image\/png;base64,(.+)$/s.exec(dataUrl);
	if (!match) throw new Error("competition renderer returned an invalid PNG data URL");
	return Buffer.from(match[1], "base64");
}

function contentBounds(raw, width, height) {
	const corners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]];
	const background = [0, 1, 2].map((channel) => Math.round(corners.reduce((sum, [x, y]) => sum + raw[(y * width + x) * 3 + channel], 0) / corners.length));
	let minX = width, minY = height, maxX = -1, maxY = -1, count = 0, dark = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const offset = (y * width + x) * 3;
			const red = raw[offset], green = raw[offset + 1], blue = raw[offset + 2];
			const delta = Math.hypot(red - background[0], green - background[1], blue - background[2]);
			if (delta > 10) {
				minX = Math.min(minX, x); maxX = Math.max(maxX, x);
				minY = Math.min(minY, y); maxY = Math.max(maxY, y); count++;
			}
			if (0.2126 * red + 0.7152 * green + 0.0722 * blue < 90) dark++;
		}
	}
	if (maxX < 0) throw new Error("competition elevation contains no foreground pixels");
	return {
		bounds: { min_x: minX, min_y: minY, max_x: maxX, max_y: maxY },
		foregroundFraction: count / (width * height),
		darkFraction: dark / (width * height),
	};
}

function edgeMetrics(raw, width, height) {
	let edges = 0, strong = 0, samples = 0;
	const luminance = (x, y) => {
		const offset = (y * width + x) * 3;
		return 0.2126 * raw[offset] + 0.7152 * raw[offset + 1] + 0.0722 * raw[offset + 2];
	};
	for (let y = 2; y < height - 2; y += 2) {
		for (let x = 2; x < width - 2; x += 2) {
			const gx = -luminance(x - 1, y - 1) + luminance(x + 1, y - 1)
				- 2 * luminance(x - 1, y) + 2 * luminance(x + 1, y)
				- luminance(x - 1, y + 1) + luminance(x + 1, y + 1);
			const gy = -luminance(x - 1, y - 1) - 2 * luminance(x, y - 1) - luminance(x + 1, y - 1)
				+ luminance(x - 1, y + 1) + 2 * luminance(x, y + 1) + luminance(x + 1, y + 1);
			const magnitude = Math.hypot(gx, gy);
			if (magnitude > 80) edges++;
			if (magnitude > 180) strong++;
			samples++;
		}
	}
	return { total_edge_density: edges / samples, strong_edge_density: strong / samples };
}

function decodeDepthMetres(raw, offset, near, far) {
	const normalized = raw[offset] / 255 + raw[offset + 1] / (255 ** 2) + raw[offset + 2] / (255 ** 3);
	return near + normalized * (far - near);
}

function decodeNormal(raw, offset) {
	const vector = [raw[offset] / 255 * 2 - 1, raw[offset + 1] / 255 * 2 - 1, raw[offset + 2] / 255 * 2 - 1];
	const length = Math.hypot(...vector);
	return length > 0 ? vector.map((value) => value / length) : [0, 0, 0];
}

function diagnosticMetrics({ base, materialId, depth, normal, width, height, bounds, near, far }) {
	const isBackground = (offset) => materialId[offset] === 0 && materialId[offset + 1] === 0 && materialId[offset + 2] === 0;
	const sameId = (left, right) => materialId[left] === materialId[right] && materialId[left + 1] === materialId[right + 1] && materialId[left + 2] === materialId[right + 2];
	const luminance = (offset) => 0.2126 * base[offset] + 0.7152 * base[offset + 1] + 0.0722 * base[offset + 2];
	const safeFromBoundary = (x, y, offset) => {
		for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
			if (!sameId(offset, ((y + dy) * width + x + dx) * 3)) return false;
		}
		return true;
	};
	const candidates = new Uint8Array(width * height);
	let candidateCount = 0;
	let minDepth = Infinity, maxDepth = -Infinity, depthCount = 0, normalCount = 0;
	const normalSum = [0, 0, 0], normalSquareSum = [0, 0, 0];
	for (let y = bounds.min_y; y <= bounds.max_y; y++) for (let x = bounds.min_x; x <= bounds.max_x; x++) {
		const offset = (y * width + x) * 3;
		if (isBackground(offset)) continue;
		const decodedNormal = decodeNormal(normal, offset);
		for (let channel = 0; channel < 3; channel++) {
			normalSum[channel] += decodedNormal[channel];
			normalSquareSum[channel] += decodedNormal[channel] ** 2;
		}
		normalCount++;
		const interior = x >= bounds.min_x + 7 && x <= bounds.max_x - 7 && y >= bounds.min_y + 7 && y <= bounds.max_y - 7 && safeFromBoundary(x, y, offset);
		if (!interior) continue;
		const depthM = decodeDepthMetres(depth, offset, near, far);
		minDepth = Math.min(minDepth, depthM); maxDepth = Math.max(maxDepth, depthM); depthCount++;
		const at = (dx, dy) => luminance(offset + (dy * width + dx) * 3);
		const gx = -at(-1, -1) + at(1, -1) - 2 * at(-1, 0) + 2 * at(1, 0) - at(-1, 1) + at(1, 1);
		const gy = -at(-1, -1) - 2 * at(0, -1) - at(1, -1) + at(-1, 1) + 2 * at(0, 1) + at(1, 1);
		if (Math.hypot(gx, gy) <= 80) continue;
		const stepX = Math.abs(gx) >= Math.abs(gy) ? 2 : 0;
		const stepY = Math.abs(gy) >= Math.abs(gx) ? 2 : 0;
		const left = ((y - stepY) * width + x - stepX) * 3;
		const right = ((y + stepY) * width + x + stepX) * 3;
		if (!sameId(left, right)) continue;
		const depthDelta = Math.abs(decodeDepthMetres(depth, left, near, far) - decodeDepthMetres(depth, right, near, far));
		if (depthDelta >= 0.0005) continue;
		const leftNormal = decodeNormal(normal, left), rightNormal = decodeNormal(normal, right);
		const normalDot = leftNormal.reduce((sum, value, channel) => sum + value * rightNormal[channel], 0);
		if (normalDot < Math.cos(2 * Math.PI / 180)) continue;
		candidates[y * width + x] = 1;
		candidateCount++;
	}
	const visited = new Uint8Array(candidates.length);
	const segmentCounts = { connected_at_least_12px: 0, short: 0, axial: 0, diagonal: 0 };
	for (let y = bounds.min_y; y <= bounds.max_y; y++) for (let x = bounds.min_x; x <= bounds.max_x; x++) {
		const start = y * width + x;
		if (!candidates[start] || visited[start]) continue;
		const stack = [start]; visited[start] = 1;
		let size = 0, minX = x, maxX = x, minY = y, maxY = y;
		while (stack.length) {
			const index = stack.pop(), currentX = index % width, currentY = Math.floor(index / width);
			size++; minX = Math.min(minX, currentX); maxX = Math.max(maxX, currentX); minY = Math.min(minY, currentY); maxY = Math.max(maxY, currentY);
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const next = (currentY + dy) * width + currentX + dx;
				if ((dx || dy) && candidates[next] && !visited[next]) { visited[next] = 1; stack.push(next); }
			}
		}
		if (size >= 12) segmentCounts.connected_at_least_12px++;
		else segmentCounts.short++;
		const segmentWidth = maxX - minX + 1, segmentHeight = maxY - minY + 1;
		if (segmentWidth >= segmentHeight * 3 || segmentHeight >= segmentWidth * 3) segmentCounts.axial++;
		else segmentCounts.diagonal++;
	}
	const contentArea = (bounds.max_x - bounds.min_x + 1) * (bounds.max_y - bounds.min_y + 1);
	return {
		seamFraction: candidateCount / contentArea,
		segmentCounts,
		depth: { encoding: "orthographic-linear-rgb24", min_m: minDepth, max_m: maxDepth, valid_pixels: depthCount, quantization_m: (far - near) / (255 ** 3) },
		normal: {
			non_background_pixels: normalCount,
			channel_variance: normalSum.map((sum, channel) => normalSquareSum[channel] / normalCount - (sum / normalCount) ** 2),
		},
	};
}

function materialRolePixelCounts(raw, width, height) {
	const counts = { concrete: 0, glass: 0, bronze: 0, opaque: 0 };
	for (let offset = 0; offset < width * height * 3; offset += 3) {
		const red = raw[offset], green = raw[offset + 1], blue = raw[offset + 2];
		if (red > 200 && green < 80 && blue < 80) counts.concrete++;
		else if (green > 200 && red < 80 && blue < 80) counts.glass++;
		else if (blue > 200 && red < 80 && green < 80) counts.bronze++;
		else if (red > 180 && green > 180 && blue < 80) counts.opaque++;
	}
	return counts;
}

function hexLab(hex) {
	const rgb = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
		.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
	const xyz = [
		rgb[0] * 0.4124564 + rgb[1] * 0.3575761 + rgb[2] * 0.1804375,
		rgb[0] * 0.2126729 + rgb[1] * 0.7151522 + rgb[2] * 0.072175,
		rgb[0] * 0.0193339 + rgb[1] * 0.119192 + rgb[2] * 0.9503041,
	].map((value, index) => value / [0.95047, 1, 1.08883][index])
		.map((value) => value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116);
	return [116 * xyz[1] - 16, 500 * (xyz[0] - xyz[1]), 200 * (xyz[1] - xyz[2])];
}

function deltaE00(left, right) {
	const [l1, a1, b1] = left, [l2, a2, b2] = right;
	const c1 = Math.hypot(a1, b1), c2 = Math.hypot(a2, b2), cMean = (c1 + c2) / 2;
	const g = 0.5 * (1 - Math.sqrt(cMean ** 7 / (cMean ** 7 + 25 ** 7)));
	const ap1 = (1 + g) * a1, ap2 = (1 + g) * a2;
	const cp1 = Math.hypot(ap1, b1), cp2 = Math.hypot(ap2, b2);
	const hue = (a, b) => { const value = Math.atan2(b, a) * 180 / Math.PI; return value < 0 ? value + 360 : value; };
	const hp1 = hue(ap1, b1), hp2 = hue(ap2, b2);
	const dl = l2 - l1, dc = cp2 - cp1;
	const dhDegrees = cp1 * cp2 === 0 ? 0 : Math.abs(hp2 - hp1) <= 180 ? hp2 - hp1 : hp2 <= hp1 ? hp2 - hp1 + 360 : hp2 - hp1 - 360;
	const dh = 2 * Math.sqrt(cp1 * cp2) * Math.sin((dhDegrees / 2) * Math.PI / 180);
	const lMean = (l1 + l2) / 2, cpMean = (cp1 + cp2) / 2;
	const hpMean = cp1 * cp2 === 0 ? hp1 + hp2 : Math.abs(hp1 - hp2) <= 180 ? (hp1 + hp2) / 2 : hp1 + hp2 < 360 ? (hp1 + hp2 + 360) / 2 : (hp1 + hp2 - 360) / 2;
	const t = 1 - 0.17 * Math.cos((hpMean - 30) * Math.PI / 180) + 0.24 * Math.cos(2 * hpMean * Math.PI / 180)
		+ 0.32 * Math.cos((3 * hpMean + 6) * Math.PI / 180) - 0.20 * Math.cos((4 * hpMean - 63) * Math.PI / 180);
	const sl = 1 + 0.015 * (lMean - 50) ** 2 / Math.sqrt(20 + (lMean - 50) ** 2);
	const sc = 1 + 0.045 * cpMean, sh = 1 + 0.015 * cpMean * t;
	const rt = -2 * Math.sqrt(cpMean ** 7 / (cpMean ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-1 * ((hpMean - 275) / 25) ** 2) * Math.PI / 180);
	return Math.sqrt((dl / sl) ** 2 + (dc / sc) ** 2 + (dh / sh) ** 2 + rt * (dc / sc) * (dh / sh));
}

function paletteContrasts(palette) {
	const lab = Object.fromEntries(Object.entries(palette.roles).map(([role, values]) => [role, hexLab(values.elevation_fill)]));
	return {
		concrete_glass: deltaE00(lab.concrete, lab.glass),
		concrete_bronze: deltaE00(lab.concrete, lab.bronze),
		glass_bronze: deltaE00(lab.glass, lab.bronze),
		concrete_opaque: deltaE00(lab.concrete, lab.opaque),
	};
}

async function writeBrowserPng(page, mode, path, approvedRoot) {
	const dataUrl = await page.evaluate(async (renderMode) => globalThis.__ELEVATION3D_RENDER_MODE__(renderMode), mode);
	const bytes = decodeDataUrl(dataUrl);
	await atomicWrite(path, bytes, approvedRoot);
	return bytes;
}

export async function renderCompetitionElevationBase({
	runDir, glbPath, sourceMesh, camera, palette, dimensions, view, pixelsPerMetre, signal, lifecycle = {},
}) {
	assertInputs({ view, camera, palette, dimensions });
	const outputDir = join(resolve(runDir), "competition-elevation", view);
	await prepareSafeDirectory(resolve(runDir), outputDir, "competition elevation directory");
	const selectedGlbBytes = await readFile(glbPath);
	const selectedGlbSha256 = sha256(selectedGlbBytes);
	if (dimensions.selected_glb_sha256 !== selectedGlbSha256) throw new Error("selected GLB SHA-256 does not match dimensions");
	if (sourceMesh?.identity?.geometry_hash !== dimensions.geometry_hash) throw new Error("source mesh geometry hash does not match dimensions");

	const config = {
		schema_version: "arr.elevation3d.competition-viewer.v1",
		candidate_id: sourceMesh.identity?.candidate_id ?? "unknown",
		geometry_hash: dimensions.geometry_hash,
		cameras: { views: { [view]: camera } },
		strategies: { hunyuan: { glb: "selected.glb" } },
		competition_elevation: {
			view,
			output_size: OUTPUT_SIZE,
			margin_ratio: 0.09,
			pixels_per_metre: pixelsPerMetre,
			background: "#fafaf7",
			palette: { preset: palette.preset, sha256: palette.sha256, roles: palette.roles },
			projected_bounds_m: dimensions.projected_bounds_m,
			line_pass: { internal_triangle_edges: false, per_primitive_edges: false, depth_silhouette: true },
		},
	};
	const viewerConfigSha256 = sha256(stableJson(config));
	await buildViewerBundle({ runDir, config });
	await atomicCopy(glbPath, join(resolve(runDir), "viewer", "selected.glb"), resolve(runDir));

	const start = lifecycle.startPreview ?? startPreview;
	const stop = lifecycle.stopPreview ?? stopPreview;
	const launch = lifecycle.launchBrowser ?? (async () => puppeteer.launch({
		executablePath: await findChrome(),
		headless: true,
		args: ["--disable-gpu-sandbox", "--no-sandbox", "--use-angle=swiftshader"],
	}));
	let browser;
	let page;
	let previewPort;
	const pageErrors = [];
	try {
		signal?.throwIfAborted();
		const base = await start(runDir, 0);
		previewPort = Number(new URL(base).port);
		signal?.throwIfAborted();
		browser = await launch();
		page = await browser.newPage();
		page.on?.("pageerror", (error) => pageErrors.push(error.message));
		await page.setViewport({ width: OUTPUT_SIZE, height: OUTPUT_SIZE, deviceScaleFactor: 1 });
		await page.goto(`${base}?strategy=hunyuan&view=${encodeURIComponent(view)}&mode=competition-elevation`, { waitUntil: "networkidle0" });
		await page.waitForFunction(() => globalThis.__ELEVATION3D_READY__ === true, { timeout: 60_000 });
		signal?.throwIfAborted();
		if (pageErrors.length) throw new Error(`competition viewer failed: ${pageErrors.join("; ")}`);

		const path = join(outputDir, `${view}-base.png`);
		const diagnosticPaths = {
			material_id: join(outputDir, `${view}-material-id.png`),
			depth: join(outputDir, `${view}-depth.png`),
			normal: join(outputDir, `${view}-normal.png`),
		};
		const bytes = await writeBrowserPng(page, "base", path, outputDir);
		const materialIdBytes = await writeBrowserPng(page, "material-id", diagnosticPaths.material_id, outputDir);
		const depthBytes = await writeBrowserPng(page, "depth", diagnosticPaths.depth, outputDir);
		const normalBytes = await writeBrowserPng(page, "normal", diagnosticPaths.normal, outputDir);
		signal?.throwIfAborted();
		const browserArtifact = await page.evaluate(() => globalThis.__ELEVATION3D_ARTIFACT__);
		const decoded = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
		if (decoded.info.width !== OUTPUT_SIZE || decoded.info.height !== OUTPUT_SIZE) throw new Error("competition elevation PNG size invalid");
		const measured = contentBounds(decoded.data, decoded.info.width, decoded.info.height);
		const edges = edgeMetrics(decoded.data, decoded.info.width, decoded.info.height);
		const materialId = await sharp(materialIdBytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
		const depth = await sharp(depthBytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
		const normal = await sharp(normalBytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
		const diagnostic = diagnosticMetrics({
			base: decoded.data,
			materialId: materialId.data,
			depth: depth.data,
			normal: normal.data,
			width: decoded.info.width,
			height: decoded.info.height,
			bounds: measured.bounds,
			near: browserArtifact.depth_encoding.near_m,
			far: browserArtifact.depth_encoding.far_m,
		});
		const rolePixelCounts = materialRolePixelCounts(materialId.data, materialId.info.width, materialId.info.height);
		const artifact = {
			schema_version: "arr.elevation3d.base-elevation-artifact.v1",
			path,
			sha256: sha256(bytes),
			width: decoded.info.width,
			height: decoded.info.height,
			camera: browserArtifact.camera,
			projected_bounds_m: browserArtifact.projected_bounds_m,
			exact_mass_projected_bounds_m: {
				min: dimensions.projected_bounds_m.min,
				max: dimensions.projected_bounds_m.max,
			},
			clipping: { applied: false },
			content_bounds_px: measured.bounds,
			annotation_lanes: browserArtifact.annotation_lanes,
			palette_sha256: palette.sha256,
			selected_glb_sha256: selectedGlbSha256,
			viewer_config_sha256: viewerConfigSha256,
			material_roles: browserArtifact.material_roles,
			typed_facade: browserArtifact.typed_facade === true,
			line_pass: config.competition_elevation.line_pass,
			diagnostic_paths: diagnosticPaths,
			diagnostics: {
				background_fraction: 1 - measured.foregroundFraction,
				dark_pixel_fraction: measured.darkFraction,
				...edges,
				same_material_seam_fraction: diagnostic.seamFraction,
				seam_diagnostics_source: "base+material-id+metric-depth+view-normal",
				seam_segments: diagnostic.segmentCounts,
				depth: diagnostic.depth,
				normal: diagnostic.normal,
				role_pixel_counts: rolePixelCounts,
				palette_delta_e00: paletteContrasts(palette),
			},
		};
		const manifestPath = join(outputDir, `${view}-base-render-manifest.json`);
		await atomicWrite(manifestPath, Buffer.from(JSON.stringify(artifact, null, 2)), outputDir);
		artifact.manifest_path = manifestPath;
		return artifact;
	} finally {
		try { if (page) await page.close(); }
		finally {
			try { if (browser) await browser.close(); }
			finally { if (previewPort) await stop(previewPort); }
		}
	}
}

function semanticRole(raw, offset) {
	const red = raw[offset], green = raw[offset + 1], blue = raw[offset + 2];
	if (red < 80 && green < 80 && blue > 200) return "bronze";
	if (red > 180 && green > 180 && blue < 80) return "opaque";
	if (red > 200 && green < 80 && blue < 80) return "concrete";
	if (green > 200 && red < 80 && blue < 80) return "glass";
	return undefined;
}

async function classifyAndCleanDarkArtifacts(base) {
	const [baseImage, materialImage, depthImage] = await Promise.all([
		sharp(base.path).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
		sharp(base.diagnostic_paths.material_id).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
		sharp(base.diagnostic_paths.depth).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
	]);
	const { width, height } = baseImage.info;
	const pixels = Buffer.from(baseImage.data);
	const mask = new Uint8Array(width * height);
	const visited = new Uint8Array(mask.length);
	const bounds = base.content_bounds_px;
	for (let y = bounds.min_y; y <= bounds.max_y; y++) for (let x = bounds.min_x; x <= bounds.max_x; x++) {
		const offset = (y * width + x) * 3;
		const luminance = 0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2];
		if (luminance < 50) mask[y * width + x] = 1;
	}
	const invalidTinyPixels = [];
	let validPixels = 0, rejectedPixels = 0, validComponents = 0, suppressedComponents = 0;
	const componentEvidence = [];
	for (let y = bounds.min_y; y <= bounds.max_y; y++) for (let x = bounds.min_x; x <= bounds.max_x; x++) {
		const start = y * width + x;
		if (!mask[start] || visited[start]) continue;
		const stack = [start], component = [];
		visited[start] = 1;
		let minX = x, maxX = x, minY = y, maxY = y, semantic = 0, authored = 0, depthValid = 0;
		while (stack.length) {
			const index = stack.pop(), px = index % width, py = Math.floor(index / width), offset = index * 3;
			component.push(index); minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
			const role = semanticRole(materialImage.data, offset);
			if (role) semantic++;
			if (role === "bronze" || role === "opaque") authored++;
			if (!(depthImage.data[offset] === 255 && depthImage.data[offset + 1] === 255 && depthImage.data[offset + 2] === 255)) depthValid++;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const nx = px + dx, ny = py + dy;
				if (nx < bounds.min_x || nx > bounds.max_x || ny < bounds.min_y || ny > bounds.max_y || (!dx && !dy)) continue;
				const next = ny * width + nx;
				if (mask[next] && !visited[next]) { visited[next] = 1; stack.push(next); }
			}
		}
		const narrowDetail = component.length <= 300 && maxX - minX + 1 <= 12 && maxY - minY + 1 <= 50;
		if (!narrowDetail) continue;
		if ((semantic > 0 && authored / semantic >= 0.7 && depthValid >= authored) || depthValid === component.length) {
			validPixels += component.length; validComponents++;
			componentEvidence.push({ bbox_px: [minX, minY, maxX, maxY], pixels: component.length, bronze_or_opaque_pixels: authored, finite_depth_pixels: depthValid, classification: authored > 0 ? "semantic-bronze-opaque" : "selected-glb-depth-silhouette" });
		} else if (component.length <= 16 && semantic === 0 && depthValid === 0) {
			invalidTinyPixels.push(...component); suppressedComponents++;
		} else rejectedPixels += component.length;
	}
	const background = [pixels[0], pixels[1], pixels[2]];
	for (const index of invalidTinyPixels) {
		const offset = index * 3;
		pixels[offset] = background[0]; pixels[offset + 1] = background[1]; pixels[offset + 2] = background[2];
	}
	return {
		pixels,
		info: baseImage.info,
		report: {
			classification: "connected dark details with bronze/opaque material-ID or complete selected-GLB depth are authored geometry",
			valid_pixels: validPixels,
			valid_components: validComponents,
			invalid_pixels: rejectedPixels,
			suppressed_screen_artifact_pixels: invalidTinyPixels.length,
			suppressed_screen_artifact_components: suppressedComponents,
			component_evidence: componentEvidence,
			geometry_clipped: false,
			selected_glb_altered: false,
		},
	};
}

export async function renderCompetitionElevation({
	runDir, glbPath, sourceMesh, floorGuides, facadePlanes, facadeSegmentAuthority, facadeValidation, facadeValidationReceipt, designFacadeManifest, camera, palette, dimensions, view, candidateId, pixelsPerMetre, signal, lifecycle,
}) {
	const base = await renderCompetitionElevationBase({ runDir, glbPath, sourceMesh, camera, palette, dimensions, view, pixelsPerMetre, signal, lifecycle });
	const outputDir = join(resolve(runDir), "competition-elevation", view);
	const annotation = buildElevationAnnotations({ dimensions, camera: base.camera, contentBounds: base.content_bounds_px, canvas: [base.width, base.height], candidateId });
	const dimensionsPath = join(outputDir, `${view}-dimensions.json`);
	const svgPath = join(outputDir, `${view}-annotations.svg`);
	await atomicWrite(dimensionsPath, Buffer.from(JSON.stringify(dimensions, null, 2)), outputDir);
	await atomicWrite(svgPath, Buffer.from(annotation.svg), outputDir);
	const dimensionsRecord = { path: dimensionsPath, sha256: sha256(await readFile(dimensionsPath)) };
	const svgRecord = { path: svgPath, sha256: sha256(await readFile(svgPath)) };
	const presentationBase = await classifyAndCleanDarkArtifacts(base);
	const presentationBasePath = join(outputDir, `${view}-presentation-base.png`);
	const presentationBaseBytes = await sharp(presentationBase.pixels, { raw: presentationBase.info }).png().toBuffer();
	await atomicWrite(presentationBasePath, presentationBaseBytes, outputDir);
	const presentationBaseRecord = { path: presentationBasePath, sha256: sha256(presentationBaseBytes) };
	const finalPath = join(outputDir, `${view}.png`);
	const finalBytes = await sharp(presentationBaseBytes)
		.composite([{ input: Buffer.from(annotation.svg), blend: "over" }])
		.png()
		.toBuffer();
	await atomicWrite(finalPath, finalBytes, outputDir);
	const finalRecord = { path: finalPath, sha256: sha256(finalBytes) };
	const displayedDimensions = {
		overall_width: dimensions.overall_width.display_mm,
		overall_height: dimensions.overall_height.display_mm,
		levels: dimensions.levels.map((item) => item.display_mm),
		floor_intervals: dimensions.floor_intervals.map((item) => item.display_mm),
		facade_width: dimensions.facade_extent.width.display_mm,
		facade_height: dimensions.facade_extent.height.display_mm,
		scale_bar: dimensions.scale_bar.display_mm,
	};
	const renderManifestPath = join(outputDir, `${view}-render-manifest.json`);
	const baseManifestRecord = { path: base.manifest_path, sha256: sha256(await readFile(base.manifest_path)) };
	const diagnosticRecords = Object.fromEntries(await Promise.all(Object.entries(base.diagnostic_paths).map(async ([name, path]) => [name, { path, sha256: sha256(await readFile(path)) }])));
	const renderManifest = {
		schema_version: "arr.elevation3d.competition-elevation.v1",
		view,
		candidate_id: candidateId ?? sourceMesh.identity?.candidate_id,
		palette: { preset: palette.preset, sha256: palette.sha256 },
		selected_glb_sha256: base.selected_glb_sha256,
		viewer_config_sha256: base.viewer_config_sha256,
		geometry_hash: dimensions.geometry_hash,
		camera: base.camera,
		content_bounds_px: base.content_bounds_px,
		displayed_dimensions: displayedDimensions,
		provenance: {
			base_png_sha256: base.sha256,
			base_manifest_sha256: baseManifestRecord.sha256,
			presentation_base_png_sha256: presentationBaseRecord.sha256,
			diagnostic_sha256: Object.fromEntries(Object.entries(diagnosticRecords).map(([name, record]) => [name, record.sha256])),
			annotations_svg_sha256: svgRecord.sha256,
			dimensions_json_sha256: dimensionsRecord.sha256,
			final_png_sha256: finalRecord.sha256,
			palette_sha256: palette.sha256,
		},
		presentation: { authored_dark_geometry: presentationBase.report },
	};
	await atomicWrite(renderManifestPath, Buffer.from(JSON.stringify(renderManifest, null, 2)), outputDir);
	const manifestRecord = { path: renderManifestPath, sha256: sha256(await readFile(renderManifestPath)) };
	const draft = {
		base,
		palette: { preset: palette.preset, sha256: palette.sha256 },
		base_manifest: baseManifestRecord,
		presentation_base_png: presentationBaseRecord,
		diagnostics: diagnosticRecords,
		dimensions,
		annotation,
		final_png: finalRecord,
		annotations_svg: svgRecord,
		dimensions_json: dimensionsRecord,
		render_manifest: manifestRecord,
		displayed_dimensions: displayedDimensions,
		presentation: { authored_dark_geometry: presentationBase.report },
	};
	const validation = await validateCompetitionElevation({
		artifacts: draft, sourceMesh, facadePlanes, facadeSegmentAuthority, facadeValidation, facadeValidationReceipt, designFacadeManifest,
		floorGuides, view: camera, selectedGlbPath: glbPath,
	});
	const validationPath = join(outputDir, `${view}-validation.json`);
	await atomicWrite(validationPath, Buffer.from(JSON.stringify(validation, null, 2)), outputDir);
	return {
		schema_version: "arr.elevation3d.elevation-artifacts.v1",
		...draft,
		validation,
		validation_report: { path: validationPath, sha256: sha256(await readFile(validationPath)) },
	};
}
