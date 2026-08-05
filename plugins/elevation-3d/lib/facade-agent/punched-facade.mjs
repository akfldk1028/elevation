import { createHash } from "node:crypto";
import { validatePunchedFacadeGrammar } from "../facade-grammar.mjs";

const EPSILON = 1e-9;

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function finitePoint(value, dimensions = 3) {
	return Array.isArray(value) && value.length === dimensions && value.every(Number.isFinite);
}

function validateSourceMesh(mesh) {
	if (!mesh || !Array.isArray(mesh.vertices) || !mesh.vertices.length
		|| !mesh.vertices.every((point) => finitePoint(point))
		|| !Array.isArray(mesh.triangles) || !mesh.triangles.length) {
		throw new TypeError("invalid facade source geometry: finite vertices and triangles are required");
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
	if (!Array.isArray(planes) || !planes.length) throw new TypeError("invalid facade geometry: facade planes are required");
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
	}
	return planes;
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

function pushDetail(details, plane, tangent, grammar, bounds, properties) {
	const geometry = boxGeometry(plane, tangent, grammar, bounds);
	details.push({
		...properties,
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
	return centers.map((center, index) => ({
		center,
		u0: index === 0 ? 0 : (centers[index - 1] + center) / 2,
		u1: index + 1 === centers.length ? width : (center + centers[index + 1]) / 2,
	}));
}

function anchorId(position, floor) {
	const canonical = [...position, floor].map((value) => Number(value.toFixed(8)));
	return `corner-${sha256(JSON.stringify(canonical)).slice(0, 20)}`;
}

function emitCornerReturns(details, plane, tangent, grammar, floor, nextFloor) {
	const width = plane.extent_m[0];
	const v0 = floor - plane.origin[2];
	const v1 = nextFloor - plane.origin[2];
	const returnWidth = Math.min(grammar.brick_module_m[0], width / 4);
	for (const side of ["start", "end"]) {
		const u = side === "start" ? 0 : width;
		const anchor = localPoint(plane, tangent, u, v0, 0);
		const bounds = {
			u0: side === "start" ? 0 : width - returnWidth,
			u1: side === "start" ? returnWidth : width,
			v0, v1, n0: 0, n1: grammar.cladding_depth_m,
		};
		pushDetail(details, plane, tangent, grammar, bounds, {
			kind: "corner-return", material: "brick", floor_m: floor, bay: null,
			depth_m: grammar.cladding_depth_m, slot: `corner-${side}`,
			corner_anchor_id: anchorId(anchor, floor), anchor_position: anchor,
		});
	}
}

function emitBay(details, plane, tangent, grammar, region, floor, nextFloor, bay) {
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
	const cladding = [
		["left", { u0: region.u0, u1: opening.u0, v0: floorLocal, v1: nextFloorLocal }],
		["right", { u0: opening.u1, u1: region.u1, v0: floorLocal, v1: nextFloorLocal }],
		["below", { u0: opening.u0, u1: opening.u1, v0: floorLocal, v1: opening.v0 }],
		["above", { u0: opening.u0, u1: opening.u1, v0: opening.v1, v1: nextFloorLocal }],
	];
	for (const [slot, rectangle] of cladding) pushDetail(details, plane, tangent, grammar, {
		...rectangle, n0: 0, n1: grammar.cladding_depth_m,
	}, { ...common, kind: "brick-cladding", material: "brick", depth_m: grammar.cladding_depth_m, slot });

	const frame = grammar.frame_width_m;
	const revealBounds = [
		["left", { u0: opening.u0, u1: opening.u0 + frame, v0: opening.v0, v1: opening.v1 }],
		["right", { u0: opening.u1 - frame, u1: opening.u1, v0: opening.v0, v1: opening.v1 }],
		["bottom", { u0: opening.u0 + frame, u1: opening.u1 - frame, v0: opening.v0, v1: opening.v0 + frame }],
		["top", { u0: opening.u0 + frame, u1: opening.u1 - frame, v0: opening.v1 - frame, v1: opening.v1 }],
	];
	for (const [slot, rectangle] of revealBounds) pushDetail(details, plane, tangent, grammar, {
		...rectangle, n0: grammar.cladding_depth_m - grammar.reveal_depth_m, n1: grammar.cladding_depth_m,
	}, { ...common, kind: "window-reveal", material: "brick", depth_m: grammar.reveal_depth_m, slot });

	const framePlane = Math.min(grammar.cladding_depth_m - EPSILON, visiblePlane + 0.01);
	for (const [slot, rectangle] of revealBounds) pushDetail(details, plane, tangent, grammar, {
		...rectangle, n0: visiblePlane, n1: framePlane,
	}, { ...common, kind: "window-frame", material: "window-frame", depth_m: framePlane - visiblePlane, slot });

	pushDetail(details, plane, tangent, grammar, {
		u0: opening.u0 + frame, u1: opening.u1 - frame,
		v0: opening.v0 + frame, v1: opening.v1 - frame,
		n0: visiblePlane, n1: Math.min(framePlane, visiblePlane + 0.001),
	}, { ...common, kind: "glazing", material: "glass", depth_m: Math.min(framePlane, visiblePlane + 0.001) - visiblePlane, slot: "pane" });

	pushDetail(details, plane, tangent, grammar, {
		u0: Math.max(region.u0, opening.u0 - frame), u1: Math.min(region.u1, opening.u1 + frame),
		v0: opening.v1, v1: opening.v1 + grammar.lintel_height_m,
		n0: 0, n1: grammar.cladding_depth_m,
	}, { ...common, kind: "precast-lintel", material: "precast", depth_m: grammar.cladding_depth_m, slot: "lintel" });

	pushDetail(details, plane, tangent, grammar, {
		u0: Math.max(region.u0, opening.u0 - frame), u1: Math.min(region.u1, opening.u1 + frame),
		v0: opening.v0 - frame, v1: opening.v0,
		n0: visiblePlane - grammar.sill_depth_m, n1: visiblePlane,
	}, { ...common, kind: "precast-sill", material: "precast", depth_m: grammar.sill_depth_m, slot: "sill" });
}

export function buildPunchedFacadeDetails({ mesh, floorGuides, facadePlanes, grammar }) {
	validateSourceMesh(mesh);
	const canonical = validatePunchedFacadeGrammar(grammar, { floorGuides, allowDerived: true });
	const planes = validatePlanes(facadePlanes, canonical);
	const floors = floorGuides.floor_guides_m;
	const details = [];
	for (const plane of planes) {
		const minimum = plane.origin[2];
		const maximum = minimum + plane.extent_m[1];
		if (floors[0] < minimum - EPSILON || floors.at(-1) > maximum + EPSILON) {
			throw new TypeError("invalid facade geometry: floor guides exceed a facade plane extent");
		}
		const tangent = [-plane.normal[1], plane.normal[0], 0];
		const regions = bayRegions(plane.extent_m[0], canonical);
		for (let floorIndex = 0; floorIndex + 1 < floors.length; floorIndex++) {
			const floor = floors[floorIndex];
			const nextFloor = floors[floorIndex + 1];
			emitCornerReturns(details, plane, tangent, canonical, floor, nextFloor);
			regions.forEach((region, bay) => emitBay(details, plane, tangent, canonical, region, floor, nextFloor, bay));
		}
	}
	return details;
}
