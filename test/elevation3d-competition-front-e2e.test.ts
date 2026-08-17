import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { renderCompetitionElevation } from "../plugins/elevation-3d/lib/competition-elevation.mjs";
import { sha256 } from "../plugins/elevation-3d/lib/core.mjs";
import { deriveElevationDimensions } from "../plugins/elevation-3d/lib/elevation-dimensions.mjs";
import { resolveMaterialPalette } from "../plugins/elevation-3d/lib/material-palettes.mjs";
import { validateCompetitionElevation } from "../plugins/elevation-3d/lib/elevation-presentation-validation.mjs";
import { resolveElevation3dAssets } from "./helpers/elevation3d-assets.ts";

const assets = resolveElevation3dAssets({ start: dirname(fileURLToPath(import.meta.url)), datasetOverride: process.env.ELEVATION3D_DATASET_ROOT, glbOverride: process.env.ELEVATION3D_SELECTED_GLB });
const massRoot = join(assets.datasetRoot, "candidates", "creative-013", "mass");
const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function inputs() {
	const [sourceMesh, floorGuides, facadePlanes, cameras, glbBytes] = await Promise.all([
		readFile(join(massRoot, "mesh/indexed-mesh.json"), "utf8").then(JSON.parse),
		readFile(join(massRoot, "elevation-research/floor-guides.json"), "utf8").then(JSON.parse),
		readFile(join(massRoot, "elevation-research/facade-planes.json"), "utf8").then(JSON.parse),
		readFile(join(massRoot, "elevation-research/camera-poses.json"), "utf8").then(JSON.parse),
		readFile(assets.selectedGlb),
	]);
	const camera = { name: "front", identity: cameras.identity, ...cameras.views.front };
	const dimensions = await deriveElevationDimensions({ sourceMesh, floorGuides, facadePlanes, artifact: { path: assets.selectedGlb, sha256: sha256(glbBytes) }, view: camera });
	return { sourceMesh, floorGuides, facadePlanes, camera, dimensions };
}

async function writeCurtainWallSpoof(path: string, nodeName: string) {
	const document = new Document();
	const buffer = document.createBuffer();
	const positions = document.createAccessor().setType("VEC3").setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer);
	const indices = document.createAccessor().setType("SCALAR").setArray(new Uint16Array([0, 1, 2])).setBuffer(buffer);
	const material = document.createMaterial("glass").setAlphaMode("BLEND");
	const primitive = document.createPrimitive().setAttribute("POSITION", positions).setIndices(indices).setMaterial(material).setExtras({ kind: "glazing" });
	const node = document.createNode(nodeName).setMesh(document.createMesh("curtain-wall").addPrimitive(primitive));
	document.createScene().addChild(node);
	await new NodeIO().write(path, document);
}

test("renders and accepts a dimensioned creative-013 front with complete provenance", { timeout: 180_000 }, async () => {
	const runDir = await mkdtemp(join(tmpdir(), "elevation3d-final-front-")); roots.push(runDir);
	const input = await inputs();
	const palette = resolveMaterialPalette("competition-warm");
	const artifacts = await renderCompetitionElevation({ runDir, glbPath: assets.selectedGlb, ...input, palette, view: "front", candidateId: "creative-013" });
	assert.deepEqual(await sharp(artifacts.final_png.path).metadata().then(({ width, height }) => [width, height]), [2400, 2400]);
	assert.equal(artifacts.validation.accepted, true, artifacts.validation.codes.join(", "));
	assert.deepEqual(artifacts.validation.codes, []);
	assert.deepEqual(artifacts.displayed_dimensions.levels, [0, 3300, 6600, 9900]);
	assert.deepEqual(artifacts.displayed_dimensions.floor_intervals, [3300, 3300, 3300]);
	assert.equal(artifacts.displayed_dimensions.overall_height, 9900);
	assert.equal(artifacts.presentation.authored_dark_geometry.invalid_pixels, 0);
	assert.ok(artifacts.presentation.authored_dark_geometry.valid_pixels > 0);
	assert.equal(artifacts.presentation.authored_dark_geometry.suppressed_screen_artifact_pixels, 0);
	// Every dark component has to be accounted for as authored geometry, and a silhouette
	// has to be one the selected GLB's depth buffer actually covers. Pinning two component
	// bounding boxes said this only about two of them, and the boxes moved the moment the
	// base pass was encoded to sRGB - the dark test is a luminance threshold, so a correct
	// transfer function reshapes which pixels fall under it. The property is what mattered.
	const evidence = artifacts.presentation.authored_dark_geometry.component_evidence;
	const silhouettes = evidence.filter((item) => item.classification === "selected-glb-depth-silhouette");
	assert.ok(silhouettes.length > 0, "no dark component was traced to the selected GLB depth buffer");
	for (const item of evidence) {
		assert.ok(["selected-glb-depth-silhouette", "semantic-bronze-opaque"].includes(item.classification), `unclassified dark component at ${item.bbox_px}`);
	}
	for (const item of silhouettes) {
		assert.equal(item.finite_depth_pixels, item.pixels, `silhouette at ${item.bbox_px} is not fully covered by the depth buffer`);
	}
	assert.notEqual(artifacts.base_manifest.path, artifacts.render_manifest.path);
	assert.match(artifacts.base_manifest.path, /front-base-render-manifest\.json$/);
	for (const record of [artifacts.final_png, artifacts.presentation_base_png, artifacts.annotations_svg, artifacts.dimensions_json, artifacts.base_manifest, artifacts.render_manifest, artifacts.validation_report, ...Object.values(artifacts.diagnostics)]) {
		assert.equal(sha256(await readFile(record.path)), record.sha256);
	}
});

test("rejects rehashed visible SVG dimension tampering even when data attributes remain authoritative", { timeout: 180_000 }, async () => {
	const runDir = await mkdtemp(join(tmpdir(), "elevation3d-svg-tamper-")); roots.push(runDir);
	const input = await inputs();
	const artifacts = await renderCompetitionElevation({ runDir, glbPath: assets.selectedGlb, ...input, palette: resolveMaterialPalette("competition-warm"), view: "front", candidateId: "creative-013" });
	const svg = await readFile(artifacts.annotations_svg.path, "utf8");
	const tamperedSvg = svg.replace(/(<text[^>]*data-source-id="overall-height"[^>]*>)9900(<\/text>)/, "$19901$2");
	assert.notEqual(tamperedSvg, svg);
	await writeFile(artifacts.annotations_svg.path, tamperedSvg);
	artifacts.annotations_svg.sha256 = sha256(await readFile(artifacts.annotations_svg.path));
	const tamperedFinal = await sharp(artifacts.presentation_base_png.path).composite([{ input: Buffer.from(tamperedSvg) }]).png().toBuffer();
	await writeFile(artifacts.final_png.path, tamperedFinal);
	artifacts.final_png.sha256 = sha256(tamperedFinal);
	const manifest = JSON.parse(await readFile(artifacts.render_manifest.path, "utf8"));
	manifest.provenance.annotations_svg_sha256 = artifacts.annotations_svg.sha256;
	manifest.provenance.final_png_sha256 = artifacts.final_png.sha256;
	await writeFile(artifacts.render_manifest.path, JSON.stringify(manifest, null, 2));
	artifacts.render_manifest.sha256 = sha256(await readFile(artifacts.render_manifest.path));
	const report = await validateCompetitionElevation({ artifacts, sourceMesh: input.sourceMesh, facadePlanes: input.facadePlanes, floorGuides: input.floorGuides, view: input.camera, selectedGlbPath: assets.selectedGlb });
	assert.equal(report.accepted, false);
	assert.ok(report.codes.includes("DIMENSION_MISMATCH"));
});

test("rejects a hidden authoritative label with an unbound visible overlay after full rehash", { timeout: 180_000 }, async () => {
	const runDir = await mkdtemp(join(tmpdir(), "elevation3d-svg-overlay-")); roots.push(runDir);
	const input = await inputs();
	const artifacts = await renderCompetitionElevation({ runDir, glbPath: assets.selectedGlb, ...input, palette: resolveMaterialPalette("competition-warm"), view: "front", candidateId: "creative-013" });
	const svg = await readFile(artifacts.annotations_svg.path, "utf8");
	const tamperedSvg = svg
		.replace(/(<text[^>]*data-source-id="overall-height")/, "$1 opacity=\"0\"")
		.replace("</svg>", '<text x="76.5" y="1200" class="dimension-label halo" text-anchor="middle" transform="rotate(-90 76.5 1200)">9901</text></svg>');
	assert.notEqual(tamperedSvg, svg);
	await writeFile(artifacts.annotations_svg.path, tamperedSvg);
	artifacts.annotations_svg.sha256 = sha256(await readFile(artifacts.annotations_svg.path));
	const tamperedFinal = await sharp(artifacts.presentation_base_png.path).composite([{ input: Buffer.from(tamperedSvg) }]).png().toBuffer();
	await writeFile(artifacts.final_png.path, tamperedFinal);
	artifacts.final_png.sha256 = sha256(tamperedFinal);
	const manifest = JSON.parse(await readFile(artifacts.render_manifest.path, "utf8"));
	manifest.provenance.annotations_svg_sha256 = artifacts.annotations_svg.sha256;
	manifest.provenance.final_png_sha256 = artifacts.final_png.sha256;
	await writeFile(artifacts.render_manifest.path, JSON.stringify(manifest, null, 2));
	artifacts.render_manifest.sha256 = sha256(await readFile(artifacts.render_manifest.path));
	const report = await validateCompetitionElevation({ artifacts, sourceMesh: input.sourceMesh, facadePlanes: input.facadePlanes, floorGuides: input.floorGuides, view: input.camera, selectedGlbPath: assets.selectedGlb });
	assert.equal(report.accepted, false);
	assert.ok(report.codes.includes("DIMENSION_MISMATCH"));
});

test("rejects a rehashed black seam-heavy final PNG from persisted pixels", { timeout: 180_000 }, async () => {
	const runDir = await mkdtemp(join(tmpdir(), "elevation3d-png-tamper-")); roots.push(runDir);
	const input = await inputs();
	const artifacts = await renderCompetitionElevation({ runDir, glbPath: assets.selectedGlb, ...input, palette: resolveMaterialPalette("competition-warm"), view: "front", candidateId: "creative-013" });
	const stripes = `<svg width="2400" height="2400" xmlns="http://www.w3.org/2000/svg"><defs><pattern id="p" width="12" height="12" patternUnits="userSpaceOnUse"><path d="M0 0H12V6H0Z" fill="#000"/></pattern></defs><rect x="215" y="805" width="1970" height="790" fill="url(#p)"/></svg>`;
	const bytes = await sharp(artifacts.final_png.path).composite([{ input: Buffer.from(stripes) }]).png().toBuffer();
	await writeFile(artifacts.final_png.path, bytes);
	artifacts.final_png.sha256 = sha256(bytes);
	const manifest = JSON.parse(await readFile(artifacts.render_manifest.path, "utf8"));
	manifest.provenance.final_png_sha256 = artifacts.final_png.sha256;
	await writeFile(artifacts.render_manifest.path, JSON.stringify(manifest, null, 2));
	artifacts.render_manifest.sha256 = sha256(await readFile(artifacts.render_manifest.path));
	const report = await validateCompetitionElevation({ artifacts, sourceMesh: input.sourceMesh, facadePlanes: input.facadePlanes, floorGuides: input.floorGuides, view: input.camera, selectedGlbPath: assets.selectedGlb });
	assert.equal(report.accepted, false);
	assert.ok(report.codes.includes("LINE_DENSITY_EXCEEDED"));
	assert.ok(report.codes.includes("MATERIAL_VISIBILITY_INVALID"));
});

test("rejects a one-millimetre dimension tamper and visible seam overload", async () => {
	const input = await inputs();
	const report = await validateCompetitionElevation({
		artifacts: {
			base: { width: 2400, height: 2400, selected_glb_sha256: input.dimensions.selected_glb_sha256, camera: { ...input.camera, type: "orthographic", px_per_m_x: 80, px_per_m_y: 80 }, content_bounds_px: { min_x: 216, min_y: 800, max_x: 2183, max_y: 1599 }, diagnostics: { total_edge_density: 0.06, strong_edge_density: 0.04, same_material_seam_fraction: 0.002, seam_segments: { visible: 2, longest_px: 185 }, role_pixel_counts: { concrete: 1, glass: 1, bronze: 1, opaque: 1 } } },
			dimensions: { ...input.dimensions, overall_height: { ...input.dimensions.overall_height, display_mm: 9901 } },
			annotation: { overlaps_content: false, overlaps_annotations: false, min_page_clearance_px: 48 },
		},
		sourceMesh: input.sourceMesh, facadePlanes: input.facadePlanes, floorGuides: input.floorGuides,
		view: input.camera, selectedGlbPath: assets.selectedGlb,
	});
	assert.equal(report.accepted, false);
	assert.ok(report.codes.includes("DIMENSION_MISMATCH"));
	assert.ok(report.codes.includes("LINE_DENSITY_EXCEEDED"));
	assert.ok(report.codes.includes("TRIANGULATION_VISIBLE"));
});

test("does not relax dark-pixel limits for renamed or facade-details curtain-wall spoofs", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-typed-spoof-")); roots.push(root);
	const input = await inputs();
	for (const nodeName of ["facade-details", "renamed-facade-details"]) {
		const glbPath = join(root, `${nodeName}.glb`);
		await writeCurtainWallSpoof(glbPath, nodeName);
		const glbHash = sha256(await readFile(glbPath));
		const report = await validateCompetitionElevation({
			artifacts: {
				base: {
					width: 2400, height: 2400, selected_glb_sha256: glbHash, typed_facade: true,
					camera: { ...input.camera, type: "orthographic", px_per_m_x: 80, px_per_m_y: 80 },
					content_bounds_px: { min_x: 216, min_y: 800, max_x: 2183, max_y: 1599 },
					diagnostics: {
						dark_pixel_fraction: 0.2, total_edge_density: 0.02, strong_edge_density: 0.02,
						same_material_seam_fraction: 0, seam_segments: { visible: 0, longest_px: 0 },
						role_pixel_counts: { concrete: 1, glass: 1, bronze: 1, opaque: 1 },
					},
				},
				dimensions: { ...input.dimensions, selected_glb_sha256: glbHash },
				annotation: { overlaps_content: false, overlaps_annotations: false, min_page_clearance_px: 48 },
			},
			sourceMesh: input.sourceMesh, facadePlanes: input.facadePlanes, floorGuides: input.floorGuides,
			view: input.camera, selectedGlbPath: glbPath,
		});
		assert.ok(report.codes.includes("MATERIAL_VISIBILITY_INVALID"), `${nodeName} spoof relaxed the dark-pixel limit`);
		assert.equal(report.metrics.typed_facade_artifact, false);
		assert.equal(report.metrics.typed_facade_receipt_bound, false);
	}
});
