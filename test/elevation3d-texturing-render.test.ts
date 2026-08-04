import assert from "node:assert/strict";
import { test } from "node:test";
import { validateEmbeddedPbrRender } from "../plugins/elevation-3d/lib/texturing/render-validator.mjs";
import { renderStyleHash, resolvePbrRenderStyle } from "../plugins/elevation-3d/lib/texturing/render-style.mjs";

const names = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];
const selectedGlbSha256 = "a".repeat(64);

function validViews() {
	return Object.fromEntries(names.map((name, index) => [name, {
		selectedGlbSha256,
		sha256: String(index).padStart(64, "0"),
		settledHashes: [String(index).padStart(64, "0"), String(index).padStart(64, "0")],
		foregroundFraction: 0.2,
		silhouetteIou: 1,
		projectedExtentDelta: 0,
		baselineProjectedExtentDelta: 0,
		cameraType: names.slice(0, 6).includes(name) ? "orthographic" : "perspective",
		pbrPixelDelta: names.includes("axon") ? 2 : names.includes("opposite-axon") ? 2 : null,
	}]));
}

function validPresentationEvidence() {
	return Object.fromEntries(names.map((name) => [name, {
		building: { sampleCount: 100, luminanceP05: 40, luminanceP95: 210 },
		background: { sampleCount: 500, deltaP95: 0, luminanceVariance: 0 },
		contactShadow: { detected: name === "axon" || name === "opposite-axon", areaFraction: 0.04, insideBuildingPixels: 0 },
		materialSeparation: { luminanceSpread: 55, chromaSpread: 35 },
	}]));
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
		renderStyle: style, renderStyleSha256, presentationEvidence,
	}), { accepted: true, status: "accepted", codes: [] });
	presentationEvidence.axon.contactShadow.detected = false;
	assert.ok(validateEmbeddedPbrRender({
		views, selectedGlbSha256, consoleErrors: [], materialMode: "embedded-pbr",
		renderStyle: style, renderStyleSha256, presentationEvidence,
	}).codes.includes("PBR_CONTACT_SHADOW_MISSING"));
	presentationEvidence.axon.contactShadow.detected = true;
	presentationEvidence.front.building.luminanceP95 = 255;
	assert.ok(validateEmbeddedPbrRender({
		views, selectedGlbSha256, consoleErrors: [], materialMode: "embedded-pbr",
		renderStyle: style, renderStyleSha256, presentationEvidence,
	}).codes.includes("PBR_PRESENTATION_RANGE_INVALID"));
	assert.ok(validateEmbeddedPbrRender({
		views, selectedGlbSha256, consoleErrors: [], materialMode: "embedded-pbr",
		renderStyle: style, renderStyleSha256: "f".repeat(64), presentationEvidence,
	}).codes.includes("PBR_RENDER_STYLE_INVALID"));
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
