import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import {
	analyzePresentationPng,
	comparePresentationEvidence,
	validatePresentationEvidence,
} from "../plugins/elevation-3d/lib/texturing/render-style-evidence.mjs";
import * as presentationEvidenceModule from "../plugins/elevation-3d/lib/texturing/render-style-evidence.mjs";
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
	} else if (shadow === "textured-object") {
		for (let x = 24; x <= 28; x += 1) for (let y = 15; y <= 24; y += 1) {
			set(x, y, (x + y) % 2 === 0 ? [200, 225, 205] : [220, 190, 205]);
		}
	} else if (shadow === "oversized-image") {
		for (let x = 24; x <= 30; x += 1) for (let y = 6; y <= 23; y += 1) {
			const shade = 216 + (x - 24) * 4;
			set(x, y, [shade, shade, shade]);
		}
	}
	return sharp(pixels, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } }).png().toBuffer();
}

async function nonRectangularTransparentPng({ oversizedBuildingShadow = false } = {}) {
	const background: Rgb = [250, 250, 247];
	const pixels = Buffer.alloc(WIDTH * HEIGHT * 4);
	for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel += 1) pixels.set([...background, 255], pixel * 4);
	const set = (x: number, y: number, color: Rgb, alpha = 255) => pixels.set([...color, alpha], (y * WIDTH + x) * 4);
	for (let y = BUILDING_BOUNDS.minY; y <= BUILDING_BOUNDS.maxY; y += 1) {
		for (let x = BUILDING_BOUNDS.minX; x <= BUILDING_BOUNDS.maxX; x += 1) {
			if (x < 13 || y >= 18) set(x, y, x < 13 ? [72, 96, 128] : [154, 104, 54]);
			else set(x, y, [0, 0, 0], 0);
		}
	}
	if (oversizedBuildingShadow) for (let x = 24; x <= 27; x += 1) for (let y = 4; y <= 23; y += 1) {
		const shade = 216 + (x - 24) * 8;
		set(x, y, [shade, shade, shade]);
	}
	return sharp(pixels, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).png().toBuffer();
}

async function evidence(options = {}) {
	return analyzePresentationPng({ png: await fixturePng(options), buildingBounds: BUILDING_BOUNDS, background: BACKGROUND });
}

async function scaleAwareShadowEvidence(buildingWidth: number) {
	const width = 64, height = 64;
	const bounds = { minX: 10, minY: 10, maxX: 9 + buildingWidth, maxY: 19 };
	const pixels = Buffer.alloc(width * height * 3);
	for (let pixel = 0; pixel < width * height; pixel += 1) pixels.set([250, 250, 247], pixel * 3);
	const set = (x: number, y: number, color: Rgb) => pixels.set(color, (y * width + x) * 3);
	for (let y = bounds.minY; y <= bounds.maxY; y += 1) for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
		set(x, y, [100, 120, 140]);
	}
	for (const [offset, shade] of [242, 236, 230, 224].entries()) set(bounds.maxX + 1, 16 + offset, [shade, shade, shade]);
	return analyzePresentationPng({
		png: await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer(),
		buildingBounds: bounds,
		background: BACKGROUND,
	});
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

test("a scale-aware building fraction accepts a credible shadow below the image-area minimum", async () => {
	const measured = await scaleAwareShadowEvidence(10);
	assert.ok(measured.contactShadow.areaFraction < 0.002);
	assert.ok(measured.contactShadow.buildingAreaFraction >= 0.01);
	assert.ok(measured.contactShadow.buildingAreaFraction < 0.1);
	assert.equal(measured.contactShadow.minimumCoverageRoute, "building");
	assert.equal(measured.contactShadow.detected, true);
});

test("a tiny shadow below both scale-aware minimum routes remains rejected", async () => {
	const measured = await scaleAwareShadowEvidence(50);
	assert.ok(measured.contactShadow.areaFraction < 0.002);
	assert.ok(measured.contactShadow.buildingAreaFraction < 0.01);
	assert.equal(measured.contactShadow.minimumCoverageRoute, null);
	assert.equal(measured.contactShadow.detected, false);
});

test("foreground metrics exclude transparent openings and background inside non-rectangular bounds", async () => {
	const measured = await analyzePresentationPng({
		png: await nonRectangularTransparentPng(), buildingBounds: BUILDING_BOUNDS, background: BACKGROUND,
	});
	assert.equal(measured.building.sampleCount, 156);
	assert.ok(measured.building.luminanceP05 > 70);
	assert.ok(measured.building.luminanceP95 < 150);
});

test("a bounded adjacent textured object is not classified as a contact shadow", async () => {
	const textured = await evidence({ shadow: "textured-object" });
	assert.ok(textured.contactShadow.pixelCount > 0);
	assert.ok(textured.contactShadow.chromaP95 > 12);
	assert.ok(textured.contactShadow.localTextureP90 > 15);
	assert.equal(textured.contactShadow.detected, false);
});

test("oversized soft shadows exercise image-area and building-area caps independently", async () => {
	const imageOversized = await evidence({ shadow: "oversized-image" });
	assert.ok(imageOversized.contactShadow.areaFraction > 0.12);
	assert.ok(imageOversized.contactShadow.buildingAreaFraction < 0.5);
	assert.equal(imageOversized.contactShadow.detected, false);
	const buildingOversized = await analyzePresentationPng({
		png: await nonRectangularTransparentPng({ oversizedBuildingShadow: true }),
		buildingBounds: BUILDING_BOUNDS,
		background: BACKGROUND,
	});
	assert.ok(buildingOversized.contactShadow.areaFraction < 0.12);
	assert.ok(buildingOversized.contactShadow.buildingAreaFraction > 0.5);
	assert.equal(buildingOversized.contactShadow.detected, false);
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

test("roof-only plan and top views do not require multi-material separation", async () => {
	const style = resolvePbrRenderStyle();
	const views = viewsFrom(await evidence());
	for (const name of ["plan", "top"]) views[name].materialSeparation = { luminanceSpread: 1, chromaSpread: 1 };
	assert.equal(validatePresentationEvidence({ views, style, styleHash: renderStyleHash(style) }).accepted, true);
	views.axon.materialSeparation = { luminanceSpread: 1, chromaSpread: 1 };
	assert.deepEqual(validatePresentationEvidence({ views, style, styleHash: renderStyleHash(style) }).codes, ["PBR_PRESENTATION_RANGE_INVALID"]);
});

test("semantic role masks measure final role colors and reject collapsed or missing required roles", async () => {
	const analyzeSemanticRolePng = (presentationEvidenceModule as any).analyzeSemanticRolePng;
	const validateSemanticRoleEvidence = (presentationEvidenceModule as any).validateSemanticRoleEvidence;
	assert.equal(typeof analyzeSemanticRolePng, "function");
	assert.equal(typeof validateSemanticRoleEvidence, "function");
	const width = 8, height = 4;
	const roleIds: Record<string, Rgb> = { concrete: [255, 0, 0], glass: [0, 255, 0], bronze: [0, 0, 255], opaque: [255, 255, 0] };
	const roleColors: Record<string, Rgb> = { concrete: [190, 180, 165], glass: [75, 130, 170], bronze: [80, 55, 35], opaque: [135, 120, 105] };
	const mask = Buffer.alloc(width * height * 3);
	const final = Buffer.alloc(width * height * 3);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		const role = Object.keys(roleIds)[Math.floor(x / 2)];
		mask.set(roleIds[role], (y * width + x) * 3);
		final.set(roleColors[role], (y * width + x) * 3);
	}
	const encode = (data: Buffer) => sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
	const measured = await analyzeSemanticRolePng({ finalPng: await encode(final), roleMaskPng: await encode(mask) });
	assert.deepEqual(Object.fromEntries(Object.entries(measured.roles).map(([role, value]: any) => [role, value.pixelCount])), { bronze: 8, concrete: 8, glass: 8, opaque: 8 });
	assert.deepEqual(measured.roles.glass.meanColor, roleColors.glass);
	assert.equal(Object.keys(measured.pairwise).length, 6);
	assert.equal(validateSemanticRoleEvidence({ views: Object.fromEntries(["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"].map((name) => [name, measured])) }).accepted, true);

	const collapsedFinal = Buffer.from(final);
	for (let y = 0; y < height; y++) for (let x = 2; x < 4; x++) collapsedFinal.set(roleColors.concrete, (y * width + x) * 3);
	const collapsed = await analyzeSemanticRolePng({ finalPng: await encode(collapsedFinal), roleMaskPng: await encode(mask) });
	assert.equal(collapsed.pairwise["concrete:glass"].colorDistance, 0);
	const collapsedViews = Object.fromEntries(["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"].map((name) => [name, collapsed]));
	assert.ok(validateSemanticRoleEvidence({ views: collapsedViews }).codes.includes("PBR_SEMANTIC_ROLE_COLLAPSED"));

	const missingMask = Buffer.from(mask);
	for (let y = 0; y < height; y++) for (let x = 2; x < 4; x++) missingMask.set([0, 0, 0], (y * width + x) * 3);
	const missing = await analyzeSemanticRolePng({ finalPng: await encode(final), roleMaskPng: await encode(missingMask) });
	assert.equal(missing.roles.glass.pixelCount, 0);
	const missingViews = Object.fromEntries(["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"].map((name) => [name, missing]));
	assert.ok(validateSemanticRoleEvidence({ views: missingViews }).codes.includes("PBR_SEMANTIC_ROLE_MISSING"));

	const missingBronze = structuredClone(measured);
	missingBronze.roles.bronze.pixelCount = 1;
	missingBronze.roles.bronze.coverageFraction = 1 / 32;
	missingBronze.roles.bronze.visibility = { status: "visible", reason: "authoritative_role_mask_fragments", geometryTriangles: 6104 };
	const missingBronzeViews = Object.fromEntries(["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"].map((name) => [name, structuredClone(missingBronze)]));
	assert.ok(validateSemanticRoleEvidence({ views: missingBronzeViews }).codes.includes("PBR_SEMANTIC_ROLE_MISSING"), "one attributed bronze pixel must not satisfy coverage");
	const insufficientBronzeCoverage = structuredClone(measured);
	insufficientBronzeCoverage.roles.bronze.pixelCount = 4;
	insufficientBronzeCoverage.roles.bronze.coverageFraction = 0.000499;
	const insufficientCoverageViews = Object.fromEntries(["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"].map((name) => [name, structuredClone(insufficientBronzeCoverage)]));
	assert.ok(validateSemanticRoleEvidence({ views: insufficientCoverageViews }).codes.includes("PBR_SEMANTIC_ROLE_MISSING"), "bronze coverage below the relative boundary must be rejected");
	const collapsedBronze = structuredClone(measured);
	collapsedBronze.pairwise["concrete:bronze"].colorDistance = 0;
	const collapsedBronzeViews = Object.fromEntries(["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"].map((name) => [name, structuredClone(collapsedBronze)]));
	assert.ok(validateSemanticRoleEvidence({ views: collapsedBronzeViews }).codes.includes("PBR_SEMANTIC_ROLE_COLLAPSED"));
	const absentOpaqueMask = Buffer.from(mask);
	for (let y = 0; y < height; y++) for (let x = 6; x < 8; x++) absentOpaqueMask.set([0, 0, 0], (y * width + x) * 3);
	const absentOpaque = await analyzeSemanticRolePng({
		finalPng: await encode(final), roleMaskPng: await encode(absentOpaqueMask),
		geometry: { opaque: { triangleCount: 3916 } },
	});
	assert.deepEqual(absentOpaque.roles.opaque.visibility, {
		status: "not_visible", reason: "no_authoritative_role_mask_fragments_survived_depth_and_clipping", geometryTriangles: 3916,
	});

	const boundaryViews = Object.fromEntries(["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"].map((name) => [name, structuredClone(measured)]));
	for (const name of ["front", "back", "left", "right", "axon", "opposite-axon"]) boundaryViews[name].pairwise["concrete:glass"].colorDistance = 5;
	assert.equal(validateSemanticRoleEvidence({ views: boundaryViews }).accepted, true);
	boundaryViews.axon.pairwise["concrete:glass"].colorDistance = 4.99;
	assert.ok(validateSemanticRoleEvidence({ views: boundaryViews }).codes.includes("PBR_SEMANTIC_ROLE_COLLAPSED"));
});

test("legacy improvement requires both grounded axons to improve role-aware material separation", () => {
	const evaluatePresentationImprovement = (presentationEvidenceModule as any).evaluatePresentationImprovement;
	assert.equal(typeof evaluatePresentationImprovement, "function");
	const sample = (luminanceSpread: number, chromaSpread: number, detected: boolean) => ({
		building: { sampleCount: 100, luminanceP05: 40, luminanceP95: 220 },
		background: { sampleCount: 500, deltaP95: 0, luminanceVariance: 0 },
		contactShadow: { detected }, materialSeparation: { luminanceSpread, chromaSpread },
	});
	const baseline = Object.fromEntries(["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"].map((name) => [name, sample(60, 15, false)]));
	const current = structuredClone(baseline);
	for (const name of ["front", "back", "left", "right"]) current[name] = sample(45, 15, false);
	for (const name of ["axon", "opposite-axon"]) current[name] = sample(30, 12, true);
	current.plan = sample(1, 1, false); current.top = sample(1, 1, false);
	const semantic = Object.fromEntries(["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"].map((name) => [name, {
		roles: Object.fromEntries(["concrete", "glass", "bronze", "opaque"].map((role) => [role, { pixelCount: 10 }])),
		pairwise: { "concrete:glass": { colorDistance: 20 }, "concrete:bronze": { colorDistance: 20 }, "concrete:opaque": { colorDistance: 20 }, "glass:bronze": { colorDistance: 20 }, "glass:opaque": { colorDistance: 20 }, "bronze:opaque": { colorDistance: 20 } },
	}]));
	const baselineSemantic = structuredClone(semantic);
	for (const name of ["axon", "opposite-axon"]) for (const pair of ["concrete:glass", "concrete:bronze", "glass:bronze"]) baselineSemantic[name].pairwise[pair].colorDistance = 15;
	const accepted = evaluatePresentationImprovement({ current, baseline, semantic, baselineSemantic });
	assert.equal(accepted.accepted, true);
	assert.equal(accepted.views.axon.groundingImproved, true);
	assert.deepEqual(accepted.views.axon.semanticMaterialScore, { old: 15, new: 20, gain: 5, improved: true });
	assert.equal(accepted.views.front.luminanceRetention, 0.75);
	const collapsedElevation = structuredClone(current); collapsedElevation.front.materialSeparation.luminanceSpread = 44.9;
	assert.equal(evaluatePresentationImprovement({ current: collapsedElevation, baseline, semantic, baselineSemantic }).accepted, false);
	const ungroundedAxon = structuredClone(current); ungroundedAxon.axon.contactShadow.detected = false;
	assert.equal(evaluatePresentationImprovement({ current: ungroundedAxon, baseline, semantic, baselineSemantic }).accepted, false);
	assert.equal(evaluatePresentationImprovement({ current, baseline, semantic }).accepted, false, "grounding alone must not replace legacy semantic evidence");
	const degraded = structuredClone(semantic);
	for (const pair of ["concrete:glass", "concrete:bronze", "glass:bronze"]) degraded["opposite-axon"].pairwise[pair].colorDistance = 14;
	const rejected = evaluatePresentationImprovement({ current, baseline, semantic: degraded, baselineSemantic });
	assert.equal(rejected.accepted, false);
	assert.equal(rejected.views["opposite-axon"].semanticMaterialScore.improved, false);
});
