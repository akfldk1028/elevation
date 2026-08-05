import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getBounds, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { sha256 } from "./core.mjs";
import { PUNCHED_FACADE_MATERIALS, PUNCHED_FACADE_SYSTEM, validatePunchedFacadeGrammar } from "./facade-grammar.mjs";

const DRAWING_NAMES = ["plan", "front", "back", "left", "right", "top", "axon"];
const REQUIRED_MATERIALS = ["bronze", "concrete", "glass", "opaque"];
const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const DEFAULT_PRIMITIVE_BUDGET = 5000;

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

function distance(left, right) {
	return Math.hypot(...left.map((value, axis) => value - right[axis]));
}

function typedPbrValid(root, grammar) {
	try {
		const grammarHash = sha256(JSON.stringify(validatePunchedFacadeGrammar(grammar, { allowDerived: true })));
		for (const name of ["brick", "precast"]) {
			const material = root.listMaterials().find((candidate) => candidate.getName() === name);
			const textures = [material?.getBaseColorTexture(), material?.getNormalTexture(), material?.getMetallicRoughnessTexture()];
			if (textures.some((texture) => !texture)) return false;
			if (textures.some((texture) => {
				const extras = texture.getExtras();
				return extras?.generator !== "elevation-3d-procedural-pbr-v1" || extras?.grammar_sha256 !== grammarHash
					|| !/^[a-f0-9]{64}$/.test(extras?.sha256 ?? "") || extras.sha256 !== sha256(texture.getImage())
					|| texture.getMimeType() !== "image/png" || JSON.stringify(texture.getSize()) !== JSON.stringify([2048, 2048]);
			})) return false;
		}
		return true;
	} catch { return false; }
}

function typedFacadeMetrics(detailRecords, surfaces, floorGuides) {
	const recordsByView = Map.groupBy(detailRecords.filter((record) => surfaces.includes(record.extras?.view)), (record) => record.extras.view);
	const coveredViews = surfaces.filter((view) => {
		const records = recordsByView.get(view) ?? [];
		const cladding = records.filter((record) => record.extras?.kind === "brick-cladding");
		return cladding.length > 0 && cladding.every((record) => record.material === "brick");
	});
	const viewsPresent = surfaces.filter((view) => (recordsByView.get(view)?.length ?? 0) > 0);
	const reveals = detailRecords.filter((record) => record.extras?.kind === "window-reveal");
	const revealDepths = reveals.map((record) => {
		const view = record.extras.view;
		const depthAxis = view === "front" || view === "back" ? 1 : 0;
		const persistedDepth = record.bounds.max[depthAxis] - record.bounds.min[depthAxis];
		return Math.min(Number(record.extras.depth_m), persistedDepth);
	}).filter(Number.isFinite);
	const corners = Map.groupBy(detailRecords.filter((record) => record.extras?.kind === "corner-return"), (record) => record.extras.corner_anchor_id);
	const floorStarts = floorGuides.slice(0, -1);
	const cornerKeysComplete = surfaces.every((view) => floorStarts.every((floor) => {
		const records = detailRecords.filter((record) => record.extras?.kind === "corner-return"
			&& record.extras.view === view && Math.abs(Number(record.extras.floor_m) - floor) <= 1e-5);
		return ["corner-start", "corner-end"].every((slot) => records.filter((record) => record.extras.slot === slot).length === 1);
	})) && [...corners.values()].every((group) => group.length === 2 && new Set(group.map((record) => record.extras.view)).size === 2);
	const floorKeysComplete = surfaces.every((view) => floorStarts.every((floor) => detailRecords.some((record) => (
		record.extras?.kind === "glazing" && record.extras.view === view && Math.abs(Number(record.extras.floor_m) - floor) <= 1e-5
	))));
	let cornerMaxGap = 0;
	let cornerInvalid = false;
	for (const group of corners.values()) for (let left = 0; left < group.length; left++) for (let right = left + 1; right < group.length; right++) {
		const a = group[left].extras.anchor_position, b = group[right].extras.anchor_position;
		if (Array.isArray(a) && Array.isArray(b) && a.length === 3 && b.length === 3 && [...a, ...b].every(Number.isFinite)) {
			cornerMaxGap = Math.max(cornerMaxGap, distance(a, b));
		} else cornerInvalid = true;
	}
	let floorError = 0;
	let floorInvalid = false;
	for (const record of detailRecords) {
		const floor = Number(record.extras?.floor_m);
		if (!Number.isFinite(floor)) continue;
		const floorIndex = floorGuides.findIndex((guide) => Math.abs(guide - floor) <= 1e-5);
		if (floorIndex < 0 || floorIndex + 1 >= floorGuides.length) { floorInvalid = true; continue; }
		floorError = Math.max(floorError, floorGuides[floorIndex] - record.bounds.min[2], record.bounds.max[2] - floorGuides[floorIndex + 1], 0);
	}
	return {
		opaque_wall_coverage: surfaces.length ? coveredViews.length / surfaces.length : 0,
		minimum_reveal_depth_m: revealDepths.length ? Math.min(...revealDepths) : 0,
		corner_max_gap_m: cornerInvalid ? null : cornerMaxGap,
		floor_alignment_max_error_m: floorInvalid ? null : floorError,
		facade_orientation_coverage: surfaces.length ? viewsPresent.length / surfaces.length : 0,
		corner_keys_complete: cornerKeysComplete,
		floor_keys_complete: floorKeysComplete,
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

export async function validateEnrichment({ sourceMesh, artifact, grammar, requiredDrawings, safeFallback = false }) {
	const codes = [];
	const metrics = { missing_drawings: [], drawing_dimensions: {} };
	const artifacts = { glb: resolve(artifact.path), drawings: {} };
	const punchedFacade = grammar?.system === PUNCHED_FACADE_SYSTEM && !safeFallback;
	if (punchedFacade) {
		try {
			validatePunchedFacadeGrammar(grammar, {
				floorGuides: { floor_guides_m: grammar.floor_elevations_m }, allowDerived: true,
			});
		} catch { codes.push("FACADE_GRAMMAR_INVALID"); }
	}
	let glbBytes;
	let glbHash;
	let artifactRealPath;
	let document;
	try {
		artifactRealPath = await realpath(artifact.path);
		artifacts.glb = artifactRealPath;
		glbBytes = await readFile(artifact.path);
		glbHash = sha256(glbBytes);
		artifacts.glb_sha256 = glbHash;
		metrics.glb_size_bytes = glbBytes.length;
		if (glbHash !== String(artifact.sha256 ?? "").toLowerCase()) codes.push("ARTIFACT_HASH_MISMATCH");
		try { document = await new NodeIO().read(artifact.path); }
		catch { codes.push("GLB_INVALID"); }
	} catch {
		codes.push("ARTIFACT_MISSING");
	}

	const sourceBounds = boundsOf(sourceMesh.vertices);
	const allowedDetailExcess = rounded((punchedFacade
		? Number(grammar.cladding_depth_m)
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
		const detailNode = root.listNodes().find((node) => node.getName() === "facade-details");
		const detailPrimitives = detailNode?.getMesh()?.listPrimitives() ?? [];
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
		if (punchedFacade && !typedPbrValid(root, grammar)) codes.push("PBR_MATERIAL_INVALID");
		const primitiveBudget = Number.isFinite(Number(grammar.primitive_budget)) ? Number(grammar.primitive_budget) : DEFAULT_PRIMITIVE_BUDGET;
		metrics.primitive_budget = primitiveBudget;
		if (primitives.length > primitiveBudget) codes.push("PRIMITIVE_BUDGET_EXCEEDED");

		const floorGuides = (grammar.floor_elevations_m ?? []).map(Number);
		const detailMatrix = detailNode?.getWorldMatrix() ?? IDENTITY_MATRIX;
		const detailRecords = detailPrimitives.map((primitive) => ({
			extras: primitive.getExtras(),
			material: primitive.getMaterial()?.getName() ?? null,
			bounds: primitiveWorldBounds(primitive, detailMatrix),
		}));
		const sourceRegions = componentRegions(sourceMesh);
		const attachmentDistances = detailRecords.map((record) => sourceRegions.map((region) => (
				overlaps(record.bounds, region, allowedAttachmentDistance) ? detailComponentDistance(record, region) : Infinity
			)));
		const attachmentCounts = attachmentDistances.map((distances) => distances.filter((distance) => distance <= allowedAttachmentDistance + 1e-7).length);
		metrics.source_component_regions = sourceRegions.map(({ min, max }) => ({ min, max }));
		metrics.detail_component_distances_m = attachmentDistances.map((distances) => distances.map((distance) => Number.isFinite(distance) ? rounded(distance) : null));
		metrics.detail_component_attachment_counts = attachmentCounts;
		if (attachmentCounts.some((count) => count === 0)) codes.push("DETAIL_COMPONENT_UNATTACHED");
		if (attachmentCounts.some((count) => count > 1)) codes.push("DETAIL_COMPONENT_BRIDGE");
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
		if (punchedFacade) {
			const surfaces = Array.isArray(grammar.surfaces) ? grammar.surfaces : [];
			const typedMetrics = typedFacadeMetrics(detailRecords, surfaces, floorGuides);
			const { corner_keys_complete: cornerKeysComplete, floor_keys_complete: floorKeysComplete, ...publicMetrics } = typedMetrics;
			Object.assign(metrics, Object.fromEntries(Object.entries(publicMetrics).map(([name, value]) => (
				[name, Number.isFinite(value) ? Number(value.toFixed(6)) : null]
			))));
			if (metrics.facade_orientation_coverage !== 1) codes.push("FACADE_ORIENTATION_COVERAGE_MISSING");
			if (metrics.opaque_wall_coverage !== 1) codes.push("OPAQUE_WALL_COVERAGE_MISSING");
			if (metrics.minimum_reveal_depth_m < Number(grammar.reveal_depth_m) - 1e-5) codes.push("PUNCHED_REVEAL_DEPTH_MISSING");
			if (!cornerKeysComplete || metrics.corner_max_gap_m === null || metrics.corner_max_gap_m > 1e-5) codes.push("CORNER_DATUM_MISMATCH");
			if (!floorKeysComplete || metrics.floor_alignment_max_error_m === null || metrics.floor_alignment_max_error_m > 1e-5) codes.push("WINDOW_CROSSES_FLOOR_BAND");
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

	return { accepted: codes.length === 0, codes: [...new Set(codes)], metrics, artifacts };
}
