import assert from "node:assert/strict";
import test from "node:test";

import {
	FacePolygonError,
	boundaryPolygons,
} from "../plugins/elevation-3d/lib/facade-agent/design/geometry/face-polygon.mjs";
import {
	InscribedRectError,
	largestInscribedRectangle,
} from "../plugins/elevation-3d/lib/facade-agent/design/geometry/inscribed-rect.mjs";

function area(rect: any) {
	return rect === null ? null : rect.area_m2;
}

test("fits the whole face when it is already a rectangle", () => {
	const rect = largestInscribedRectangle([[0, 0], [4, 0], [4, 3], [0, 3]]);
	assert.deepEqual(
		{ u_min: rect.u_min, u_max: rect.u_max, z_min: rect.z_min, z_max: rect.z_max },
		{ u_min: 0, u_max: 4, z_min: 0, z_max: 3 },
	);
	assert.equal(rect.area_m2, 12);
});

test("fits the larger leg of a notched or L-shaped face", () => {
	assert.equal(area(largestInscribedRectangle([[0, 0], [4, 0], [4, 1], [2, 1], [2, 3], [0, 3]])), 6);
	assert.equal(area(largestInscribedRectangle([[0, 0], [10, 0], [10, 5], [9, 5], [9, 4], [0, 4]])), 40);
	assert.equal(area(largestInscribedRectangle([[0, 0], [5, 0], [5, 4], [4, 4], [4, 1], [1, 1], [1, 4], [0, 4]])), 5);
});

test("fits against a diagonal edge, where the optimum is not at a vertex height", () => {
	const triangle = largestInscribedRectangle([[0, 0], [4, 0], [0, 3]]);
	assert.equal(triangle.area_m2 > 2.8 && triangle.area_m2 <= 3, true, `measured ${triangle.area_m2}`);
	assert.equal(triangle.z_max < 3, true, "a triangle cannot use its full height");
	assert.equal(area(largestInscribedRectangle([[0, 0], [6, 0], [6, 4], [3, 7], [0, 4]])), 24);
});

test("never reports a rectangle that leaves the face", () => {
	const polygon = [[0, 0], [4, 0], [4, 1], [2, 1], [2, 3], [0, 3]];
	const rect: any = largestInscribedRectangle(polygon);
	const inside = (x: number, y: number) => {
		let hit = false;
		for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
			const [ax, ay] = polygon[index] as number[];
			const [bx, by] = polygon[previous] as number[];
			if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) hit = !hit;
		}
		return hit;
	};
	for (let i = 1; i < 8; i += 1) {
		for (let j = 1; j < 8; j += 1) {
			const x = rect.u_min + ((rect.u_max - rect.u_min) * i) / 8;
			const y = rect.z_min + ((rect.z_max - rect.z_min) * j) / 8;
			assert.equal(inside(x, y), true, `sample (${x}, ${y}) escaped the face`);
		}
	}
});

test("rejects degenerate polygons", () => {
	assert.throws(() => largestInscribedRectangle([[0, 0], [1, 1]]), (error: unknown) => error instanceof InscribedRectError);
	assert.throws(() => largestInscribedRectangle([[0, 0], [1, 0], [2, 0]]), (error: unknown) => error instanceof InscribedRectError);
	assert.equal(largestInscribedRectangle([[0, 0], [4, 0], [4, 3], [0, 3]], { subdivisions: 1 }).area_m2, 12);
});

test("traces the outline of a rectangular triangle patch", () => {
	const points = [[0, 0], [4, 0], [4, 3], [0, 3]];
	const rings = boundaryPolygons({ triangles: [[0, 1, 2], [0, 2, 3]], points });

	assert.equal(rings.length, 1);
	assert.equal(rings[0].area_m2, 12);
	assert.equal(rings[0].polygon.length, 4, "collinear joins are dropped");
});

test("traces an L outline from the triangles that tile it", () => {
	const points = [[0, 0], [4, 0], [4, 1], [2, 1], [2, 3], [0, 3]];
	const rings = boundaryPolygons({
		triangles: [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 5]],
		points,
	});

	assert.equal(rings.length, 1);
	assert.equal(rings[0].area_m2, 8);
	assert.equal(rings[0].polygon.length, 6);
	assert.equal(largestInscribedRectangle(rings[0].polygon).area_m2, 6);
});

test("returns the outline before any hole it encloses", () => {
	const points = [
		[0, 0], [6, 0], [6, 6], [0, 6],
		[2, 2], [4, 2], [4, 4], [2, 4],
	];
	const rings = boundaryPolygons({
		triangles: [
			[0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
			[2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
		],
		points,
	});

	assert.equal(rings.length, 2);
	assert.equal(rings[0].area_m2, 36);
	assert.equal(rings[1].area_m2, 4);
});

test("rejects a patch whose boundary is not a clean loop", () => {
	assert.throws(
		() => boundaryPolygons({ triangles: [], points: [[0, 0], [1, 0], [0, 1]] }),
		(error: unknown) => error instanceof FacePolygonError,
	);
	assert.throws(
		() => boundaryPolygons({ triangles: [[0, 1, 1]], points: [[0, 0], [1, 0], [0, 1]] }),
		(error: unknown) => error instanceof FacePolygonError,
	);
	assert.throws(
		() => boundaryPolygons({ triangles: [[0, 1, 9]], points: [[0, 0], [1, 0], [0, 1]] }),
		(error: unknown) => error instanceof FacePolygonError,
	);
});
