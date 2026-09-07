import { NodeIO } from "@gltf-transform/core";

/**
 * The elevation's line pass: the lines a drawing has that a flat fill does not.
 *
 * Two kinds of line, both keyed to facts the GLB already carries:
 *
 * 1. JOINTS. A declared material names the module it comes in (`joint_m`), and its substance
 *    names the family of joint that module makes. The pass draws that module as lines over
 *    every pixel painted with the material's own `elevation_fill`, in the elevation's own
 *    metres, and nowhere else - so the lines stop at every window and every other material.
 *    Four reviewers in a row named the missing joints as the most legible line on the wall in
 *    every photograph and absent from every sheet; the PBR map cannot carry them at drawing
 *    scale (measured, reverted), so this is a line pass and not a texture.
 *
 * 2. MEMBER EDGES. Where the depth raster steps by more than a member's own thickness, the
 *    silhouette of the nearer member is drawn. The viewer's post-pass already darkens depth
 *    steps as a fraction of the whole depth range, which a 0.16 m fin on a thirty-metre
 *    range barely registers; this pass uses metres. On a facet turned 45 degrees to the sheet
 *    a screen of fins overlaps into one surface, which is what an orthographic projection of
 *    fins physically does, and these edges are the only thing that lets it read as fins.
 *
 * 3. CREASES. Where the surface turns on itself without stepping in depth: a folded panel, a
 *    pleat, the arris between two facets of the mass. A reviewer holding the cleft block's
 *    photograph beside its sheet called this the disqualifying difference - "every precast
 *    panel is a shallow folded diamond and the whole surface is a field of hard diagonal
 *    creases; the drawing is a flat grey wall" - and the folds were in the mass and in the
 *    hero all along. Neither of the passes above can see them: a fold changes no material and
 *    steps no depth, so the fill is flat and the depth is smooth across it. Only the normal
 *    turns, and a drawing draws that turn as a line.
 *
 * The pass returns the ink's footprint as a mask. The seam detector prosecutes a dark line on
 * a same-material coplanar surface - exactly what a joint is - so the mask is persisted beside
 * the depth and material rasters and the detector skips it, as it already skips the plan's
 * own cut line.
 */

/** A depth step counts as a member edge from here up: a pane's 20 mm offset does not, a fin does. */
export const MEMBER_EDGE_STEP_M = 0.03;
/** Below this module the joints are courses of brick or board, unreadable at sheet scale; drawn from here up. */
export const MIN_JOINT_PITCH_M = 0.2;
/**
 * A surface turned this far from the sheet is not inked. The normal raster gives each pixel
 * its facing (the view-space normal's z); at 0.25 the surface is 75 degrees off the sheet
 * and four metres of it project onto one. Measured on the cleft block: the facet turning
 * away at the sheet's edge, a pale sliver with dark slots before the pass, came back as a
 * solid dark wedge - every jamb, pane and frame of every recessed slot is a depth step, and
 * on a face compressed four to one they land a pixel apart and fill it with ink.
 */
export const MIN_FACING_FOR_EDGES = 0.25;
/** Joints stop a little earlier: a module foreshortened past 3:1 is a hatch, not a joint. */
export const MIN_FACING_FOR_JOINTS = 0.33;
/**
 * The surface has to turn this far between neighbouring pixels to be a crease.
 *
 * Two degrees is low because the raster this reads is FLAT-shaded, and that changes what the
 * floor is. Every pixel of one triangle carries that triangle's own normal, encoded to the
 * same three bytes, so a flat face reads exactly zero turn - there is no quantisation floor
 * and no smooth-shading ramp to clear. What is left under a real fold is only the pixels
 * where antialiasing blends two surfaces, and those sit against a silhouette or a member
 * edge, which the clearance below already removes.
 *
 * The threshold has to be this low because the folds are shallow. Asked directly - the angle
 * between triangles sharing an edge in the compiled mass - the cleft block answers 78 edges
 * turning 0.5 to 5 degrees and 54 turning 5 to 15, against 67 at more than 45 which are its
 * corners and already member edges. "A shallow folded diamond" is what the reviewer called
 * it, and it is: at ten degrees the pass drew ONE pixel on the whole sheet, at five 1,386, at
 * two 24,987.
 */
export const CREASE_ANGLE_DEG = 2;
/**
 * A crease is not inked within this many pixels of a member's own edge.
 *
 * A fin's arris is a normal break with continuous depth, so it answers the crease test - but
 * it sits where the side face plunges away beside it, which the member-edge pass has already
 * drawn. Without this the fin screen inked nine per cent of its own sheet. What a fold in a
 * wall has and a fin's arris does not is quiet depth on both sides.
 */
export const CREASE_EDGE_CLEARANCE_PX = 2;
/**
 * What "quiet depth" means, and why it is not the member-edge test.
 *
 * A member edge is drawn where the depth STEPS by 30 mm between neighbouring pixels. That is
 * a first difference, and on a facet turned steeply to the sheet the surface's own recession
 * spends it: at 100 px/m a facet at 45 degrees recedes 10 mm per pixel, and past about 72
 * degrees every pixel of plain wall reads as an edge. The cleft block leans and pleats, so
 * its walls are exactly that - which is why its first crease pass drew ONE pixel on the whole
 * sheet: 52,556 candidate turns were suppressed as sitting beside a member edge that was only
 * the wall going away. A real member is a DISCONTINUITY, so the clearance tests the second
 * difference instead: how far the next depth sample falls from where the previous two point.
 * A plane predicts its own next sample whatever its tilt; a fin's edge does not.
 */
export const CREASE_DISCONTINUITY_M = MEMBER_EDGE_STEP_M;
/** Ink tones. All above the luminance-50 line that marks a dark ARTEFACT, so the cleaner leaves them alone. */
const EDGE_INK = [58, 60, 64];
const JOINT_INK_BLEND = 0.45;
const JOINT_INK = [44, 46, 50];
/**
 * A fold is the lightest of the three lines, and drawn as a blend rather than a stroke.
 *
 * Line weight is hierarchy: a silhouette is where the building stops, a member edge is where
 * one thing passes in front of another, and a crease is neither - the surface continues
 * through it, only bent. Drawing it at the member-edge tone said the wall was cut there.
 * The blend also keeps a fold under the "strong edge" bar (a Sobel magnitude of 180, where a
 * 1-pixel stroke at full contrast lands near 500), which is what a strong edge should mean:
 * this is a line the drawing carries, not an edge the geometry has.
 */
const CREASE_INK = [58, 60, 64];
const CREASE_INK_BLEND = 0.28;

/**
 * How each joint family draws its module. `u` is horizontal metres along the sheet, `v`
 * vertical metres; `levels` are the slab lines the sheet already dimensions.
 */
const JOINT_PATTERNS = Object.freeze({
	// Precast: vertical joints every module, horizontal joints at the slabs.
	"unit-cast": { vertical: "pitch", horizontal: "levels" },
	// Sheet or metal panels: a grid of the module both ways.
	panelised: { vertical: "pitch", horizontal: "pitch" },
	// Masonry and stone: courses.
	coursed: { vertical: null, horizontal: "pitch" },
	// Boards: vertical.
	boarded: { vertical: "pitch", horizontal: null },
	// Extrusions and glazing: the member is its own line.
	running: null,
	"per-opening": null,
});

function hexToRgb(hex) {
	const match = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ""));
	if (!match) return null;
	const value = parseInt(match[1], 16);
	return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** The materials of a compiled GLB that draw joints: fill colour, family, module. */
export async function readInkMaterials(glbBytes) {
	const document = await new NodeIO().readBinary(new Uint8Array(glbBytes));
	const found = [];
	for (const material of document.getRoot().listMaterials()) {
		const extras = material.getExtras() ?? {};
		const fill = hexToRgb(extras.elevation_fill);
		const pitch = Number(extras.joint_pitch_m);
		const pattern = JOINT_PATTERNS[extras.joint_family] ?? null;
		if (!fill || !pattern || !(pitch >= MIN_JOINT_PITCH_M)) continue;
		found.push({ id: extras.declared_material ?? material.getName(), fill, family: extras.joint_family, pitch_m: pitch, pattern });
	}
	return found;
}

function decodeDepthMetres(raw, offset, near, far) {
	const normalized = raw[offset] / 255 + raw[offset + 1] / (255 ** 2) + raw[offset + 2] / (255 ** 3);
	return near + normalized * (far - near);
}

/** The view-space normal at this pixel, unit length, or null where the raster has none. */
function unitNormal(normal, offset) {
	if (!normal) return null;
	const x = normal[offset] / 255 * 2 - 1, y = normal[offset + 1] / 255 * 2 - 1, z = normal[offset + 2] / 255 * 2 - 1;
	const length = Math.hypot(x, y, z);
	return length > 0 ? [x / length, y / length, z / length] : null;
}

/** How squarely the surface at this pixel faces the sheet: |z| of the view-space normal, 1 head-on, 0 edge-on. */
function facing(normal, offset) {
	if (!normal) return 1;
	const unit = unitNormal(normal, offset);
	return unit ? Math.abs(unit[2]) : 0;
}

/** The angle between two view-space normals, in degrees. */
function turnDegrees(left, right) {
	const dot = Math.min(1, Math.max(-1, left[0] * right[0] + left[1] * right[1] + left[2] * right[2]));
	return Math.acos(dot) * 180 / Math.PI;
}

/**
 * Ink the base raster in place and return the footprint.
 *
 * `pixels` is the RGB base (mutated), `materialId` and `depth` the diagnostic rasters, `camera`
 * the viewer's manifest (`px_per_m_x`, `px_per_m_y`), `projectedBounds` its `{min, max}` in
 * sheet metres, `levels` the slab lines in metres, `materials` from `readInkMaterials`.
 */
export function inkElevation({ pixels, materialId, depth, normal = null, creaseNormal = null, width, height, near, far, camera, projectedBounds, levels = [], materials = [] }) {
	const mask = new Uint8Array(width * height);
	const isBackground = (offset) => materialId[offset] === 0 && materialId[offset + 1] === 0 && materialId[offset + 2] === 0;
	const sameMaterial = (left, right) => materialId[left] === materialId[right]
		&& materialId[left + 1] === materialId[right + 1] && materialId[left + 2] === materialId[right + 2];
	// Where the depth genuinely BREAKS, both sides of it: the second difference, so a steeply
	// turned wall's own recession does not count. The crease pass keeps clear of this.
	const depthBreaks = () => {
		const zone = new Uint8Array(width * height);
		const at = (index) => decodeDepthMetres(depth, index * 3, near, far);
		for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
			const here = y * width + x;
			if (isBackground(here * 3)) continue;
			for (const [dx, dy] of [[1, 0], [0, 1]]) {
				const before = (y - dy) * width + x - dx, after = (y + dy) * width + x + dx;
				if (isBackground(before * 3) || isBackground(after * 3)) continue;
				// Where the previous two samples point, against where the next one lands.
				if (Math.abs(at(after) - 2 * at(here) + at(before)) < CREASE_DISCONTINUITY_M) continue;
				zone[before] = 1; zone[here] = 1; zone[after] = 1;
			}
		}
		return zone;
	};
	let edgePixels = 0, jointPixels = 0, creasePixels = 0;

	// The sheet's own frame: the projected bounds sit centred on the canvas at px_per_m, which
	// is how the viewer laid them out and how the annotations find them.
	const pxPerM = camera.px_per_m_x;
	const widthPx = (projectedBounds.max[0] - projectedBounds.min[0]) * pxPerM;
	const heightPx = (projectedBounds.max[1] - projectedBounds.min[1]) * (camera.px_per_m_y ?? pxPerM);
	const originX = (width - widthPx) / 2;
	const originY = (height - heightPx) / 2;
	const uAt = (x) => projectedBounds.min[0] + (x - originX) / pxPerM;
	const vAt = (y) => projectedBounds.max[1] - (y - originY) / (camera.px_per_m_y ?? pxPerM);
	const onLine = (metres, pitch, origin = 0) => {
		const distance = Math.abs(((metres - origin) % pitch + pitch) % pitch);
		return Math.min(distance, pitch - distance) * pxPerM <= 0.5;
	};

	// 1. Member edges: a depth step of a member's thickness or more, drawn on the nearer side.
	for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
		const offset = (y * width + x) * 3;
		if (isBackground(offset)) continue;
		if (facing(normal, offset) < MIN_FACING_FOR_EDGES) continue;
		const here = decodeDepthMetres(depth, offset, near, far);
		let edge = false;
		for (const [dx, dy] of [[1, 0], [0, 1]]) {
			const other = ((y + dy) * width + x + dx) * 3;
			if (isBackground(other)) continue;
			const there = decodeDepthMetres(depth, other, near, far);
			// Draw on whichever of the pair is nearer the camera (smaller depth).
			if (there - here >= MEMBER_EDGE_STEP_M) edge = true;
			else if (here - there >= MEMBER_EDGE_STEP_M && facing(normal, other) >= MIN_FACING_FOR_EDGES) {
				pixels[other] = EDGE_INK[0]; pixels[other + 1] = EDGE_INK[1]; pixels[other + 2] = EDGE_INK[2];
				mask[(y + dy) * width + x + dx] = 1; edgePixels++;
			}
		}
		if (edge) { pixels[offset] = EDGE_INK[0]; pixels[offset + 1] = EDGE_INK[1]; pixels[offset + 2] = EDGE_INK[2]; mask[y * width + x] = 1; edgePixels++; }
	}

	// 2. Creases: the surface turning on itself with the depth continuous through the turn.
	// Same material on both sides, because two materials meeting is already a line in the fill;
	// clear of every member edge, because a fin's arris belongs to the pass above.
	// Flat-shaded normals if the caller has them, because a smooth raster has no crease in it
	// to find; with only the smooth one this pass stands down rather than drawing its ramps.
	const creases = creaseNormal ?? null;
	if (creases) {
		const clear = dilateMask(depthBreaks(), width, height, CREASE_EDGE_CLEARANCE_PX);
		for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
			const index = y * width + x;
			if (mask[index] || clear[index]) continue;
			const offset = index * 3;
			if (isBackground(offset)) continue;
			const hereNormal = unitNormal(creases, offset);
			if (!hereNormal || Math.abs(hereNormal[2]) < MIN_FACING_FOR_EDGES) continue;
			const hereDepth = decodeDepthMetres(depth, offset, near, far);
			let crease = false;
			for (const [dx, dy] of [[1, 0], [0, 1]]) {
				const neighbour = (y + dy) * width + x + dx;
				if (clear[neighbour]) continue;
				const other = neighbour * 3;
				if (isBackground(other) || !sameMaterial(offset, other)) continue;
				const otherNormal = unitNormal(creases, other);
				if (!otherNormal || Math.abs(otherNormal[2]) < MIN_FACING_FOR_EDGES) continue;
				if (Math.abs(decodeDepthMetres(depth, other, near, far) - hereDepth) >= MEMBER_EDGE_STEP_M) continue;
				if (turnDegrees(hereNormal, otherNormal) >= CREASE_ANGLE_DEG) crease = true;
			}
			if (!crease) continue;
			for (let channel = 0; channel < 3; channel++) {
				pixels[offset + channel] = Math.round(pixels[offset + channel] * (1 - CREASE_INK_BLEND) + CREASE_INK[channel] * CREASE_INK_BLEND);
			}
			mask[index] = 1; creasePixels++;
		}
	}

	// 3. Joints: the material's module, drawn only where its own fill is painted.
	if (materials.length) {
		for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
			const index = y * width + x;
			if (mask[index]) continue;
			const offset = index * 3;
			if (isBackground(offset)) continue;
			if (facing(normal, offset) < MIN_FACING_FOR_JOINTS) continue;
			const material = materials.find((item) => pixels[offset] === item.fill[0] && pixels[offset + 1] === item.fill[1] && pixels[offset + 2] === item.fill[2]);
			if (!material) continue;
			const { pattern, pitch_m: pitch } = material;
			const vertical = pattern.vertical === "pitch" && onLine(uAt(x), pitch, projectedBounds.min[0]);
			const horizontal = pattern.horizontal === "pitch" ? onLine(vAt(y), pitch, 0)
				: pattern.horizontal === "levels" ? levels.some((level) => Math.abs(vAt(y) - level) * pxPerM <= 0.5) : false;
			if (!vertical && !horizontal) continue;
			for (let channel = 0; channel < 3; channel++) {
				pixels[offset + channel] = Math.round(pixels[offset + channel] * (1 - JOINT_INK_BLEND) + JOINT_INK[channel] * JOINT_INK_BLEND);
			}
			mask[index] = 1; jointPixels++;
		}
	}
	return { mask, report: { member_edge_pixels: edgePixels, crease_pixels: creasePixels, joint_pixels: jointPixels, materials: materials.map(({ id, family, pitch_m }) => ({ id, family, pitch_m })) } };
}

/** The mask as an RGB raster (255 where inked), so it persists as a PNG beside the other rasters. */
export function inkMaskToRgb(mask) {
	const out = Buffer.alloc(mask.length * 3);
	for (let index = 0; index < mask.length; index++) if (mask[index]) out[index * 3] = out[index * 3 + 1] = out[index * 3 + 2] = 255;
	return out;
}

/** Back from the persisted raster: any non-black pixel is ink. */
export function inkMaskFromRgb(raw, width, height) {
	const mask = new Uint8Array(width * height);
	for (let index = 0; index < mask.length; index++) if (raw[index * 3] || raw[index * 3 + 1] || raw[index * 3 + 2]) mask[index] = 1;
	return mask;
}

/**
 * The footprint grown by `radius` pixels, for a detector that reads a gradient across
 * neighbours: a one-pixel line lights the Sobel kernel two pixels either side of itself, so
 * the skip has to cover what the line touches, not only what it is. Measured on the first
 * inked sheet - the exact footprint left five diagonal seam candidates two pixels long
 * beside the joints and the sheet was refused for triangulation.
 */
export function dilateMask(mask, width, height, radius = 2) {
	const out = new Uint8Array(mask.length);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		if (!mask[y * width + x]) continue;
		for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
			const nx = x + dx, ny = y + dy;
			if (nx >= 0 && nx < width && ny >= 0 && ny < height) out[ny * width + nx] = 1;
		}
	}
	return out;
}
