import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import {
	analyzePresentationPng,
	comparePresentationEvidence,
	validatePresentationEvidence,
} from "../plugins/elevation-3d/lib/texturing/render-style-evidence.mjs";
import { renderStyleHash, resolvePbrRenderStyle } from "../plugins/elevation-3d/lib/texturing/render-style.mjs";

const WIDTH = 32;
const HEIGHT = 32;
const BUILDING_BOUNDS = { minX: 8, minY: 6, maxX: 23, maxY: 23 };
const BACKGROUND = "#fafaf7";

type Rgb = [number, number, number];

async function fixturePng({ building = "varied", shadow = "soft", background = [250, 250, 247] as Rgb } = {}) {
	const pixels = Buffer.alloc(WIDTH * HEIGHT * 3);
	for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel += 1) pixels.set(background, pixel * 3);
	const set = (x: number, y: number, color: Rgb) => pixels.set(color, (y * WIDTH + x) * 3);
	for (let y = BUILDING_BOUNDS.minY; y <= BUILDING_BOUNDS.maxY; y += 1) {
		for (let x = BUILDING_BOUNDS.minX; x <= BUILDING_BOUNDS.maxX; x += 1) {
			let color: Rgb;
			if (building === "white") color = [254, 254, 254];
			else if (building === "black") color = [2, 2, 2];
			else if (x < 13) color = [72, 96, 128];
			else if (x < 18) color = [154, 104, 54];
			else color = [92, 164, 188];
			set(x, y, color);
		}
	}
	if (shadow === "soft") {
		const shades = [238, 228, 218, 232, 241];
		for (let x = 24; x <= 28; x += 1) for (let y = 15; y <= 24; y += 1) set(x, y, [shades[x - 24], shades[x - 24], shades[x - 24]]);
	} else if (shadow === "hard") {
		for (let x = 24; x <= 28; x += 1) for (let y = 15; y <= 24; y += 1) set(x, y, [0, 0, 0]);
	}
	return sharp(pixels, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } }).png().toBuffer();
}

async function evidence(options = {}) {
	return analyzePresentationPng({ png: await fixturePng(options), buildingBounds: BUILDING_BOUNDS, background: BACKGROUND });
}

function viewsFrom(sample: Awaited<ReturnType<typeof evidence>>) {
	return Object.fromEntries(["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"].map((name) => [name, structuredClone(sample)]));
}

test("building luminance percentiles reject clipped-white and crushed-black regions", async () => {
	const style = resolvePbrRenderStyle();
	const whiteViews = viewsFrom(await evidence({ building: "white" }));
	const blackViews = viewsFrom(await evidence({ building: "black" }));
	assert.ok(whiteViews.front.building.luminanceP95 >= 250);
	assert.ok(blackViews.front.building.luminanceP05 <= 5);
	assert.deepEqual(validatePresentationEvidence({ views: whiteViews, style, styleHash: renderStyleHash(style) }).codes, ["PBR_PRESENTATION_RANGE_INVALID"]);
	assert.deepEqual(validatePresentationEvidence({ views: blackViews, style, styleHash: renderStyleHash(style) }).codes, ["PBR_PRESENTATION_RANGE_INVALID"]);
});

test("background delta and variance recognize the configured competition white", async () => {
	const measured = await evidence();
	assert.equal(measured.background.sampleCount > 500, true);
	assert.equal(measured.background.deltaP95, 0);
	assert.ok(measured.background.luminanceVariance < 1e-12);
});

test("a bounded soft adjacent shadow is distinguished from no shadow and a hard black block", async () => {
	const soft = await evidence({ shadow: "soft" });
	const none = await evidence({ shadow: "none" });
	const hard = await evidence({ shadow: "hard" });
	assert.equal(soft.contactShadow.detected, true);
	assert.equal(none.contactShadow.detected, false);
	assert.equal(hard.contactShadow.detected, false);
	assert.ok(soft.contactShadow.areaFraction > 0 && soft.contactShadow.areaFraction < 0.12);
	assert.equal(soft.contactShadow.insideBuildingPixels, 0);
});

test("material separation reports luminance and chroma spread without filename metadata", async () => {
	const measured = await evidence();
	assert.ok(measured.materialSeparation.luminanceSpread > 20);
	assert.ok(measured.materialSeparation.chromaSpread > 20);
	assert.equal(Object.hasOwn(measured.materialSeparation, "filename"), false);
});

test("baseline comparison reports presentation deltas but never geometry acceptance", async () => {
	const baseline = await evidence();
	const current = await evidence({ building: "white" });
	const comparison = comparePresentationEvidence(current, baseline);
	assert.ok(comparison.contrastDelta < 0);
	assert.ok(comparison.materialSeparation.luminanceSpreadDelta < 0);
	assert.equal(Object.hasOwn(comparison, "accepted"), false);
	assert.equal(Object.hasOwn(comparison, "geometryAccepted"), false);
});

test("presentation validation separates style, contact-shadow, and range failures", async () => {
	const style = resolvePbrRenderStyle();
	const styleHash = renderStyleHash(style);
	const validViews = viewsFrom(await evidence());
	assert.deepEqual(validatePresentationEvidence({ views: validViews, style, styleHash }), { accepted: true, codes: [] });
	assert.deepEqual(validatePresentationEvidence({ views: validViews, style, styleHash: "0".repeat(64) }).codes, ["PBR_RENDER_STYLE_INVALID"]);
	const noShadowViews = viewsFrom(await evidence({ shadow: "none" }));
	assert.deepEqual(validatePresentationEvidence({ views: noShadowViews, style, styleHash }).codes, ["PBR_CONTACT_SHADOW_MISSING"]);
	const clippedViews = viewsFrom(await evidence({ building: "white" }));
	assert.deepEqual(validatePresentationEvidence({ views: clippedViews, style, styleHash }).codes, ["PBR_PRESENTATION_RANGE_INVALID"]);
});
