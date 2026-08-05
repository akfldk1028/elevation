import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { buildPunchedFacadeDetails } from "../plugins/elevation-3d/lib/facade-agent/punched-facade.mjs";
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
const facadePlanes = {
	facade_planes: [
		{ view: "front", origin: [-4, -2, 0], normal: [0, -1, 0], extent_m: [8, 6.6] },
		{ view: "right", origin: [4, -2, 0], normal: [1, 0, 0], extent_m: [4, 6.6] },
	],
};
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
