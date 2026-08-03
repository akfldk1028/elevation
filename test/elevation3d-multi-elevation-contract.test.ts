import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { sha256 } from "../plugins/elevation-3d/lib/core.mjs";
import { buildElevationAnnotations } from "../plugins/elevation-3d/lib/elevation-annotations.mjs";
import { deriveElevationDimensions } from "../plugins/elevation-3d/lib/elevation-dimensions.mjs";
import { validateCompetitionElevation } from "../plugins/elevation-3d/lib/elevation-presentation-validation.mjs";

const datasetMassRoot = "D:/Data/50_ELE/MAAS_ELEVATION_TEST_SET_20260730/candidates/creative-013/mass";
const selectedGlbPath = "D:/Data/50_ELE/elevation-3d-e2e-results/creative-013/final-fix-b-round1-20260803-190000/versions/v001/enriched.glb";
const elevationNames = ["front", "back", "left", "right"] as const;
const temporaryRoots: string[] = [];

after(async () => Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true }))));

async function realInputs() {
	const [sourceMesh, floorGuides, facadePlanes, cameras, glbBytes] = await Promise.all([
		readFile(`${datasetMassRoot}/mesh/indexed-mesh.json`, "utf8").then(JSON.parse),
		readFile(`${datasetMassRoot}/elevation-research/floor-guides.json`, "utf8").then(JSON.parse),
		readFile(`${datasetMassRoot}/elevation-research/facade-planes.json`, "utf8").then(JSON.parse),
		readFile(`${datasetMassRoot}/elevation-research/camera-poses.json`, "utf8").then(JSON.parse),
		readFile(selectedGlbPath),
	]);
	return { sourceMesh, floorGuides, facadePlanes, cameras, artifact: { path: selectedGlbPath, sha256: sha256(glbBytes) } };
}

function annotationBase(view) {
	const [[minimumHorizontal, minimumVertical], [maximumHorizontal, maximumVertical]] = view.projected_bounds_m;
	const scale = 79.60685862;
	const center = [(minimumHorizontal + maximumHorizontal) / 2, (minimumVertical + maximumVertical) / 2];
	const point = ([horizontal, vertical]) => [1200 + (horizontal - center[0]) * scale, 1200 - (vertical - center[1]) * scale];
	const minimum = point([minimumHorizontal, maximumVertical]);
	const maximum = point([maximumHorizontal, minimumVertical]);
	return {
		camera: { type: "orthographic", projection_axes: view.projection_axes, center_m: center, px_per_m_x: scale, px_per_m_y: scale },
		contentBounds: { min_x: Math.floor(minimum[0]), min_y: Math.floor(minimum[1]), max_x: Math.ceil(maximum[0]), max_y: Math.ceil(maximum[1]) },
	};
}

test("all named elevations derive exact projected dimensions from the selected GLB", async () => {
	const inputs = await realInputs();
	const facadeIndexByView = { front: 0, back: 2, left: 3, right: 1 };
	for (const plane of inputs.facadePlanes.facade_planes) plane.view = "non-authoritative-label";
	for (const name of elevationNames) {
		const dimensions = await deriveElevationDimensions({
			...inputs,
			view: { name, identity: inputs.cameras.identity, ...inputs.cameras.views[name] },
		});
		assert.equal(dimensions.view, name);
		assert.equal(dimensions.overall_height.display_mm, 9900);
		assert.deepEqual(dimensions.levels.map((level) => level.label), [
			"EL. +0.000", "EL. +3.300", "EL. +6.600", "EL. +9.900",
		]);
		assert.ok(dimensions.overall_width.display_mm > 0);
		assert.equal(dimensions.facade_extent.width.source.index, facadeIndexByView[name]);
	}
});

test("rejects ambiguous facade planes aligned to the same elevation camera", async () => {
	const inputs = await realInputs();
	inputs.facadePlanes.facade_planes.push(structuredClone(inputs.facadePlanes.facade_planes[0]));
	await assert.rejects(
		() => deriveElevationDimensions({
			...inputs,
			view: { name: "front", identity: inputs.cameras.identity, ...inputs.cameras.views.front },
		}),
		/dimension source invalid: ambiguous elevation facade plane/,
	);
});

test("ignores a malformed unrelated facade normal after selecting the aligned elevation", async () => {
	const inputs = await realInputs();
	inputs.facadePlanes.facade_planes.find((plane) => plane.view === "right").normal = [Number.NaN, 0, 0];
	const dimensions = await deriveElevationDimensions({
		...inputs,
		view: { name: "front", identity: inputs.cameras.identity, ...inputs.cameras.views.front },
	});
	assert.equal(dimensions.view, "front");
	assert.equal(dimensions.facade_extent.width.source.index, 0);
});

test("validation rejects camera axes substituted from another named elevation", async () => {
	const inputs = await realInputs();
	const view = { name: "front", identity: inputs.cameras.identity, ...inputs.cameras.views.front };
	const dimensions = await deriveElevationDimensions({ ...inputs, view });
	const base = annotationBase(view);
	const report = await validateCompetitionElevation({
		artifacts: {
			base: {
				width: 2400,
				height: 2400,
				camera: { ...base.camera, projection_axes: inputs.cameras.views.back.projection_axes },
				content_bounds_px: base.contentBounds,
				selected_glb_sha256: inputs.artifact.sha256,
			},
			dimensions,
		},
		sourceMesh: inputs.sourceMesh,
		facadePlanes: inputs.facadePlanes,
		floorGuides: inputs.floorGuides,
		view,
		selectedGlbPath,
	});
	assert.ok(report.codes.includes("ELEVATION_AXIS_MISMATCH"));
});

test("validation rejects a dimension manifest from the wrong symmetric elevation", async () => {
	const inputs = await realInputs();
	const backView = { name: "back", identity: inputs.cameras.identity, ...inputs.cameras.views.back };
	const frontDimensions = await deriveElevationDimensions({
		...inputs,
		view: { name: "front", identity: inputs.cameras.identity, ...inputs.cameras.views.front },
	});
	const base = annotationBase(backView);
	const report = await validateCompetitionElevation({
		artifacts: {
			base: { width: 2400, height: 2400, camera: base.camera, content_bounds_px: base.contentBounds, selected_glb_sha256: inputs.artifact.sha256 },
			dimensions: frontDimensions,
		},
		sourceMesh: inputs.sourceMesh,
		facadePlanes: inputs.facadePlanes,
		floorGuides: inputs.floorGuides,
		view: backView,
		selectedGlbPath,
	});
	assert.ok(report.codes.includes("DIMENSION_MISMATCH"));
});

test("validation rejects non-finite or non-numeric camera axis components", async () => {
	const inputs = await realInputs();
	const view = { name: "front", identity: inputs.cameras.identity, ...inputs.cameras.views.front };
	const dimensions = await deriveElevationDimensions({ ...inputs, view });
	const base = annotationBase(view);
	for (const horizontal of [[Number.NaN, 0, 0], [1, null, null], ["1", 0, 0]]) {
		const report = await validateCompetitionElevation({
			artifacts: {
				base: {
					width: 2400,
					height: 2400,
					camera: { ...base.camera, projection_axes: { ...base.camera.projection_axes, horizontal } },
					content_bounds_px: base.contentBounds,
					selected_glb_sha256: inputs.artifact.sha256,
				},
				dimensions,
			},
			sourceMesh: inputs.sourceMesh,
			facadePlanes: inputs.facadePlanes,
			floorGuides: inputs.floorGuides,
			view,
			selectedGlbPath,
		});
		assert.ok(report.codes.includes("ELEVATION_AXIS_MISMATCH"), `axis accepted: ${JSON.stringify(horizontal)}`);
	}
});

test("all named elevations build collision-free canonical SVG with the correct title and width", async () => {
	const inputs = await realInputs();
	for (const name of elevationNames) {
		const view = { name, identity: inputs.cameras.identity, ...inputs.cameras.views[name] };
		const dimensions = await deriveElevationDimensions({ ...inputs, view });
		const base = annotationBase(view);
		const annotation = buildElevationAnnotations({ dimensions, camera: base.camera, contentBounds: base.contentBounds, candidateId: "creative-013" });
		assert.match(annotation.svg, new RegExp(`>${dimensions.overall_width.display_mm}<`));
		assert.match(annotation.svg, new RegExp(`>${name.toUpperCase()} ELEVATION<`));
		assert.equal(annotation.overlaps_content, false);
		assert.equal(annotation.overlaps_annotations, false);
	}
});

test("validation rejects a re-hashed back elevation with an altered canonical label", async () => {
	const inputs = await realInputs();
	const name = "back";
	const view = { name, identity: inputs.cameras.identity, ...inputs.cameras.views[name] };
	const dimensions = await deriveElevationDimensions({ ...inputs, view });
	const base = annotationBase(view);
	const canonical = buildElevationAnnotations({ dimensions, camera: base.camera, contentBounds: base.contentBounds, candidateId: "creative-013" }).svg;
	const altered = canonical.replace(`>${dimensions.overall_width.display_mm}</text>`, `>${dimensions.overall_width.display_mm + 1}</text>`);
	assert.notEqual(altered, canonical);
	const root = await mkdtemp(join(tmpdir(), "elevation3d-multi-view-"));
	temporaryRoots.push(root);
	const svgPath = join(root, "back.svg");
	await writeFile(svgPath, altered);
	const report = await validateCompetitionElevation({
		artifacts: {
			base: { width: 2400, height: 2400, camera: base.camera, content_bounds_px: base.contentBounds, selected_glb_sha256: inputs.artifact.sha256 },
			dimensions,
			annotations_svg: { path: svgPath, sha256: sha256(await readFile(svgPath)) },
		},
		sourceMesh: inputs.sourceMesh,
		facadePlanes: inputs.facadePlanes,
		floorGuides: inputs.floorGuides,
		view,
		selectedGlbPath,
	});
	assert.ok(report.codes.includes("DIMENSION_MISMATCH") || report.codes.includes("ANNOTATION_CANONICAL_MISMATCH"));
});
