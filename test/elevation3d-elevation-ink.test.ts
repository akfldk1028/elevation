import assert from "node:assert/strict";
import test from "node:test";

import { CREASE_ANGLE_DEG, dilateMask, inkElevation, inkMaskFromRgb, inkMaskToRgb, MEMBER_EDGE_STEP_M } from "../plugins/elevation-3d/lib/elevation-ink.mjs";

// A 100 x 100 sheet at 10 px/m showing a 10 x 10 m wall; the projected bounds fill the
// canvas exactly so pixel (x, y) is (x / 10 m, 10 - y / 10 m).
const W = 100, H = 100;
const camera = { px_per_m_x: 10, px_per_m_y: 10 };
const projectedBounds = { min: [0, 0], max: [10, 10] };
const NEAR = 0, FAR = 255;

function encodeDepth(metres: number) {
	// Only the high byte matters at this precision: depth = R / 255 * (far - near).
	return [Math.round(metres), 0, 0];
}

function sheet(fill: number[], depthM: number) {
	const pixels = Buffer.alloc(W * H * 3);
	const materialId = Buffer.alloc(W * H * 3);
	const depth = Buffer.alloc(W * H * 3);
	for (let i = 0; i < W * H; i++) {
		pixels.set(fill, i * 3);
		materialId.set([255, 0, 0], i * 3);
		depth.set(encodeDepth(depthM), i * 3);
	}
	return { pixels, materialId, depth };
}

test("a declared module draws as joints over its own fill only, in the sheet's metres", () => {
	const fill = [200, 200, 200];
	const { pixels, materialId, depth } = sheet(fill, 10);
	// A window: different fill, same depth, in the middle.
	for (let y = 40; y < 60; y++) for (let x = 40; x < 60; x++) pixels.set([40, 40, 40], (y * W + x) * 3);
	const materials = [{ id: "precast", fill, family: "unit-cast", pitch_m: 2.5, pattern: { vertical: "pitch", horizontal: "levels" } }];
	const { mask, report } = inkElevation({ pixels, materialId, depth, width: W, height: H, near: NEAR, far: FAR, camera, projectedBounds, levels: [3.3, 6.6], materials });

	// Vertical joints at u = 2.5, 5, 7.5 m -> x = 25, 50, 75; horizontal at v = 3.3, 6.6 -> y = 67, 34.
	assert.equal(mask[10 * W + 25], 1);
	assert.equal(mask[10 * W + 75], 1);
	assert.equal(mask[67 * W + 10], 1, "a slab line joint");
	assert.equal(mask[10 * W + 30], 0, "between joints nothing is drawn");
	// The joint stops at the window: x = 50 inside the window rows carries no ink.
	assert.equal(mask[50 * W + 50], 0);
	assert.ok(report.joint_pixels > 0);
	assert.equal(report.member_edge_pixels, 0, "a flat sheet has no member edge");
	// The line is a blend, darker than the fill and lighter than a dark artefact.
	const inked = pixels[(10 * W + 25) * 3];
	assert.ok(inked < 200 && inked > 50, `joint tone ${inked}`);
});

test("a depth step of a member's thickness draws its edge on the nearer side; a pane's offset does not", () => {
	const { pixels, materialId, depth } = sheet([200, 200, 200], 10);
	// A fin: 2 px wide, standing 1 m proud (depth 9) at x = 20..21.
	for (let y = 0; y < H; y++) for (const x of [20, 21]) depth.set(encodeDepth(9), (y * W + x) * 3);
	const { mask, report } = inkElevation({ pixels, materialId, depth, width: W, height: H, near: NEAR, far: FAR, camera, projectedBounds });
	assert.ok(report.member_edge_pixels > 0);
	assert.equal(mask[50 * W + 20], 1, "the fin's near face is outlined");
	assert.equal(mask[50 * W + 21], 1);
	assert.equal(mask[50 * W + 30], 0, "the wall beside it is not");
	assert.ok(MEMBER_EDGE_STEP_M < 1);
	// A surface turned almost edge-on to the sheet is not inked: the same fin on a facet whose
	// normal points 80 degrees off the view leaves no edge (measured on the cleft block's
	// sliver facet, which the pass had filled solid).
	const turned = sheet([200, 200, 200], 10);
	for (let y = 0; y < H; y++) for (const x of [20, 21]) turned.depth.set(encodeDepth(9), (y * W + x) * 3);
	const normal = Buffer.alloc(W * H * 3);
	// view-space normal (0.98, 0, 0.17): x = 0.98 -> 252, y = 0 -> 128, z = 0.17 -> 149
	for (let i = 0; i < W * H; i++) normal.set([252, 128, 149], i * 3);
	const away = inkElevation({ ...turned, normal, width: W, height: H, near: NEAR, far: FAR, camera, projectedBounds });
	assert.equal(away.report.member_edge_pixels, 0);
	// The mask survives a round trip through its RGB raster.
	const back = inkMaskFromRgb(inkMaskToRgb(mask), W, H);
	assert.deepEqual([...back], [...mask]);
	// And the seam detector's skip is the footprint grown by the kernel it reads with: two
	// pixels either side of a one-pixel line, measured as the exact footprint leaving seam
	// candidates beside every joint on the first inked sheet.
	const grown = dilateMask(mask, W, H, 2);
	assert.equal(grown[50 * W + 18], 1);
	assert.equal(grown[50 * W + 23], 1);
	assert.equal(grown[50 * W + 17], 0);
	assert.equal(grown[50 * W + 24], 0);
});

/** A view-space normal encoded the way the raster carries it. */
function encodeNormal(x: number, y: number, z: number) {
	const length = Math.hypot(x, y, z);
	return [x / length, y / length, z / length].map((component) => Math.round((component + 1) / 2 * 255));
}

test("a fold draws as a crease: the surface turns, the depth does not step, the fill is one material", () => {
	// A wall folded down the middle: the left half faces the sheet, the right half is turned
	// 20 degrees about the vertical. Same material, same fill, and the depth is flat - which
	// is exactly what the cleft block's folded panel field was, and what left it a grey wall.
	const { pixels, materialId, depth } = sheet([200, 200, 200], 10);
	const normal = Buffer.alloc(W * H * 3);
	const head = encodeNormal(0, 0, 1);
	const turned = encodeNormal(Math.sin(20 * Math.PI / 180), 0, Math.cos(20 * Math.PI / 180));
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) normal.set(x < 50 ? head : turned, (y * W + x) * 3);

	const { mask, report } = inkElevation({ pixels, materialId, depth, normal, creaseNormal: normal, width: W, height: H, near: NEAR, far: FAR, camera, projectedBounds });
	assert.ok(report.crease_pixels > 0, "the fold is drawn");
	assert.equal(mask[50 * W + 49], 1, "on the fold line");
	assert.equal(mask[50 * W + 30], 0, "and nowhere on either flat half");
	assert.equal(mask[50 * W + 70], 0);
	assert.equal(report.member_edge_pixels, 0, "a fold steps no depth, so it is not a member edge");
	// A fold is a lighter line than a member's silhouette: the surface continues through it.
	assert.ok(pixels[(50 * W + 49) * 3] > 58 && pixels[(50 * W + 49) * 3] < 200);
});

test("a turn under the threshold, a material boundary and a fin's own arris are not creases", () => {
	// The threshold is low because the raster is flat-shaded and the folds are shallow: the
	// cleft block's own mass turns 0.5-5 degrees across 78 of its shared edges.
	assert.ok(CREASE_ANGLE_DEG > 0 && CREASE_ANGLE_DEG < 5);
	const flatter = encodeNormal(Math.sin((CREASE_ANGLE_DEG / 2) * Math.PI / 180), 0, Math.cos((CREASE_ANGLE_DEG / 2) * Math.PI / 180));
	const head = encodeNormal(0, 0, 1);

	// Half the threshold is the antialiasing smear, not a fold.
	const gentle = sheet([200, 200, 200], 10);
	const gentleNormal = Buffer.alloc(W * H * 3);
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) gentleNormal.set(x < 50 ? head : flatter, (y * W + x) * 3);
	assert.equal(inkElevation({ ...gentle, normal: gentleNormal, creaseNormal: gentleNormal, width: W, height: H, near: NEAR, far: FAR, camera, projectedBounds }).report.crease_pixels, 0);

	// Two materials meeting at 20 degrees: already a line in the fill, so the pass leaves it.
	const twoTone = sheet([200, 200, 200], 10);
	const steep = encodeNormal(Math.sin(20 * Math.PI / 180), 0, Math.cos(20 * Math.PI / 180));
	const twoToneNormal = Buffer.alloc(W * H * 3);
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		twoToneNormal.set(x < 50 ? head : steep, (y * W + x) * 3);
		if (x >= 50) twoTone.materialId.set([0, 255, 0], (y * W + x) * 3);
	}
	assert.equal(inkElevation({ ...twoTone, normal: twoToneNormal, creaseNormal: twoToneNormal, width: W, height: H, near: NEAR, far: FAR, camera, projectedBounds }).report.crease_pixels, 0);

	// A fin: its arris turns 20 degrees with the depth continuous across the turn itself, but
	// the side face plunges away beside it and the member-edge pass has already drawn that.
	// Without the clearance the fin screen inked nine per cent of its own sheet.
	const fin = sheet([200, 200, 200], 10);
	const finNormal = Buffer.alloc(W * H * 3);
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		finNormal.set(x === 20 ? steep : head, (y * W + x) * 3);
		if (x === 21) fin.depth.set(encodeDepth(9), (y * W + x) * 3);
	}
	const inked = inkElevation({ ...fin, normal: finNormal, creaseNormal: finNormal, width: W, height: H, near: NEAR, far: FAR, camera, projectedBounds });
	assert.ok(inked.report.member_edge_pixels > 0, "the fin is drawn as an edge");
	assert.equal(inked.report.crease_pixels, 0, "and not a second time as a crease");
});
