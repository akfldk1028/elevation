import assert from "node:assert/strict";
import test from "node:test";

import { dilateMask, inkElevation, inkMaskFromRgb, inkMaskToRgb, MEMBER_EDGE_STEP_M } from "../plugins/elevation-3d/lib/elevation-ink.mjs";

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
