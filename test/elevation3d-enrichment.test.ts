import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { NodeIO } from "@gltf-transform/core";
import { Triangle, Vector3 } from "three";
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
	assert.equal(scene.details.every((detail) => detail.positions.length >= 6 && detail.indices.length >= 8), true);
});

test("uses equal bay spacing without exceeding facade extents and clamps detail depths", () => {
	const narrowGrammar = { ...grammar, bay_width_m: 3, frame_depth_m: 9, mullion_depth_m: 9 };
	const scene = buildEnrichedScene({ mesh, floorGuides, facadePlanes, grammar: narrowGrammar, safeFallback: false });
	const frontMullions = scene.details.filter((detail) => detail.kind === "mullion" && detail.view === "front");
	assert.deepEqual([...new Set(frontMullions.map((detail) => Number(detail.offset_m.toFixed(12))))],
		[0, Number((8 / 3).toFixed(12)), Number((16 / 3).toFixed(12)), 8]);
	assert.equal(frontMullions.every((detail) => {
		const horizontal = detail.positions.map((point) => point[0] - facadePlanes.facade_planes[0].origin[0]);
		return Math.min(...horizontal) >= -1e-12 && Math.max(...horizontal) <= 8 + 1e-12;
	}), true);
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
	assert.deepEqual([...new Set(middleBands.map((detail) => detail.component_id))].sort(), [0, 1]);
	assert.equal(middleBands.every((detail) => {
		const minimum = Math.min(...detail.positions.map((point) => point[0]));
		const maximum = Math.max(...detail.positions.map((point) => point[0]));
		return (minimum >= -4.18 && maximum <= -1.82) || (minimum >= 1.82 && maximum <= 4.18);
	}), true);
});

test("adds mullion coverage inside every intersecting component span between global bay offsets", () => {
	const narrowComponents = {
		vertices: [
			[-2.8, -2, 0], [-2.2, -2, 0], [-2.2, -2, 6.6], [-2.8, -2, 6.6],
			[0.2, -2, 0], [0.8, -2, 0], [0.8, -2, 6.6], [0.2, -2, 6.6],
		],
		triangles: [[0, 1, 2], [0, 2, 3], [4, 5, 6], [4, 6, 7]],
	};
	const scene = buildEnrichedScene({
		mesh: narrowComponents,
		floorGuides,
		facadePlanes: { facade_planes: [facadePlanes.facade_planes[0]] },
		grammar,
		safeFallback: false,
	});
	const mullionBounds = scene.details
		.filter((detail) => detail.kind === "mullion" && detail.view === "front")
		.map((detail) => {
			const offsets = detail.positions.map((point) => point[0] - facadePlanes.facade_planes[0].origin[0]);
			return [Math.min(...offsets), Math.max(...offsets)];
		});
	const centers = mullionBounds.map(([minimum, maximum]) => (minimum + maximum) / 2);
	assert.equal(centers.some((center) => center >= 1.2 && center <= 1.8), true);
	assert.equal(centers.some((center) => center >= 4.2 && center <= 4.8), true);
	assert.equal(mullionBounds.every(([minimum, maximum]) => (
		(minimum >= 1.2 && maximum <= 1.8) || (minimum >= 4.2 && maximum <= 4.8)
	)), true);
});

test("clips a nominal endpoint mullion to a tiny intersecting component span", () => {
	const tinyComponent = {
		vertices: [
			[-3.99, -2, 0], [-3.985, -2, 0], [-3.985, -2, 6.6], [-3.99, -2, 6.6],
		],
		triangles: [[0, 1, 2], [0, 2, 3]],
	};
	const scene = buildEnrichedScene({
		mesh: tinyComponent,
		floorGuides,
		facadePlanes: { facade_planes: [facadePlanes.facade_planes[0]] },
		grammar,
		safeFallback: false,
	});
	const mullions = scene.details.filter((detail) => detail.kind === "mullion");
	assert.deepEqual([...new Set(mullions.map((detail) => detail.offset_m))], [0]);
	assert.equal(mullions.every((detail) => {
		const offsets = detail.positions.map((point) => point[0] - facadePlanes.facade_planes[0].origin[0]);
		return Math.min(...offsets) >= 0.01 - 1e-12 && Math.max(...offsets) <= 0.015 + 1e-12;
	}), true);
});

test("keeps detached components separate when their facade projections overlap", () => {
	const overlapping = {
		vertices: [
			[-1, -2, 0], [1, -2, 0], [1, -2, 6.6], [-1, -2, 6.6],
			[-1, -1, 0], [1, -1, 0], [1, -1, 6.6], [-1, -1, 6.6],
		],
		triangles: [[0, 1, 2], [0, 2, 3], [4, 5, 6], [4, 6, 7]],
	};
	const scene = buildEnrichedScene({ mesh: overlapping, floorGuides, facadePlanes, grammar, safeFallback: false });
	const attachedComponents = [...new Set(scene.details
		.filter((detail) => detail.kind === "floor-band" && detail.view === "front" && detail.elevation_m === 3.3)
		.map((detail) => detail.component_id))].sort();
	assert.deepEqual(attachedComponents, [0, 1]);
});

test("recesses glazing inward from its authored facade surface", () => {
	const scene = buildEnrichedScene({ mesh, floorGuides, facadePlanes, grammar, safeFallback: false });
	const frontGlass = scene.details.find((detail) => detail.kind === "glazing" && detail.view === "front");
	assert.ok(frontGlass);
	const signedDepths = frontGlass.positions.map((point) => (
		(point[0] - facadePlanes.facade_planes[0].origin[0]) * facadePlanes.facade_planes[0].normal[0]
		+ (point[1] - facadePlanes.facade_planes[0].origin[1]) * facadePlanes.facade_planes[0].normal[1]
	));
	assert.equal(Math.max(...signedDepths) <= 1e-12, true);
	assert.equal(Math.min(...signedDepths) < 0, true);
});

test("uses concrete floor bands and creates grammar-height concrete parapets", () => {
	const scene = buildEnrichedScene({ mesh, floorGuides, facadePlanes, grammar, safeFallback: false });
	assert.equal(scene.details.filter((detail) => detail.kind === "floor-band").every((detail) => detail.material === "concrete"), true);
	const parapets = scene.details.filter((detail) => detail.kind === "parapet");
	assert.equal(parapets.length > 0, true);
	assert.equal(parapets.every((detail) => detail.material === "concrete"), true);
	assert.equal(parapets.every((detail) => detail.positions.every((point) => point[2] >= 6.6 - grammar.parapet_height_m - 1e-12)), true);
});

test("keeps every generated detail vertex within strict distance of a real source triangle", () => {
	const triangularMesh = {
		vertices: [[-2, -1, 0], [2, -1, 0], [-2, -1, 3]],
		triangles: [[0, 1, 2]],
	};
	const guides = { floor_guides_m: [0, 1.5, 3] };
	const planes = { facade_planes: [{ view: "front", origin: [-2, -1, 0], normal: [0, -1, 0], extent_m: [4, 3] }] };
	const scene = buildEnrichedScene({ mesh: triangularMesh, floorGuides: guides, facadePlanes: planes, grammar, safeFallback: false });
	const sourceTriangle = new Triangle(...triangularMesh.vertices.map((point) => new Vector3(...point)));
	const target = new Vector3();
	const maximumDistance = Math.max(...scene.details.flatMap((detail) => detail.positions.map((point) => {
		const sample = new Vector3(...point);
		return sourceTriangle.closestPointToPoint(sample, target).distanceTo(sample);
	})));
	assert.equal(maximumDistance <= Math.max(grammar.frame_depth_m, grammar.mullion_depth_m) + 0.01 + 1e-12, true);
});

test("uses attached component triangles to cover a floor guide when facing triangles do not reach it", () => {
	const recessedGround = {
		vertices: [
			[-1, -1, 1], [1, -1, 1], [1, -1, 3], [-1, -1, 3],
			[-1, 1, 0], [-1, 1, 1],
		],
		triangles: [[0, 1, 2], [0, 2, 3], [0, 4, 5]],
	};
	const guides = { floor_guides_m: [0, 1, 3] };
	const planes = { facade_planes: [{ view: "front", origin: [-1, -1, 0], normal: [0, -1, 0], extent_m: [2, 3] }] };
	const scene = buildEnrichedScene({ mesh: recessedGround, floorGuides: guides, facadePlanes: planes, grammar, safeFallback: false });
	assert.equal(scene.details.some((detail) => detail.kind === "floor-band" && detail.view === "front" && detail.elevation_m === 0), true);
});

test("clips every detail to the authored facade tangent and elevation rectangle", () => {
	const wideTriangle = {
		vertices: [[-10, -1, 0], [10, -1, 0], [-10, -1, 10]],
		triangles: [[0, 1, 2]],
	};
	const planes = { facade_planes: [{ view: "front", origin: [-1, -1, 0], normal: [0, -1, 0], extent_m: [2, 3] }] };
	const scene = buildEnrichedScene({
		mesh: wideTriangle,
		floorGuides: { floor_guides_m: [0, 1.5, 3] },
		facadePlanes: planes,
		grammar,
		safeFallback: false,
	});
	assert.equal(scene.details.some((detail) => detail.kind === "floor-band"), true);
	assert.equal(scene.details.some((detail) => detail.kind === "parapet"), true);
	for (const detail of scene.details) for (const point of detail.positions) {
		assert.equal(point[0] >= -1 - 1e-10 && point[0] <= 1 + 1e-10, true);
		assert.equal(point[2] >= -1e-10 && point[2] <= 3 + 1e-10, true);
	}
});
