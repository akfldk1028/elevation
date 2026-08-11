import { createHash } from "node:crypto";
import { stableJson } from "../core.mjs";
import { boundaryPolygons } from "./design/geometry/face-polygon.mjs";
import { largestInscribedRectangle } from "./design/geometry/inscribed-rect.mjs";
import {
	PUNCHED_FACADE_MATERIALS, PUNCHED_FACADE_SURFACES, PUNCHED_FACADE_SYSTEM,
	validatePunchedFacadeGrammar,
} from "../facade-grammar.mjs";

const EPSILON = 1e-9;
const GEOMETRY_GAP_M = 1e-4;
const DETAIL_PRIMITIVES_PER_BAY = 15;

export const PUNCHED_FACADE_BUDGETS = Object.freeze({
	maxFacadeWidthM: 120,
	maxFacadePlanes: 4,
	maxFacadeSegments: 32,
	maxBaysPerPlane: 128,
	maxFloorGuides: 65,
	maxStoreys: 64,
	maxDetailPrimitives: 10_000,
	maxTotalVertices: 80_000,
	maxTotalIndices: 360_000,
	maxSourceTriangles: 120_000,
	maxTextureBytes: 100_700_000,
	maxProjectedGlbBytes: 16 * 1024 * 1024,
	maxFinalGlbBytes: 16 * 1024 * 1024,
});

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function dot(left, right) {
	return left.reduce((sum, value, axis) => sum + value * right[axis], 0);
}

function cross(left, right) {
	return [
		left[1] * right[2] - left[2] * right[1],
		left[2] * right[0] - left[0] * right[2],
		left[0] * right[1] - left[1] * right[0],
	];
}

function finitePoint(value, dimensions = 3) {
	return denseArray(value) && value.length === dimensions && value.every(Number.isFinite);
}

function denseArray(value) {
	if (!Array.isArray(value)) return false;
	for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) return false;
	return true;
}

function validateSourceMesh(mesh) {
	if (!mesh || !Array.isArray(mesh.vertices) || !mesh.vertices.length
		|| !Array.isArray(mesh.triangles) || !mesh.triangles.length) {
		throw new TypeError("invalid facade source geometry: finite vertices and triangles are required");
	}
	if (mesh.vertices.length > PUNCHED_FACADE_BUDGETS.maxTotalVertices) throw new RangeError("facade vertex budget exceeded");
	if (mesh.triangles.length > PUNCHED_FACADE_BUDGETS.maxSourceTriangles) throw new RangeError("facade index budget exceeded");
	if (!denseArray(mesh.vertices) || !mesh.vertices.every((point) => finitePoint(point)) || !denseArray(mesh.triangles)) {
		throw new TypeError("invalid facade source geometry: finite dense vertices and triangles are required");
	}
	for (const triangle of mesh.triangles) {
		if (!Array.isArray(triangle) || triangle.length !== 3 || new Set(triangle).size !== 3
			|| triangle.some((index) => !Number.isInteger(index) || index < 0 || index >= mesh.vertices.length)) {
			throw new TypeError("invalid facade source geometry: triangle indices must reference three distinct vertices");
		}
		const [a, b, c] = triangle.map((index) => mesh.vertices[index]);
		const ab = b.map((value, axis) => value - a[axis]);
		const ac = c.map((value, axis) => value - a[axis]);
		const cross = [
			ab[1] * ac[2] - ab[2] * ac[1],
			ab[2] * ac[0] - ab[0] * ac[2],
			ab[0] * ac[1] - ab[1] * ac[0],
		];
		if (Math.hypot(...cross) <= EPSILON) throw new TypeError("invalid facade source geometry: degenerate triangle");
	}
}

function massComponentOrientations(mesh) {
	const edges = new Map();
	const triangleEdges = mesh.triangles.map((triangle, triangleIndex) => triangle.map((start, index) => {
		const end = triangle[(index + 1) % 3];
		const forward = start < end;
		const key = forward ? `${start}|${end}` : `${end}|${start}`;
		const entries = edges.get(key) ?? [];
		entries.push({ triangleIndex, direction: forward ? 1 : -1 });
		edges.set(key, entries);
		return key;
	}));
	const adjacent = Array.from({ length: mesh.triangles.length }, () => []);
	for (const entries of edges.values()) for (let index = 1; index < entries.length; index++) {
		adjacent[entries[0].triangleIndex].push(entries[index].triangleIndex);
		adjacent[entries[index].triangleIndex].push(entries[0].triangleIndex);
	}
	const orientations = Array(mesh.triangles.length).fill(null);
	const visited = new Set();
	for (let start = 0; start < mesh.triangles.length; start++) {
		if (visited.has(start)) continue;
		const component = [];
		const stack = [start];
		while (stack.length) {
			const triangleIndex = stack.pop();
			if (visited.has(triangleIndex)) continue;
			visited.add(triangleIndex);
			component.push(triangleIndex);
			for (const neighbor of adjacent[triangleIndex]) stack.push(neighbor);
		}
		const componentEdges = new Set(component.flatMap((triangleIndex) => triangleEdges[triangleIndex]));
		const closedAndConsistent = [...componentEdges].every((key) => {
			const entries = edges.get(key);
			return entries.length === 2 && entries[0].direction + entries[1].direction === 0;
		});
		if (!closedAndConsistent) continue;
		const reference = mesh.vertices[mesh.triangles[component[0]][0]];
		let signedVolume = 0;
		for (const triangleIndex of component) {
			const [a, b, c] = mesh.triangles[triangleIndex]
				.map((vertex) => mesh.vertices[vertex].map((value, axis) => value - reference[axis]));
			signedVolume += dot(a, cross(b, c)) / 6;
		}
		if (Math.abs(signedVolume) <= EPSILON) continue;
		for (const triangleIndex of component) orientations[triangleIndex] = Math.sign(signedVolume);
	}
	return orientations;
}

function validatePlanes(facadePlanes, grammar) {
	const planes = facadePlanes?.facade_planes;
	const segmentAuthority = facadePlanes?.schema_version === "arr.elevation3d.facade-segments.v1";
	if (!Array.isArray(planes)) throw new TypeError("invalid facade geometry: facade planes must be a dense array");
	if (!planes.length) throw new TypeError("invalid facade geometry: facade planes are required");
	if (planes.length > (segmentAuthority ? PUNCHED_FACADE_BUDGETS.maxFacadeSegments : PUNCHED_FACADE_BUDGETS.maxFacadePlanes)) throw new RangeError("facade plane budget exceeded");
	if (!denseArray(planes)) throw new TypeError("invalid facade geometry: facade planes must be a dense array");
	if (!segmentAuthority && new Set(planes.map((plane) => plane.view)).size !== planes.length) {
		throw new TypeError("invalid facade geometry: facade views must be unique");
	}
	if (segmentAuthority && (new Set(planes.map((plane) => plane.segment_id)).size !== planes.length
		|| planes.some((plane, index) => plane.end_corner_id !== planes[(index + 1) % planes.length].start_corner_id))) {
		throw new TypeError("invalid facade geometry: facade segment topology is invalid");
	}
	for (const plane of planes) {
		if (!grammar.surfaces.includes(plane.view) || !finitePoint(plane.origin) || !finitePoint(plane.normal)
			|| !finitePoint(plane.extent_m, 2) || plane.extent_m.some((value) => value <= 0)
			|| Math.abs(Math.hypot(...plane.normal) - 1) > 1e-6 || Math.abs(plane.normal[2]) > 1e-8) {
			throw new TypeError("invalid facade geometry: planes require canonical views, unit horizontal normals, origins, and positive extents");
		}
		if (plane.extent_m[0] + EPSILON < grammar.bay_width_m) {
			throw new TypeError("invalid facade geometry: facade extent cannot contain an approved bay");
		}
		if (plane.extent_m[0] > PUNCHED_FACADE_BUDGETS.maxFacadeWidthM + EPSILON) {
			throw new RangeError("facade width budget exceeded");
		}
	}
	return planes;
}

function clipPolygon2d(polygon, axis, threshold, keepAbove) {
	const result = [];
	for (let index = 0; index < polygon.length; index++) {
		const current = polygon[index];
		const previous = polygon[(index + polygon.length - 1) % polygon.length];
		const currentInside = keepAbove ? current[axis] >= threshold - EPSILON : current[axis] <= threshold + EPSILON;
		const previousInside = keepAbove ? previous[axis] >= threshold - EPSILON : previous[axis] <= threshold + EPSILON;
		if (currentInside !== previousInside) {
			const amount = (threshold - previous[axis]) / (current[axis] - previous[axis]);
			result.push([
				previous[0] + (current[0] - previous[0]) * amount,
				previous[1] + (current[1] - previous[1]) * amount,
			]);
		}
		if (currentInside) result.push(current);
	}
	return result;
}

function polygonSignedArea2d(polygon) {
	let twiceArea = 0;
	for (let index = 0; index < polygon.length; index++) {
		const next = polygon[(index + 1) % polygon.length];
		twiceArea += polygon[index][0] * next[1] - next[0] * polygon[index][1];
	}
	return twiceArea / 2;
}

function polygonArea2d(polygon) {
	return Math.abs(polygonSignedArea2d(polygon));
}

function massSupportTriangles(mesh, plane, tangent, componentOrientations) {
	const support = [];
	for (let triangleIndex = 0; triangleIndex < mesh.triangles.length; triangleIndex++) {
		const triangle = mesh.triangles[triangleIndex];
		const points = triangle.map((index) => mesh.vertices[index]);
		const local = points.map((point) => {
			const relative = point.map((value, axis) => value - plane.origin[axis]);
			return [dot(relative, tangent), point[2] - plane.origin[2], dot(relative, plane.normal)];
		});
		if (local.every((point) => Math.abs(point[2]) <= 1e-5) && polygonArea2d(local.map(([u, v]) => [u, v])) > EPSILON) {
			const ab = points[1].map((value, axis) => value - points[0][axis]);
			const ac = points[2].map((value, axis) => value - points[0][axis]);
			support.push({
				projected: local.map(([u, v]) => [u, v]),
				worldNormal: cross(ab, ac),
				componentOrientation: componentOrientations[triangleIndex],
			});
		}
	}
	return support;
}

function pointKey(point) {
	return point.map((value) => Number(value.toFixed(9))).join(",");
}

function onRectangleBoundary(start, end, bounds) {
	return [
		[0, bounds.u0], [0, bounds.u1], [1, bounds.v0], [1, bounds.v1],
	].some(([axis, value]) => Math.abs(start[axis] - value) <= EPSILON && Math.abs(end[axis] - value) <= EPSILON);
}

function massBackingCoverage(support, bounds) {
	const targetArea = (bounds.u1 - bounds.u0) * (bounds.v1 - bounds.v0);
	let coveredArea = 0;
	let winding = 0;
	const edges = new Map();
	const triangles = new Set();
	for (const { projected: triangle } of support) {
		let clipped = clipPolygon2d(triangle, 0, bounds.u0, true);
		clipped = clipPolygon2d(clipped, 0, bounds.u1, false);
		clipped = clipPolygon2d(clipped, 1, bounds.v0, true);
		clipped = clipPolygon2d(clipped, 1, bounds.v1, false);
		if (clipped.length < 3 || polygonArea2d(clipped) <= EPSILON) continue;
		// The facade plane may be a sub-rectangle of a larger face - a mass with a
		// chamfer, notch or batter has no rectangular face to match exactly - so the
		// tiling is checked on the clipped patches. Overlaps still fail through the
		// duplicate and edge-closure checks, and every unmatched edge must still land
		// on the rectangle boundary, so the plane remains fully backed by mass.
		const triangleKey = clipped.map(pointKey).sort().join("|");
		if (triangles.has(triangleKey)) return { coveredArea: 0, targetArea };
		triangles.add(triangleKey);
		const signedArea = polygonSignedArea2d(clipped);
		const triangleWinding = Math.sign(signedArea);
		if (winding && triangleWinding !== winding) return { coveredArea: 0, targetArea };
		winding = triangleWinding;
		coveredArea += Math.abs(signedArea);
		for (let index = 0; index < clipped.length; index++) {
			const start = clipped[index];
			const end = clipped[(index + 1) % clipped.length];
			const startKey = pointKey(start);
			const endKey = pointKey(end);
			const forward = startKey < endKey;
			const key = forward ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
			const edge = edges.get(key) ?? { count: 0, direction: 0, start, end };
			edge.count++;
			edge.direction += forward ? 1 : -1;
			edges.set(key, edge);
		}
	}
	for (const edge of edges.values()) {
		if (edge.count === 1) {
			if (!onRectangleBoundary(edge.start, edge.end, bounds)) return { coveredArea: 0, targetArea };
		} else if (edge.count !== 2 || edge.direction !== 0) return { coveredArea: 0, targetArea };
	}
	return { coveredArea, targetArea };
}

function validateMassBacking(mesh, plane, tangent, componentOrientations) {
	const bounds = {
		u0: 0,
		u1: plane.extent_m[0],
		v0: 0,
		v1: plane.extent_m[1],
	};
	const support = massSupportTriangles(mesh, plane, tangent, componentOrientations).filter(({ projected }) => {
		let clipped = clipPolygon2d(projected, 0, bounds.u0, true);
		clipped = clipPolygon2d(clipped, 0, bounds.u1, false);
		clipped = clipPolygon2d(clipped, 1, bounds.v0, true);
		clipped = clipPolygon2d(clipped, 1, bounds.v1, false);
		return clipped.length >= 3 && polygonArea2d(clipped) > EPSILON;
	});
	const coverage = massBackingCoverage(support, bounds);
	if (coverage.targetArea <= EPSILON
		|| Math.abs(coverage.coveredArea - coverage.targetArea) > Math.max(EPSILON, coverage.targetArea * 1e-6)) {
		throw new TypeError("invalid facade geometry: detail lacks exact-MASS backing");
	}
	if (support.some(({ componentOrientation }) => componentOrientation === null)) {
		throw new TypeError("invalid facade geometry: supporting facade requires a closed MASS component");
	}
	if (support.some(({ worldNormal, componentOrientation }) => (
		dot(worldNormal, plane.normal) * componentOrientation / Math.hypot(...worldNormal) < 1 - 1e-6
	))) {
		throw new TypeError("invalid facade geometry: facade plane requires outward orientation");
	}
	return coverage;
}

function localPoint(plane, tangent, u, v, n) {
	return [
		plane.origin[0] + tangent[0] * u + plane.normal[0] * n,
		plane.origin[1] + tangent[1] * u + plane.normal[1] * n,
		plane.origin[2] + v,
	];
}

const BOX_INDICES = Object.freeze([
	[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
	[0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
	[2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
]);

function boxGeometry(plane, tangent, grammar, bounds) {
	const { u0, u1, v0, v1, n0, n1 } = bounds;
	if (![u0, u1, v0, v1, n0, n1].every(Number.isFinite)
		|| u1 - u0 <= EPSILON || v1 - v0 <= EPSILON || Math.abs(n1 - n0) <= EPSILON) {
		throw new TypeError("invalid facade geometry: detail prism has non-positive dimensions");
	}
	const coordinates = [
		[u0, v0, n0], [u1, v0, n0], [u1, v1, n0], [u0, v1, n0],
		[u0, v0, n1], [u1, v0, n1], [u1, v1, n1], [u0, v1, n1],
	];
	return {
		positions: coordinates.map(([u, v, n]) => localPoint(plane, tangent, u, v, n)),
		indices: BOX_INDICES.map((triangle) => [...triangle]),
		uvs: coordinates.map(([u, v]) => [u / grammar.brick_module_m[0], (plane.origin[2] + v) / grammar.brick_module_m[1]]),
	};
}

function primitiveSignature(kind, material, slot, bounds) {
	const dimensions = [bounds.u1 - bounds.u0, bounds.v1 - bounds.v0, Math.abs(bounds.n1 - bounds.n0)]
		.map((value) => Number(value.toFixed(9)));
	return sha256(JSON.stringify({ kind, material, slot, dimensions }));
}

function pushDetail(details, plane, tangent, grammar, bounds, properties, massBacking) {
	const minimumDepth = Math.min(bounds.n0, bounds.n1);
	const maximumDepth = Math.max(bounds.n0, bounds.n1);
	let massBackingProperties = {};
	if (minimumDepth <= EPSILON && maximumDepth >= -EPSILON) {
		if (!massBacking) throw new TypeError("invalid facade geometry: detail lacks exact-MASS backing");
		massBackingProperties = {
			mass_intersection_classification: "deliberate-exact-mass-backing",
			mass_backing_intersection_m: Math.max(0, -minimumDepth),
			mass_backing_plane_area_m2: massBacking.targetArea,
		};
	}
	const geometry = boxGeometry(plane, tangent, grammar, bounds);
	details.push({
		...properties,
		...massBackingProperties,
		view: plane.view,
		...(plane.segment_id ? {
			segment_id: plane.segment_id,
			segment_length_m: plane.extent_m[0],
			segment_start_corner_id: plane.start_corner_id,
			segment_end_corner_id: plane.end_corner_id,
			local_bounds: { u0: bounds.u0, u1: bounds.u1, v0: bounds.v0, v1: bounds.v1, n0: bounds.n0, n1: bounds.n1 },
		} : {}),
		component_id: 0,
		geometry_signature: primitiveSignature(properties.kind, properties.material, properties.slot, bounds),
		...geometry,
	});
}

function bayRegions(width, grammar) {
	const centers = [];
	const halfWindow = grammar.window_width_m / 2;
	const firstIndex = Math.ceil((-grammar.corner_datum_m - grammar.bay_width_m / 2) / grammar.bay_width_m);
	for (let index = firstIndex; ; index++) {
		const center = grammar.corner_datum_m + (index + 0.5) * grammar.bay_width_m;
		if (center + halfWindow > width + EPSILON) break;
		if (center - halfWindow >= -EPSILON) centers.push(center);
	}
	if (!centers.length) throw new TypeError("invalid facade geometry: no approved punched-window bay fits the facade plane");
	const startClearance = centers[0] - halfWindow;
	const endClearance = width - centers.at(-1) - halfWindow;
	if (startClearance <= 2 * GEOMETRY_GAP_M || endClearance <= 2 * GEOMETRY_GAP_M) {
		throw new TypeError("invalid facade geometry: corner return cannot be separated from an approved opening");
	}
	const startReturnWidth = Math.min(grammar.brick_module_m[0], startClearance / 2);
	const endReturnWidth = Math.min(grammar.brick_module_m[0], endClearance / 2);
	const regions = centers.map((center, index) => ({
		center,
		u0: index === 0 ? startReturnWidth + GEOMETRY_GAP_M : (centers[index - 1] + center) / 2,
		u1: index + 1 === centers.length ? width - endReturnWidth - GEOMETRY_GAP_M : (center + centers[index + 1]) / 2,
	}));
	return { regions, startReturnWidth, endReturnWidth };
}

function validateFloorGuideBudget(floorGuides) {
	const floors = floorGuides?.floor_guides_m;
	if (!Array.isArray(floors) || floors.length < 2) {
		throw new TypeError("floor guides must be a finite dense array");
	}
	if (floors.length > PUNCHED_FACADE_BUDGETS.maxFloorGuides) throw new RangeError("floor guide budget exceeded");
	if (!denseArray(floors) || floors.some((value) => !Number.isFinite(value))) {
		throw new TypeError("floor guides must be a finite dense array");
	}
	if (floors.length - 1 > PUNCHED_FACADE_BUDGETS.maxStoreys) throw new RangeError("storey budget exceeded");
	for (let index = 1; index < floors.length; index++) if (floors[index] <= floors[index - 1]) {
		throw new TypeError("floor guides must increase strictly");
	}
	return floors;
}

function bayCountWithinBudget(width, grammar) {
	const halfWindow = grammar.window_width_m / 2;
	const firstIndex = Math.ceil((-grammar.corner_datum_m - grammar.bay_width_m / 2) / grammar.bay_width_m);
	let count = 0;
	for (let index = firstIndex; ; index++) {
		const center = grammar.corner_datum_m + (index + 0.5) * grammar.bay_width_m;
		if (center + halfWindow > width + EPSILON) break;
		if (center - halfWindow >= -EPSILON) count++;
		if (count > PUNCHED_FACADE_BUDGETS.maxBaysPerPlane) throw new RangeError("facade bay count budget exceeded");
	}
	if (!count) throw new TypeError("invalid facade geometry: no approved punched-window bay fits the facade plane");
	return count;
}

function validateProjectedDetailBudget(mesh, planes, floors, grammar) {
	const storeys = BigInt(floors.length - 1);
	let primitives = 0n;
	for (const plane of planes) {
		const bays = BigInt(bayCountWithinBudget(plane.extent_m[0], grammar));
		primitives += storeys * (2n + bays * BigInt(DETAIL_PRIMITIVES_PER_BAY));
	}
	if (primitives > BigInt(PUNCHED_FACADE_BUDGETS.maxDetailPrimitives)) throw new RangeError("detail primitive budget exceeded");
	const vertices = BigInt(mesh.vertices.length) + primitives * 8n;
	const indices = BigInt(mesh.triangles.length) * 3n + primitives * 36n;
	if (vertices > BigInt(PUNCHED_FACADE_BUDGETS.maxTotalVertices)) throw new RangeError("facade vertex budget exceeded");
	if (indices > BigInt(PUNCHED_FACADE_BUDGETS.maxTotalIndices)) throw new RangeError("facade index budget exceeded");
}

function assertFloat32Separation(floors, planes) {
	const halfGap = GEOMETRY_GAP_M / 2;
	const values = [...floors];
	for (const plane of planes) {
		const tangent = [-plane.normal[1], plane.normal[0], 0];
		for (let axis = 0; axis < 2; axis++) {
			values.push(plane.origin[axis]);
			values.push(plane.origin[axis] + tangent[axis] * plane.extent_m[0]);
		}
	}
	if (values.some((value) => !Number.isFinite(Math.fround(value))
		|| Math.fround(value - halfGap) === Math.fround(value + halfGap))) {
		throw new RangeError("Float32 separation budget exceeded");
	}
}

function anchorId(position, floor) {
	const canonical = [...position, floor].map((value) => Number(value.toFixed(8)));
	return `corner-${sha256(JSON.stringify(canonical)).slice(0, 20)}`;
}

function emitCornerReturns(details, plane, tangent, grammar, floor, nextFloor, returnWidths, massSupport) {
	const width = plane.extent_m[0];
	const v0 = floor - plane.origin[2] + GEOMETRY_GAP_M;
	const v1 = nextFloor - plane.origin[2] - GEOMETRY_GAP_M;
	for (const side of ["start", "end"]) {
		const u = side === "start" ? 0 : width;
		const anchor = localPoint(plane, tangent, u, v0, 0);
		const returnWidth = side === "start" ? returnWidths.startReturnWidth : returnWidths.endReturnWidth;
		const bounds = {
			u0: side === "start" ? 0 : width - returnWidth,
			u1: side === "start" ? returnWidth : width,
			v0, v1, n0: 0, n1: grammar.cladding_depth_m,
		};
		pushDetail(details, plane, tangent, grammar, bounds, {
			kind: "corner-return", material: "brick", floor_m: floor, bay: null,
			depth_m: grammar.cladding_depth_m, slot: `corner-${side}`,
			corner_anchor_id: plane.segment_id
				? `corner-${sha256(JSON.stringify([side === "start" ? plane.start_corner_id : plane.end_corner_id, Number(floor.toFixed(8))])).slice(0, 20)}`
				: anchorId(anchor, floor),
			anchor_position: anchor,
		}, massSupport);
	}
}

function emitBay(details, plane, tangent, grammar, region, floor, nextFloor, bay, massSupport) {
	const floorLocal = floor - plane.origin[2];
	const nextFloorLocal = nextFloor - plane.origin[2];
	const opening = {
		u0: region.center - grammar.window_width_m / 2,
		u1: region.center + grammar.window_width_m / 2,
		v0: floorLocal + grammar.sill_height_m,
		v1: floorLocal + grammar.sill_height_m + grammar.window_height_m,
	};
	if (opening.u0 < region.u0 - EPSILON || opening.u1 > region.u1 + EPSILON
		|| opening.v0 <= floorLocal || opening.v1 + grammar.lintel_height_m >= nextFloorLocal + EPSILON) {
		throw new TypeError("invalid facade geometry: approved opening does not fit its authored storey bay");
	}
	const common = { floor_m: floor, bay };
	const visiblePlane = Math.min(0.002, grammar.cladding_depth_m / 10);
	const frame = grammar.frame_width_m;
	const regionMinimum = region.u0 + GEOMETRY_GAP_M / 2;
	const regionMaximum = region.u1 - GEOMETRY_GAP_M / 2;
	const storeyMinimum = floorLocal + GEOMETRY_GAP_M;
	const storeyMaximum = nextFloorLocal - GEOMETRY_GAP_M;
	const cladding = [
		["left", { u0: regionMinimum, u1: opening.u0 - GEOMETRY_GAP_M, v0: storeyMinimum, v1: storeyMaximum }],
		["right", { u0: opening.u1 + GEOMETRY_GAP_M, u1: regionMaximum, v0: storeyMinimum, v1: storeyMaximum }],
		["below", { u0: opening.u0 + GEOMETRY_GAP_M, u1: opening.u1 - GEOMETRY_GAP_M, v0: storeyMinimum, v1: opening.v0 - frame - GEOMETRY_GAP_M }],
		["above", { u0: opening.u0 + GEOMETRY_GAP_M, u1: opening.u1 - GEOMETRY_GAP_M, v0: opening.v1 + grammar.lintel_height_m + GEOMETRY_GAP_M, v1: storeyMaximum }],
	];
	for (const [slot, rectangle] of cladding) pushDetail(details, plane, tangent, grammar, {
		...rectangle, n0: 0, n1: grammar.cladding_depth_m,
	}, { ...common, kind: "brick-cladding", material: "brick", depth_m: grammar.cladding_depth_m, slot }, massSupport);

	const revealBounds = [
		["left", { u0: opening.u0, u1: opening.u0 + frame, v0: opening.v0 + GEOMETRY_GAP_M, v1: opening.v1 - GEOMETRY_GAP_M }],
		["right", { u0: opening.u1 - frame, u1: opening.u1, v0: opening.v0 + GEOMETRY_GAP_M, v1: opening.v1 - GEOMETRY_GAP_M }],
		["bottom", { u0: opening.u0 + frame + GEOMETRY_GAP_M, u1: opening.u1 - frame - GEOMETRY_GAP_M, v0: opening.v0, v1: opening.v0 + frame }],
		["top", { u0: opening.u0 + frame + GEOMETRY_GAP_M, u1: opening.u1 - frame - GEOMETRY_GAP_M, v0: opening.v1 - frame, v1: opening.v1 }],
	];
	for (const [slot, rectangle] of revealBounds) pushDetail(details, plane, tangent, grammar, {
		...rectangle, n0: grammar.cladding_depth_m - grammar.reveal_depth_m, n1: grammar.cladding_depth_m,
	}, { ...common, kind: "window-reveal", material: "brick", depth_m: grammar.reveal_depth_m, slot }, massSupport);

	const frameBounds = [
		["left", { u0: opening.u0 + frame + GEOMETRY_GAP_M, u1: opening.u0 + 2 * frame, v0: opening.v0 + frame + GEOMETRY_GAP_M, v1: opening.v1 - frame - GEOMETRY_GAP_M }],
		["right", { u0: opening.u1 - 2 * frame, u1: opening.u1 - frame - GEOMETRY_GAP_M, v0: opening.v0 + frame + GEOMETRY_GAP_M, v1: opening.v1 - frame - GEOMETRY_GAP_M }],
		["bottom", { u0: opening.u0 + 2 * frame + GEOMETRY_GAP_M, u1: opening.u1 - 2 * frame - GEOMETRY_GAP_M, v0: opening.v0 + frame + GEOMETRY_GAP_M, v1: opening.v0 + 2 * frame }],
		["top", { u0: opening.u0 + 2 * frame + GEOMETRY_GAP_M, u1: opening.u1 - 2 * frame - GEOMETRY_GAP_M, v0: opening.v1 - 2 * frame, v1: opening.v1 - frame - GEOMETRY_GAP_M }],
	];
	const framePlane = Math.min(grammar.cladding_depth_m - EPSILON, visiblePlane + 0.01);
	for (const [slot, rectangle] of frameBounds) pushDetail(details, plane, tangent, grammar, {
		...rectangle, n0: visiblePlane, n1: framePlane,
	}, { ...common, kind: "window-frame", material: "window-frame", depth_m: framePlane - visiblePlane, slot }, massSupport);

	pushDetail(details, plane, tangent, grammar, {
		u0: opening.u0 + 2 * frame + GEOMETRY_GAP_M, u1: opening.u1 - 2 * frame - GEOMETRY_GAP_M,
		v0: opening.v0 + 2 * frame + GEOMETRY_GAP_M, v1: opening.v1 - 2 * frame - GEOMETRY_GAP_M,
		n0: visiblePlane, n1: Math.min(framePlane, visiblePlane + 0.001),
	}, { ...common, kind: "glazing", material: "glass", depth_m: Math.min(framePlane, visiblePlane + 0.001) - visiblePlane, slot: "pane" }, massSupport);

	pushDetail(details, plane, tangent, grammar, {
		u0: opening.u0 + GEOMETRY_GAP_M, u1: opening.u1 - GEOMETRY_GAP_M,
		v0: opening.v1 + GEOMETRY_GAP_M, v1: opening.v1 + grammar.lintel_height_m,
		n0: 0, n1: grammar.cladding_depth_m,
	}, { ...common, kind: "precast-lintel", material: "precast", depth_m: grammar.cladding_depth_m, slot: "lintel" }, massSupport);

	pushDetail(details, plane, tangent, grammar, {
		u0: opening.u0 + GEOMETRY_GAP_M, u1: opening.u1 - GEOMETRY_GAP_M,
		v0: opening.v0 - frame, v1: opening.v0 - GEOMETRY_GAP_M,
		n0: visiblePlane - grammar.sill_depth_m, n1: visiblePlane,
	}, { ...common, kind: "precast-sill", material: "precast", depth_m: grammar.sill_depth_m, slot: "sill" }, massSupport);
}

function closedShellOrientation(mesh) {
	validateSourceMesh(mesh);
	const edges = new Map();
	const adjacent = Array.from({ length: mesh.triangles.length }, () => []);
	for (let triangleIndex = 0; triangleIndex < mesh.triangles.length; triangleIndex++) {
		const triangle = mesh.triangles[triangleIndex];
		for (let index = 0; index < 3; index++) {
			const start = triangle[index], end = triangle[(index + 1) % 3];
			const key = start < end ? `${start}|${end}` : `${end}|${start}`;
			const entries = edges.get(key) ?? [];
			entries.push({ triangleIndex, direction: start < end ? 1 : -1 });
			edges.set(key, entries);
		}
	}
	for (const entries of edges.values()) {
		if (entries.length !== 2 || entries[0].direction + entries[1].direction !== 0) {
			throw new TypeError("invalid facade topology: MASS must be a consistently oriented closed shell");
		}
		adjacent[entries[0].triangleIndex].push(entries[1].triangleIndex);
		adjacent[entries[1].triangleIndex].push(entries[0].triangleIndex);
	}
	const visited = new Set(), stack = [0];
	while (stack.length) {
		const index = stack.pop();
		if (visited.has(index)) continue;
		visited.add(index);
		stack.push(...adjacent[index]);
	}
	if (visited.size !== mesh.triangles.length) throw new TypeError("invalid facade topology: MASS must contain one connected component");
	let signedVolume = 0;
	for (const triangle of mesh.triangles) {
		const [a, b, c] = triangle.map((index) => mesh.vertices[index]);
		signedVolume += dot(a, cross(b, c)) / 6;
	}
	if (Math.abs(signedVolume) <= EPSILON) throw new TypeError("invalid facade topology: MASS shell volume is zero");
	if (signedVolume < 0) throw new TypeError("invalid facade orientation: MASS shell winding is not the approved positive orientation");
	return 1;
}

function roundedPoint(point) {
	return point.map((value) => Number(value.toFixed(8)));
}

/** The point on a facade plane at drawing coordinates (u, z), derived from any face point. */
function planePoint(reference, tangent, u, z) {
	const offset = u - dot(reference, tangent);
	return [reference[0] + tangent[0] * offset, reference[1] + tangent[1] * offset, z];
}

/**
 * The placeable rectangle of one coplanar face patch.
 *
 * A mass face is not always a rectangle: chamfers, notches, batters and gable ends all
 * produce something else. Rather than reject those, the patch is traced to its real
 * outline and reduced to the largest rectangle that fits inside it, so every opening
 * placed later still sits on mass. A face that is already rectangular returns its full
 * extent, which keeps prismatic candidates byte-identical to the earlier pipeline.
 */
function usableFaceRectangle(mesh, indexes, tangent) {
	const localIndex = new Map();
	const points = [];
	const triangles = indexes.map((index) => mesh.triangles[index].map((vertex) => {
		if (!localIndex.has(vertex)) {
			localIndex.set(vertex, points.length);
			const point = mesh.vertices[vertex];
			points.push([dot(point, tangent), point[2]]);
		}
		return localIndex.get(vertex);
	}));
	let rings;
	try { rings = boundaryPolygons({ triangles, points }); }
	catch (error) { throw new TypeError(`invalid facade topology: ${error.message}`); }
	const rectangle = largestInscribedRectangle(rings[0].polygon);
	if (!rectangle) return null;
	const vertices = [...localIndex.keys()].map((vertex) => mesh.vertices[vertex]);
	// Sliding along a tangent built from a rounded normal drifts by a few nanometres,
	// which is enough to lose exact-MASS backing, so a rectangle corner that is a real
	// face vertex uses that vertex verbatim.
	const corner = (u, z) => vertices.find((point) => Math.abs(dot(point, tangent) - u) <= 1e-7
		&& Math.abs(point[2] - z) <= 1e-7) ?? planePoint(vertices[0], tangent, u, z);
	return {
		u0: rectangle.u_min, u1: rectangle.u_max, z0: rectangle.z_min, z1: rectangle.z_max,
		start: [...corner(rectangle.u_min, rectangle.z_min)], end: [...corner(rectangle.u_max, rectangle.z_min)],
	};
}

function cornerId(point) {
	return `facade-corner-${sha256(JSON.stringify(roundedPoint(point))).slice(0, 20)}`;
}

function facadeView(normal) {
	if (Math.abs(normal[0]) > Math.abs(normal[1])) return normal[0] > 0 ? "right" : "left";
	return normal[1] > 0 ? "back" : "front";
}

function connectedTriangleGroups(mesh, triangleIndexes) {
	const byEdge = new Map();
	for (const triangleIndex of triangleIndexes) {
		const triangle = mesh.triangles[triangleIndex];
		for (let index = 0; index < 3; index++) {
			const values = [triangle[index], triangle[(index + 1) % 3]].sort((a, b) => a - b);
			const key = values.join("|");
			const entries = byEdge.get(key) ?? [];
			entries.push(triangleIndex);
			byEdge.set(key, entries);
		}
	}
	const adjacent = new Map(triangleIndexes.map((index) => [index, []]));
	for (const entries of byEdge.values()) if (entries.length === 2) {
		adjacent.get(entries[0]).push(entries[1]);
		adjacent.get(entries[1]).push(entries[0]);
	}
	const pending = new Set(triangleIndexes), groups = [];
	while (pending.size) {
		const group = [], stack = [pending.values().next().value];
		while (stack.length) {
			const index = stack.pop();
			if (!pending.delete(index)) continue;
			group.push(index);
			stack.push(...adjacent.get(index));
		}
		groups.push(group);
	}
	return groups;
}

export function deriveFacadeSegmentsFromMass({ mesh } = {}) {
	const orientation = closedShellOrientation(mesh);
	const planeGroups = new Map();
	for (let triangleIndex = 0; triangleIndex < mesh.triangles.length; triangleIndex++) {
		const points = mesh.triangles[triangleIndex].map((index) => mesh.vertices[index]);
		const raw = cross(points[1].map((value, axis) => value - points[0][axis]), points[2].map((value, axis) => value - points[0][axis]));
		const length = Math.hypot(...raw);
		const normal = raw.map((value) => value * orientation / length);
		if (Math.abs(normal[2]) > 1e-7) continue;
		const roundedNormal = normal.map((value) => Number(value.toFixed(8)));
		const offset = Number(dot(roundedNormal, points[0]).toFixed(8));
		const key = `${roundedNormal.join(",")}|${offset}`;
		const group = planeGroups.get(key) ?? { normal: roundedNormal, indexes: [] };
		group.indexes.push(triangleIndex);
		planeGroups.set(key, group);
	}
	const unsorted = [];
	for (const group of planeGroups.values()) for (const indexes of connectedTriangleGroups(mesh, group.indexes)) {
		const normal = group.normal;
		const tangent = [-normal[1], normal[0], 0];
		const usable = usableFaceRectangle(mesh, indexes, tangent);
		if (!usable) continue;
		const { u0, u1, z0, z1, start, end } = usable;
		if (u1 - u0 <= EPSILON || z1 - z0 <= EPSILON) throw new TypeError("invalid facade topology: vertical segment is degenerate");
		const plane = { origin: [...start], normal: [...normal], extent_m: [u1 - u0, z1 - z0] };
		const backing = validateMassBacking(mesh, plane, tangent, Array(mesh.triangles.length).fill(orientation));
		const canonical = { normal: roundedPoint(normal), origin: roundedPoint(start), extent_m: roundedPoint(plane.extent_m) };
		unsorted.push({
			segment_id: `facade-segment-${sha256(JSON.stringify(canonical)).slice(0, 20)}`,
			view: facadeView(normal), normal: [...normal], origin: [...start], extent_m: [u1 - u0, z1 - z0],
			start_corner_id: cornerId(start), end_corner_id: cornerId(end),
			mass_backed: Math.abs(backing.coveredArea - backing.targetArea) <= Math.max(EPSILON, backing.targetArea * 1e-6),
			outward: true,
		});
	}
	if (!unsorted.length || unsorted.length > PUNCHED_FACADE_BUDGETS.maxFacadeSegments) throw new RangeError("facade segment budget exceeded");
	const byStart = new Map(unsorted.map((segment) => [segment.start_corner_id, segment]));
	if (byStart.size !== unsorted.length) throw new TypeError("invalid facade topology: perimeter segment starts are ambiguous");
	const first = [...unsorted].sort((left, right) => left.origin[0] - right.origin[0] || left.origin[1] - right.origin[1] || left.segment_id.localeCompare(right.segment_id))[0];
	const segments = [], used = new Set();
	let current = first;
	while (current && !used.has(current.segment_id)) {
		segments.push(current); used.add(current.segment_id); current = byStart.get(current.end_corner_id);
	}
	if (segments.length !== unsorted.length || current?.segment_id !== first.segment_id) throw new TypeError("invalid facade topology: perimeter is not one closed cycle");
	const xs = mesh.vertices.map((point) => point[0]), ys = mesh.vertices.map((point) => point[1]);
	const facadeLengths = {
		front: Math.max(...xs) - Math.min(...xs), back: Math.max(...xs) - Math.min(...xs),
		right: Math.max(...ys) - Math.min(...ys), left: Math.max(...ys) - Math.min(...ys),
	};
	const value = {
		schema_version: "arr.elevation3d.facade-segments.v1",
		source_geometry_sha256: sha256(stableJson({ vertices: mesh.vertices, triangles: mesh.triangles })),
		source_signed_volume_orientation: 1,
		facade_planes: segments,
		segments,
		facade_lengths_m: facadeLengths,
	};
	return { ...value, sha256: sha256(stableJson(value)) };
}

export function assertCanonicalFacadeSegmentAuthority({ mesh, facadeSegmentAuthority } = {}) {
	const expected = deriveFacadeSegmentsFromMass({ mesh });
	if (stableJson(facadeSegmentAuthority) !== stableJson(expected)) {
		throw new TypeError("invalid facade segment authority: supplied authority does not exactly match canonical MASS derivation");
	}
	return expected;
}

function verifiedFacadeSegmentAuthority(mesh, supplied) {
	const expected = deriveFacadeSegmentsFromMass({ mesh });
	if (supplied?.schema_version === "arr.elevation3d.facade-segments.v1") {
		if (stableJson(supplied) !== stableJson(expected)) {
			throw new TypeError("invalid facade segment authority: supplied authority does not exactly match canonical MASS derivation");
		}
		return expected;
	}
	const geometry = (plane) => ({
		view: plane?.view, origin: plane?.origin, normal: plane?.normal, extent_m: plane?.extent_m,
	});
	const suppliedPlanes = supplied?.facade_planes;
	if (!Array.isArray(suppliedPlanes)
		|| suppliedPlanes.some((plane, index) => !Object.hasOwn(suppliedPlanes, index) || !plane)
		|| stableJson(suppliedPlanes.map(geometry)) !== stableJson(expected.facade_planes.map(geometry))) {
		throw new TypeError("invalid facade segment authority: legacy planes do not exactly match canonical MASS derivation");
	}
	return expected;
}

export function buildPunchedFacadeDetails({ mesh, floorGuides, facadePlanes, grammar }) {
	const floors = validateFloorGuideBudget(floorGuides);
	validateSourceMesh(mesh);
	const verifiedFacadePlanes = verifiedFacadeSegmentAuthority(mesh, facadePlanes);
	const componentOrientations = massComponentOrientations(mesh);
	const canonical = validatePunchedFacadeGrammar(grammar, { floorGuides, allowDerived: true });
	const planes = validatePlanes(verifiedFacadePlanes, canonical);
	assertFloat32Separation(floors, planes);
	validateProjectedDetailBudget(mesh, planes, floors, canonical);
	const details = [];
	for (const plane of planes) {
		const minimum = plane.origin[2];
		const maximum = minimum + plane.extent_m[1];
		if (floors[0] < minimum - EPSILON || floors.at(-1) > maximum + EPSILON) {
			throw new TypeError("invalid facade geometry: floor guides exceed a facade plane extent");
		}
		const tangent = [-plane.normal[1], plane.normal[0], 0];
		const massBacking = validateMassBacking(mesh, plane, tangent, componentOrientations);
		const { regions, ...returnWidths } = bayRegions(plane.extent_m[0], canonical);
		for (let floorIndex = 0; floorIndex + 1 < floors.length; floorIndex++) {
			const floor = floors[floorIndex];
			const nextFloor = floors[floorIndex + 1];
			emitCornerReturns(details, plane, tangent, canonical, floor, nextFloor, returnWidths, massBacking);
			regions.forEach((region, bay) => emitBay(details, plane, tangent, canonical, region, floor, nextFloor, bay, massBacking));
		}
	}
	return details;
}

export const TYPED_FACADE_GRAMMAR = Object.freeze({
	system: PUNCHED_FACADE_SYSTEM,
	surfaces: PUNCHED_FACADE_SURFACES,
	materials: PUNCHED_FACADE_MATERIALS,
	corner_datum_m: 0, bay_width_m: 1.8, window_width_m: 1.2, window_height_m: 1.6,
	sill_height_m: 0.8, reveal_depth_m: 0.15, frame_width_m: 0.03,
	lintel_height_m: 0.15, sill_depth_m: 0.1, cladding_depth_m: 0.12,
	brick_module_m: Object.freeze([0.215, 0.065]), confidence: 1,
	unresolved_surfaces: Object.freeze([]),
});
const TYPED_MATERIAL = Object.freeze({
	door: "glass", window: "glass", reveal: "window-frame", lintel: "precast",
	sill: "precast", pilaster: "brick", band: "precast", cornice: "precast",
});

export function buildTypedFacadeDetails({ mesh, floorGuides, facadePlanes, primitives }) {
	validateFloorGuideBudget(floorGuides);
	validateSourceMesh(mesh);
	const authority = verifiedFacadeSegmentAuthority(mesh, facadePlanes);
	if (!denseArray(primitives) || primitives.length > 2_048) throw new TypeError("invalid typed facade primitive collection");
	const planes = new Map(authority.facade_planes.map((plane) => [plane.segment_id, plane]));
	const componentOrientations = massComponentOrientations(mesh);
	const backing = new Map();
	const details = [];
	for (let index = 0; index < primitives.length; index += 1) {
		const primitive = primitives[index];
		const plane = planes.get(primitive?.segment_id);
		const material = TYPED_MATERIAL[primitive?.kind];
		const local = primitive?.local_bounds;
		if (!plane || !material || !local) throw new TypeError("invalid typed facade primitive authority");
		const tangent = [-plane.normal[1], plane.normal[0], 0];
		if (!backing.has(plane.segment_id)) backing.set(
			plane.segment_id, validateMassBacking(mesh, plane, tangent, componentOrientations),
		);
		const depth = primitive.kind === "door" || primitive.kind === "window"
			? Math.max(0.015, primitive.depth_m || 0.015)
			: primitive.depth_m;
		const bounds = {
			u0: local.u_min, u1: local.u_max,
			v0: local.z_min - plane.origin[2], v1: local.z_max - plane.origin[2],
			n0: 0, n1: depth,
		};
		if (bounds.u0 < -EPSILON || bounds.u1 > plane.extent_m[0] + EPSILON
			|| bounds.v0 < -EPSILON || bounds.v1 > plane.extent_m[1] + EPSILON) {
			throw new TypeError("invalid typed facade primitive bounds");
		}
		pushDetail(details, plane, tangent, TYPED_FACADE_GRAMMAR, bounds, {
			kind: primitive.kind, material, slot: `typed-${index}`,
			design_primitive_index: index,
			...(primitive.role ? { role: primitive.role } : {}),
			...(primitive.family_id ? { family_id: primitive.family_id } : {}),
			...(primitive.zone_id ? { zone_id: primitive.zone_id } : {}),
			...(primitive.material_id ? { material_id: primitive.material_id } : {}),
		}, backing.get(plane.segment_id));
		if (primitive.kind === "door" || primitive.kind === "window") {
			const frameWidth = Math.min(
				TYPED_FACADE_GRAMMAR.frame_width_m, (bounds.u1 - bounds.u0) / 4, (bounds.v1 - bounds.v0) / 4,
			);
			const frameDepth = Math.max(bounds.n1 + 0.02, 0.035);
			const frameBounds = [
				{ u0: bounds.u0, u1: bounds.u0 + frameWidth, v0: bounds.v0 + frameWidth, v1: bounds.v1 - frameWidth },
				{ u0: bounds.u1 - frameWidth, u1: bounds.u1, v0: bounds.v0 + frameWidth, v1: bounds.v1 - frameWidth },
			].map((frame) => ({ ...frame, n0: 0, n1: frameDepth }));
			frameBounds.forEach((frame, frameIndex) => pushDetail(
				details, plane, tangent, TYPED_FACADE_GRAMMAR, frame,
				{
					kind: "window-frame", material: "window-frame", slot: `typed-${index}-frame-${frameIndex}`,
					design_primitive_index: index, source_kind: primitive.kind,
					...(primitive.role ? { role: primitive.role } : {}),
					...(primitive.family_id ? { family_id: primitive.family_id } : {}),
				},
				backing.get(plane.segment_id),
			));
		}
	}
	return details;
}
