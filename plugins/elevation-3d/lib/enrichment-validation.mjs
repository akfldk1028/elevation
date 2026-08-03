import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getBounds, NodeIO } from "@gltf-transform/core";
import { sha256 } from "./core.mjs";

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

function pngInfo(bytes) {
	const signature = [137, 80, 78, 71, 13, 10, 26, 10];
	if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value) || bytes.toString("ascii", 12, 16) !== "IHDR") return null;
	const width = bytes.readUInt32BE(16);
	const height = bytes.readUInt32BE(20);
	return width > 0 && height > 0 ? { width, height } : null;
}

function pathFrom(root, path) {
	return isAbsolute(path) ? resolve(path) : resolve(root, path);
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

export async function validateEnrichment({ sourceMesh, artifact, grammar, requiredDrawings, safeFallback = false }) {
	const codes = [];
	const metrics = { missing_drawings: [], drawing_dimensions: {} };
	const artifacts = { glb: resolve(artifact.path), drawings: {} };
	let glbBytes;
	let glbHash;
	let document;
	try {
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
	const allowedDetailExcess = rounded(Math.max(Number(grammar.frame_depth_m), Number(grammar.mullion_depth_m)) + 0.01);
	metrics.allowed_detail_excess_m = allowedDetailExcess;
	if (document) {
		const root = document.getRoot();
		const baseNodes = root.listNodes().filter((node) => node.getName() === "exact-mass");
		const baseNode = baseNodes.length === 1 ? baseNodes[0] : null;
		const basePrimitives = baseNode?.getMesh()?.getName() === "exact-mass" ? baseNode.getMesh().listPrimitives() : [];
		const basePrimitive = basePrimitives.length === 1 ? basePrimitives[0] : null;
		const positions = basePrimitive?.getAttribute("POSITION");
		const indices = basePrimitive?.getIndices();
		if (!basePrimitive || !positions || !indices) codes.push("BASE_PRIMITIVE_MISSING");
		else {
			const expectedPositions = Array.from(new Float32Array(sourceMesh.vertices.flat()));
			const actualPositions = Array.from(positions.getArray());
			const expectedIndices = sourceMesh.triangles.flat();
			const actualIndices = Array.from(indices.getArray());
			const identityTransform = Array.from(baseNode.getWorldMatrix()).every((value, index) => value === IDENTITY_MATRIX[index]);
			if (!identityTransform || JSON.stringify(actualPositions) !== JSON.stringify(expectedPositions) || JSON.stringify(actualIndices) !== JSON.stringify(expectedIndices)) codes.push("BASE_GEOMETRY_CHANGED");
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
		const enrichedMaterialsValid = detailPrimitives.length > 0 && REQUIRED_MATERIALS.every((name) => materials.includes(name));
		if (safeFallback ? !fallbackMaterialValid : !enrichedMaterialsValid) codes.push("MATERIAL_SET_INVALID");
		const primitiveBudget = Number.isFinite(Number(grammar.primitive_budget)) ? Number(grammar.primitive_budget) : DEFAULT_PRIMITIVE_BUDGET;
		metrics.primitive_budget = primitiveBudget;
		if (primitives.length > primitiveBudget) codes.push("PRIMITIVE_BUDGET_EXCEEDED");

		const floorGuides = (grammar.floor_elevations_m ?? []).map(Number);
		const detailExtras = detailPrimitives.map((primitive) => primitive.getExtras());
		const facadeViews = Object.keys(grammar.facade_lengths_m ?? {});
		if (!safeFallback && facadeViews.some((view) => !detailExtras.some((extras) => extras?.kind === "mullion" && extras.view === view))) codes.push("DETAIL_COVERAGE_MISSING");
		if (!safeFallback && floorGuides.length) {
			const bands = detailExtras.filter((extras) => extras?.kind === "floor-band");
			const elevations = bands.map((extras) => Number(extras.elevation_m)).filter(Number.isFinite);
			metrics.floor_band_elevations_m = [...new Set(elevations)].sort((a, b) => a - b);
			const coverageMissing = facadeViews.length
				? facadeViews.some((view) => floorGuides.some((guide) => !bands.some((band) => band.view === view && Math.abs(Number(band.elevation_m) - guide) <= 1e-5)))
				: floorGuides.some((guide) => !elevations.some((value) => Math.abs(value - guide) <= 1e-5));
			if (coverageMissing) codes.push("FLOOR_GUIDE_COVERAGE_MISSING");
			if (elevations.some((value) => value < sourceBounds.min[2] - 1e-5 || value > sourceBounds.max[2] + 1e-5 || !floorGuides.some((guide) => Math.abs(value - guide) <= 1e-5))) codes.push("NEW_STOREY_DETECTED");
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
			const dimensions = pngInfo(bytes);
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
			const configBytes = await readFile(configPath);
			const configHash = sha256(configBytes);
			const config = JSON.parse(configBytes.toString("utf8"));
			artifacts.viewer_config = configPath;
			artifacts.viewer_config_sha256 = configHash;
			mismatch ||= provenance.viewer_config?.sha256 !== configHash;
			mismatch ||= "mesh" in config || JSON.stringify(Object.keys(config.strategies ?? {})) !== JSON.stringify(["hunyuan"]);
			const configuredGlb = config.strategies?.hunyuan?.glb;
			if (!configuredGlb) mismatch = true;
			else {
				const configuredPath = resolve(dirname(configPath), configuredGlb);
				const provenanceGlbPath = pathFrom(runDir, provenance.selected_glb?.path ?? "");
				mismatch ||= configuredPath !== provenanceGlbPath;
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
