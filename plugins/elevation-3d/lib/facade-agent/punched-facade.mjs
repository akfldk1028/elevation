import { createHash } from "node:crypto";
import { validatePunchedFacadeGrammar } from "../facade-grammar.mjs";

const EPSILON = 1e-9;
const GEOMETRY_GAP_M = 1e-4;
const DETAIL_PRIMITIVES_PER_BAY = 15;

export const PUNCHED_FACADE_BUDGETS = Object.freeze({
	maxFacadeWidthM: 120,
	maxFacadePlanes: 4,
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

function validatePlanes(facadePlanes, grammar) {
	const planes = facadePlanes?.facade_planes;
	if (!Array.isArray(planes)) throw new TypeError("invalid facade geometry: facade planes must be a dense array");
	if (!planes.length) throw new TypeError("invalid facade geometry: facade planes are required");
	if (planes.length > PUNCHED_FACADE_BUDGETS.maxFacadePlanes) throw new RangeError("facade plane budget exceeded");
	if (!denseArray(planes)) throw new TypeError("invalid facade geometry: facade planes must be a dense array");
	if (new Set(planes.map((plane) => plane.view)).size !== planes.length) {
		throw new TypeError("invalid facade geometry: facade views must be unique");
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

function massSupportTriangles(mesh, plane, tangent) {
	const support = [];
	for (const triangle of mesh.triangles) {
		const local = triangle.map((index) => {
			const point = mesh.vertices[index];
			const relative = point.map((value, axis) => value - plane.origin[axis]);
			return [dot(relative, tangent), point[2] - plane.origin[2], dot(relative, plane.normal)];
		});
		if (local.every((point) => Math.abs(point[2]) <= 1e-5) && polygonArea2d(local.map(([u, v]) => [u, v])) > EPSILON) {
			support.push(local.map(([u, v]) => [u, v]));
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
	for (const triangle of support) {
		let clipped = clipPolygon2d(triangle, 0, bounds.u0, true);
		clipped = clipPolygon2d(clipped, 0, bounds.u1, false);
		clipped = clipPolygon2d(clipped, 1, bounds.v0, true);
		clipped = clipPolygon2d(clipped, 1, bounds.v1, false);
		if (clipped.length < 3 || polygonArea2d(clipped) <= EPSILON) continue;
		if (triangle.some(([u, v]) => u < bounds.u0 - EPSILON || u > bounds.u1 + EPSILON
			|| v < bounds.v0 - EPSILON || v > bounds.v1 + EPSILON)) return { coveredArea: 0, targetArea };
		const triangleKey = triangle.map(pointKey).sort().join("|");
		if (triangles.has(triangleKey)) return { coveredArea: 0, targetArea };
		triangles.add(triangleKey);
		const signedArea = polygonSignedArea2d(triangle);
		const triangleWinding = Math.sign(signedArea);
		if (winding && triangleWinding !== winding) return { coveredArea: 0, targetArea };
		winding = triangleWinding;
		coveredArea += Math.abs(signedArea);
		for (let index = 0; index < 3; index++) {
			const start = triangle[index];
			const end = triangle[(index + 1) % 3];
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

function validateMassBacking(mesh, plane, tangent) {
	const coverage = massBackingCoverage(massSupportTriangles(mesh, plane, tangent), {
		u0: 0,
		u1: plane.extent_m[0],
		v0: 0,
		v1: plane.extent_m[1],
	});
	if (coverage.targetArea <= EPSILON
		|| Math.abs(coverage.coveredArea - coverage.targetArea) > Math.max(EPSILON, coverage.targetArea * 1e-6)) {
		throw new TypeError("invalid facade geometry: detail lacks exact-MASS backing");
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
			corner_anchor_id: anchorId(anchor, floor), anchor_position: anchor,
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

export function buildPunchedFacadeDetails({ mesh, floorGuides, facadePlanes, grammar }) {
	const floors = validateFloorGuideBudget(floorGuides);
	validateSourceMesh(mesh);
	const canonical = validatePunchedFacadeGrammar(grammar, { floorGuides, allowDerived: true });
	const planes = validatePlanes(facadePlanes, canonical);
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
		const massBacking = validateMassBacking(mesh, plane, tangent);
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
