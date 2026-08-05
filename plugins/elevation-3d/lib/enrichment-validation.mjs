import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getBounds, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { sha256, stableJson } from "./core.mjs";
import { correctGrammar, PUNCHED_FACADE_MATERIALS, PUNCHED_FACADE_SYSTEM, validatePunchedFacadeGrammar } from "./facade-grammar.mjs";
import { assertCanonicalFacadeSegmentAuthority, PUNCHED_FACADE_BUDGETS } from "./facade-agent/punched-facade.mjs";
import { createFacadePbrMaps } from "./facade-agent/procedural-materials.mjs";
import { readVerifiedFacadeGrammarAuthority } from "./facade-agent/grammar-agent.mjs";

const DRAWING_NAMES = ["plan", "front", "back", "left", "right", "top", "axon"];
const REQUIRED_MATERIALS = ["bronze", "concrete", "glass", "opaque"];
const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const DEFAULT_PRIMITIVE_BUDGET = 5000;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MINIMUM_OPAQUE_COVERAGE = 0.5;
const MAXIMUM_PUNCHED_FACADE_OUTWARD_DEPTH_M = 0.2;
const PBR_DECODE_CACHE = new Map();
const PBR_EXPECTED_HASH_CACHE = new Map();
const TYPED_KINDS = new Set(["corner-return", "brick-cladding", "window-reveal", "window-frame", "glazing", "precast-lintel", "precast-sill"]);
const BOX_INDICES = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
const VERIFIED_FACADE_SCORE_AUTHORITIES = new WeakMap();

function deepFreeze(value) {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const item of Object.values(value)) deepFreeze(item);
	return Object.freeze(value);
}

export function readVerifiedFacadeValidationAuthority(value) {
	if (!value || typeof value !== "object") return null;
	const authority = VERIFIED_FACADE_SCORE_AUTHORITIES.get(value);
	return authority ? structuredClone(authority) : null;
}

export function rehydrateVerifiedFacadeValidationAuthority(value, authority) {
	if (!value || typeof value !== "object" || Array.isArray(value) || value.accepted !== true
		|| !authority || typeof authority !== "object" || Array.isArray(authority)
		|| typeof authority.provider !== "string" || typeof authority.candidateId !== "string"
		|| !authority.bindings || typeof authority.bindings !== "object"
		|| !authority.grammar || typeof authority.grammar !== "object"
		|| !authority.metrics || typeof authority.metrics !== "object"
		|| !Number.isFinite(authority.visualScore)) throw new Error("VALIDATION_REHYDRATION_INVALID");
	const frozenAuthority = deepFreeze(structuredClone(authority));
	deepFreeze(value);
	VERIFIED_FACADE_SCORE_AUTHORITIES.set(value, frozenAuthority);
	return value;
}

function boundsOf(vertices) {
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (const point of vertices) for (let axis = 0; axis < 3; axis++) {
		min[axis] = Math.min(min[axis], point[axis]);
		max[axis] = Math.max(max[axis], point[axis]);
	}
	return { min, max };
}

function rounded(value) {
	return Number(value.toFixed(12));
}

function boundsDistance(left, right) {
	return Math.hypot(...[0, 1, 2].map((axis) => Math.max(0, left.min[axis] - right.max[axis], right.min[axis] - left.max[axis])));
}

async function decodedPngValid(image, hash) {
	if (PBR_DECODE_CACHE.has(hash)) return PBR_DECODE_CACHE.get(hash);
	let valid = false;
	try {
		const { data, info } = await sharp(image, { failOn: "error", limitInputPixels: 2048 * 2048 }).raw().toBuffer({ resolveWithObject: true });
		valid = info.format === "raw" && info.width === 2048 && info.height === 2048 && info.channels === 4
			&& data.length === 2048 * 2048 * 4;
	} catch { valid = false; }
	if (PBR_DECODE_CACHE.size >= 64) PBR_DECODE_CACHE.delete(PBR_DECODE_CACHE.keys().next().value);
	PBR_DECODE_CACHE.set(hash, valid);
	return valid;
}

async function typedPbrValid(root, grammar) {
	try {
		const grammarHash = sha256(JSON.stringify(validatePunchedFacadeGrammar(grammar, { allowDerived: true })));
		let expectedHashes = PBR_EXPECTED_HASH_CACHE.get(grammarHash);
		if (!expectedHashes) {
			const maps = createFacadePbrMaps({ grammar, resolution: 2048 });
			expectedHashes = Object.fromEntries(Object.values(maps).flatMap((channels) => Object.values(channels).map((map) => [map.name, map.sha256])));
			if (PBR_EXPECTED_HASH_CACHE.size >= 16) PBR_EXPECTED_HASH_CACHE.delete(PBR_EXPECTED_HASH_CACHE.keys().next().value);
			PBR_EXPECTED_HASH_CACHE.set(grammarHash, expectedHashes);
		}
		for (const name of ["brick", "precast"]) {
			const material = root.listMaterials().find((candidate) => candidate.getName() === name);
			const textures = [
				[material?.getBaseColorTexture(), `${name}-base-color`],
				[material?.getNormalTexture(), `${name}-normal`],
				[material?.getMetallicRoughnessTexture(), `${name}-metallic-roughness`],
			];
			if (textures.some(([texture]) => !texture)) return false;
			for (const [texture, expectedName] of textures) {
				const extras = texture.getExtras();
				const image = texture.getImage();
				if (texture.getName() !== expectedName || extras?.generator !== "elevation-3d-procedural-pbr-v1" || extras?.grammar_sha256 !== grammarHash
					|| !/^[a-f0-9]{64}$/.test(extras?.sha256 ?? "") || extras.sha256 !== sha256(texture.getImage())
					|| extras.sha256 !== expectedHashes[expectedName]
					|| texture.getMimeType() !== "image/png" || JSON.stringify(texture.getSize()) !== JSON.stringify([2048, 2048])
					|| !await decodedPngValid(image, extras.sha256)) return false;
			}
		}
		return true;
	} catch { return false; }
}

function typedPrimitiveShapeValid(primitive, surfaces, segmentById) {
	const positions = primitive.getAttribute("POSITION"), indices = primitive.getIndices(), extras = primitive.getExtras();
	if (!positions || positions.getCount() !== 8 || !indices || indices.getCount() !== 36
		|| !TYPED_KINDS.has(extras?.kind) || !surfaces.includes(extras?.view)) return false;
	const positionValues = positions.getArray(), indexValues = indices.getArray();
	if (!Array.from(positionValues).every((value) => Number.isFinite(value))
		|| JSON.stringify(Array.from(indexValues)) !== JSON.stringify(BOX_INDICES)) return false;
	if (extras?.segment_id) {
		const segment = segmentById?.get(extras.segment_id);
		const bounds = extras.local_bounds;
		if (!segment || extras.segment_length_m !== segment.extent_m[0]
			|| extras.segment_start_corner_id !== segment.start_corner_id || extras.segment_end_corner_id !== segment.end_corner_id
			|| !bounds || !["u0", "u1", "v0", "v1", "n0", "n1"].every((key) => Number.isFinite(bounds[key]))
			|| bounds.u0 < -1e-7 || bounds.u1 > segment.extent_m[0] + 1e-7
			|| bounds.v0 < -1e-7 || bounds.v1 > segment.extent_m[1] + 1e-7) return false;
		const points = Array.from({ length: 8 }, (_, index) => [0, 1, 2].map((axis) => positionValues[index * 3 + axis]));
		const close = (left, right, tolerance = 2e-5) => left.every((value, axis) => Math.abs(value - right[axis]) <= tolerance);
		const tangent = [-segment.normal[1], segment.normal[0], 0];
		const expected = [
			[bounds.u0, bounds.v0, bounds.n0], [bounds.u1, bounds.v0, bounds.n0],
			[bounds.u1, bounds.v1, bounds.n0], [bounds.u0, bounds.v1, bounds.n0],
			[bounds.u0, bounds.v0, bounds.n1], [bounds.u1, bounds.v0, bounds.n1],
			[bounds.u1, bounds.v1, bounds.n1], [bounds.u0, bounds.v1, bounds.n1],
		].map(([u, v, n]) => segment.origin.map((value, axis) => value + tangent[axis] * u + (axis === 2 ? v : 0) + segment.normal[axis] * n));
		return points.every((point, index) => close(point, expected[index]));
	}
	const axes = [0, 1, 2].map((axis) => [...new Set(Array.from({ length: 8 }, (_, index) => positionValues[index * 3 + axis]))]);
	if (axes.some((values) => values.length !== 2)) return false;
	const expectedCorners = new Set(axes[0].flatMap((x) => axes[1].flatMap((y) => axes[2].map((z) => `${x},${y},${z}`))));
	return new Set(Array.from({ length: 8 }, (_, index) => `${positionValues[index * 3]},${positionValues[index * 3 + 1]},${positionValues[index * 3 + 2]}`)).size === 8
		&& Array.from({ length: 8 }, (_, index) => `${positionValues[index * 3]},${positionValues[index * 3 + 1]},${positionValues[index * 3 + 2]}`)
			.every((key) => expectedCorners.has(key));
}

function documentWithinBudget(root, primitiveBudget) {
	if (root.listAccessors().length > primitiveBudget * 3 + 2) return false;
	let primitives = 0, vertices = 0, indices = 0;
	for (const mesh of root.listMeshes()) for (const primitive of mesh.listPrimitives()) {
		primitives++;
		if (primitives > primitiveBudget + 1) return false;
		vertices += primitive.getAttribute("POSITION")?.getCount() ?? 0;
		indices += primitive.getIndices()?.getCount() ?? 0;
		if (vertices > PUNCHED_FACADE_BUDGETS.maxTotalVertices || indices > PUNCHED_FACADE_BUDGETS.maxTotalIndices) return false;
	}
	return true;
}

function projectedRectangle(record) {
	const horizontalAxis = record.extras.view === "front" || record.extras.view === "back" ? 0 : 1;
	return {
		minX: record.bounds.min[horizontalAxis], maxX: record.bounds.max[horizontalAxis],
		minY: record.bounds.min[2], maxY: record.bounds.max[2],
	};
}

function rectanglesOverlap(rectangles, tolerance = 1e-7) {
	const sorted = [...rectangles].sort((left, right) => left.minX - right.minX || left.minY - right.minY
		|| left.maxX - right.maxX || left.maxY - right.maxY);
	for (let leftIndex = 0; leftIndex < sorted.length; leftIndex++) {
		const left = sorted[leftIndex];
		for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex++) {
			const right = sorted[rightIndex];
			if (right.minX >= left.maxX - tolerance) break;
			if (Math.min(left.maxY, right.maxY) - Math.max(left.minY, right.minY) > tolerance) return true;
		}
	}
	return false;
}

function rectangleUnionArea(rectangles) {
	const xValues = [...new Set(rectangles.flatMap((rectangle) => [rectangle.minX, rectangle.maxX]))].sort((a, b) => a - b);
	let area = 0;
	for (let index = 0; index + 1 < xValues.length; index++) {
		const minX = xValues[index], maxX = xValues[index + 1];
		if (!(maxX > minX)) continue;
		const intervals = rectangles.filter((rectangle) => rectangle.minX < maxX && rectangle.maxX > minX)
			.map((rectangle) => [rectangle.minY, rectangle.maxY]).sort((left, right) => left[0] - right[0] || left[1] - right[1]);
		let unionLength = 0, start = null, end = null;
		for (const [intervalStart, intervalEnd] of intervals) {
			if (!(intervalEnd > intervalStart)) continue;
			if (start === null) { start = intervalStart; end = intervalEnd; continue; }
			if (intervalStart <= end) end = Math.max(end, intervalEnd);
			else { unionLength += end - start; start = intervalStart; end = intervalEnd; }
		}
		if (start !== null) unionLength += end - start;
		area += (maxX - minX) * unionLength;
	}
	return area;
}

function clippedRectangle(rectangle, canonical) {
	const clipped = {
		minX: Math.max(rectangle.minX, canonical.minX), maxX: Math.min(rectangle.maxX, canonical.maxX),
		minY: Math.max(rectangle.minY, canonical.minY), maxY: Math.min(rectangle.maxY, canonical.maxY),
	};
	return clipped.maxX > clipped.minX && clipped.maxY > clipped.minY ? clipped : null;
}

function typedFacadeMetrics(detailRecords, surfaces, floorGuides, facadeLengths, sourceBounds, expectedSegmentIds = []) {
	const segmentMode = detailRecords.some((record) => typeof record.extras?.segment_id === "string");
	const recordsByView = Map.groupBy(detailRecords.filter((record) => surfaces.includes(record.extras?.view)), (record) => record.extras.view);
	let projectionOverlap = false;
	const facadeHeight = floorGuides.length > 1 ? floorGuides.at(-1) - floorGuides[0] : 0;
	const coverageGroups = segmentMode
		? [...Map.groupBy(detailRecords.filter((record) => record.extras?.segment_id), (record) => record.extras.segment_id).entries()]
		: surfaces.map((view) => [view, recordsByView.get(view) ?? []]);
	const viewOpaqueCoverage = coverageGroups.map(([group, records]) => {
		const opaqueRectangles = records.filter((record) => ["brick-cladding", "corner-return"].includes(record.extras?.kind) && record.material === "brick")
			.map((record) => segmentMode ? {
				minX: record.extras.local_bounds.u0, maxX: record.extras.local_bounds.u1,
				minY: record.extras.local_bounds.v0, maxY: record.extras.local_bounds.v1,
			} : projectedRectangle(record));
		if (rectanglesOverlap(opaqueRectangles)) projectionOverlap = true;
		const representative = records[0]?.extras;
		const view = group;
		const horizontalAxis = view === "front" || view === "back" ? 0 : 1;
		const canonicalRectangle = segmentMode ? {
			minX: 0, maxX: Number(representative?.segment_length_m),
			minY: floorGuides[0] - (records[0].bounds.min[2] - Math.min(representative.local_bounds.v0, representative.local_bounds.v1)),
			maxY: floorGuides.at(-1) - (records[0].bounds.min[2] - Math.min(representative.local_bounds.v0, representative.local_bounds.v1)),
		} : {
			minX: sourceBounds.min[horizontalAxis], maxX: sourceBounds.max[horizontalAxis],
			minY: floorGuides[0], maxY: floorGuides.at(-1),
		};
		const clippedRectangles = opaqueRectangles.map((rectangle) => clippedRectangle(rectangle, canonicalRectangle)).filter(Boolean);
		const canonicalArea = (segmentMode ? Number(representative?.segment_length_m) : Number(facadeLengths?.[view])) * facadeHeight;
		return canonicalArea > 0 ? Math.min(1, rectangleUnionArea(clippedRectangles) / canonicalArea) : 0;
	});
	const opaqueMaterialsValid = detailRecords.every((record) => !["brick-cladding", "corner-return", "window-reveal"].includes(record.extras?.kind)
		|| record.material === "brick") && detailRecords.every((record) => record.extras?.kind !== "glazing" || record.material === "glass");
	const viewsPresent = surfaces.filter((view) => (recordsByView.get(view)?.length ?? 0) > 0);
	const reveals = detailRecords.filter((record) => record.extras?.kind === "window-reveal");
	const revealDepths = reveals.map((record) => {
		if (segmentMode) return Number(record.extras.depth_m);
		const view = record.extras.view;
		const depthAxis = view === "front" || view === "back" ? 1 : 0;
		return record.bounds.max[depthAxis] - record.bounds.min[depthAxis];
	}).filter(Number.isFinite);
	const corners = Map.groupBy(detailRecords.filter((record) => record.extras?.kind === "corner-return"), (record) => record.extras.corner_anchor_id);
	const floorStarts = floorGuides.slice(0, -1);
	const segmentIds = segmentMode ? [...expectedSegmentIds] : [];
	const coverageKeys = segmentMode ? segmentIds : surfaces;
	const cornerKeysComplete = coverageKeys.every((key) => floorStarts.every((floor) => {
		const records = detailRecords.filter((record) => record.extras?.kind === "corner-return"
			&& (segmentMode ? record.extras.segment_id === key : record.extras.view === key)
			&& Math.abs(Number(record.extras.floor_m) - floor) <= 1e-5);
		return ["corner-start", "corner-end"].every((slot) => records.filter((record) => record.extras.slot === slot).length === 1);
	})) && [...corners.values()].every((group) => group.length === 2
		&& new Set(group.map((record) => segmentMode ? record.extras.segment_id : record.extras.view)).size === 2);
	const inferredGlazing = detailRecords.filter((record) => record.extras?.kind === "glazing").map((record) => {
		const matches = floorStarts.map((floor, index) => ({ floor, index })).filter(({ index }) => (
			record.bounds.min[2] >= floorGuides[index] - 1e-5 && record.bounds.max[2] <= floorGuides[index + 1] + 1e-5
		));
		return { record, matches };
	});
	const floorKeysComplete = coverageKeys.every((key) => floorStarts.every((floor) => inferredGlazing.some(({ record, matches }) => (
		(segmentMode ? record.extras?.segment_id === key : record.extras?.view === key)
		&& matches.length === 1 && Math.abs(matches[0].floor - floor) <= 1e-5
	))));
	let cornerMaxGap = 0;
	let cornerInvalid = false;
	for (const group of corners.values()) {
		if (group.length !== 2) { cornerInvalid = true; continue; }
		cornerMaxGap = Math.max(cornerMaxGap, boundsDistance(group[0].bounds, group[1].bounds));
	}
	let floorError = 0, floorLabelMismatch = false;
	for (const { record, matches } of inferredGlazing) {
		if (matches.length !== 1) {
			const minimumError = floorStarts.reduce((minimum, _floor, index) => Math.min(minimum, Math.max(
				floorGuides[index] - record.bounds.min[2], record.bounds.max[2] - floorGuides[index + 1], 0,
			)), Infinity);
			floorError = Math.max(floorError, Number.isFinite(minimumError) ? minimumError : 0);
		}
		if (Object.hasOwn(record.extras, "floor_m")) {
			const label = record.extras.floor_m;
			if (!Number.isFinite(label) || Object.is(label, -0) || matches.length !== 1 || Math.abs(label - matches[0].floor) > 1e-5) floorLabelMismatch = true;
		}
	}
	return {
		opaque_wall_coverage: viewOpaqueCoverage.length ? Math.min(...viewOpaqueCoverage) : 0,
		minimum_reveal_depth_m: revealDepths.length ? Math.min(...revealDepths) : 0,
		corner_max_gap_m: cornerInvalid ? null : cornerMaxGap,
		floor_alignment_max_error_m: floorError,
		facade_orientation_coverage: surfaces.length ? viewsPresent.length / surfaces.length : 0,
		corner_keys_complete: cornerKeysComplete,
		floor_keys_complete: floorKeysComplete,
		floor_label_mismatch: floorLabelMismatch,
		opaque_materials_valid: opaqueMaterialsValid,
		projection_overlap: projectionOverlap,
	};
}

async function pngInfo(bytes) {
	try {
		const { data, info } = await sharp(bytes, { failOn: "error" }).raw().toBuffer({ resolveWithObject: true });
		if (info.format !== "raw" || info.width <= 0 || info.height <= 0 || data.length !== info.width * info.height * info.channels) return null;
		return { width: info.width, height: info.height };
	} catch {
		return null;
	}
}

function pathFrom(root, path) {
	return isAbsolute(path) ? resolve(path) : resolve(root, path);
}

function primitiveWorldBounds(primitive, matrix) {
	const positions = primitive.getAttribute("POSITION");
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	if (!positions) return { min, max, centroid: [NaN, NaN, NaN], samples: [] };
	const centroid = [0, 0, 0];
	const points = [];
	for (let index = 0; index < positions.getCount(); index++) {
		const [x, y, z] = positions.getElement(index, [0, 0, 0]);
		const point = [
			matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
			matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
			matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
		];
		points.push(point);
		for (let axis = 0; axis < 3; axis++) {
			min[axis] = Math.min(min[axis], point[axis]);
			max[axis] = Math.max(max[axis], point[axis]);
			centroid[axis] += point[axis] / positions.getCount();
		}
	}
	const samples = [...points];
	const indices = primitive.getIndices();
	const values = indices ? Array.from(indices.getArray()) : Array.from({ length: points.length }, (_, index) => index);
	for (let index = 0; index + 2 < values.length; index += 3) {
		const a = points[values[index]], b = points[values[index + 1]], c = points[values[index + 2]];
		samples.push(
			a.map((value, axis) => (value + b[axis]) / 2),
			b.map((value, axis) => (value + c[axis]) / 2),
			c.map((value, axis) => (value + a[axis]) / 2),
			a.map((value, axis) => (value + b[axis] + c[axis]) / 3),
		);
	}
	return { min, max, centroid, samples };
}

function components(indices, vertexCount) {
	const parent = Array.from({ length: vertexCount }, (_, index) => index);
	const find = (value) => parent[value] === value ? value : (parent[value] = find(parent[value]));
	const union = (a, b) => { const x = find(a), y = find(b); if (x !== y) parent[y] = x; };
	for (let index = 0; index + 2 < indices.length; index += 3) {
		union(indices[index], indices[index + 1]);
		union(indices[index], indices[index + 2]);
	}
	return new Set(indices.map(find)).size;
}

function componentRegions(mesh) {
	const parent = Array.from({ length: mesh.vertices.length }, (_, index) => index);
	const find = (value) => parent[value] === value ? value : (parent[value] = find(parent[value]));
	const union = (a, b) => { const x = find(a), y = find(b); if (x !== y) parent[y] = x; };
	const referenced = new Set();
	for (const triangle of mesh.triangles) {
		triangle.forEach((index) => referenced.add(index));
		union(triangle[0], triangle[1]);
		union(triangle[0], triangle[2]);
	}
	const groups = new Map();
	for (const index of referenced) {
		const root = find(index);
		if (!groups.has(root)) groups.set(root, { vertices: [], triangles: [] });
		groups.get(root).vertices.push(mesh.vertices[index]);
	}
	for (const triangle of mesh.triangles) groups.get(find(triangle[0])).triangles.push(triangle.map((index) => mesh.vertices[index]));
	return [...groups.values()].map((group) => ({ ...boundsOf(group.vertices), triangles: group.triangles }));
}

function overlaps(bounds, region, tolerance) {
	return [0, 1, 2].every((axis) => bounds.max[axis] >= region.min[axis] - tolerance && bounds.min[axis] <= region.max[axis] + tolerance);
}

function subtract(a, b) {
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a, b) {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function pointSegmentDistanceSquared(point, a, b) {
	const ab = subtract(b, a);
	const denominator = dot(ab, ab);
	const t = denominator ? Math.max(0, Math.min(1, dot(subtract(point, a), ab) / denominator)) : 0;
	const closest = a.map((value, axis) => value + ab[axis] * t);
	const delta = subtract(point, closest);
	return dot(delta, delta);
}

function pointTriangleDistanceSquared(point, a, b, c) {
	const ab = subtract(b, a), ac = subtract(c, a), ap = subtract(point, a);
	const d1 = dot(ab, ap), d2 = dot(ac, ap);
	if (d1 <= 0 && d2 <= 0) return dot(ap, ap);
	const bp = subtract(point, b);
	const d3 = dot(ab, bp), d4 = dot(ac, bp);
	if (d3 >= 0 && d4 <= d3) return dot(bp, bp);
	const vc = d1 * d4 - d3 * d2;
	if (vc <= 0 && d1 >= 0 && d3 <= 0) return pointSegmentDistanceSquared(point, a, b);
	const cp = subtract(point, c);
	const d5 = dot(ab, cp), d6 = dot(ac, cp);
	if (d6 >= 0 && d5 <= d6) return dot(cp, cp);
	const vb = d5 * d2 - d1 * d6;
	if (vb <= 0 && d2 >= 0 && d6 <= 0) return pointSegmentDistanceSquared(point, a, c);
	const va = d3 * d6 - d5 * d4;
	if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return pointSegmentDistanceSquared(point, b, c);
	const denominator = va + vb + vc;
	if (Math.abs(denominator) <= Number.EPSILON) return Math.min(
		pointSegmentDistanceSquared(point, a, b),
		pointSegmentDistanceSquared(point, b, c),
		pointSegmentDistanceSquared(point, c, a),
	);
	const inverse = 1 / denominator;
	const closest = a.map((value, axis) => value + ab[axis] * vb * inverse + ac[axis] * vc * inverse);
	const delta = subtract(point, closest);
	return dot(delta, delta);
}

function detailComponentDistance(record, component) {
	let minimum = Infinity;
	for (const point of record.bounds.samples) for (const triangle of component.triangles) {
		minimum = Math.min(minimum, pointTriangleDistanceSquared(point, triangle[0], triangle[1], triangle[2]));
	}
	return Math.sqrt(minimum);
}

export async function validateEnrichment({ sourceMesh, artifact, grammar, extractedGrammar, requiredDrawings, facadeSegmentAuthority, safeFallback = false }) {
	const codes = [];
	const metrics = { missing_drawings: [], drawing_dimensions: {} };
	const artifacts = { glb: resolve(artifact.path), drawings: {} };
	const punchedFacade = grammar?.system === PUNCHED_FACADE_SYSTEM && !safeFallback;
	let canonicalFacadeSegmentAuthority = null;
	if (facadeSegmentAuthority) {
		try {
			canonicalFacadeSegmentAuthority = assertCanonicalFacadeSegmentAuthority({ mesh: sourceMesh, facadeSegmentAuthority });
			metrics.segment_authority_match = true;
		} catch {
			metrics.segment_authority_match = false;
			codes.push("FACADE_SEGMENT_AUTHORITY_MISMATCH");
		}
	}
	let typedGrammarValid = true;
	if (punchedFacade) {
		try {
			if (!Array.isArray(grammar.floor_elevations_m) || grammar.floor_elevations_m.length > PUNCHED_FACADE_BUDGETS.maxFloorGuides) {
				throw new RangeError("floor guide budget exceeded");
			}
			validatePunchedFacadeGrammar(grammar, {
				floorGuides: { floor_guides_m: grammar.floor_elevations_m }, allowDerived: true,
			});
		} catch { typedGrammarValid = false; codes.push("FACADE_GRAMMAR_INVALID"); }
	}
	let glbBytes;
	let glbHash;
	let artifactRealPath;
	let document;
	try {
		artifactRealPath = await realpath(artifact.path);
		artifacts.glb = artifactRealPath;
		const artifactStat = await stat(artifactRealPath);
		metrics.glb_size_bytes = artifactStat.size;
		if (!artifactStat.isFile() || artifactStat.size > MAX_ARTIFACT_BYTES) codes.push("ARTIFACT_BUDGET_EXCEEDED");
		else {
			glbBytes = await readFile(artifactRealPath);
			glbHash = sha256(glbBytes);
			artifacts.glb_sha256 = glbHash;
			if (glbHash !== String(artifact.sha256 ?? "").toLowerCase()) codes.push("ARTIFACT_HASH_MISMATCH");
			try { document = await new NodeIO().read(artifactRealPath); }
			catch { codes.push("GLB_INVALID"); }
		}
	} catch {
		codes.push("ARTIFACT_MISSING");
	}
	if (document && punchedFacade) {
		if (!typedGrammarValid || !documentWithinBudget(document.getRoot(), DEFAULT_PRIMITIVE_BUDGET)) {
			if (typedGrammarValid) codes.push("ARTIFACT_BUDGET_EXCEEDED");
			document = undefined;
		}
	}

	const sourceBounds = boundsOf(sourceMesh.vertices);
	const allowedDetailExcess = rounded((punchedFacade
		? Math.min(Number(grammar.cladding_depth_m), MAXIMUM_PUNCHED_FACADE_OUTWARD_DEPTH_M)
		: Math.max(Number(grammar.frame_depth_m), Number(grammar.mullion_depth_m))) + 0.01);
	const allowedAttachmentDistance = rounded((punchedFacade
		? Math.max(Number(grammar.cladding_depth_m), Number(grammar.reveal_depth_m), Number(grammar.sill_depth_m))
		: Math.max(Number(grammar.frame_depth_m), Number(grammar.mullion_depth_m))) + 0.01);
	metrics.allowed_detail_excess_m = allowedDetailExcess;
	if (document) {
		const root = document.getRoot();
		const baseNodes = root.listNodes().filter((node) => node.getName() === "exact-mass");
		const baseNode = baseNodes.length === 1 ? baseNodes[0] : null;
		const basePrimitives = baseNode?.getMesh()?.getName() === "exact-mass" ? baseNode.getMesh().listPrimitives() : [];
		const basePrimitive = basePrimitives.length === 1 ? basePrimitives[0] : null;
		const positions = basePrimitive?.getAttribute("POSITION");
		const indices = basePrimitive?.getIndices();
		metrics.canonical_surface_match = 0;
		if (!basePrimitive || !positions || !indices) codes.push("BASE_PRIMITIVE_MISSING");
		else {
			const expectedPositions = Array.from(new Float32Array(sourceMesh.vertices.flat()));
			const actualPositions = Array.from(positions.getArray());
			const expectedIndices = sourceMesh.triangles.flat();
			const actualIndices = Array.from(indices.getArray());
			const identityTransform = Array.from(baseNode.getWorldMatrix()).every((value, index) => value === IDENTITY_MATRIX[index]);
			const canonicalSurfaceMatch = identityTransform && JSON.stringify(actualPositions) === JSON.stringify(expectedPositions)
				&& JSON.stringify(actualIndices) === JSON.stringify(expectedIndices);
			metrics.canonical_surface_match = canonicalSurfaceMatch ? 1 : 0;
			if (!canonicalSurfaceMatch) codes.push(punchedFacade ? "CANONICAL_SURFACE_MISMATCH" : "BASE_GEOMETRY_CHANGED");
			metrics.source_base_components = components(expectedIndices, expectedPositions.length / 3);
			metrics.actual_base_components = components(actualIndices, actualPositions.length / 3);
			metrics.base_vertex_count = positions.getCount();
			metrics.base_triangle_count = indices.getCount() / 3;
			metrics.base_sha256 = sha256(Buffer.concat([
				Buffer.from(new Float32Array(actualPositions).buffer),
				Buffer.from(actualIndices.join(",")),
			]));
		}

		const scene = root.getDefaultScene() ?? root.listScenes()[0];
		const actualBounds = scene ? getBounds(scene) : { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
		metrics.bounds = actualBounds;
		let maximumBoundsExcess = 0;
		for (let axis = 0; axis < 3; axis++) maximumBoundsExcess = Math.max(
			maximumBoundsExcess,
			sourceBounds.min[axis] - actualBounds.min[axis],
			actualBounds.max[axis] - sourceBounds.max[axis],
		);
		metrics.maximum_bounds_excess_m = rounded(maximumBoundsExcess);
		if (metrics.maximum_bounds_excess_m > allowedDetailExcess) codes.push("DETAIL_BOUNDS_EXCEEDED");

		const primitives = root.listMeshes().flatMap((mesh) => mesh.listPrimitives());
		const detailNodes = root.listNodes().filter((node) => node.getName() === "facade-details");
		const detailNode = detailNodes.length === 1 ? detailNodes[0] : null;
		const detailPrimitives = detailNode?.getMesh()?.listPrimitives() ?? [];
		if (punchedFacade) {
			const outwardDepths = detailPrimitives.flatMap((primitive) => {
				const bounds = primitive.getExtras()?.local_bounds;
				return [bounds?.n0, bounds?.n1].filter(Number.isFinite);
			});
			metrics.maximum_outward_depth_m = outwardDepths.length ? rounded(Math.max(...outwardDepths)) : null;
			metrics.allowed_outward_depth_m = MAXIMUM_PUNCHED_FACADE_OUTWARD_DEPTH_M;
			if (metrics.maximum_outward_depth_m > MAXIMUM_PUNCHED_FACADE_OUTWARD_DEPTH_M) {
				codes.push("DETAIL_BOUNDS_EXCEEDED");
			}
		}
		if (punchedFacade) {
			const canonicalMeshes = new Set([baseNode?.getMesh(), detailNode?.getMesh()].filter(Boolean));
			const nonCanonicalGeometry = basePrimitives.length !== 1 || detailNodes.length !== 1 || detailNode?.getMesh()?.getName() !== "facade-details"
				|| root.listMeshes().some((mesh) => mesh.listPrimitives().length > 0 && !canonicalMeshes.has(mesh))
				|| root.listNodes().some((node) => node.getMesh() && node !== baseNode && node !== detailNode);
			if (nonCanonicalGeometry) codes.push("NON_CANONICAL_GEOMETRY");
		}
		const materials = [...new Set(primitives.map((primitive) => primitive.getMaterial()?.getName()).filter(Boolean))].sort();
		metrics.primitive_count = primitives.length;
		metrics.detail_primitive_count = detailPrimitives.length;
		metrics.materials = materials;
		const fallbackMaterialValid = detailPrimitives.length === 0 && materials.length === 1 && materials[0] === "concrete";
		const expectedPunchedMaterials = ["concrete", ...PUNCHED_FACADE_MATERIALS].sort();
		const enrichedMaterialsValid = punchedFacade
			? detailPrimitives.length > 0 && JSON.stringify(materials) === JSON.stringify(expectedPunchedMaterials)
			: detailPrimitives.length > 0 && REQUIRED_MATERIALS.every((name) => materials.includes(name));
		if (safeFallback ? !fallbackMaterialValid : !enrichedMaterialsValid) codes.push("MATERIAL_SET_INVALID");
		if (punchedFacade && !await typedPbrValid(root, grammar)) codes.push("PBR_MATERIAL_INVALID");
		const primitiveBudget = Number.isFinite(Number(grammar.primitive_budget)) ? Number(grammar.primitive_budget) : DEFAULT_PRIMITIVE_BUDGET;
		metrics.primitive_budget = primitiveBudget;
		if (primitives.length > primitiveBudget) codes.push("PRIMITIVE_BUDGET_EXCEEDED");

		const floorGuides = (grammar.floor_elevations_m ?? []).map(Number);
		const detailMatrix = detailNode?.getWorldMatrix() ?? IDENTITY_MATRIX;
		const authoritativeSegments = canonicalFacadeSegmentAuthority?.facade_planes ?? [];
		const segmentById = new Map(authoritativeSegments.map((segment) => [segment.segment_id, segment]));
		const primitiveSegmentIds = detailPrimitives.map((primitive) => primitive.getExtras()?.segment_id);
		const usesSegments = primitiveSegmentIds.some((segmentId) => typeof segmentId === "string");
		const expectsSegments = Boolean(facadeSegmentAuthority);
		const actualSegmentIds = new Set(primitiveSegmentIds);
		const segmentAuthorityValid = expectsSegments
			? Boolean(canonicalFacadeSegmentAuthority) && segmentById.size === authoritativeSegments.length && segmentById.size > 0
				&& primitiveSegmentIds.every((segmentId) => typeof segmentId === "string" && segmentById.has(segmentId))
				&& actualSegmentIds.size === segmentById.size
			: !usesSegments;
		const typedShapesValid = !punchedFacade || (segmentAuthorityValid
			&& detailPrimitives.every((primitive) => typedPrimitiveShapeValid(primitive, grammar.surfaces, segmentById)));
		metrics.segment_authority_match = segmentAuthorityValid;
		if (!segmentAuthorityValid && !codes.includes("FACADE_SEGMENT_AUTHORITY_MISMATCH")) codes.push("FACADE_SEGMENT_AUTHORITY_MISMATCH");
		if (!typedShapesValid) codes.push("FACADE_PRIMITIVE_SHAPE_INVALID");
		const detailRecords = typedShapesValid ? detailPrimitives.map((primitive) => ({
			extras: primitive.getExtras(),
			material: primitive.getMaterial()?.getName() ?? null,
			bounds: primitiveWorldBounds(primitive, detailMatrix),
		})) : [];
		const sourceRegions = componentRegions(sourceMesh);
		const attachmentDistances = detailRecords.map((record) => sourceRegions.map((region) => (
				overlaps(record.bounds, region, allowedAttachmentDistance) ? detailComponentDistance(record, region) : Infinity
			)));
		const attachmentCounts = attachmentDistances.map((distances) => distances.filter((distance) => distance <= allowedAttachmentDistance + 1e-7).length);
		metrics.source_component_regions = sourceRegions.map(({ min, max }) => ({ min, max }));
		metrics.detail_component_distances_m = attachmentDistances.map((distances) => distances.map((distance) => Number.isFinite(distance) ? rounded(distance) : null));
		metrics.detail_component_attachment_counts = attachmentCounts;
		if (typedShapesValid && attachmentCounts.some((count) => count === 0)) codes.push("DETAIL_COMPONENT_UNATTACHED");
		if (typedShapesValid && attachmentCounts.some((count) => count > 1)) codes.push("DETAIL_COMPONENT_BRIDGE");
		const detailExtras = detailRecords.map((record) => record.extras);
		const facadeViews = Object.keys(grammar.facade_lengths_m ?? {});
		if (!safeFallback && !punchedFacade && facadeViews.some((view) => !detailExtras.some((extras) => extras?.kind === "mullion" && extras.view === view))) codes.push("DETAIL_COVERAGE_MISSING");
		if (!safeFallback && !punchedFacade && floorGuides.length) {
			const bands = detailRecords.filter((record) => record.extras?.kind === "floor-band");
			const elevations = bands.map((record) => Number(record.extras.elevation_m)).filter(Number.isFinite);
			const alignedBands = bands.filter((record) => {
				const elevation = Number(record.extras.elevation_m);
				return Number.isFinite(elevation)
					&& elevation >= record.bounds.min[2] - 1e-5
					&& elevation <= record.bounds.max[2] + 1e-5
					&& Math.abs(record.bounds.centroid[2] - elevation) <= 0.061;
			});
			metrics.floor_band_elevations_m = [...new Set(elevations)].sort((a, b) => a - b);
			const coverageMissing = facadeViews.length
				? facadeViews.some((view) => floorGuides.some((guide) => !alignedBands.some((band) => band.extras.view === view && Math.abs(Number(band.extras.elevation_m) - guide) <= 1e-5)))
				: floorGuides.some((guide) => !alignedBands.some((band) => Math.abs(Number(band.extras.elevation_m) - guide) <= 1e-5));
			if (coverageMissing) codes.push("FLOOR_GUIDE_COVERAGE_MISSING");
			if (elevations.some((value) => value < sourceBounds.min[2] - 1e-5 || value > sourceBounds.max[2] + 1e-5 || !floorGuides.some((guide) => Math.abs(value - guide) <= 1e-5))) codes.push("NEW_STOREY_DETECTED");
		}
		if (punchedFacade && typedShapesValid) {
			const surfaces = Array.isArray(grammar.surfaces) ? grammar.surfaces : [];
			const typedMetrics = typedFacadeMetrics(detailRecords, surfaces, floorGuides, grammar.facade_lengths_m, sourceBounds, [...segmentById.keys()]);
			const {
				corner_keys_complete: cornerKeysComplete, floor_keys_complete: floorKeysComplete,
				floor_label_mismatch: floorLabelMismatch, opaque_materials_valid: opaqueMaterialsValid,
				projection_overlap: projectionOverlap, ...publicMetrics
			} = typedMetrics;
			Object.assign(metrics, Object.fromEntries(Object.entries(publicMetrics).map(([name, value]) => (
				[name, Number.isFinite(value) ? Number(value.toFixed(6)) : null]
			))));
			if (metrics.facade_orientation_coverage !== 1) codes.push("FACADE_ORIENTATION_COVERAGE_MISSING");
			if (!opaqueMaterialsValid || metrics.opaque_wall_coverage < MINIMUM_OPAQUE_COVERAGE) codes.push("OPAQUE_WALL_COVERAGE_MISSING");
			if (projectionOverlap) codes.push("FACADE_PROJECTION_OVERLAP");
			if (metrics.minimum_reveal_depth_m < Number(grammar.reveal_depth_m) - 1e-5) codes.push("PUNCHED_REVEAL_DEPTH_MISSING");
			if (!cornerKeysComplete || metrics.corner_max_gap_m === null || metrics.corner_max_gap_m > 1e-5) codes.push("CORNER_DATUM_MISMATCH");
			if (!floorKeysComplete || metrics.floor_alignment_max_error_m === null || metrics.floor_alignment_max_error_m > 1e-5) codes.push("WINDOW_CROSSES_FLOOR_BAND");
			if (floorLabelMismatch) codes.push("WINDOW_FLOOR_KEY_MISMATCH");
		}
	}

	const drawingState = {};
	for (const name of DRAWING_NAMES) {
		const path = requiredDrawings?.[name];
		if (!path) {
			metrics.missing_drawings.push(name);
			continue;
		}
		try {
			const bytes = await readFile(path);
			const dimensions = await pngInfo(bytes);
			const hash = sha256(bytes);
			drawingState[name] = { path: resolve(path), sha256: hash, ...dimensions };
			artifacts.drawings[name] = drawingState[name];
			if (!dimensions) codes.push("DRAWING_INVALID");
			else metrics.drawing_dimensions[name] = dimensions;
		} catch {
			metrics.missing_drawings.push(name);
		}
	}
	if (metrics.missing_drawings.length) codes.push("DRAWING_MISSING");

	const runDir = dirname(resolve(artifact.path));
	const provenancePath = join(runDir, "drawing-provenance.json");
	artifacts.provenance = provenancePath;
	let provenance;
	try { provenance = JSON.parse(await readFile(provenancePath, "utf8")); }
	catch { codes.push("DRAWING_PROVENANCE_MISSING"); }
	if (provenance) {
		let mismatch = provenance.selected_glb?.sha256 !== glbHash;
			const configPath = join(runDir, "viewer", "config.json");
		try {
			const configRealPath = await realpath(configPath);
			const configBytes = await readFile(configRealPath);
			const configHash = sha256(configBytes);
			const config = JSON.parse(configBytes.toString("utf8"));
			artifacts.viewer_config = configRealPath;
			artifacts.viewer_config_sha256 = configHash;
			mismatch ||= provenance.viewer_config?.sha256 !== configHash;
			mismatch ||= await realpath(pathFrom(runDir, provenance.viewer_config?.path ?? "")) !== configRealPath;
			mismatch ||= "mesh" in config || JSON.stringify(Object.keys(config.strategies ?? {})) !== JSON.stringify(["hunyuan"]);
			const configuredGlb = config.strategies?.hunyuan?.glb;
			if (!configuredGlb) mismatch = true;
			else {
				const configuredPath = await realpath(resolve(dirname(configRealPath), configuredGlb));
				const provenanceGlbPath = await realpath(pathFrom(runDir, provenance.selected_glb?.path ?? ""));
				const configuredHash = sha256(await readFile(configuredPath));
				mismatch ||= configuredPath !== provenanceGlbPath || configuredPath !== artifactRealPath || provenanceGlbPath !== artifactRealPath;
				mismatch ||= configuredHash !== glbHash || provenance.selected_glb?.sha256 !== configuredHash;
			}
			for (const name of DRAWING_NAMES) {
				const actual = drawingState[name];
				const recorded = provenance.drawings?.[name];
				if (!actual || !recorded) { mismatch = true; continue; }
				mismatch ||= pathFrom(runDir, recorded.path) !== actual.path
					|| recorded.sha256 !== actual.sha256
					|| recorded.width !== actual.width
					|| recorded.height !== actual.height
					|| recorded.glb_sha256 !== glbHash
					|| recorded.viewer_config_sha256 !== configHash;
			}
		} catch { mismatch = true; }
		if (mismatch) codes.push("DRAWING_PROVENANCE_MISMATCH");
	}

	const grammarAuthority = readVerifiedFacadeGrammarAuthority(extractedGrammar);
	const normalizedBaseGrammar = grammar && Object.fromEntries(Object.entries(grammar).filter(([name]) => (
		!["wall_opacity", "curtain_wall_allowed", "floor_elevations_m", "facade_lengths_m"].includes(name)
	)));
	const authorizedGrammarVariants = grammarAuthority ? [extractedGrammar, ...[
		"WINDOW_CROSSES_FLOOR_BAND", "DETAIL_BOUNDS_EXCEEDED", "CORNER_DATUM_MISMATCH", "PRIMITIVE_BUDGET_EXCEEDED",
	].map((code) => correctGrammar({
		...extractedGrammar,
		wall_opacity: "opaque",
		curtain_wall_allowed: false,
		floor_elevations_m: [...grammarAuthority.floorGuides],
		facade_lengths_m: { ...grammarAuthority.facadeLengths },
	}, [code])).map((variant) => Object.fromEntries(Object.entries(variant).filter(([name]) => (
		!["wall_opacity", "curtain_wall_allowed", "floor_elevations_m", "facade_lengths_m"].includes(name)
	))))] : [];
	const sourceFacadeLengths = {
		front: sourceBounds.max[0] - sourceBounds.min[0], back: sourceBounds.max[0] - sourceBounds.min[0],
		right: sourceBounds.max[1] - sourceBounds.min[1], left: sourceBounds.max[1] - sourceBounds.min[1],
	};
	const geometryBound = grammarAuthority && typeof sourceMesh?.identity?.geometry_hash === "string"
		&& sourceMesh.identity.geometry_hash === grammarAuthority.geometryHash
		&& /^[a-f0-9]{64}$/.test(grammarAuthority.geometryContentSha256 ?? "")
		&& sha256(stableJson({ vertices: sourceMesh.vertices, triangles: sourceMesh.triangles })) === grammarAuthority.geometryContentSha256;
	if (grammarAuthority && !geometryBound) codes.push("EVIDENCE_GEOMETRY_MISMATCH");
	const segmentEvidenceBound = !facadeSegmentAuthority || Boolean(canonicalFacadeSegmentAuthority
		&& grammarAuthority?.geometrySignedVolumeOrientation === 1
		&& grammarAuthority?.facadeSegmentAuthority?.sha256 === canonicalFacadeSegmentAuthority.sha256
		&& stableJson(grammarAuthority.facadeSegmentAuthority.segmentIds)
			=== stableJson(canonicalFacadeSegmentAuthority.facade_planes.map((segment) => segment.segment_id)));
	if (grammarAuthority && !segmentEvidenceBound && !codes.includes("EVIDENCE_GEOMETRY_MISMATCH")) codes.push("EVIDENCE_GEOMETRY_MISMATCH");
	const grammarBound = grammarAuthority && geometryBound
		&& segmentEvidenceBound
		&& grammarAuthority.grammarSha256 === sha256(stableJson(extractedGrammar))
		&& authorizedGrammarVariants.some((variant) => stableJson(normalizedBaseGrammar) === stableJson(variant))
		&& stableJson(grammar.floor_elevations_m) === stableJson(grammarAuthority.floorGuides)
		&& stableJson(grammar.facade_lengths_m) === stableJson(grammarAuthority.facadeLengths)
		&& Object.entries(sourceFacadeLengths).every(([view, length]) => Math.abs(length - Number(grammarAuthority.facadeLengths[view])) <= 1e-5)
		&& Math.abs(sourceBounds.min[2] - grammarAuthority.floorGuides[0]) <= 1e-5
		&& Math.abs(sourceBounds.max[2] - grammarAuthority.floorGuides.at(-1)) <= 1e-5;
	const report = { accepted: codes.length === 0, codes: [...new Set(codes)], metrics, artifacts };
	if (report.accepted && punchedFacade && grammarBound && glbHash && DRAWING_NAMES.every((name) => drawingState[name])) {
		const drawingBindings = Object.fromEntries(DRAWING_NAMES.map((name) => [name, drawingState[name].sha256]));
		const areas = DRAWING_NAMES.map((name) => drawingState[name].width * drawingState[name].height);
		const visualScore = Math.round(1000 * Math.min(...areas) / Math.max(...areas)) / 10;
		VERIFIED_FACADE_SCORE_AUTHORITIES.set(report, Object.freeze({
			provider: grammarAuthority.provider,
			candidateId: grammarAuthority.candidateId,
			bindings: {
				geometry_hash: grammarAuthority.geometryHash,
				geometry_content_sha256: grammarAuthority.geometryContentSha256,
				geometry_signed_volume_orientation: grammarAuthority.geometrySignedVolumeOrientation,
				facade_segment_authority_sha256: grammarAuthority.facadeSegmentAuthority?.sha256 ?? null,
				glb_sha256: glbHash,
				evidence_sha256: grammarAuthority.evidenceManifestSha256,
				cameras_sha256: grammarAuthority.camerasSha256,
				proposal_sha256: grammarAuthority.proposalSha256,
				grammar_sha256: sha256(stableJson(grammar)),
				extracted_grammar_sha256: grammarAuthority.grammarSha256,
				render_sha256: sha256(stableJson(drawingBindings)),
			},
			grammar: structuredClone(grammar),
			metrics: structuredClone(metrics),
			visualScore,
		}));
	}
	return report;
}
