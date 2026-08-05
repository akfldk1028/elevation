import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { buildPunchedFacadeDetails } from "../plugins/elevation-3d/lib/facade-agent/punched-facade.mjs";
import * as punchedFacade from "../plugins/elevation-3d/lib/facade-agent/punched-facade.mjs";
import { createFacadePbrMaps } from "../plugins/elevation-3d/lib/facade-agent/procedural-materials.mjs";
import { buildEnrichedScene } from "../plugins/elevation-3d/lib/enrichment.mjs";

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
const facadePlanes = (punchedFacade as any).deriveFacadeSegmentsFromMass({ mesh });
const grammar = {
	system: "brick-punched-window-v1",
	surfaces: ["front", "right", "back", "left"],
	materials: ["brick", "precast", "window-frame", "glass"],
	corner_datum_m: 0,
	bay_width_m: 2.4,
	window_width_m: 1.2,
	window_height_m: 1.65,
	sill_height_m: 0.85,
	reveal_depth_m: 0.22,
	frame_width_m: 0.06,
	lintel_height_m: 0.18,
	sill_depth_m: 0.08,
	cladding_depth_m: 0.12,
	brick_module_m: [0.215, 0.065],
	confidence: 0.92,
	unresolved_surfaces: [],
};

test("derives the real creative-020 closed-shell perimeter as 16 deterministic backed segments", async () => {
	const source = JSON.parse(await readFile("D:/Data/50_ELE/MAAS_ELEVATION_TEST_SET_20260730/candidates/creative-020/mass/mesh/indexed-mesh.json", "utf8"));
	assert.throws(() => buildPunchedFacadeDetails({
		mesh: source,
		floorGuides: { floor_guides_m: [0, 3.3, 6.6, 9.9, 13.2, 16.5] },
		facadePlanes: { facade_planes: [
			{ view: "front", origin: [-5.325923, -5.325923, 0], normal: [0, -1, 0], extent_m: [10.651846, 16.5] },
		] },
		grammar: { ...grammar, bay_width_m: 1.2, window_width_m: 0.8 },
	}), /segment authority/i);
	assert.equal(typeof (punchedFacade as any).deriveFacadeSegmentsFromMass, "function");
	const derive = (punchedFacade as any).deriveFacadeSegmentsFromMass;
	const first = derive({ mesh: source });
	const permuted = derive({ mesh: { ...source, triangles: [...source.triangles].reverse() } });
	assert.equal(first.schema_version, "arr.elevation3d.facade-segments.v1");
	assert.equal(first.source_signed_volume_orientation, 1);
	assert.match(first.source_geometry_sha256, /^[a-f0-9]{64}$/);
	assert.equal(first.segments.length, 16);
	assert.deepEqual(permuted.facade_planes, first.facade_planes);
	assert.notEqual(permuted.source_geometry_sha256, first.source_geometry_sha256);
	assert.equal(new Set(first.segments.map((segment: any) => segment.segment_id)).size, 16);
	assert.equal(first.segments.every((segment: any) => segment.mass_backed === true && segment.outward === true), true);
	assert.equal(first.segments.every((segment: any) => segment.extent_m[0] > 0 && segment.extent_m[1] === 16.5), true);
	const cornerCounts = Map.groupBy(first.segments.flatMap((segment: any) => [segment.start_corner_id, segment.end_corner_id]), (value: string) => value);
	assert.equal([...cornerCounts.values()].every((ids) => ids.length === 2), true);
	for (let index = 0; index < first.segments.length; index++) {
		assert.equal(first.segments[index].end_corner_id, first.segments[(index + 1) % first.segments.length].start_corner_id);
	}
	const reversedFace = structuredClone(source);
	reversedFace.triangles[0].reverse();
	assert.throws(() => derive({ mesh: reversedFace }), /closed|orientation|topology/i);
	const reversedShell = { ...source, triangles: source.triangles.map((triangle: number[]) => [...triangle].reverse()) };
	assert.throws(() => derive({ mesh: reversedShell }), /approved|orientation|winding/i);
	assert.throws(() => derive({ mesh: { ...source, triangles: source.triangles.slice(1) } }), /closed|topology/i);
	const disconnected = structuredClone(source);
	const offset = disconnected.vertices.length;
	disconnected.vertices.push([20, 20, 0], [21, 20, 0], [20, 21, 0], [20, 20, 1]);
	disconnected.triangles.push(...[[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]].map((triangle) => triangle.map((value) => value + offset)));
	assert.throws(() => derive({ mesh: disconnected }), /connected|component|topology/i);
});

test("recomputes exact creative-020 segment authority before allocating facade details", async () => {
	const source = JSON.parse(await readFile("D:/Data/50_ELE/MAAS_ELEVATION_TEST_SET_20260730/candidates/creative-020/mass/mesh/indexed-mesh.json", "utf8"));
	const derive = (punchedFacade as any).deriveFacadeSegmentsFromMass;
	const authority = derive({ mesh: source });
	const floors = { floor_guides_m: [0, 3.3, 6.6, 9.9, 13.2, 16.5] };
	const realGrammar = { ...grammar, bay_width_m: 1.2, window_width_m: 0.8 };
	assert.ok(buildPunchedFacadeDetails({ mesh: source, floorGuides: floors, facadePlanes: authority, grammar: realGrammar }).length > 0);

	const oneSegment = structuredClone(authority);
	oneSegment.facade_planes = [{ ...oneSegment.facade_planes[0], end_corner_id: oneSegment.facade_planes[0].start_corner_id }];
	oneSegment.segments = structuredClone(oneSegment.facade_planes);
	const omitted = structuredClone(authority);
	omitted.facade_planes = omitted.facade_planes.slice(1);
	omitted.segments = structuredClone(omitted.facade_planes);
	const extra = structuredClone(authority);
	extra.facade_planes.push({ ...extra.facade_planes[0], segment_id: "forged-extra-segment" });
	extra.segments = structuredClone(extra.facade_planes);
	const reordered = structuredClone(authority);
	reordered.facade_planes = [...reordered.facade_planes.slice(1), reordered.facade_planes[0]];
	reordered.segments = structuredClone(reordered.facade_planes);
	const mutated = structuredClone(authority);
	mutated.facade_planes[0].extent_m[0] += 0.01;
	mutated.segments = structuredClone(mutated.facade_planes);
	const downgraded = { facade_planes: authority.facade_planes.slice(0, 4).map((plane: any) => ({
		view: plane.view, origin: plane.origin, normal: plane.normal, extent_m: plane.extent_m,
	})) };
	for (const forged of [oneSegment, omitted, extra, reordered, mutated, downgraded]) {
		assert.throws(() => buildPunchedFacadeDetails({
			mesh: source, floorGuides: floors, facadePlanes: forged, grammar: realGrammar,
		}), /segment authority/i);
	}
	const reversedShell = { ...source, triangles: source.triangles.map((triangle: number[]) => [...triangle].reverse()) };
	assert.throws(() => buildPunchedFacadeDetails({
		mesh: reversedShell, floorGuides: floors, facadePlanes: downgraded, grammar: realGrammar,
	}), /approved|orientation|winding/i);
});

function facadeBackingMesh(plane: { origin: number[]; normal: number[]; extent_m: number[] }, backingDepth = 1) {
	const tangent = [-plane.normal[1], plane.normal[0], 0];
	const point = (u: number, v: number, depth: number) => plane.origin.map((value, axis) => (
		value + tangent[axis] * u + (axis === 2 ? v : 0) - plane.normal[axis] * depth
	));
	const width = plane.extent_m[0];
	const height = plane.extent_m[1];
	return {
		vertices: [
			point(0, 0, 0), point(width, 0, 0), point(width, height, 0), point(0, height, 0),
			point(0, 0, backingDepth), point(width, 0, backingDepth), point(width, height, backingDepth), point(0, height, backingDepth),
		],
		triangles: [
			[0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
			[0, 4, 5], [0, 5, 1], [3, 2, 6], [3, 6, 7],
			[0, 3, 7], [0, 7, 4], [1, 5, 6], [1, 6, 2],
		],
	};
}

function distance(left: number[], right: number[]) {
	return Math.hypot(...left.map((value, index) => value - right[index]));
}

test("builds opaque brick cladding around genuinely recessed punched windows without mutating MASS", () => {
	const details = buildPunchedFacadeDetails({ mesh, floorGuides, facadePlanes, grammar });
	const scene = buildEnrichedScene({ mesh, floorGuides, facadePlanes, grammar, safeFallback: false });
	assert.ok(details.some((item) => item.kind === "brick-cladding"));
	assert.ok(details.some((item) => item.kind === "window-reveal" && item.depth_m >= 0.18));
	assert.ok(details.some((item) => item.kind === "precast-lintel"));
	assert.ok(details.some((item) => item.kind === "precast-sill"));
	assert.equal(details.some((item) => item.kind === "mullion" || item.material === "curtain-wall"), false);
	assert.deepEqual(scene.base.positions, mesh.vertices);
	assert.deepEqual(scene.base.indices, mesh.triangles);
	assert.ok(details.filter((item) => item.material === "brick")
		.every((item) => item.uvs.length === item.positions.length));
});

test("joins adjacent facade corner returns on one deterministic anchor and never exceeds outward cladding depth", () => {
	const details = buildPunchedFacadeDetails({ mesh, floorGuides, facadePlanes, grammar });
	const cornerGroups = Map.groupBy(details.filter((detail) => detail.kind === "corner-return"), (detail) => detail.corner_anchor_id);
	const joined = [...cornerGroups.values()].find((items) => (
		items.some((item) => item.view === "front") && items.some((item) => item.view === "right")
	));
	assert.ok(joined);
	const front = joined.find((item) => item.view === "front");
	const right = joined.find((item) => item.view === "right");
	assert.equal(front.floor_m, right.floor_m);
	assert.ok(distance(front.anchor_position, right.anchor_position) < 1e-5);
	for (const detail of details) {
		const plane = facadePlanes.facade_planes.find((candidate) => candidate.view === detail.view);
		const outward = detail.positions.map((point) => point.reduce((sum, value, axis) => (
			sum + (value - plane.origin[axis]) * plane.normal[axis]
		), 0));
		assert.ok(Math.max(...outward) <= grammar.cladding_depth_m + 1e-5);
	}
});

test("keeps glazing visible in front of immutable MASS while recessed behind the cladding face", () => {
	const details = buildPunchedFacadeDetails({ mesh, floorGuides, facadePlanes, grammar });
	for (const reveal of details.filter((detail) => detail.kind === "window-reveal")) {
		const plane = facadePlanes.facade_planes.find((candidate) => candidate.view === reveal.view);
		const signedDepths = reveal.positions.map((point) => point.reduce((sum, value, axis) => (
			sum + (value - plane.origin[axis]) * plane.normal[axis]
		), 0));
		assert.ok(Math.abs(Math.max(...signedDepths) - Math.min(...signedDepths) - reveal.depth_m) < 1e-9);
	}
	for (const glazing of details.filter((detail) => detail.kind === "glazing")) {
		const plane = facadePlanes.facade_planes.find((candidate) => candidate.view === glazing.view);
		const signedDepths = glazing.positions.map((point) => point.reduce((sum, value, axis) => (
			sum + (value - plane.origin[axis]) * plane.normal[axis]
		), 0));
		assert.ok(Math.min(...signedDepths) > 0, "opaque MASS must not occlude glazing");
		assert.ok(Math.max(...signedDepths) < grammar.cladding_depth_m, "glazing must remain recessed");
	}
});

test("assigns one reusable geometry signature to repeated bay primitives", () => {
	const details = buildPunchedFacadeDetails({ mesh, floorGuides, facadePlanes, grammar });
	const repeated = details.filter((detail) => detail.kind === "glazing" && detail.view === "front");
	assert.ok(repeated.length > 1);
	assert.equal(new Set(repeated.map((detail) => detail.geometry_signature)).size, 1);
});

test("rejects malformed source geometry rather than silently clipping facade details", () => {
	assert.throws(
		() => buildPunchedFacadeDetails({ mesh: { ...mesh, triangles: [[0, 1, 99]] }, floorGuides, facadePlanes, grammar }),
		/invalid facade source geometry/i,
	);
});

test("creates deterministic, decodable procedural PBR maps", async () => {
	const first = createFacadePbrMaps({ grammar, resolution: 64 });
	const second = createFacadePbrMaps({ grammar, resolution: 64 });
	for (const materialName of ["brick", "precast"]) for (const channel of ["baseColor", "normal", "metallicRoughness"]) {
		const left = first[materialName][channel];
		const right = second[materialName][channel];
		assert.equal(left.sha256, right.sha256);
		assert.equal(left.data.equals(right.data), true);
		const metadata = await sharp(left.data).metadata();
		assert.deepEqual([metadata.width, metadata.height], [64, 64]);
		assert.equal(metadata.format, "png");
	}
});

test("accepts the deterministic bay-count boundary and independently rejects bay-count and facade-width overruns", () => {
	const boundaryPlane = { ...facadePlanes.facade_planes[0], extent_m: [115.2, 6.6] };
	const boundaryMesh = facadeBackingMesh(boundaryPlane, 2);
	assert.ok(buildPunchedFacadeDetails({
		mesh: boundaryMesh, floorGuides, facadePlanes: (punchedFacade as any).deriveFacadeSegmentsFromMass({ mesh: boundaryMesh }), grammar: { ...grammar, bay_width_m: 0.9, window_width_m: 0.6 },
	}).length > 0);
	const bayOverrunPlane = { ...boundaryPlane, extent_m: [116.1, 6.6] };
	const bayOverrunMesh = facadeBackingMesh(bayOverrunPlane);
	assert.throws(() => buildPunchedFacadeDetails({
		mesh: bayOverrunMesh,
		floorGuides,
		facadePlanes: (punchedFacade as any).deriveFacadeSegmentsFromMass({ mesh: bayOverrunMesh }),
		grammar: { ...grammar, bay_width_m: 0.9, window_width_m: 0.6 },
	}), /facade bay count budget exceeded/i);
	const widthOverrunPlane = { ...boundaryPlane, extent_m: [120.1, 6.6] };
	const widthOverrunMesh = facadeBackingMesh(widthOverrunPlane);
	assert.throws(() => buildPunchedFacadeDetails({
		mesh: widthOverrunMesh,
		floorGuides,
		facadePlanes: (punchedFacade as any).deriveFacadeSegmentsFromMass({ mesh: widthOverrunMesh }),
		grammar,
	}), /facade width budget exceeded/i);
});

test("rejects excessive dense floor guides and projected detail primitives before constructing output", () => {
	const boundaryGuides = { floor_guides_m: Array.from({ length: 65 }, (_, index) => index * 3.3) };
	const boundaryPlane = { ...facadePlanes.facade_planes[0], extent_m: [4, boundaryGuides.floor_guides_m.at(-1)] };
	const boundaryMesh = facadeBackingMesh(boundaryPlane, 4);
	assert.ok(buildPunchedFacadeDetails({
		mesh: boundaryMesh,
		floorGuides: boundaryGuides,
		facadePlanes: (punchedFacade as any).deriveFacadeSegmentsFromMass({ mesh: boundaryMesh }),
		grammar,
	}).length > 0);
	const excessiveGuides = { floor_guides_m: Array.from({ length: 66 }, (_, index) => index * 3.3) };
	assert.throws(() => buildPunchedFacadeDetails({
		mesh,
		floorGuides: excessiveGuides,
		facadePlanes: { facade_planes: [{ ...facadePlanes.facade_planes[0], extent_m: [8, excessiveGuides.floor_guides_m.at(-1)] }] },
		grammar,
	}), /floor guide budget exceeded/i);

	const manyFloors = { floor_guides_m: Array.from({ length: 6 }, (_, index) => index * 3.3) };
	const wideMesh = { ...mesh, vertices: mesh.vertices.map(([x, y, z]) => [x * 5, y * 10, z * 2.5]) };
	const widePlanes = (punchedFacade as any).deriveFacadeSegmentsFromMass({ mesh: wideMesh });
	assert.throws(() => buildPunchedFacadeDetails({
		mesh: wideMesh, floorGuides: manyFloors, facadePlanes: widePlanes, grammar: { ...grammar, bay_width_m: 0.9, window_width_m: 0.6 },
	}), /detail primitive budget exceeded/i);
});

test("rejects sparse typed geometry inputs and texture allocations beyond the deterministic byte budget", () => {
	const sparsePlanes = [];
	sparsePlanes.length = 1;
	assert.throws(() => buildPunchedFacadeDetails({ mesh, floorGuides, facadePlanes: { facade_planes: sparsePlanes }, grammar }), /segment authority/i);
	assert.throws(() => createFacadePbrMaps({ grammar, resolution: 2049 }), /texture byte budget exceeded/i);
});

test("rejects high-incidence non-manifold MASS without overflowing the component walk", () => {
	const frontTriangle = { vertices: [mesh.vertices[0], mesh.vertices[1], mesh.vertices[5]], triangles: Array.from({ length: 60_000 }, () => [0, 1, 2]) };
	assert.throws(
		() => buildPunchedFacadeDetails({ mesh: frontTriangle, floorGuides, facadePlanes: { facade_planes: [facadePlanes.facade_planes[0]] }, grammar }),
		(error: Error) => {
			assert.doesNotMatch(error.message, /Maximum call stack/i);
			assert.match(error.message, /closed shell/i);
			return true;
		},
	);
});

test("rejects procedural facade planes that have no positive-area exact-MASS backing", () => {
	const detached = { ...facadePlanes.facade_planes[0], origin: [-4, -20, 0] };
	assert.throws(
		() => buildPunchedFacadeDetails({ mesh, floorGuides, facadePlanes: { facade_planes: [detached] }, grammar }),
		/segment authority/i,
	);
});

test("rejects a facade plane whose outward normal points through opaque MASS", () => {
	const inwardFront = {
		...facadePlanes.facade_planes[0],
		origin: [4, -2, 0],
		normal: [0, 1, 0],
		extent_m: [8, 6.6],
	};
	assert.throws(
		() => buildPunchedFacadeDetails({ mesh, floorGuides, facadePlanes: { facade_planes: [inwardFront] }, grammar }),
		/segment authority/i,
	);
});

test("rejects reversed facade orientation when the supporting MASS component is open", () => {
	const openReversedMass = {
		vertices: mesh.vertices.map((point) => [...point]),
		triangles: mesh.triangles.filter((_, index) => index !== 2 && index !== 3).map((triangle) => [...triangle].reverse()),
	};
	const inwardFront = { ...facadePlanes.facade_planes[0], origin: [4, -2, 0], normal: [0, 1, 0] };
	assert.throws(
		() => buildPunchedFacadeDetails({ mesh: openReversedMass, floorGuides, facadePlanes: { facade_planes: [inwardFront] }, grammar }),
		/(closed (?:MASS|shell)|outward orientation)/i,
	);
});

test("rejects inward facade orientation on an oppositely wound disconnected MASS component", () => {
	const translatedVertices = mesh.vertices.map(([x, y, z]) => [x + 20, y + 20, z]);
	const offset = mesh.vertices.length;
	const mixedMass = {
		vertices: mesh.vertices.concat(translatedVertices),
		triangles: mesh.triangles.concat(mesh.triangles.map((triangle) => triangle.map((index) => index + offset).reverse())),
	};
	const inwardFront = { ...facadePlanes.facade_planes[0], origin: [24, 18, 0], normal: [0, 1, 0] };
	assert.throws(
		() => buildPunchedFacadeDetails({ mesh: mixedMass, floorGuides, facadePlanes: { facade_planes: [inwardFront] }, grammar }),
		/one connected component/i,
	);
});

test("rejects duplicate coplanar MASS triangles that double-count missing backing", () => {
	const plane = facadePlanes.facade_planes[0];
	const incomplete = facadeBackingMesh({ ...plane, extent_m: [plane.extent_m[0] / 2, plane.extent_m[1]] });
	incomplete.triangles = incomplete.triangles.concat(incomplete.triangles.map((triangle) => [...triangle]));
	assert.throws(
		() => buildPunchedFacadeDetails({ mesh: incomplete, floorGuides, facadePlanes: { facade_planes: [plane] }, grammar }),
		/closed shell/i,
	);
});

test("rejects opposite-winding duplicate MASS triangles that counterfeit full backing", () => {
	const plane = facadePlanes.facade_planes[0];
	const backing = facadeBackingMesh(plane);
	const incomplete = { vertices: backing.vertices.slice(0, 3), triangles: [[0, 1, 2], [2, 1, 0]] };
	assert.throws(
		() => buildPunchedFacadeDetails({ mesh: incomplete, floorGuides, facadePlanes: { facade_planes: [plane] }, grammar }),
		/shell volume is zero/i,
	);
});

test("rejects opposite-winding subdivided MASS triangles that counterfeit full backing", () => {
	const plane = facadePlanes.facade_planes[0];
	const backing = facadeBackingMesh(plane);
	const triangle = backing.vertices.slice(0, 3);
	const centroid = triangle[0].map((value, axis) => triangle.reduce((sum, point) => sum + point[axis], 0) / 3);
	const incomplete = {
		vertices: triangle.concat([centroid]),
		triangles: [[0, 1, 2], [3, 1, 0], [3, 2, 1], [3, 0, 2]],
	};
	assert.throws(
		() => buildPunchedFacadeDetails({ mesh: incomplete, floorGuides, facadePlanes: { facade_planes: [plane] }, grammar }),
		/shell volume is zero/i,
	);
});

test("counts authoritative MASS vertices and indices in the pre-allocation output budget", () => {
	const largeMass = { ...mesh, vertices: mesh.vertices.concat(Array.from({ length: 79_692 }, () => [0, 0, 0])) };
	assert.throws(
		() => buildPunchedFacadeDetails({ mesh: largeMass, floorGuides, facadePlanes: (punchedFacade as any).deriveFacadeSegmentsFromMass({ mesh: largeMass }), grammar }),
		/facade vertex budget exceeded/i,
	);
});

test("rejects coordinates whose facade joints collapse after Float32 persistence", () => {
	const translation = 1_000_000;
	const translatedMesh = { ...mesh, vertices: mesh.vertices.map((point) => [point[0] + translation, point[1], point[2]]) };
	assert.throws(
		() => buildPunchedFacadeDetails({ mesh: translatedMesh, floorGuides, facadePlanes: (punchedFacade as any).deriveFacadeSegmentsFromMass({ mesh: translatedMesh }), grammar }),
		/Float32 separation budget exceeded/i,
	);
});
