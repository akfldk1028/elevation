import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { NodeIO } from "@gltf-transform/core";
import { buildEnrichedScene, writeEnrichedGlb } from "../plugins/elevation-3d/lib/enrichment.mjs";

const temporaryRoots: string[] = [];

after(async () => {
	await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

const mesh = {
	vertices: [
		[-4, -2, 0], [4, -2, 0], [4, 2, 0], [-4, 2, 0],
		[-4, -2, 6.6], [4, -2, 6.6], [4, 2, 6.6], [-4, 2, 6.6],
	],
	triangles: [
		[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
		[0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
		[2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
	],
};

const floorGuides = { floor_guides_m: [0, 3.3, 6.6] };
const facadePlanes = {
	facade_planes: [
		{ view: "front", origin: [-4, -2, 0], normal: [0, -1, 0], extent_m: [8, 6.6] },
		{ view: "right", origin: [4, -2, 0], normal: [1, 0, 0], extent_m: [4, 6.6] },
		{ view: "back", origin: [4, 2, 0], normal: [0, 1, 0], extent_m: [8, 6.6] },
		{ view: "left", origin: [-4, 2, 0], normal: [-1, 0, 0], extent_m: [4, 6.6] },
	],
};
const grammar = {
	bay_width_m: 2,
	frame_depth_m: 0.18,
	mullion_depth_m: 0.08,
	glazing_recess_m: 0.12,
	parapet_height_m: 0.35,
};

test("preserves every source vertex and triangle in the base primitive", () => {
	const scene = buildEnrichedScene({ mesh, floorGuides, facadePlanes, grammar, safeFallback: false });
	assert.deepEqual(scene.base.positions, mesh.vertices);
	assert.deepEqual(scene.base.indices, mesh.triangles);
});

test("creates floor bands at every authored guide and mullions on every facade plane", () => {
	const scene = buildEnrichedScene({ mesh, floorGuides, facadePlanes, grammar, safeFallback: false });
	assert.deepEqual(
		[...new Set(scene.details.filter((detail) => detail.kind === "floor-band").map((detail) => detail.elevation_m))],
		[0, 3.3, 6.6],
	);
	assert.deepEqual(
		[...new Set(scene.details.filter((detail) => detail.kind === "mullion").map((detail) => detail.view))].sort(),
		["back", "front", "left", "right"],
	);
	assert.equal(scene.details.every((detail) => detail.positions.length === 8 && detail.indices.length === 12), true);
});

test("uses equal bay spacing without exceeding facade extents and clamps detail depths", () => {
	const narrowGrammar = { ...grammar, bay_width_m: 3, frame_depth_m: 9, mullion_depth_m: 9 };
	const scene = buildEnrichedScene({ mesh, floorGuides, facadePlanes, grammar: narrowGrammar, safeFallback: false });
	const frontMullions = scene.details.filter((detail) => detail.kind === "mullion" && detail.view === "front");
	assert.deepEqual(frontMullions.map((detail) => detail.offset_m), [0, 8 / 3, 16 / 3, 8]);
	assert.equal(frontMullions.every((detail) => detail.depth_m === 0.12), true);
	assert.equal(scene.details.filter((detail) => detail.kind === "floor-band").every((detail) => detail.depth_m === 0.25), true);
});

test("exports a parseable GLB containing the immutable base and all detail materials", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-enrichment-"));
	temporaryRoots.push(root);
	const output = join(root, "enriched.glb");
	const scene = buildEnrichedScene({ mesh, floorGuides, facadePlanes, grammar, safeFallback: false });
	const artifact = await writeEnrichedGlb(scene, output);
	const parsed = await new NodeIO().read(output);
	const parsedMeshes = parsed.getRoot().listMeshes();
	const base = parsedMeshes.find((item) => item.getName() === "exact-mass")?.listPrimitives()[0];

	assert.ok(parsedMeshes.length >= 2);
	assert.deepEqual(Array.from(base?.getAttribute("POSITION")?.getArray() ?? []), Array.from(new Float32Array(mesh.vertices.flat())));
	assert.deepEqual(Array.from(base?.getIndices()?.getArray() ?? []), mesh.triangles.flat());
	assert.deepEqual(
		[...new Set(parsedMeshes.flatMap((item) => item.listPrimitives().map((primitive) => primitive.getMaterial()?.getName())))].sort(),
		["bronze", "concrete", "glass", "opaque"],
	);
	const glass = parsed.getRoot().listMaterials().find((material) => material.getName() === "glass");
	assert.equal(glass?.getAlphaMode(), "BLEND");
	assert.equal(glass?.getDoubleSided(), true);
	assert.deepEqual(glass?.getBaseColorFactor(), [0.72, 0.86, 0.92, 0.28]);
	assert.deepEqual([...artifact.materials].sort(), ["bronze", "concrete", "glass", "opaque"]);
	assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
	assert.deepEqual(artifact.bounds, { min: [-4.18, -2.18, 0], max: [4.18, 2.18, 6.6] });
});

test("safe fallback exports only exact base geometry with conservative material", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-fallback-"));
	temporaryRoots.push(root);
	const output = join(root, "fallback.glb");
	const scene = buildEnrichedScene({ mesh, floorGuides, facadePlanes, grammar, safeFallback: true });
	assert.equal(scene.details.length, 0);
	const artifact = await writeEnrichedGlb(scene, output);
	const parsed = await new NodeIO().read(output);
	assert.equal(parsed.getRoot().listMeshes().length, 1);
	assert.deepEqual(artifact.materials, ["concrete"]);
	assert.deepEqual(artifact.detail_primitives, []);
});

test("splits facade details across disconnected source components intersecting the plane", () => {
	const disconnectedMesh = {
		vertices: [
			[-4, -2, 0], [-2, -2, 0], [-2, 2, 0], [-4, 2, 0],
			[-4, -2, 6.6], [-2, -2, 6.6], [-2, 2, 6.6], [-4, 2, 6.6],
			[2, -2, 0], [4, -2, 0], [4, 2, 0], [2, 2, 0],
			[2, -2, 6.6], [4, -2, 6.6], [4, 2, 6.6], [2, 2, 6.6],
		],
		triangles: [
			[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
			[1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
			[8, 10, 9], [8, 11, 10], [12, 13, 14], [12, 14, 15], [8, 9, 13], [8, 13, 12],
			[9, 10, 14], [9, 14, 13], [10, 11, 15], [10, 15, 14], [11, 8, 12], [11, 12, 15],
		],
	};
	const scene = buildEnrichedScene({
		mesh: disconnectedMesh,
		floorGuides,
		facadePlanes: { facade_planes: [facadePlanes.facade_planes[0]] },
		grammar,
		safeFallback: false,
	});
	const middleBands = scene.details.filter((detail) => detail.kind === "floor-band" && detail.elevation_m === 3.3);
	assert.equal(middleBands.length, 2);
	assert.deepEqual(
		middleBands.map((detail) => [Math.min(...detail.positions.map((point) => point[0])), Math.max(...detail.positions.map((point) => point[0]))]),
		[[-4, -2], [2, 4]],
	);
});
