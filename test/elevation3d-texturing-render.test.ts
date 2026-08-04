import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import sharp from "sharp";
import { renderEmbeddedPbrViews, validateEmbeddedPbrRender } from "../plugins/elevation-3d/lib/texturing/render-validator.mjs";
import { renderStyleHash, resolvePbrRenderStyle } from "../plugins/elevation-3d/lib/texturing/render-style.mjs";

const names = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];
const selectedGlbSha256 = "a".repeat(64);
const temporaryRoots: string[] = [];

after(async () => Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

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

async function presentationPng(viewIndex: number, diagnostic = false, presentation = true) {
	const width = 100, height = 100;
	const data = Buffer.alloc(width * height * 3, 0);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		const offset = (y * width + x) * 3;
		let color = [250, 250, 247];
		if (x >= 10 && x <= 89 && y >= 5 && y <= 84) {
			const light = diagnostic ? 105 : 70 + ((x + y + viewIndex) % 6) * 24;
			color = diagnostic ? [light, light, light] : [light, Math.min(240, light + 28), Math.max(20, light - 18)];
		} else if (presentation && y === 85 && x >= 20 && x <= 39) {
			const light = 212 - Math.floor((x - 20) / 3) * 3;
			color = [light, light, light];
		}
		if (!diagnostic && x === 50 && y === 50) color = [80 + viewIndex, 120, 60];
		data[offset] = color[0]; data[offset + 1] = color[1]; data[offset + 2] = color[2];
	}
	return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function writeProceduralBaseline(root: string) {
	const views: Record<string, unknown> = {};
	for (const name of names) {
		const manifestPath = join("views", name, "view.json");
		await mkdir(join(root, "views", name), { recursive: true });
		await writeFile(join(root, manifestPath), JSON.stringify({ building_content: { bounds_px: { min_x: 10, min_y: 5, max_x: 89, max_y: 84 } } }));
		views[name] = { width: 100, height: 100, manifest: { path: manifestPath } };
	}
	await writeFile(join(root, "all-views-manifest.json"), JSON.stringify({ views }));
}

test("render-only v2 delivery persists resolved style, per-view evidence, baseline comparison, and final hashes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-render-artifacts-"));
	temporaryRoots.push(root);
	const runDir = join(root, "render");
	const baselineRunDir = join(root, "procedural");
	const presentationBaselineRunDir = join(root, "v6");
	const glbPath = join(root, "textured.glb");
	await mkdir(presentationBaselineRunDir, { recursive: true });
	await writeFile(glbPath, Buffer.from("unchanged textured glb"));
	await writeProceduralBaseline(baselineRunDir);
	await writeFile(join(presentationBaselineRunDir, "render-validation.json"), JSON.stringify({
		schema_version: "arr.elevation3d.embedded-pbr-render.v1",
		validation: { accepted: true }, presentation_evidence: validPresentationEvidence(),
	}));
	const textured = await Promise.all(names.map((_, index) => presentationPng(index)));
	const geometryTextured = await Promise.all(names.map((_, index) => presentationPng(index, false, false)));
	const diagnostic = await Promise.all(names.map((_, index) => presentationPng(index, true, false)));
	let activeView = "axon", embeddedMaps = true, presentationVisible = true;
	const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString("base64")}`;
	const page = {
		on: () => {}, setViewport: async () => {}, goto: async () => {}, waitForFunction: async () => {}, close: async () => {},
		evaluate: async (callback: Function, argument?: string) => {
			const source = callback.toString();
			if (source.includes("activateView")) { activeView = argument!; return; }
			if (source.includes("const first =")) return [dataUrl(textured[names.indexOf(activeView)]), dataUrl(textured[names.indexOf(activeView)])];
			if (source.includes("__ELEVATION3D_VIEWER_STATE__")) return {
				camera: { type: names.slice(0, 6).includes(activeView) ? "orthographic" : "perspective" },
				presentation: { style: { id: "competition-daylight-v1", hash: renderStyleHash(resolvePbrRenderStyle()) }, view: activeView },
			};
			if (source.includes("setEmbeddedMaps(false)")) { embeddedMaps = false; return; }
			if (source.includes("setEmbeddedMaps(true)")) { embeddedMaps = true; return; }
			if (source.includes("setPresentationObjectsVisible(false)")) { presentationVisible = false; return; }
			if (source.includes("setPresentationObjectsVisible(true)")) { presentationVisible = true; return; }
			if (source.includes("presentationEvidence")) return { style: { id: "competition-daylight-v1" }, view: activeView };
			if (source.includes("embeddedPbrEvidence")) return { embedded_maps: true };
			if (source.includes("settledPng")) return dataUrl(embeddedMaps
				? (presentationVisible ? textured[names.indexOf(activeView)] : geometryTextured[names.indexOf(activeView)])
				: diagnostic[names.indexOf(activeView)]);
			throw new Error(`unexpected browser callback: ${source}`);
		},
	};
	const browser = { newPage: async () => page, close: async () => {} };
	const report = await renderEmbeddedPbrViews({
		glbPath, runDir, candidateId: "creative-013", cameras: {}, baselineRunDir, presentationBaselineRunDir,
		outputSize: 100,
		lifecycle: { startPreview: async () => "http://127.0.0.1:4173/", stopPreview: async () => {}, launchBrowser: async () => browser },
	});

	assert.equal(report.schema_version, "arr.elevation3d.embedded-pbr-render.v2");
	assert.equal(report.provider_calls, 0); assert.equal(report.credits_consumed, 0);
	assert.equal(report.validation.accepted, true, JSON.stringify(report.validation));
	assert.equal(report.views.axon.baselineProjectedExtentDelta, 0, "presentation-only pixels must not expand procedural geometry bounds");
	const style = JSON.parse(await readFile(join(runDir, "render-style.json"), "utf8"));
	assert.equal(style.id, "competition-daylight-v1");
	const viewerConfig = JSON.parse(await readFile(join(runDir, "viewer", "config.json"), "utf8"));
	assert.deepEqual(viewerConfig.all_views.render_style, style);
	assert.equal(viewerConfig.all_views.render_style_sha256, renderStyleHash(style));
	const evidence = JSON.parse(await readFile(join(runDir, "presentation-evidence.json"), "utf8"));
	assert.deepEqual(Object.keys(evidence.views), names);
	assert.equal(evidence.views.front.browser.view, "front");
	assert.equal(evidence.views.front.image.image.width, 100);
	const comparison = JSON.parse(await readFile(join(runDir, "baseline-comparison.json"), "utf8"));
	assert.equal(comparison.status, "compared");
	assert.deepEqual(Object.keys(comparison.views), names);
	for (const artifact of ["render-style.json", "presentation-evidence.json", "baseline-comparison.json", "render-validation.json", "contact-sheet.png"]) {
		await access(join(runDir, artifact));
	}
	for (const name of names) await access(join(runDir, "views", name, `${name}.png`));
	for (const record of Object.values(report.artifacts) as any[]) assert.match(record.sha256, /^[a-f0-9]{64}$/);
	const persistedBytes = await readFile(join(runDir, "render-validation.json"));
	assert.deepEqual(JSON.parse(persistedBytes.toString("utf8")), report);
	assert.equal(
		(await readFile(join(runDir, "render-validation.sha256"), "utf8")).trim(),
		createHash("sha256").update(persistedBytes).digest("hex"),
	);

	for (const [label, baselineReport, reason] of [
		["missing", null, "baseline_missing"],
		["rejected", { schema_version: "arr.elevation3d.embedded-pbr-render.v1", validation: { accepted: false }, presentation_evidence: validPresentationEvidence() }, "baseline_not_accepted"],
		["empty evidence", { schema_version: "arr.elevation3d.embedded-pbr-render.v1", validation: { accepted: true }, presentation_evidence: {} }, "baseline_evidence_incomplete"],
		["incomplete evidence", { schema_version: "arr.elevation3d.embedded-pbr-render.v1", validation: { accepted: true }, presentation_evidence: { front: validPresentationEvidence().front } }, "baseline_evidence_incomplete"],
	] as const) await t.test(`${label} v6 presentation baseline is not compared`, async () => {
		const baselineDir = join(root, `v6-${label.replaceAll(" ", "-")}`);
		if (baselineReport) {
			await mkdir(baselineDir, { recursive: true });
			await writeFile(join(baselineDir, "render-validation.json"), JSON.stringify(baselineReport));
		}
		const withoutBaseline = await renderEmbeddedPbrViews({
			glbPath, runDir: join(root, `render-${label.replaceAll(" ", "-")}`), candidateId: "creative-013", cameras: {}, baselineRunDir,
			presentationBaselineRunDir: baselineDir, outputSize: 100,
			lifecycle: { startPreview: async () => "http://127.0.0.1:4173/", stopPreview: async () => {}, launchBrowser: async () => browser },
		});
		assert.equal(withoutBaseline.baseline_comparison.status, "not_compared");
		assert.equal(withoutBaseline.baseline_comparison.reason, reason);
		assert.equal(withoutBaseline.validation.accepted, true, JSON.stringify(withoutBaseline.validation));
	});
});
