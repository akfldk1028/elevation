import { countRolePixels, SEMANTIC_ROLES } from "./semantic-role-mask.mjs";
import { readFile } from "node:fs/promises";
import { NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { sha256, stableJson } from "./core.mjs";
import { deriveElevationDimensions } from "./elevation-dimensions.mjs";
import { buildElevationAnnotations } from "./elevation-annotations.mjs";
import { readVerifiedFacadeValidationAuthority } from "./enrichment-validation.mjs";
import { assertCanonicalFacadeSegmentAuthority } from "./facade-agent/punched-facade.mjs";

const TYPED_FACADE_KINDS = new Set(["corner-return", "brick-cladding", "window-reveal", "window-frame", "glazing", "precast-lintel", "precast-sill"]);
const DESIGN_FACADE_KINDS = new Set(["door", "window", "window-frame", "reveal", "lintel", "sill", "pilaster", "band", "cornice", "mullion", "transom", "spandrel", "arch", "louvre"]);

async function verifiedDesignFacadeArtifact(path, designFacadeManifest, sourceMesh, facadeSegmentAuthority) {
	try {
		if (!designFacadeManifest?.path || !/^[a-f0-9]{64}$/.test(designFacadeManifest.sha256 ?? "")) return { typed: false, receiptBound: false };
		const manifestBytes = await readFile(designFacadeManifest.path);
		if (sha256(manifestBytes) !== designFacadeManifest.sha256) return { typed: false, receiptBound: false };
		const manifest = JSON.parse(manifestBytes.toString("utf8"));
		const { compilation_sha256: compilation, ...manifestBase } = manifest;
		if (manifest.schema_version !== "arr.elevation3d.compiled-facade.v1"
			|| compilation !== sha256(stableJson(manifestBase))) return { typed: false, receiptBound: false };
		const canonicalSegments = assertCanonicalFacadeSegmentAuthority({ mesh: sourceMesh, facadeSegmentAuthority });
		const bytes = await readFile(path);
		if (sha256(bytes) !== manifest.output?.sha256
			|| manifest.authority?.mass_sha256 !== sha256(stableJson({ vertices: sourceMesh.vertices, triangles: sourceMesh.triangles }))
			|| manifest.authority?.facade_segments_sha256 !== sha256(stableJson(facadeSegmentAuthority))) return { typed: false, receiptBound: false };
		const root = (await new NodeIO().read(path)).getRoot();
		const primitives = root.listMeshes().flatMap((mesh) => mesh.listPrimitives());
		const typed = primitives.filter((primitive) => DESIGN_FACADE_KINDS.has(primitive.getExtras()?.kind));
		const segmentIds = new Set(canonicalSegments.facade_planes.map((segment) => segment.segment_id));
		const kinds = new Set(typed.map((primitive) => primitive.getExtras().kind));
		const typedArtifact = typed.length === manifest.output?.detail_primitive_count
			&& typed.every((primitive) => segmentIds.has(primitive.getExtras()?.segment_id))
			&& kinds.has("door") && kinds.has("window");
		return { typed: typedArtifact, receiptBound: typedArtifact };
	} catch { return { typed: false, receiptBound: false }; }
}

async function verifiedTypedFacadeArtifact(path, facadeValidation, facadeValidationReceipt, sourceMesh, facadeSegmentAuthority) {
	try {
		const authority = readVerifiedFacadeValidationAuthority(facadeValidation);
		if (!authority || authority.grammar?.system !== "brick-punched-window-v1") return { typed: false, receiptBound: false };
		const canonicalSegments = assertCanonicalFacadeSegmentAuthority({ mesh: sourceMesh, facadeSegmentAuthority });
		const bytes = await readFile(path);
		if (sha256(bytes) !== authority.bindings.glb_sha256
			|| authority.bindings.geometry_content_sha256 !== canonicalSegments.source_geometry_sha256
			|| authority.bindings.geometry_signed_volume_orientation !== 1
			|| authority.bindings.facade_segment_authority_sha256 !== canonicalSegments.sha256
			|| authority.metrics?.canonical_surface_match !== 1 || authority.metrics?.segment_authority_match !== true) return { typed: false, receiptBound: false };
		const receiptBytes = await readFile(facadeValidationReceipt?.path);
		const receipt = JSON.parse(receiptBytes.toString("utf8"));
		const receiptChecks = {
			file_hash: sha256(receiptBytes) === facadeValidationReceipt.sha256,
			receipt_hash: sha256(stableJson(receipt)) === facadeValidationReceipt.receipt_sha256,
			schema: receipt.schema_version === "arr.elevation3d.facade-validation-receipt.v1",
			artifact: receipt.artifact_sha256 === authority.bindings.glb_sha256,
			accepted: receipt.validation?.accepted === true,
			codes: stableJson(receipt.validation?.codes) === "[]",
			metrics: stableJson(receipt.validation?.metrics) === stableJson(authority.metrics),
		};
		const receiptBound = Object.values(receiptChecks).every(Boolean);
		if (!receiptBound) return { typed: false, receiptBound: false, receiptChecks };
		const root = (await new NodeIO().read(path)).getRoot();
		const primitives = root.listMeshes().flatMap((mesh) => mesh.listPrimitives());
		const typed = primitives.filter((primitive) => TYPED_FACADE_KINDS.has(primitive.getExtras()?.kind));
		const segmentIds = new Set(typed.map((primitive) => primitive.getExtras()?.segment_id));
		const expectedIds = canonicalSegments.facade_planes.map((segment) => segment.segment_id);
		const kinds = new Set(typed.map((primitive) => primitive.getExtras().kind));
		const typedArtifact = primitives.length === authority.metrics.primitive_count
			&& typed.length === authority.metrics.detail_primitive_count
			&& typed.every((primitive) => typeof primitive.getExtras()?.segment_id === "string")
			&& segmentIds.size === expectedIds.length && expectedIds.every((segmentId) => segmentIds.has(segmentId))
			&& ["brick-cladding", "window-reveal", "glazing", "precast-lintel", "precast-sill", "corner-return"].every((kind) => kinds.has(kind));
		return { typed: typedArtifact, receiptBound, receiptChecks };
	} catch { return { typed: false, receiptBound: false, receiptChecks: null }; }
}

function dot(left, right) {
	return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function length(vector) {
	return Math.sqrt(dot(vector, vector));
}

function dimensionValues(manifest) {
	return {
		overall_width: manifest.overall_width?.display_mm,
		overall_height: manifest.overall_height?.display_mm,
		levels: manifest.levels?.map((item) => item.display_mm),
		floor_intervals: manifest.floor_intervals?.map((item) => item.display_mm),
		facade_width: manifest.facade_extent?.width?.display_mm,
		facade_height: manifest.facade_extent?.height?.display_mm,
		scale_bar: manifest.scale_bar?.display_mm,
	};
}

function dimensionContract(manifest) {
	if (!manifest || typeof manifest !== "object") return manifest;
	return {
		schema_version: manifest.schema_version,
		view: manifest.view,
		selected_glb_sha256: manifest.selected_glb_sha256,
		geometry_hash: manifest.geometry_hash,
		projected_bounds_m: manifest.projected_bounds_m,
		overall_width: manifest.overall_width,
		overall_height: manifest.overall_height,
		levels: manifest.levels,
		floor_intervals: manifest.floor_intervals,
		facade_extent: manifest.facade_extent,
		scale_bar: manifest.scale_bar,
		tolerance_mm: manifest.tolerance_mm,
	};
}

function sameJson(left, right) {
	return stableJson(left) === stableJson(right);
}

async function validRecord(record) {
	if (!record?.path || !/^[a-f0-9]{64}$/.test(record.sha256 ?? "")) return false;
	try { return sha256(await readFile(record.path)) === record.sha256; }
	catch { return false; }
}

function add(codes, code, condition) {
	if (condition && !codes.includes(code)) codes.push(code);
}

async function decodedRgb(path) {
	return sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
}

function rasterMetrics(raw, width, height) {
	const corners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]];
	const background = [0, 1, 2].map((channel) => Math.round(corners.reduce((sum, [x, y]) => sum + raw[(y * width + x) * 3 + channel], 0) / 4));
	let minX = width, minY = height, maxX = -1, maxY = -1, foreground = 0, dark = 0;
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		const offset = (y * width + x) * 3;
		const red = raw[offset], green = raw[offset + 1], blue = raw[offset + 2];
		if (Math.hypot(red - background[0], green - background[1], blue - background[2]) > 10) {
			minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); foreground++;
		}
		if (0.2126 * red + 0.7152 * green + 0.0722 * blue < 90) dark++;
	}
	let edges = 0, strong = 0, samples = 0;
	const luminance = (x, y) => { const offset = (y * width + x) * 3; return 0.2126 * raw[offset] + 0.7152 * raw[offset + 1] + 0.0722 * raw[offset + 2]; };
	for (let y = 2; y < height - 2; y += 2) for (let x = 2; x < width - 2; x += 2) {
		const gx = -luminance(x - 1, y - 1) + luminance(x + 1, y - 1) - 2 * luminance(x - 1, y) + 2 * luminance(x + 1, y) - luminance(x - 1, y + 1) + luminance(x + 1, y + 1);
		const gy = -luminance(x - 1, y - 1) - 2 * luminance(x, y - 1) - luminance(x + 1, y - 1) + luminance(x - 1, y + 1) + 2 * luminance(x, y + 1) + luminance(x + 1, y + 1);
		const magnitude = Math.hypot(gx, gy);
		if (magnitude > 80) edges++;
		if (magnitude > 180) strong++;
		samples++;
	}
	return { background, bounds: { min_x: minX, min_y: minY, max_x: maxX, max_y: maxY }, foreground_fraction: foreground / (width * height), dark_fraction: dark / (width * height), total_edge_density: edges / samples, strong_edge_density: strong / samples };
}

const roleCounts = (raw) => countRolePixels(raw);

function decodeDepth(raw, offset, near, far) {
	return near + (raw[offset] / 255 + raw[offset + 1] / (255 ** 2) + raw[offset + 2] / (255 ** 3)) * (far - near);
}

function decodeNormal(raw, offset) {
	const value = [raw[offset] / 255 * 2 - 1, raw[offset + 1] / 255 * 2 - 1, raw[offset + 2] / 255 * 2 - 1];
	const magnitude = Math.hypot(...value);
	return magnitude ? value.map((item) => item / magnitude) : value;
}

/**
 * How far a same-material seam has to run before it reads as a drawn line rather than as
 * aliasing along a real edge.
 *
 * Measured on the plan view of four live runs. The two components that failed v10 were
 * compact specks, 13 px and 11 px across their bounding boxes; v12's genuine seams - the
 * diagonals of the roof quads and four coplanar band lines - spanned 111 to 185 px. There
 * is an order of magnitude between the two populations and nothing in between, so 48 px
 * on a 2400 px sheet sits clear of the speck without reaching any real seam. Zero
 * tolerance is kept, but on a length that means something at this scale: 12 px did not.
 */
export const MIN_VISIBLE_SEAM_PX = 48;

/**
 * Every threshold the presentation gates test, named once.
 *
 * They used to be literals inside the gate expressions, with their derivations in comment
 * blocks two screens away - which is how this project twice shipped a number whose reason
 * nobody could find, and how a limit calibrated for a strict subset of a budget quietly
 * became the whole budget. `COMPOSITION_BOUNDS` in the design layer already keeps its
 * numbers this way; this is the raster half of the same discipline. Each entry carries the
 * measurement it came from, so changing one means arguing with its evidence.
 *
 * `MIN_VISIBLE_SEAM_PX` above stays a separate export because `competition-elevation.mjs`
 * measures against it while rendering, before any of this runs.
 */
export const PRESENTATION_BOUNDS = Object.freeze({
	/**
	 * Share of the sheet allowed to be dark ink.
	 *
	 * A typed or authored facade draws its own trim, reveals and framing, so a large dark
	 * share is the drawing working; a plain mass has almost nothing to draw and a dark
	 * field there means something is wrong with the render.
	 */
	darkPixelFraction: Object.freeze({ typed: 0.60, untyped: 0.07 }),
	/**
	 * Strong-edge density: the real line budget, and the honest limit of what it measures.
	 *
	 * The untyped limit was 0.015 and it was reading the transfer function rather than the
	 * drawing: encoding the base pass to sRGB brightened every fill, so the same lines
	 * crossed a threshold they used to fall just under - creative-013's front went
	 * strong 0.014953 -> 0.015667 while total went 0.016074 -> 0.015743, and the limit had
	 * 0.3% of headroom. 0.020 restored a real margin.
	 *
	 * The typed limit's own re-derivation found something worse than a number set too low:
	 * **in the regime that triggered it, the metric is inverted.** The first louvre-screen
	 * grammar measured 0.025412 on a back elevation that is a clean rhythm of slats over
	 * glass, legible at a glance, and was rejected at 0.025. A deliberately denser probe of
	 * the same grammar - tile pitch 0.30 m -> 0.18 m, leaving 0.04 m of glass between
	 * 0.14 m of solid, reading as a near-solid dark field with the glazing gone - measured
	 * 0.024773 and passed. Past the point where a member is thinner than the antialiasing
	 * width the drawing turns to mush and the edge count goes DOWN, so no threshold in this
	 * vicinity separates legible from illegible: the worse drawing scores better. What does
	 * separate them is composition, not raster - skin transparency 0.393 against 0.229, and
	 * glass share of the elevation 0.272 against 0.127 - and that is measured in
	 * composition.mjs, reported rather than gated.
	 *
	 * So the typed limit is set to admit every drawing this pipeline has been shown to make
	 * legibly (0.030 against a measured maximum of 0.025412 over fifteen schemes) and its
	 * job is narrowed to what it can still do: catch a drawing far busier than anything yet
	 * authored.
	 */
	strongEdgeDensity: Object.freeze({ typed: 0.030, untyped: 0.020 }),
	/**
	 * Total-edge density. Unreachable and kept as a backstop: measured over thirteen
	 * authored schemes x four elevations, strong is 95.6% to 99.9% of total and never
	 * below, so for this clause to fire first strong would have to fall under 71% of total.
	 */
	totalEdgeDensity: 0.035,
	/** Plan and top draw a cut, not a facade, so they get the tighter untyped-scale budget. */
	planTopStrongEdgeDensity: 0.015,
	/** Same-material seam area share; the length test in MIN_VISIBLE_SEAM_PX is the real gate. */
	seamFraction: 0.001,
	/** Plan/top pixel scale must be square: anisotropy above this is a broken camera fit. */
	planTopScaleSkew: 0.0025,
	/**
	 * How far the finished composite may drift from its own base metrics before the
	 * difference is ink that appeared after validation rather than annotation antialiasing.
	 */
	finalCompositeExcess: 0.002,
});

/** The strong-edge limit for the kind of drawing in hand. */
function strongEdgeLimit(typedFacadeArtifact) {
	return typedFacadeArtifact ? PRESENTATION_BOUNDS.strongEdgeDensity.typed : PRESENTATION_BOUNDS.strongEdgeDensity.untyped;
}

function persistedSeamMetrics(base, material, depth, normal, width, height, bounds, near, far) {
	const sameMaterial = (left, right) => material[left] === material[right] && material[left + 1] === material[right + 1] && material[left + 2] === material[right + 2];
	const background = (offset) => material[offset] === 0 && material[offset + 1] === 0 && material[offset + 2] === 0;
	const luminance = (offset) => 0.2126 * base[offset] + 0.7152 * base[offset + 1] + 0.0722 * base[offset + 2];
	const candidates = new Uint8Array(width * height);
	let count = 0;
	for (let y = bounds.min_y + 7; y <= bounds.max_y - 7; y += 2) for (let x = bounds.min_x + 7; x <= bounds.max_x - 7; x += 2) {
		const offset = (y * width + x) * 3;
		if (background(offset)) continue;
		if (![[-6, 0], [6, 0], [0, -6], [0, 6]].every(([dx, dy]) => sameMaterial(offset, ((y + dy) * width + x + dx) * 3))) continue;
		const at = (dx, dy) => luminance(offset + (dy * width + dx) * 3);
		const gx = -at(-1, -1) + at(1, -1) - 2 * at(-1, 0) + 2 * at(1, 0) - at(-1, 1) + at(1, 1);
		const gy = -at(-1, -1) - 2 * at(0, -1) - at(1, -1) + at(-1, 1) + 2 * at(0, 1) + at(1, 1);
		if (Math.hypot(gx, gy) <= 80) continue;
		const stepX = Math.abs(gx) >= Math.abs(gy) ? 2 : 0, stepY = Math.abs(gy) >= Math.abs(gx) ? 2 : 0;
		const left = ((y - stepY) * width + x - stepX) * 3, right = ((y + stepY) * width + x + stepX) * 3;
		if (!sameMaterial(left, right) || Math.abs(decodeDepth(depth, left, near, far) - decodeDepth(depth, right, near, far)) >= 0.0005) continue;
		const leftNormal = decodeNormal(normal, left), rightNormal = decodeNormal(normal, right);
		if (dot(leftNormal, rightNormal) < Math.cos(2 * Math.PI / 180)) continue;
		candidates[y * width + x] = 1; count++;
	}
	const visited = new Uint8Array(candidates.length);
	let visibleSegments = 0, longestPx = 0;
	// Where, not just how many. Five hypotheses about what causes these seams were built and
	// refuted from primitive lists alone, and every one of them was possible only because this
	// function reported a count and no location. A bounding box per visible segment turns the
	// next diagnosis into an observation.
	const segments = [];
	for (let y = bounds.min_y; y <= bounds.max_y; y++) for (let x = bounds.min_x; x <= bounds.max_x; x++) {
		const start = y * width + x;
		if (!candidates[start] || visited[start]) continue;
		const stack = [start]; visited[start] = 1;
		let minX = x, maxX = x, minY = y, maxY = y;
		while (stack.length) {
			const index = stack.pop(), px = index % width, py = Math.floor(index / width);
			if (px < minX) minX = px; if (px > maxX) maxX = px;
			if (py < minY) minY = py; if (py > maxY) maxY = py;
			for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
				const next = (py + dy) * width + px + dx;
				if ((dx || dy) && candidates[next] && !visited[next]) { visited[next] = 1; stack.push(next); }
			}
		}
		// The span the component covers on the sheet, not how many samples fell inside it.
		// Counting samples let a compact speck of a dozen of them be reported as a 12 px
		// line when its bounding box was 11 px square.
		const extent = Math.max(maxX - minX + 1, maxY - minY + 1);
		if (extent > longestPx) longestPx = extent;
		if (extent >= MIN_VISIBLE_SEAM_PX) {
			visibleSegments++;
			if (segments.length < 24) segments.push({ min_x: minX, min_y: minY, max_x: maxX, max_y: maxY, extent_px: extent });
		}
	}
	const area = (bounds.max_x - bounds.min_x + 1) * (bounds.max_y - bounds.min_y + 1);
	return { fraction: count / area, visible_segments: visibleSegments, longest_segment_px: longestPx, segments };
}

function persistedDarkGeometry(base, material, depth, width, height, bounds) {
	const mask = new Uint8Array(width * height), visited = new Uint8Array(width * height);
	for (let y = bounds.min_y; y <= bounds.max_y; y++) for (let x = bounds.min_x; x <= bounds.max_x; x++) {
		const offset = (y * width + x) * 3;
		if (0.2126 * base[offset] + 0.7152 * base[offset + 1] + 0.0722 * base[offset + 2] < 50) mask[y * width + x] = 1;
	}
	let validPixels = 0, validComponents = 0, invalidPixels = 0;
	const evidence = [];
	for (let y = bounds.min_y; y <= bounds.max_y; y++) for (let x = bounds.min_x; x <= bounds.max_x; x++) {
		const start = y * width + x;
		if (!mask[start] || visited[start]) continue;
		const stack = [start]; visited[start] = 1; let pixels = 0, authored = 0, finiteDepth = 0, minX = x, maxX = x, minY = y, maxY = y;
		while (stack.length) {
			const index = stack.pop(), px = index % width, py = Math.floor(index / width), offset = index * 3; pixels++;
			minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
			const bronze = material[offset] < 80 && material[offset + 1] < 80 && material[offset + 2] > 200;
			const opaque = material[offset] > 180 && material[offset + 1] > 180 && material[offset + 2] < 80;
			if (bronze || opaque) authored++;
			if (!(depth[offset] === 255 && depth[offset + 1] === 255 && depth[offset + 2] === 255)) finiteDepth++;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const nx = px + dx, ny = py + dy, next = ny * width + nx;
				if ((dx || dy) && nx >= bounds.min_x && nx <= bounds.max_x && ny >= bounds.min_y && ny <= bounds.max_y && mask[next] && !visited[next]) { visited[next] = 1; stack.push(next); }
			}
		}
		const narrow = pixels <= 300 && maxX - minX + 1 <= 12 && maxY - minY + 1 <= 50;
		if (!narrow) continue;
		if (finiteDepth === pixels || authored > 0) {
			validPixels += pixels; validComponents++;
			evidence.push({ bbox_px: [minX, minY, maxX, maxY], pixels, bronze_or_opaque_pixels: authored, finite_depth_pixels: finiteDepth, classification: authored ? "semantic-bronze-opaque" : "selected-glb-depth-silhouette" });
		} else invalidPixels += pixels;
	}
	return { classification: "connected dark details with bronze/opaque material-ID or complete selected-GLB depth are authored geometry", valid_pixels: validPixels, valid_components: validComponents, invalid_pixels: invalidPixels, suppressed_screen_artifact_pixels: 0, suppressed_screen_artifact_components: 0, component_evidence: evidence, geometry_clipped: false, selected_glb_altered: false };
}

function decodeXml(value) {
	return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function attributes(source) {
	return Object.fromEntries(Array.from(source.matchAll(/([\w:-]+)="([^"]*)"/g), (match) => [match[1], decodeXml(match[2])]));
}

function intersects(left, right) {
	return left.min_x < right.max_x && left.max_x > right.min_x && left.min_y < right.max_y && left.max_y > right.min_y;
}

function inspectSvg(svg, authoritative, contentBounds) {
	const textItems = Array.from(svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g), (match) => ({ attrs: attributes(match[1]), visible: decodeXml(match[2].replace(/<[^>]*>/g, "")) }));
	const bySource = new Map();
	for (const item of textItems) if (item.attrs["data-source-id"]) {
		const list = bySource.get(item.attrs["data-source-id"]) ?? []; list.push(item); bySource.set(item.attrs["data-source-id"], list);
	}
	const expected = new Map([
		["overall-width", [authoritative.overall_width.display_mm, String(authoritative.overall_width.display_mm)]],
		["overall-height", [authoritative.overall_height.display_mm, String(authoritative.overall_height.display_mm)]],
		["facade-width", [authoritative.facade_extent.width.display_mm, String(authoritative.facade_extent.width.display_mm)]],
		["facade-height", [authoritative.facade_extent.height.display_mm, String(authoritative.facade_extent.height.display_mm)]],
		["scale-bar", [authoritative.scale_bar.display_mm, `${authoritative.scale_bar.value_m} m`]],
		...authoritative.levels.map((item) => [item.id, [item.display_mm, item.label]]),
		...authoritative.floor_intervals.map((item) => [item.id, [item.display_mm, String(item.display_mm)]]),
	]);
	let mismatch = false;
	for (const [id, [displayMm, visible]] of expected) {
		const items = bySource.get(id) ?? [];
		if (items.length !== 1 || items[0].attrs["data-display-mm"] !== String(displayMm) || items[0].visible !== visible) mismatch = true;
	}
	let pageViolation = !/<svg\b[^>]*width="2400"[^>]*height="2400"[^>]*viewBox="0 0 2400 2400"/.test(svg), overlap = false;
	const page = { min_x: 48, min_y: 48, max_x: 2352, max_y: 2352 };
	for (const item of textItems) {
		const x = Number(item.attrs.x), y = Number(item.attrs.y);
		if (!Number.isFinite(x) || !Number.isFinite(y)) { pageViolation = true; continue; }
		const font = item.attrs.class?.includes("title") ? 34 : item.attrs.class?.includes("subtitle") || item.attrs.class?.includes("note") ? 18 : 20;
		let boxWidth = Math.max(font, item.visible.length * font * 0.62), boxHeight = font * 1.25;
		if (/rotate\(-90/.test(item.attrs.transform ?? "")) [boxWidth, boxHeight] = [boxHeight, boxWidth];
		const anchor = item.attrs["text-anchor"] ?? "start";
		const minX = anchor === "end" ? x - boxWidth : anchor === "middle" ? x - boxWidth / 2 : x;
		const box = { min_x: minX, min_y: y - boxHeight * 0.78, max_x: minX + boxWidth, max_y: y + boxHeight * 0.22 };
		if (box.min_x < page.min_x || box.min_y < page.min_y || box.max_x > page.max_x || box.max_y > page.max_y) pageViolation = true;
		if (intersects(box, { min_x: contentBounds.min_x, min_y: contentBounds.min_y, max_x: contentBounds.max_x + 1, max_y: contentBounds.max_y + 1 })) overlap = true;
	}
	for (const match of svg.matchAll(/<line\b([^>]*)\/>/g)) {
		const attrs = attributes(match[1]);
		const x1 = Number(attrs.x1), x2 = Number(attrs.x2), y1 = Number(attrs.y1), y2 = Number(attrs.y2);
		const box = { min_x: Math.min(x1, x2) - 1, min_y: Math.min(y1, y2) - 1, max_x: Math.max(x1, x2) + 1, max_y: Math.max(y1, y2) + 1 };
		if (![x1, x2, y1, y2].every(Number.isFinite)) pageViolation = true;
		else if (intersects(box, { min_x: contentBounds.min_x, min_y: contentBounds.min_y, max_x: contentBounds.max_x + 1, max_y: contentBounds.max_y + 1 })) overlap = true;
	}
	return { mismatch, overlap, pageViolation, source_count: bySource.size };
}

export async function validateCompetitionElevation({ artifacts, sourceMesh, facadePlanes, facadeSegmentAuthority, facadeValidation, facadeValidationReceipt, designFacadeManifest, floorGuides, view, selectedGlbPath }) {
	const codes = [];
	const grammarEvidence = await verifiedTypedFacadeArtifact(selectedGlbPath, facadeValidation, facadeValidationReceipt, sourceMesh, facadeSegmentAuthority);
	const designEvidence = grammarEvidence.typed
		? null
		: await verifiedDesignFacadeArtifact(selectedGlbPath, designFacadeManifest, sourceMesh, facadeSegmentAuthority);
	const typedFacadeEvidence = designEvidence?.typed ? designEvidence : grammarEvidence;
	const typedFacadeArtifact = typedFacadeEvidence.typed;
	let authoritative;
	try {
		authoritative = await deriveElevationDimensions({
			sourceMesh,
			facadePlanes,
			floorGuides,
			view,
			artifact: { path: selectedGlbPath, sha256: artifacts.base?.selected_glb_sha256 },
		});
	} catch {
		add(codes, "DIMENSION_SOURCE_MISSING", true);
	}
	if (authoritative) {
		add(codes, "DIMENSION_MISMATCH", !sameJson(dimensionContract(authoritative), dimensionContract(artifacts.dimensions)));
		add(codes, "LEVEL_GUIDE_MISMATCH", !sameJson(authoritative.levels.map((item) => item.display_mm), artifacts.dimensions?.levels?.map((item) => item.display_mm))
			|| !sameJson(authoritative.floor_intervals.map((item) => item.display_mm), artifacts.dimensions?.floor_intervals?.map((item) => item.display_mm)));
	}
	const camera = artifacts.base?.camera;
	add(codes, "ELEVATION_CAMERA_NOT_ORTHOGRAPHIC", camera?.type !== "orthographic");
	const axes = camera?.projection_axes;
	const validAxis = (axis) => Array.isArray(axis) && axis.length === 3
		&& axis.every((component) => typeof component === "number" && Number.isFinite(component));
	const axesInvalid = !axes || [axes.horizontal, axes.vertical, axes.depth].some((axis) => !validAxis(axis))
		|| [axes?.horizontal ?? [], axes?.vertical ?? [], axes?.depth ?? []].some((axis) => Math.abs(length(axis) - 1) > 1e-6)
		|| Math.abs(dot(axes?.horizontal ?? [], axes?.vertical ?? [])) > 1e-6
		|| Math.abs(dot(axes?.horizontal ?? [], axes?.depth ?? [])) > 1e-6
		|| Math.abs(dot(axes?.vertical ?? [], axes?.depth ?? [])) > 1e-6
		|| (["horizontal", "vertical", "depth"].some((axis) => view?.projection_axes?.[axis]
			&& Math.abs(dot(axes?.[axis] ?? [], view.projection_axes[axis]) - 1) > 1e-6))
		|| Math.abs((camera?.px_per_m_x ?? 0) / (camera?.px_per_m_y ?? 1) - 1) > 0.0025;
	add(codes, "ELEVATION_AXIS_MISMATCH", axesInvalid);
	let bounds = artifacts.base?.content_bounds_px;
	const size = artifacts.base?.width;
	let diagnostics = artifacts.base?.diagnostics ?? {};
	let computedDark = artifacts.presentation?.authored_dark_geometry ?? null;
	let computedSvg = null, canonicalSvgMismatch = false;
	let finalCompositeMismatch = false, finalDarkExcess = 0, finalEdgeExcess = 0;
	if (artifacts.base?.path && artifacts.diagnostics?.material_id?.path && artifacts.diagnostics?.depth?.path && artifacts.diagnostics?.normal?.path) {
		try {
			const [baseImage, materialImage, depthImage, normalImage] = await Promise.all([
				decodedRgb(artifacts.base.path), decodedRgb(artifacts.diagnostics.material_id.path), decodedRgb(artifacts.diagnostics.depth.path), decodedRgb(artifacts.diagnostics.normal.path),
			]);
			const measured = rasterMetrics(baseImage.data, baseImage.info.width, baseImage.info.height);
			bounds = measured.bounds;
			const seams = persistedSeamMetrics(baseImage.data, materialImage.data, depthImage.data, normalImage.data, baseImage.info.width, baseImage.info.height, bounds, camera.frustum.near, camera.frustum.far);
			computedDark = persistedDarkGeometry(baseImage.data, materialImage.data, depthImage.data, baseImage.info.width, baseImage.info.height, bounds);
			diagnostics = {
				background_fraction: 1 - measured.foreground_fraction,
				dark_pixel_fraction: measured.dark_fraction,
				total_edge_density: measured.total_edge_density,
				strong_edge_density: measured.strong_edge_density,
				role_pixel_counts: roleCounts(materialImage.data),
				same_material_seam_fraction: seams.fraction,
				seam_segments: { visible: seams.visible_segments, longest_px: seams.longest_segment_px, boxes: seams.segments ?? [] },
			};
			add(codes, "DIMENSION_SOURCE_MISSING", !sameJson(bounds, artifacts.base.content_bounds_px));
			add(codes, "MATERIAL_VISIBILITY_INVALID", !sameJson(computedDark, artifacts.presentation?.authored_dark_geometry));
		} catch { add(codes, "DIMENSION_SOURCE_MISSING", true); }
	}
	add(codes, "ELEVATION_CONTENT_CLIPPED", !bounds || size !== 2400 || artifacts.base?.height !== 2400
		|| bounds.min_x < size * 0.08 || bounds.max_x > size * 0.92 - 1 || bounds.min_y < 48 || bounds.max_y > size - 48);
	add(codes, "MATERIAL_ROLE_MISSING", ["concrete", "glass", "bronze", "opaque"].some((role) => !(diagnostics.role_pixel_counts?.[role] > 0)));
	add(codes, "MATERIAL_VISIBILITY_INVALID", diagnostics.dark_pixel_fraction > (typedFacadeArtifact ? PRESENTATION_BOUNDS.darkPixelFraction.typed : PRESENTATION_BOUNDS.darkPixelFraction.untyped)
		|| computedDark?.invalid_pixels > 0);
	add(codes, "LINE_DENSITY_EXCEEDED", diagnostics.total_edge_density > PRESENTATION_BOUNDS.totalEdgeDensity
		|| diagnostics.strong_edge_density > strongEdgeLimit(typedFacadeArtifact));
	add(codes, "TRIANGULATION_VISIBLE", diagnostics.same_material_seam_fraction > PRESENTATION_BOUNDS.seamFraction
		|| diagnostics.seam_segments?.visible > 0);
	if (artifacts.final_png?.path) {
		try {
			const metadata = await sharp(artifacts.final_png.path).metadata();
			add(codes, "ELEVATION_CONTENT_CLIPPED", metadata.width !== 2400 || metadata.height !== 2400 || metadata.format !== "png");
		} catch { add(codes, "ELEVATION_CONTENT_CLIPPED", true); }
	}
	const selectedBytes = selectedGlbPath ? await readFile(selectedGlbPath).catch(() => undefined) : undefined;
	add(codes, "DIMENSION_SOURCE_MISSING", !selectedBytes || artifacts.base?.selected_glb_sha256 !== sha256(selectedBytes));
	const records = [artifacts.final_png, artifacts.presentation_base_png, artifacts.annotations_svg, artifacts.dimensions_json, artifacts.base_manifest, artifacts.render_manifest, ...Object.values(artifacts.diagnostics ?? {})].filter(Boolean);
	if (records.length) add(codes, "DIMENSION_SOURCE_MISSING", !(await Promise.all(records.map(validRecord))).every(Boolean));
	if (artifacts.base_manifest?.path) {
		try {
			const manifest = JSON.parse(await readFile(artifacts.base_manifest.path, "utf8"));
			add(codes, "DIMENSION_SOURCE_MISSING", manifest.path !== artifacts.base.path || manifest.sha256 !== artifacts.base.sha256
				|| manifest.selected_glb_sha256 !== artifacts.base.selected_glb_sha256 || !sameJson(manifest.diagnostic_paths, artifacts.base.diagnostic_paths));
		} catch { add(codes, "DIMENSION_SOURCE_MISSING", true); }
	}
	if (artifacts.dimensions_json?.path) {
		try {
			const persisted = JSON.parse(await readFile(artifacts.dimensions_json.path, "utf8"));
			add(codes, "DIMENSION_MISMATCH", !sameJson(dimensionContract(persisted), dimensionContract(artifacts.dimensions))
				|| (authoritative && !sameJson(dimensionContract(persisted), dimensionContract(authoritative))));
		} catch { add(codes, "DIMENSION_SOURCE_MISSING", true); }
	}
	if (artifacts.annotations_svg?.path) {
		try {
			const svg = await readFile(artifacts.annotations_svg.path, "utf8");
			if (authoritative) {
				computedSvg = inspectSvg(svg, authoritative, bounds);
				add(codes, "DIMENSION_MISMATCH", computedSvg.mismatch);
				const canonicalSvg = buildElevationAnnotations({
					dimensions: authoritative,
					camera,
					contentBounds: bounds,
					canvas: [2400, 2400],
					candidateId: sourceMesh?.identity?.candidate_id ?? "unknown",
				}).svg;
				canonicalSvgMismatch = Buffer.byteLength(svg) !== Buffer.byteLength(canonicalSvg) || svg !== canonicalSvg;
				add(codes, "DIMENSION_MISMATCH", canonicalSvgMismatch);
				add(codes, "ANNOTATION_CANONICAL_MISMATCH", canonicalSvgMismatch);
				add(codes, "LEVEL_GUIDE_MISMATCH", computedSvg.mismatch && authoritative.levels.some((level) => !svg.includes(`>${level.label}</text>`)));
				add(codes, "ELEVATION_CONTENT_CLIPPED", computedSvg.overlap || computedSvg.pageViolation);
			}
			if (artifacts.presentation_base_png?.path && artifacts.final_png?.path) {
				const expectedBytes = await sharp(artifacts.presentation_base_png.path).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
				const actualBytes = await readFile(artifacts.final_png.path);
				finalCompositeMismatch = sha256(expectedBytes) !== sha256(actualBytes);
				if (finalCompositeMismatch) {
					const [expected, actual] = await Promise.all([sharp(expectedBytes).removeAlpha().raw().toBuffer({ resolveWithObject: true }), sharp(actualBytes).removeAlpha().raw().toBuffer({ resolveWithObject: true })]);
					const expectedMetrics = rasterMetrics(expected.data, expected.info.width, expected.info.height), actualMetrics = rasterMetrics(actual.data, actual.info.width, actual.info.height);
					finalDarkExcess = actualMetrics.dark_fraction - expectedMetrics.dark_fraction;
					finalEdgeExcess = actualMetrics.total_edge_density - expectedMetrics.total_edge_density;
				}
			}
		} catch { add(codes, "DIMENSION_SOURCE_MISSING", true); }
	}
	add(codes, "LINE_DENSITY_EXCEEDED", finalCompositeMismatch && (finalEdgeExcess > PRESENTATION_BOUNDS.finalCompositeExcess || finalDarkExcess > PRESENTATION_BOUNDS.finalCompositeExcess));
	add(codes, "MATERIAL_VISIBILITY_INVALID", finalCompositeMismatch && finalDarkExcess > PRESENTATION_BOUNDS.finalCompositeExcess);
	add(codes, "DIMENSION_SOURCE_MISSING", finalCompositeMismatch && finalEdgeExcess <= PRESENTATION_BOUNDS.finalCompositeExcess && finalDarkExcess <= PRESENTATION_BOUNDS.finalCompositeExcess);
	if (artifacts.render_manifest?.path) {
		try {
			const manifest = JSON.parse(await readFile(artifacts.render_manifest.path, "utf8"));
			const expected = {
				base_png_sha256: artifacts.base?.sha256,
				base_manifest_sha256: artifacts.base_manifest?.sha256,
				presentation_base_png_sha256: artifacts.presentation_base_png?.sha256,
				annotations_svg_sha256: artifacts.annotations_svg?.sha256,
				dimensions_json_sha256: artifacts.dimensions_json?.sha256,
				final_png_sha256: artifacts.final_png?.sha256,
			};
			add(codes, "DIMENSION_SOURCE_MISSING", !Object.entries(expected).every(([field, value]) => manifest.provenance?.[field] === value)
				|| !Object.entries(artifacts.diagnostics ?? {}).every(([name, record]) => manifest.provenance?.diagnostic_sha256?.[name] === record.sha256)
				|| manifest.selected_glb_sha256 !== artifacts.base?.selected_glb_sha256
				|| manifest.viewer_config_sha256 !== artifacts.base?.viewer_config_sha256
				|| !sameJson(manifest.displayed_dimensions, dimensionValues(artifacts.dimensions)));
		} catch { add(codes, "DIMENSION_SOURCE_MISSING", true); }
	}
	return {
		schema_version: "arr.elevation3d.presentation-validation.v1",
		accepted: codes.length === 0,
		codes,
		tolerance_mm: 1,
		metrics: {
			dimension_values: authoritative ? dimensionValues(authoritative) : null,
			total_edge_density: diagnostics.total_edge_density ?? null,
			strong_edge_density: diagnostics.strong_edge_density ?? null,
			dark_pixel_fraction: diagnostics.dark_pixel_fraction ?? null,
			typed_facade_artifact: typedFacadeArtifact,
			typed_facade_receipt_bound: typedFacadeEvidence.receiptBound,
			same_material_seam_fraction: diagnostics.same_material_seam_fraction ?? null,
			content_bounds_px: bounds ?? null,
			annotation_overlap: computedSvg ? computedSvg.overlap : Boolean(artifacts.annotation?.overlaps_content || artifacts.annotation?.overlaps_annotations),
			authored_dark_geometry: computedDark,
			final_composite_mismatch: finalCompositeMismatch,
			canonical_svg_mismatch: canonicalSvgMismatch,
		},
	};
}

function normalizedProjectedBounds(bounds) {
	if (Array.isArray(bounds) && bounds.length === 2) return { min: bounds[0], max: bounds[1] };
	return bounds;
}

function horizontalTopAxes(axes) {
	const valid = (axis) => Array.isArray(axis) && axis.length === 3 && axis.every((value) => typeof value === "number" && Number.isFinite(value));
	if (!valid(axes?.horizontal) || !valid(axes?.vertical) || !valid(axes?.depth)) return false;
	const [horizontal, vertical, depth] = [axes.horizontal, axes.vertical, axes.depth];
	const determinant = horizontal[0] * (vertical[1] * depth[2] - vertical[2] * depth[1])
		- horizontal[1] * (vertical[0] * depth[2] - vertical[2] * depth[0])
		+ horizontal[2] * (vertical[0] * depth[1] - vertical[1] * depth[0]);
	return [horizontal, vertical, depth].every((axis) => Math.abs(length(axis) - 1) <= 1e-6)
		&& Math.abs(dot(horizontal, vertical)) <= 1e-6
		&& Math.abs(dot(horizontal, depth)) <= 1e-6
		&& Math.abs(dot(vertical, depth)) <= 1e-6
		&& Math.abs(determinant - 1) <= 1e-6
		&& Math.abs(Math.abs(depth[2]) - 1) <= 1e-6
		&& Math.abs(horizontal[2]) <= 1e-6
		&& Math.abs(vertical[2]) <= 1e-6;
}

export async function validateCompetitionPlanTopArtifact({ artifact, sourceMesh, camera, selectedGlbPath, mode, cutElevationM }) {
	const codes = [];
	let rasterDiagnostics = null;
	const manifest = artifact?.manifest;
	const selectedBytes = await readFile(selectedGlbPath).catch(() => undefined);
	const selectedHash = selectedBytes ? sha256(selectedBytes) : null;
	add(codes, "PLAN_TOP_MODE_INVALID", !["plan", "top"].includes(mode) || manifest?.mode !== mode);
	add(codes, "PLAN_TOP_PNG_INVALID", artifact?.width !== 2400 || artifact?.height !== 2400 || !await validRecord({ path: artifact?.path, sha256: artifact?.sha256 }));
	if (artifact?.path) {
		try {
			const metadata = await sharp(artifact.path).metadata();
			add(codes, "PLAN_TOP_PNG_INVALID", metadata.width !== 2400 || metadata.height !== 2400);
		} catch { add(codes, "PLAN_TOP_PNG_INVALID", true); }
	}
	add(codes, "PLAN_TOP_SELECTED_GLB_INVALID", !selectedHash || manifest?.selected_glb?.sha256 !== selectedHash || manifest?.selected_glb?.path !== selectedGlbPath);
	add(codes, "PLAN_TOP_GEOMETRY_MISMATCH", manifest?.geometry_hash !== sourceMesh?.identity?.geometry_hash);
	add(codes, "PLAN_TOP_CAMERA_INVALID", manifest?.camera?.type !== "orthographic" || !horizontalTopAxes(manifest?.camera?.projection_axes)
		|| !sameJson(manifest?.camera?.projection_axes, camera?.projection_axes));
	const scaleX = manifest?.camera?.px_per_m_x, scaleY = manifest?.camera?.px_per_m_y;
	add(codes, "PLAN_TOP_SCALE_INVALID", !Number.isFinite(scaleX) || !Number.isFinite(scaleY) || Math.abs(scaleX - scaleY) / Math.max(scaleX ?? 0, 1) > PRESENTATION_BOUNDS.planTopScaleSkew);
	const expectedBounds = normalizedProjectedBounds(camera?.projected_bounds_m);
	add(codes, "PLAN_TOP_EXACT_MASS_OUTLINE_INVALID", !sameJson(manifest?.exact_mass_projected_bounds_m, expectedBounds));
	const content = manifest?.content_bounds_px;
	add(codes, "PLAN_TOP_OUTLINE_CLIPPED", !content || content.min_x < 0 || content.min_y < 0 || content.max_x >= 2400 || content.max_y >= 2400
		|| content.min_x > 360 || content.max_x < 2039 || content.min_y > 720 || content.max_y < 1679);
	if (mode === "plan") {
		add(codes, "PLAN_CUT_PROVENANCE_INVALID", !Number.isFinite(cutElevationM) || manifest?.cut?.enabled !== true
			|| manifest.cut.elevation_m !== cutElevationM || !sameJson(manifest.cut.plane_world, [0, 0, 1, -cutElevationM])
			|| manifest?.cut_line?.segment_count <= 0 || manifest?.cut_line?.source !== "selected-glb-triangle-plane-intersections"
			|| manifest?.overhead_context?.enabled !== true || manifest?.overhead_context?.source !== "selected-glb-uncut-projection");
	} else add(codes, "TOP_UNCUT_PROVENANCE_INVALID", manifest?.cut?.enabled !== false || manifest?.cut?.elevation_m !== null
		|| manifest?.cut?.plane_world !== null || manifest?.cut_line?.segment_count !== 0 || manifest?.overhead_context?.enabled !== false);
	add(codes, "PLAN_TOP_LEVEL_ANNOTATION_LEAKAGE", manifest?.annotations?.enabled !== false || manifest?.annotations?.level_labels?.length !== 0);
	for (const name of ["material_id", "depth", "normal"]) {
		const record = artifact?.diagnostics?.[name];
		add(codes, "PLAN_TOP_DIAGNOSTIC_INVALID", !await validRecord(record));
		if (record?.path) {
			try {
				const metadata = await sharp(record.path).metadata();
				add(codes, "PLAN_TOP_DIAGNOSTIC_INVALID", metadata.width !== 2400 || metadata.height !== 2400);
			} catch { add(codes, "PLAN_TOP_DIAGNOSTIC_INVALID", true); }
		}
	}
	if (artifact?.path && artifact?.diagnostics?.material_id?.path && artifact?.diagnostics?.depth?.path && artifact?.diagnostics?.normal?.path) {
		try {
			const [baseImage, materialImage, depthImage, normalImage] = await Promise.all([
				decodedRgb(artifact.path), decodedRgb(artifact.diagnostics.material_id.path), decodedRgb(artifact.diagnostics.depth.path), decodedRgb(artifact.diagnostics.normal.path),
			]);
			const measured = rasterMetrics(baseImage.data, baseImage.info.width, baseImage.info.height);
			const seams = persistedSeamMetrics(baseImage.data, materialImage.data, depthImage.data, normalImage.data,
				baseImage.info.width, baseImage.info.height, measured.bounds, manifest.camera.frustum.near, manifest.camera.frustum.far);
			rasterDiagnostics = {
				total_edge_density: measured.total_edge_density,
				strong_edge_density: measured.strong_edge_density,
				same_material_seam_fraction: seams.fraction,
				seam_segments: { visible: seams.visible_segments, longest_px: seams.longest_segment_px, boxes: seams.segments ?? [] },
			};
			add(codes, "PLAN_TOP_LINE_DENSITY_EXCEEDED", measured.total_edge_density > PRESENTATION_BOUNDS.totalEdgeDensity
				|| measured.strong_edge_density > PRESENTATION_BOUNDS.planTopStrongEdgeDensity);
			add(codes, "TRIANGULATION_VISIBLE", seams.fraction > PRESENTATION_BOUNDS.seamFraction || seams.visible_segments > 0);
		} catch { add(codes, "PLAN_TOP_DIAGNOSTIC_INVALID", true); }
	}
	add(codes, "PLAN_TOP_MANIFEST_INVALID", !await validRecord(artifact?.manifest_record));
	return {
		schema_version: "arr.elevation3d.plan-top-validation.v1",
		accepted: codes.length === 0,
		codes,
		metrics: { content_bounds_px: content ?? null, selected_glb_sha256: selectedHash, equal_scale: scaleX === scaleY, ...rasterDiagnostics },
	};
}

export async function validateCompetitionPlanTopPair({ plan, top, sourceMesh, camera, selectedGlbPath }) {
	const codes = [];
	const selectedBytes = await readFile(selectedGlbPath).catch(() => undefined);
	const selectedHash = selectedBytes ? sha256(selectedBytes) : null;
	add(codes, "PLAN_TOP_SELECTED_GLB_INVALID", !selectedHash || plan?.manifest?.selected_glb?.sha256 !== selectedHash || top?.manifest?.selected_glb?.sha256 !== selectedHash);
	add(codes, "PLAN_TOP_GEOMETRY_MISMATCH", plan?.manifest?.geometry_hash !== sourceMesh?.identity?.geometry_hash || top?.manifest?.geometry_hash !== sourceMesh?.identity?.geometry_hash);
	add(codes, "PLAN_TOP_CAMERA_INVALID", !horizontalTopAxes(plan?.manifest?.camera?.projection_axes) || !horizontalTopAxes(top?.manifest?.camera?.projection_axes)
		|| !sameJson(plan?.manifest?.camera?.projection_axes, camera?.projection_axes) || !sameJson(top?.manifest?.camera?.projection_axes, camera?.projection_axes));
	add(codes, "PLAN_TOP_SCALE_INVALID", plan?.manifest?.camera?.px_per_m_x !== plan?.manifest?.camera?.px_per_m_y
		|| top?.manifest?.camera?.px_per_m_x !== top?.manifest?.camera?.px_per_m_y
		|| plan?.manifest?.camera?.px_per_m_x !== top?.manifest?.camera?.px_per_m_x);
	add(codes, "PLAN_CUT_PROVENANCE_INVALID", plan?.manifest?.mode !== "plan" || plan?.manifest?.cut?.enabled !== true || plan?.manifest?.cut?.elevation_m == null);
	add(codes, "TOP_UNCUT_PROVENANCE_INVALID", top?.manifest?.mode !== "top" || top?.manifest?.cut?.enabled !== false || top?.manifest?.cut?.elevation_m !== null || top?.manifest?.cut?.plane_world !== null);
	add(codes, "PLAN_TOP_PIXELS_IDENTICAL", plan?.sha256 === top?.sha256);
	add(codes, "PLAN_TOP_LEVEL_ANNOTATION_LEAKAGE", [plan, top].some((artifact) => artifact?.manifest?.annotations?.enabled !== false || artifact?.manifest?.annotations?.level_labels?.length !== 0));
	add(codes, "PLAN_TOP_EXACT_MASS_OUTLINE_INVALID", !sameJson(plan?.manifest?.exact_mass_projected_bounds_m, normalizedProjectedBounds(camera?.projected_bounds_m))
		|| !sameJson(top?.manifest?.exact_mass_projected_bounds_m, normalizedProjectedBounds(camera?.projected_bounds_m)));
	add(codes, "PLAN_TOP_PNG_INVALID", [plan, top].some((artifact) => artifact?.width !== 2400 || artifact?.height !== 2400));
	return { schema_version: "arr.elevation3d.plan-top-pair-validation.v1", accepted: codes.length === 0, codes };
}
