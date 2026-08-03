import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { sha256 } from "../plugins/elevation-3d/lib/core.mjs";
import { deriveElevationDimensions } from "../plugins/elevation-3d/lib/elevation-dimensions.mjs";
import { resolveMaterialPalette } from "../plugins/elevation-3d/lib/material-palettes.mjs";

const roleNames = ["bronze", "concrete", "glass", "opaque"];
const roleFields = [
	"elevation_fill",
	"axon_pbr",
	"opacity",
	"roughness",
	"metalness",
	"line_contrast",
	"texture_intensity",
	"normal_intensity",
];

test("resolves three complete competition palettes without changing semantic roles", () => {
	for (const id of ["competition-warm", "competition-neutral", "competition-stone"]) {
		const first = resolveMaterialPalette(id);
		const second = resolveMaterialPalette(id);
		assert.deepEqual(Object.keys(first.roles).sort(), roleNames);
		assert.equal(first.schema_version, "arr.elevation3d.material-palette.v1");
		assert.match(first.sha256, /^[a-f0-9]{64}$/);
		assert.equal(first.sha256, second.sha256);
		assert.equal(Object.isFrozen(first), true);
		for (const [roleName, role] of Object.entries(first.roles)) {
			assert.deepEqual(Object.keys(role).sort(), [...roleFields].sort());
			assert.equal(Object.isFrozen(role), true);
			const [minimum, maximum] = roleName === "glass" ? [0.25, 0.85] : [0.85, 1];
			assert.ok(role.opacity >= minimum && role.opacity <= maximum);
		}
	}
});

test("rejects an invisible structural material override", () => {
	assert.throws(
		() => resolveMaterialPalette({ preset: "competition-warm", roles: { concrete: { opacity: 0 } } }),
		/material visibility invalid/,
	);
});

const datasetMassRoot = "D:/Data/50_ELE/MAAS_ELEVATION_TEST_SET_20260730/candidates/creative-013/mass";
const selectedGlbPath = "D:/Data/50_ELE/elevation-3d-e2e-results/creative-013/final-fix-b-round1-20260803-190000/versions/v001/enriched.glb";

async function realCreative013Inputs() {
	const [sourceMesh, floorGuides, facadePlanes, glbBytes] = await Promise.all([
		readFile(`${datasetMassRoot}/mesh/indexed-mesh.json`, "utf8").then(JSON.parse),
		readFile(`${datasetMassRoot}/elevation-research/floor-guides.json`, "utf8").then(JSON.parse),
		readFile(`${datasetMassRoot}/elevation-research/facade-planes.json`, "utf8").then(JSON.parse),
		readFile(selectedGlbPath),
	]);
	return {
		sourceMesh,
		floorGuides,
		facadePlanes,
		artifact: { path: selectedGlbPath, sha256: sha256(glbBytes) },
		view: "front",
	};
}

test("derives front dimensions from parsed exact MASS and authored floor guides", async () => {
	const inputs = await realCreative013Inputs();
	const manifest = await deriveElevationDimensions(inputs);
	assert.equal(manifest.schema_version, "arr.elevation3d.dimension-manifest.v1");
	assert.equal(manifest.view, "front");
	assert.equal(manifest.selected_glb_sha256, inputs.artifact.sha256);
	assert.equal(manifest.geometry_hash, inputs.sourceMesh.identity.geometry_hash);
	assert.equal(manifest.overall_height.value_m, 9.9);
	assert.equal(manifest.overall_height.display_mm, 9900);
	assert.deepEqual(manifest.levels.map((level) => level.label), ["EL. +0.000", "EL. +3.300", "EL. +6.600", "EL. +9.900"]);
	assert.deepEqual(manifest.floor_intervals.map((interval) => interval.display_mm), [3300, 3300, 3300]);
	assert.equal(manifest.overall_height.source.field, "exact-mass.POSITION");
	assert.equal(manifest.overall_width.source.field, "exact-mass.POSITION");
	assert.equal(manifest.levels[0].source.field, "floor_guides.floor_guides_m");
	assert.equal(manifest.facade_extent.width.source.field, "facade_planes.facade_planes");
	assert.equal(manifest.scale_bar.source.field, "exact-mass.POSITION");
});

test("detects a facade extent or guide outside the exact MASS envelope", async () => {
	const inputs = await realCreative013Inputs();
	await assert.rejects(
		() => deriveElevationDimensions({ ...inputs, floorGuides: { ...inputs.floorGuides, floor_guides_m: [0, 3.3, 6.6, 10] } }),
		/dimension source outside exact MASS/,
	);
	const facadePlanes = structuredClone(inputs.facadePlanes);
	facadePlanes.facade_planes.find((plane) => plane.view === "front").extent_m[0] += 1;
	await assert.rejects(
		() => deriveElevationDimensions({ ...inputs, facadePlanes }),
		/dimension source outside exact MASS/,
	);
});
