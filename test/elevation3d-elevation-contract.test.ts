import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { NodeIO } from "@gltf-transform/core";
import { sha256 } from "../plugins/elevation-3d/lib/core.mjs";
import { deriveElevationDimensions } from "../plugins/elevation-3d/lib/elevation-dimensions.mjs";
import { writeEnrichedGlb } from "../plugins/elevation-3d/lib/enrichment.mjs";
import { resolveMaterialPalette } from "../plugins/elevation-3d/lib/material-palettes.mjs";

const temporaryRoots: string[] = [];
after(async () => Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true }))));

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

test("rejects overrides that erase or corrupt required material parameters", () => {
	const invalidOverrides = [
		{ role: "concrete", values: { elevation_fill: undefined } },
		{ role: "glass", values: { axon_pbr: 7 } },
		{ role: "bronze", values: { roughness: Number.NaN } },
		{ role: "opaque", values: { metalness: 2 } },
		{ role: "concrete", values: { line_contrast: -0.1 } },
		{ role: "concrete", values: { texture_intensity: Number.POSITIVE_INFINITY } },
		{ role: "concrete", values: { normal_intensity: "high" } },
		{ role: "concrete", values: { unsupported: 1 } },
	];
	for (const { role, values } of invalidOverrides) {
		assert.throws(
			() => resolveMaterialPalette({ preset: "competition-warm", roles: { [role]: values } }),
			/material parameter invalid/,
		);
	}
});

test("retains the complete material schema after a valid partial override", () => {
	const palette = resolveMaterialPalette({ preset: "competition-warm", roles: { concrete: { roughness: 0.75 } } });
	assert.deepEqual(Object.keys(palette.roles).sort(), roleNames);
	assert.deepEqual(Object.keys(palette.roles.concrete).sort(), [...roleFields].sort());
	assert.equal(palette.roles.concrete.roughness, 0.75);
});

const datasetMassRoot = "D:/Data/50_ELE/MAAS_ELEVATION_TEST_SET_20260730/candidates/creative-013/mass";
const selectedGlbPath = "D:/Data/50_ELE/elevation-3d-e2e-results/creative-013/final-fix-b-round1-20260803-190000/versions/v001/enriched.glb";

async function realCreative013Inputs() {
	const [sourceMesh, floorGuides, facadePlanes, cameras, glbBytes] = await Promise.all([
		readFile(`${datasetMassRoot}/mesh/indexed-mesh.json`, "utf8").then(JSON.parse),
		readFile(`${datasetMassRoot}/elevation-research/floor-guides.json`, "utf8").then(JSON.parse),
		readFile(`${datasetMassRoot}/elevation-research/facade-planes.json`, "utf8").then(JSON.parse),
		readFile(`${datasetMassRoot}/elevation-research/camera-poses.json`, "utf8").then(JSON.parse),
		readFile(selectedGlbPath),
	]);
	return {
		sourceMesh,
		floorGuides,
		facadePlanes,
		artifact: { path: selectedGlbPath, sha256: sha256(glbBytes) },
		view: { name: "front", identity: cameras.identity, ...cameras.views.front },
	};
}

async function rotatedFixture() {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-dimensions-"));
	temporaryRoots.push(root);
	const horizontal = [Math.SQRT1_2, Math.SQRT1_2, 0];
	const vertical = [0, 0, 1];
	const normal = [Math.SQRT1_2, -Math.SQRT1_2, 0];
	const point = (x: number, depth: number, z: number) => [0, 1, 2].map((axis) => horizontal[axis] * x + normal[axis] * depth + vertical[axis] * z);
	const vertices = [
		point(-2, -1, 0), point(2, -1, 0), point(2, 1, 0), point(-2, 1, 0),
		point(-2, -1, 3), point(2, -1, 3), point(2, 1, 3), point(-2, 1, 3),
	];
	const triangles = [
		[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
		[0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
		[2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
	];
	const identity = { candidate_id: "rotated", geometry_hash: "rotated-geometry", program_hash: "rotated-program", run_id: "rotated-run" };
	const artifact = await writeEnrichedGlb({ base: { positions: vertices, indices: triangles }, details: [] }, join(root, "rotated.glb"));
	return {
		sourceMesh: { identity, vertices, triangles },
		artifact,
		facadePlanes: { identity, facade_planes: [{ view: "front", origin: point(-2, -1, 0), normal, extent_m: [4, 3] }] },
		floorGuides: { identity, floor_guides_m: [0, 1.5, 3] },
		view: { name: "front", identity, projection: "orthographic", projection_axes: { horizontal, vertical, depth: normal } },
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

test("uses selected GLB exact-mass bounds instead of stale sourceMesh bounds", async () => {
	const inputs = await realCreative013Inputs();
	inputs.sourceMesh.bounds = { min: [-100, 0, -100], max: [100, 0, 100] };
	const manifest = await deriveElevationDimensions(inputs);
	assert.equal(manifest.overall_width.display_mm, 24361);
	assert.equal(manifest.overall_height.display_mm, 9900);
});

test("rejects a larger exact-mass GLB carrying the source identity", async () => {
	const inputs = await rotatedFixture();
	const positions = [...inputs.sourceMesh.vertices, [0, 0, 1], [0.1, 0.1, 1], [0, 0.1, 1.1]];
	const indices = [...inputs.sourceMesh.triangles, [8, 9, 10]];
	inputs.artifact = await writeEnrichedGlb(
		{ base: { positions, indices }, details: [] },
		inputs.artifact.path.replace("rotated.glb", "mismatched.glb"),
	);
	await assert.rejects(() => deriveElevationDimensions(inputs), /exact MASS geometry mismatch/);
});

test("rejects translated or scaled exact-mass nodes before reading local accessors", async () => {
	for (const transform of ["translation", "scale"]) {
		const inputs = await rotatedFixture();
		const io = new NodeIO();
		const document = await io.read(inputs.artifact.path);
		const exactMass = document.getRoot().listNodes().find((node) => node.getName() === "exact-mass");
		if (transform === "translation") exactMass.setTranslation([0.25, 0, 0]);
		else exactMass.setScale([1.1, 1, 1]);
		await io.write(inputs.artifact.path, document);
		inputs.artifact.sha256 = sha256(await readFile(inputs.artifact.path));
		await assert.rejects(() => deriveElevationDimensions(inputs), /exact MASS transform invalid/);
	}
});

test("projects rotated exact MASS geometry with authoritative front camera axes", async () => {
	const manifest = await deriveElevationDimensions(await rotatedFixture());
	assert.equal(manifest.overall_width.value_m, 4);
	assert.equal(manifest.overall_height.value_m, 3);
	assert.equal(manifest.overall_width.value_m / manifest.overall_height.value_m, 4 / 3);
	assert.deepEqual(manifest.projected_bounds_m.source.projection_axes.horizontal, [Math.SQRT1_2, Math.SQRT1_2, 0]);
});

test("checks a rotated facade extent in authoritative projected coordinates", async () => {
	const inputs = await rotatedFixture();
	inputs.facadePlanes.facade_planes[0].extent_m[0] = 5;
	await assert.rejects(() => deriveElevationDimensions(inputs), /dimension source outside exact MASS/);
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

test("rejects authored guides and facade planes bound to stale identities", async () => {
	const guideInputs = await realCreative013Inputs();
	guideInputs.floorGuides.identity = { ...guideInputs.floorGuides.identity, geometry_hash: "stale-geometry" };
	await assert.rejects(() => deriveElevationDimensions(guideInputs), /dimension source identity mismatch: floorGuides.geometry_hash/);

	const facadeInputs = await realCreative013Inputs();
	facadeInputs.facadePlanes.identity = { ...facadeInputs.facadePlanes.identity, candidate_id: "creative-stale" };
	await assert.rejects(() => deriveElevationDimensions(facadeInputs), /dimension source identity mismatch: facadePlanes.candidate_id/);
});

test("rejects malformed or non-finite facade plane coordinates and extents", async () => {
	const mutations = [
		(plane) => { plane.origin = [0, 0]; },
		(plane) => { plane.origin[0] = Number.NaN; },
		(plane) => { plane.normal = [0, -1]; },
		(plane) => { plane.normal[1] = Number.POSITIVE_INFINITY; },
		(plane) => { plane.normal = [0, -2, 0]; },
		(plane) => { plane.extent_m[0] = "24.361488"; },
		(plane) => { plane.extent_m[1] = Number.NaN; },
	];
	for (const mutate of mutations) {
		const inputs = await realCreative013Inputs();
		mutate(inputs.facadePlanes.facade_planes.find((plane) => plane.view === "front"));
		await assert.rejects(() => deriveElevationDimensions(inputs), /dimension source invalid: facade_planes.facade_planes/);
	}
});
