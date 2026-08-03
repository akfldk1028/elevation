import { readFile } from "node:fs/promises";
import { NodeIO } from "@gltf-transform/core";
import { sha256, stableJson } from "./core.mjs";
import { compareGeometry } from "./geometry.mjs";

const SCHEMA_VERSION = "arr.elevation3d.dimension-manifest.v1";
const ENVELOPE_TOLERANCE_M = 0.001;
const IDENTITY_FIELDS = ["candidate_id", "geometry_hash", "pnu", "program_hash", "run_id"];
const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const ELEVATION_VIEWS = new Set(["front", "back", "left", "right"]);

function dot(left, right) {
	return left.reduce((sum, value, axis) => sum + value * right[axis], 0);
}

function vectorLength(vector) {
	return Math.sqrt(dot(vector, vector));
}

function validateProjectionAxes(projectionAxes) {
	const { horizontal, vertical, depth } = projectionAxes ?? {};
	for (const [name, vector] of [["horizontal", horizontal], ["vertical", vertical], ["depth", depth]]) {
		if (!Array.isArray(vector) || vector.length !== 3 || !vector.every(Number.isFinite) || Math.abs(vectorLength(vector) - 1) > 1e-6) {
			throw new Error(`dimension source invalid: elevation camera ${name} axis`);
		}
	}
	if (Math.abs(dot(horizontal, vertical)) > 1e-6 || Math.abs(dot(horizontal, depth)) > 1e-6 || Math.abs(dot(vertical, depth)) > 1e-6) {
		throw new Error("dimension source invalid: elevation camera axes");
	}
	return { horizontal: [...horizontal], vertical: [...vertical], depth: [...depth] };
}

function projectionView(view) {
	if (!view || typeof view !== "object" || !ELEVATION_VIEWS.has(view.name)) throw new Error("dimension source missing: elevation camera");
	return { name: view.name, identity: view.identity, axes: validateProjectionAxes(view.projection_axes) };
}

function assertBoundIdentity(sourceIdentity, targetIdentity, label) {
	if (!sourceIdentity?.geometry_hash) throw new Error("dimension source identity missing: sourceMesh.geometry_hash");
	if (!targetIdentity || typeof targetIdentity !== "object") throw new Error(`dimension source identity missing: ${label}`);
	for (const field of IDENTITY_FIELDS) {
		if (sourceIdentity[field] !== undefined && targetIdentity[field] !== sourceIdentity[field]) {
			throw new Error(`dimension source identity mismatch: ${label}.${field}`);
		}
	}
}

function displayMillimetres(valueM) {
	return Math.round(valueM * 1000);
}

function canonicalMetres(valueM) {
	return displayMillimetres(valueM) / 1000;
}

function exactMassSource(extra = {}) {
	return { kind: "selected_glb_accessor", field: "exact-mass.POSITION", ...extra };
}

function floorGuideSource(index) {
	return { kind: "authored_floor_guide", field: "floor_guides.floor_guides_m", index };
}

function facadePlaneSource(index, component) {
	return { kind: "authored_facade_plane", field: "facade_planes.facade_planes", index, component };
}

function dimension(valueM, source, endpoints_m) {
	const result = { value_m: canonicalMetres(valueM), display_mm: displayMillimetres(valueM), source };
	if (endpoints_m) result.projected_endpoints_m = endpoints_m;
	return result;
}

function outsideEnvelope(value, minimum, maximum) {
	return value < minimum - ENVELOPE_TOLERANCE_M || value > maximum + ENVELOPE_TOLERANCE_M;
}

function assertInsideEnvelope(values, minimum, maximum) {
	if (values.some((value) => outsideEnvelope(value, minimum, maximum))) {
		throw new Error("dimension source outside exact MASS");
	}
}

function projectedFacade(facadePlanes, axes, viewName) {
	const planes = facadePlanes?.facade_planes;
	if (!Array.isArray(planes)) throw new Error("dimension source missing: facade_planes.facade_planes");
	const validNormal = (plane) => Array.isArray(plane?.normal) && plane.normal.length === 3
		&& plane.normal.every(Number.isFinite) && Math.abs(vectorLength(plane.normal) - 1) <= 1e-6;
	const aligned = planes.map((plane, index) => ({ plane, index }))
		.filter(({ plane }) => validNormal(plane) && Math.abs(dot(plane.normal, axes.depth) - 1) <= 1e-6);
	if (aligned.length > 1) throw new Error("dimension source invalid: ambiguous elevation facade plane");
	if (!aligned.length) {
		if (planes.some((plane) => plane?.view === viewName && !validNormal(plane))) throw new Error("dimension source invalid: facade_planes.facade_planes");
		throw new Error("dimension source missing: elevation facade plane");
	}
	const [{ plane, index }] = aligned;
	return { plane, index };
}

function sortedGuideRecords(floorGuides) {
	if (!Array.isArray(floorGuides?.floor_guides_m)) throw new Error("dimension source missing: floor_guides.floor_guides_m");
	const records = floorGuides.floor_guides_m.map((value, index) => ({ value: Number(value), index }));
	if (records.some(({ value }) => !Number.isFinite(value))) throw new Error("dimension source invalid: floor_guides.floor_guides_m");
	records.sort((left, right) => left.value - right.value || left.index - right.index);
	const unique = [];
	for (const record of records) {
		if (!unique.length || displayMillimetres(record.value) !== displayMillimetres(unique.at(-1).value)) unique.push(record);
	}
	return unique;
}

function chooseScaleBar(widthM) {
	const candidates = [20, 10, 5, 2, 1, 0.5, 0.2, 0.1];
	return candidates.find((candidate) => candidate <= widthM / 4) ?? 0.1;
}

function geometryHash(sourceMesh) {
	return sourceMesh?.identity?.geometry_hash
		?? sha256(stableJson({ vertices: sourceMesh?.vertices ?? [], triangles: sourceMesh?.triangles ?? [] }));
}

async function exactMassPositions(artifact) {
	if (!artifact?.path) throw new Error("dimension source missing: selected GLB path");
	const bytes = await readFile(artifact.path);
	const actualSha256 = sha256(bytes);
	if (artifact.sha256 && String(artifact.sha256).toLowerCase() !== actualSha256) throw new Error("selected GLB SHA-256 mismatch");
	const document = await new NodeIO().read(artifact.path);
	const root = document.getRoot();
	const node = root.listNodes().find((item) => item.getName() === "exact-mass");
	if (!node) throw new Error("dimension source missing: exact-mass");
	if (!Array.from(node.getWorldMatrix()).every((value, index) => value === IDENTITY_MATRIX[index])) {
		throw new Error("exact MASS transform invalid");
	}
	const mesh = node.getMesh();
	if (!mesh) throw new Error("dimension source missing: exact-mass");
	const primitives = mesh.listPrimitives();
	if (!primitives.length) throw new Error("dimension source missing: exact-mass.POSITION");
	const positions = [];
	const triangles = [];
	for (const primitive of primitives) {
		const accessor = primitive.getAttribute("POSITION");
		if (!accessor) throw new Error("dimension source missing: exact-mass.POSITION");
		const offset = positions.length;
		for (let index = 0; index < accessor.getCount(); index++) {
			const value = accessor.getElement(index, [0, 0, 0]);
			positions.push(value.map((coordinate) => Math.fround(coordinate)));
		}
		const indices = primitive.getIndices();
		const values = indices
			? Array.from({ length: indices.getCount() }, (_, index) => indices.getScalar(index))
			: Array.from({ length: accessor.getCount() }, (_, index) => index);
		for (let index = 0; index + 2 < values.length; index += 3) triangles.push(values.slice(index, index + 3).map((value) => value + offset));
	}
	return { actualSha256, geometry: { vertices: positions, triangles } };
}

export async function deriveElevationDimensions({ sourceMesh, artifact, facadePlanes, floorGuides, view }) {
	const projection = projectionView(view);
	assertBoundIdentity(sourceMesh?.identity, projection.identity, "view");
	assertBoundIdentity(sourceMesh.identity, floorGuides?.identity, "floorGuides");
	assertBoundIdentity(sourceMesh.identity, facadePlanes?.identity, "facadePlanes");
	const axes = projection.axes;
	const { actualSha256, geometry: exactMassGeometry } = await exactMassPositions(artifact);
	if (!compareGeometry(sourceMesh, exactMassGeometry, 1e-5).accepted) throw new Error("exact MASS geometry mismatch");
	const positions = exactMassGeometry.vertices;
	const horizontalValues = positions.map((point) => dot(point, axes.horizontal));
	const verticalValues = positions.map((point) => dot(point, axes.vertical));
	const minimumHorizontal = Math.min(...horizontalValues);
	const maximumHorizontal = Math.max(...horizontalValues);
	const minimumVertical = Math.min(...verticalValues);
	const maximumVertical = Math.max(...verticalValues);
	if (![minimumHorizontal, maximumHorizontal, minimumVertical, maximumVertical].every(Number.isFinite)) {
		throw new Error("dimension source missing: exact-mass.POSITION");
	}

	const { plane, index: planeIndex } = projectedFacade(facadePlanes, axes, projection.name);
	const validVector = (value) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
	const validExtent = Array.isArray(plane.extent_m) && plane.extent_m.length === 2
		&& plane.extent_m.every((value) => Number.isFinite(value) && value > 0);
	if (!validVector(plane.origin) || !validVector(plane.normal) || Math.abs(vectorLength(plane.normal) - 1) > 1e-6 || !validExtent) {
		throw new Error("dimension source invalid: facade_planes.facade_planes");
	}
	const tangent = [-plane.normal[1], plane.normal[0], 0];
	const horizontalStart = dot(plane.origin, axes.horizontal);
	const horizontalEndPoint = plane.origin.map((value, axis) => value + tangent[axis] * plane.extent_m[0]);
	const verticalEndPoint = plane.origin.map((value, axis) => value + (axis === 2 ? Number(plane.extent_m[1]) : 0));
	const horizontalEnd = dot(horizontalEndPoint, axes.horizontal);
	const verticalStart = dot(plane.origin, axes.vertical);
	const verticalEnd = dot(verticalEndPoint, axes.vertical);
	assertInsideEnvelope([horizontalStart, horizontalEnd], minimumHorizontal, maximumHorizontal);
	assertInsideEnvelope([verticalStart, verticalEnd], minimumVertical, maximumVertical);
	const guides = sortedGuideRecords(floorGuides).map((record) => ({
		...record,
		projected: dot([plane.origin[0], plane.origin[1], record.value], axes.vertical),
	}));
	assertInsideEnvelope(guides.map(({ projected }) => projected), minimumVertical, maximumVertical);

	const projectedBounds = [
		[minimumHorizontal, minimumVertical],
		[maximumHorizontal, maximumVertical],
	];
	const overallWidth = maximumHorizontal - minimumHorizontal;
	const overallHeight = maximumVertical - minimumVertical;
	const levels = guides.map(({ value, index, projected }) => ({
		id: `level-${displayMillimetres(value)}`,
		...dimension(value, floorGuideSource(index), [[minimumHorizontal, projected], [maximumHorizontal, projected]]),
		label: `EL. ${value < 0 ? "-" : "+"}${Math.abs(canonicalMetres(value)).toFixed(3)}`,
	}));
	const floorIntervals = guides.slice(1).map(({ value }, intervalIndex) => {
		const previous = guides[intervalIndex];
		return {
			id: `floor-interval-${intervalIndex}`,
			...dimension(value - previous.value, {
				kind: "authored_floor_guide_interval",
				field: "floor_guides.floor_guides_m",
				indices: [previous.index, guides[intervalIndex + 1].index],
			}, [[minimumHorizontal, previous.projected], [minimumHorizontal, guides[intervalIndex + 1].projected]]),
		};
	});
	const scaleBarM = chooseScaleBar(overallWidth);

	return {
		schema_version: SCHEMA_VERSION,
		view: projection.name,
		selected_glb_sha256: actualSha256,
		geometry_hash: geometryHash(sourceMesh),
		projected_bounds_m: {
			min: projectedBounds[0],
			max: projectedBounds[1],
			source: exactMassSource({ projection_axes: axes }),
		},
		overall_width: dimension(overallWidth, exactMassSource({ projection_axis: "horizontal" }), [[minimumHorizontal, minimumVertical], [maximumHorizontal, minimumVertical]]),
		overall_height: dimension(overallHeight, exactMassSource({ projection_axis: "vertical" }), [[maximumHorizontal, minimumVertical], [maximumHorizontal, maximumVertical]]),
		levels,
		floor_intervals: floorIntervals,
		facade_extent: {
			width: dimension(Math.abs(horizontalEnd - horizontalStart), facadePlaneSource(planeIndex, "extent_m[0]"), [[horizontalStart, verticalStart], [horizontalEnd, verticalStart]]),
			height: dimension(Math.abs(verticalEnd - verticalStart), facadePlaneSource(planeIndex, "extent_m[1]"), [[horizontalStart, verticalStart], [horizontalStart, verticalEnd]]),
		},
		scale_bar: dimension(scaleBarM, exactMassSource({ derivation: "projected_width" }), [[minimumHorizontal, minimumVertical], [minimumHorizontal + scaleBarM, minimumVertical]]),
		tolerance_mm: 1,
	};
}
