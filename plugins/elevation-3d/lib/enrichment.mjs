import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Document, Material, NodeIO } from "@gltf-transform/core";
import { PUNCHED_FACADE_SYSTEM } from "./facade-grammar.mjs";
import { atomicWrite } from "./facade-agent/path-safety.mjs";
import { buildPunchedFacadeDetails, buildTypedFacadeDetails, PUNCHED_FACADE_BUDGETS, TYPED_FACADE_GRAMMAR } from "./facade-agent/punched-facade.mjs";
import { createFacadePbrMaps } from "./facade-agent/procedural-materials.mjs";

const DETAIL_LIMITS = {
	frame_depth_m: [0.05, 0.25],
	mullion_depth_m: [0.03, 0.12],
	glazing_recess_m: [0.03, 0.20],
};

function clamp(value, [minimum, maximum]) {
	return Math.min(maximum, Math.max(minimum, Number(value)));
}

function subtract(left, right) {
	return left.map((value, axis) => value - right[axis]);
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

function normalize(vector) {
	const length = Math.sqrt(dot(vector, vector));
	return length ? vector.map((value) => value / length) : [0, 0, 0];
}

function centroid(points) {
	return [0, 1, 2].map((axis) => points.reduce((sum, point) => sum + point[axis], 0) / points.length);
}

function connectedComponents(mesh) {
	const parent = mesh.vertices.map((_, index) => index);
	const find = (index) => {
		while (parent[index] !== index) {
			parent[index] = parent[parent[index]];
			index = parent[index];
		}
		return index;
	};
	const union = (left, right) => {
		const a = find(left);
		const b = find(right);
		if (a !== b) parent[b] = a;
	};
	const referenced = new Set();
	for (const triangle of mesh.triangles) {
		triangle.forEach((index) => referenced.add(index));
		union(triangle[0], triangle[1]);
		union(triangle[0], triangle[2]);
	}
	const groups = new Map();
	for (const index of referenced) {
		const root = find(index);
		if (!groups.has(root)) groups.set(root, { vertex_indices: [], triangles: [] });
		groups.get(root).vertex_indices.push(index);
	}
	mesh.triangles.forEach((triangle, triangleIndex) => groups.get(find(triangle[0])).triangles.push({
		index: triangleIndex,
		vertices: triangle.map((index) => mesh.vertices[index]),
	}));
	return [...groups.values()].map((group, componentId) => ({ ...group, id: componentId }));
}

function interpolate(left, right, amount) {
	return left.map((value, axis) => value + (right[axis] - value) * amount);
}

function clipHalfSpace(polygon, scalar, threshold, keepAbove) {
	const result = [];
	for (let index = 0; index < polygon.length; index++) {
		const current = polygon[index];
		const previous = polygon[(index + polygon.length - 1) % polygon.length];
		const currentValue = scalar(current);
		const previousValue = scalar(previous);
		const currentInside = keepAbove ? currentValue >= threshold - 1e-10 : currentValue <= threshold + 1e-10;
		const previousInside = keepAbove ? previousValue >= threshold - 1e-10 : previousValue <= threshold + 1e-10;
		if (currentInside !== previousInside) {
			const denominator = currentValue - previousValue;
			if (Math.abs(denominator) > 1e-12) result.push(interpolate(previous, current, (threshold - previousValue) / denominator));
		}
		if (currentInside) result.push(current);
	}
	return result.filter((point, index) => index === 0 || point.some((value, axis) => Math.abs(value - result[index - 1][axis]) > 1e-10));
}

function clipRange(polygon, scalar, minimum, maximum) {
	if (maximum - minimum <= 1e-8) return [];
	return clipHalfSpace(clipHalfSpace(polygon, scalar, minimum, true), scalar, maximum, false);
}

function clipToFacadeRectangle(polygon, plane) {
	const [width, height] = plane.extent_m;
	const horizontal = Math.hypot(plane.normal[0], plane.normal[1]);
	// A rounded vertical normal measures within 1e-8 of unit horizontal; dividing by that
	// noise would move every retained prism artifact by a ninth decimal. Only a real
	// batter is corrected.
	const unit = Math.abs(horizontal - 1) > 1e-6 ? horizontal : 1;
	const tangent = [-plane.normal[1] / unit, plane.normal[0] / unit, 0];
	const tangentOffset = (point) => dot(subtract(point, plane.origin), tangent);
	const elevation = (point) => point[2] - plane.origin[2];
	return clipRange(clipRange(polygon, tangentOffset, 0, width), elevation, 0, height);
}

function polygonAreaMagnitude(polygon) {
	if (polygon.length < 3) return 0;
	let sum = [0, 0, 0];
	for (let index = 0; index < polygon.length; index++) {
		const edgeCross = cross(polygon[index], polygon[(index + 1) % polygon.length]);
		sum = sum.map((value, axis) => value + edgeCross[axis]);
	}
	return Math.sqrt(dot(sum, sum)) / 2;
}

function createPolygonPrism(polygon, direction, depth) {
	if (polygon.length < 3 || polygonAreaMagnitude(polygon) <= 1e-10) return null;
	const extrusion = normalize(direction).map((value) => value * depth);
	const positions = [...polygon, ...polygon.map((point) => point.map((value, axis) => value + extrusion[axis]))];
	const count = polygon.length;
	const indices = [];
	for (let index = 1; index + 1 < count; index++) {
		indices.push([0, index + 1, index]);
		indices.push([count, count + index, count + index + 1]);
	}
	for (let index = 0; index < count; index++) {
		const next = (index + 1) % count;
		indices.push([index, next, count + next], [index, count + next, count + index]);
	}
	return { positions, indices };
}

function triangleRecords(mesh) {
	const massCentroid = centroid(mesh.vertices);
	return connectedComponents(mesh).map((component) => ({
		...component,
		triangles: component.triangles.map((triangle) => {
			const center = centroid(triangle.vertices);
			let normal = normalize(cross(subtract(triangle.vertices[1], triangle.vertices[0]), subtract(triangle.vertices[2], triangle.vertices[0])));
			if (dot(normal, subtract(center, massCentroid)) < 0) normal = normal.map((value) => -value);
			return { ...triangle, center, normal };
		}),
	}));
}

function extentTriangles(component, plane) {
	const [width, height] = plane.extent_m;
	const horizontal = Math.hypot(plane.normal[0], plane.normal[1]);
	// A rounded vertical normal measures within 1e-8 of unit horizontal; dividing by that
	// noise would move every retained prism artifact by a ninth decimal. Only a real
	// batter is corrected.
	const unit = Math.abs(horizontal - 1) > 1e-6 ? horizontal : 1;
	const tangent = [-plane.normal[1] / unit, plane.normal[0] / unit, 0];
	const offset = (point) => dot(subtract(point, plane.origin), tangent);
	const elevation = (point) => point[2] - plane.origin[2];
	return component.triangles.filter((triangle) => {
		const offsets = triangle.vertices.map(offset);
		const elevations = triangle.vertices.map(elevation);
		return Math.max(...offsets) >= -1e-8 && Math.min(...offsets) <= width + 1e-8
			&& Math.max(...elevations) >= -1e-8 && Math.min(...elevations) <= height + 1e-8;
	});
}

function viewTriangles(component, plane) {
	const inExtent = extentTriangles(component, plane);
	const facing = inExtent.filter((triangle) => dot(triangle.normal, plane.normal) >= 0.15);
	if (facing.length) return facing;
	const maximumAlignment = Math.max(...inExtent.map((triangle) => dot(triangle.normal, plane.normal)), -Infinity);
	return inExtent.filter((triangle) => dot(triangle.normal, plane.normal) >= maximumAlignment - 1e-10);
}

function addClippedDetail(details, triangle, plane, polygon, depth, extras) {
	const geometry = createPolygonPrism(polygon, plane.normal, depth);
	if (!geometry) return false;
	details.push({
		...extras,
		view: plane.view,
		component_id: extras.component_id,
		source_triangle_index: triangle.index,
		depth_m: Math.abs(depth),
		...geometry,
	});
	return true;
}

function facadeDetails(mesh, floorGuides, facadePlanes, grammar) {
	const details = [];
	const components = triangleRecords(mesh);
	const frameDepth = clamp(grammar.frame_depth_m, DETAIL_LIMITS.frame_depth_m);
	const mullionDepth = clamp(grammar.mullion_depth_m, DETAIL_LIMITS.mullion_depth_m);
	const glazingRecess = clamp(grammar.glazing_recess_m, DETAIL_LIMITS.glazing_recess_m);
	const parapetHeight = Math.max(0, Number(grammar.parapet_height_m));
	for (const plane of facadePlanes.facade_planes) {
		const [width, height] = plane.extent_m;
		const horizontal = Math.hypot(plane.normal[0], plane.normal[1]);
		// A rounded vertical normal measures within 1e-8 of unit horizontal; dividing by that
		// noise would move every retained prism artifact by a ninth decimal. Only a real
		// batter is corrected.
		const unit = Math.abs(horizontal - 1) > 1e-6 ? horizontal : 1;
		const tangent = [-plane.normal[1] / unit, plane.normal[0] / unit, 0];
		const offset = (point) => dot(subtract(point, plane.origin), tangent);
		const elevation = (point) => point[2] - plane.origin[2];
		const facadePolygon = (triangle) => clipToFacadeRectangle(triangle.vertices, plane);
		const bayCount = Math.max(1, Math.round(width / grammar.bay_width_m));
		const spacing = width / bayCount;
		const mullionWidth = Math.min(0.08, spacing);
		for (const component of components) {
			const triangles = viewTriangles(component, plane);
			if (!triangles.length) continue;
			for (const authoredElevation of floorGuides.floor_guides_m) {
				const localElevation = authoredElevation - plane.origin[2];
				const minimum = Math.max(0, localElevation - 0.06);
				const maximum = Math.min(height, localElevation + 0.06);
				let bandAdded = false;
				for (const triangle of triangles) bandAdded = addClippedDetail(
					details, triangle, plane, clipRange(facadePolygon(triangle), elevation, minimum, maximum), frameDepth,
					{ kind: "floor-band", elevation_m: authoredElevation, material: "concrete", component_id: component.id },
				) || bandAdded;
				if (!bandAdded) for (const triangle of extentTriangles(component, plane)) addClippedDetail(
					details, triangle, plane, clipRange(facadePolygon(triangle), elevation, minimum, maximum), frameDepth,
					{ kind: "floor-band", elevation_m: authoredElevation, material: "concrete", component_id: component.id },
				);
			}

			let componentHasMullion = false;
			for (let bay = 0; bay <= bayCount; bay++) {
				const nominalOffset = spacing * bay;
				const minimum = Math.max(0, nominalOffset - mullionWidth / 2);
				const maximum = Math.min(width, nominalOffset + mullionWidth / 2);
				for (const triangle of triangles) componentHasMullion = addClippedDetail(
					details, triangle, plane, clipRange(facadePolygon(triangle), offset, minimum, maximum), mullionDepth,
					{ kind: "mullion", offset_m: nominalOffset, material: "bronze", component_id: component.id },
				) || componentHasMullion;
			}
			if (!componentHasMullion) {
				const triangle = [...triangles].sort((left, right) => left.index - right.index)[0];
				const localOffset = Math.max(0, Math.min(width, offset(triangle.center)));
				addClippedDetail(
					details, triangle, plane,
					clipRange(facadePolygon(triangle), offset, localOffset - mullionWidth / 2, localOffset + mullionWidth / 2),
					mullionDepth,
					{ kind: "mullion", offset_m: localOffset, material: "bronze", component_id: component.id },
				);
			}

			for (let floor = 0; floor + 1 < floorGuides.floor_guides_m.length; floor++) {
				const floorElevation = floorGuides.floor_guides_m[floor];
				const nextElevation = Math.min(plane.origin[2] + height, floorGuides.floor_guides_m[floor + 1]);
				const opaqueMinimum = floorElevation + 0.06;
				const opaqueMaximum = Math.min(nextElevation - 0.06, floorElevation + 0.45);
				const glassMinimum = opaqueMaximum;
				const glassMaximum = nextElevation - 0.06;
				for (let bay = 0; bay < bayCount; bay++) {
					const bayMinimum = spacing * bay + mullionWidth / 2;
					const bayMaximum = spacing * (bay + 1) - mullionWidth / 2;
					for (const triangle of triangles) {
						const bayPolygon = clipRange(facadePolygon(triangle), offset, bayMinimum, bayMaximum);
						addClippedDetail(details, triangle, plane, clipRange(bayPolygon, (point) => point[2], opaqueMinimum, opaqueMaximum), frameDepth, {
							kind: "opaque-panel", floor_m: floorElevation, bay, material: "opaque", component_id: component.id,
						});
						addClippedDetail(details, triangle, plane, clipRange(bayPolygon, (point) => point[2], glassMinimum, glassMaximum), -glazingRecess, {
							kind: "glazing", floor_m: floorElevation, bay, material: "glass", component_id: component.id,
						});
					}
				}
			}

			if (parapetHeight > 0) for (const triangle of triangles) addClippedDetail(
				details, triangle, plane,
				clipRange(facadePolygon(triangle), elevation, Math.max(0, height - parapetHeight), height),
				frameDepth,
				{ kind: "parapet", material: "concrete", component_id: component.id, parapet_height_m: parapetHeight },
			);
		}
	}
	return details;
}

export function buildEnrichedScene({ mesh, floorGuides, facadePlanes, grammar, typedPrimitives, safeFallback }) {
	const sceneGrammar = typedPrimitives ? TYPED_FACADE_GRAMMAR : grammar;
	return {
		base: { positions: mesh.vertices, indices: mesh.triangles },
		details: safeFallback ? [] : typedPrimitives
			? buildTypedFacadeDetails({ mesh, floorGuides, facadePlanes, primitives: typedPrimitives })
			: grammar?.system === PUNCHED_FACADE_SYSTEM
			? buildPunchedFacadeDetails({ mesh, floorGuides, facadePlanes, grammar })
			: facadeDetails(mesh, floorGuides, facadePlanes, grammar),
		grammar: sceneGrammar,
	};
}

const MATERIAL_FACTORS = {
	concrete: { color: [0.62, 0.58, 0.52, 1], metallic: 0, roughness: 0.85 },
	glass: { color: [0.72, 0.86, 0.92, 0.28], metallic: 0, roughness: 0.12 },
	bronze: { color: [0.16, 0.10, 0.06, 1], metallic: 0.75, roughness: 0.30 },
	opaque: { color: [0.18, 0.20, 0.22, 1], metallic: 0.20, roughness: 0.55 },
	brick: { color: [0.52, 0.22, 0.15, 1], metallic: 0, roughness: 0.82 },
	precast: { color: [0.68, 0.66, 0.62, 1], metallic: 0, roughness: 0.76 },
	"window-frame": { color: [0.12, 0.09, 0.07, 1], metallic: 0.72, roughness: 0.28 },
};

function createMaterial(document, name, textures) {
	const factors = MATERIAL_FACTORS[name];
	if (!factors) throw new TypeError(`unsupported facade material: ${name}`);
	const material = document.createMaterial(name)
		.setBaseColorFactor(factors.color)
		.setMetallicFactor(factors.metallic)
		.setRoughnessFactor(factors.roughness);
	if (textures) material
		.setBaseColorTexture(textures.baseColor)
		.setNormalTexture(textures.normal)
		.setMetallicRoughnessTexture(textures.metallicRoughness);
	if (name === "glass") material.setAlphaMode(Material.AlphaMode.BLEND).setDoubleSided(true);
	return material;
}

function indexArray(indices) {
	const flat = indices.flat();
	const maximum = flat.reduce((value, index) => Math.max(value, index), 0);
	return maximum <= 65535 ? new Uint16Array(flat) : new Uint32Array(flat);
}

function addPrimitive(document, buffer, mesh, name, geometry, material, extras) {
	if (!material) throw new TypeError(`missing material for primitive: ${name}`);
	if (geometry.uvs && geometry.uvs.length !== geometry.positions.length) {
		throw new TypeError(`invalid facade geometry: ${name} UV count does not match positions`);
	}
	const positions = document.createAccessor(`${name}-positions`, buffer)
		.setType("VEC3")
		.setArray(new Float32Array(geometry.positions.flat()));
	const indices = document.createAccessor(`${name}-indices`, buffer)
		.setType("SCALAR")
		.setArray(indexArray(geometry.indices));
	const primitive = document.createPrimitive().setAttribute("POSITION", positions).setIndices(indices).setMaterial(material);
	if (geometry.uvs) {
		const uvs = document.createAccessor(`${name}-uvs`, buffer)
			.setType("VEC2")
			.setArray(new Float32Array(geometry.uvs.flat()));
		primitive.setAttribute("TEXCOORD_0", uvs);
	}
	if (extras) primitive.setExtras(extras);
	mesh.addPrimitive(primitive);
}

function geometryBounds(scene) {
	const positions = [scene.base, ...scene.details].flatMap((geometry) => geometry.positions);
	const minimum = [Infinity, Infinity, Infinity];
	const maximum = [-Infinity, -Infinity, -Infinity];
	for (const position of positions) for (let axis = 0; axis < 3; axis++) {
		minimum[axis] = Math.min(minimum[axis], position[axis]);
		maximum[axis] = Math.max(maximum[axis], position[axis]);
	}
	return { min: minimum, max: maximum };
}

function denseArray(value) {
	if (!Array.isArray(value)) return false;
	for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) return false;
	return true;
}

function projectedValueBytes(value, seen = new Set(), depth = 0) {
	if (value === null || value === undefined) return 4n;
	if (typeof value === "string") return BigInt(value.length) * 6n + 2n;
	if (typeof value === "number" || typeof value === "boolean") return 16n;
	if (typeof value !== "object" || depth > 12) throw new TypeError("invalid facade extras for GLB projection");
	if (seen.has(value)) throw new TypeError("invalid cyclic facade extras for GLB projection");
	seen.add(value);
	if (Array.isArray(value) && !denseArray(value)) throw new TypeError("facade extras arrays must be dense");
	let bytes = 2n;
	const descriptors = Object.getOwnPropertyDescriptors(value);
	for (const [key, descriptor] of Object.entries(descriptors)) {
		if (!Object.hasOwn(descriptor, "value")) throw new TypeError("facade extras cannot contain accessors");
		bytes += BigInt(key.length) * 6n + 3n + projectedValueBytes(descriptor.value, seen, depth + 1);
	}
	seen.delete(value);
	return bytes;
}

function validateGeometryForBudget(geometry, label) {
	if (!geometry || !denseArray(geometry.positions) || !denseArray(geometry.indices)) {
		throw new TypeError(`${label} geometry must contain dense positions and indices`);
	}
	for (const point of geometry.positions) if (!denseArray(point) || point.length !== 3 || point.some((value) => !Number.isFinite(value))) {
		throw new TypeError(`${label} positions must be finite dense VEC3 values`);
	}
	let indexCount = 0n;
	for (const face of geometry.indices) {
		if (!denseArray(face) || !face.length || face.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= geometry.positions.length)) {
			throw new TypeError(`${label} indices must be dense and reference positions`);
		}
		indexCount += BigInt(face.length);
	}
	if (geometry.uvs !== undefined) {
		if (!denseArray(geometry.uvs) || geometry.uvs.length !== geometry.positions.length
			|| geometry.uvs.some((uv) => !denseArray(uv) || uv.length !== 2 || uv.some((value) => !Number.isFinite(value)))) {
			throw new TypeError(`${label} UVs must be finite dense VEC2 values matching positions`);
		}
	}
	return { vertices: BigInt(geometry.positions.length), indices: indexCount };
}

function assertEnrichedSceneBudget(scene) {
	if (!scene || !denseArray(scene.details)) throw new TypeError("enriched scene details must be a dense array");
	if (scene.details.length > PUNCHED_FACADE_BUDGETS.maxDetailPrimitives) throw new RangeError("detail primitive budget exceeded");
	let { vertices, indices } = validateGeometryForBudget(scene.base, "base");
	let extrasBytes = 0n;
	for (let index = 0; index < scene.details.length; index++) {
		const detail = scene.details[index];
		const counts = validateGeometryForBudget(detail, `detail-${index}`);
		vertices += counts.vertices;
		indices += counts.indices;
		const extras = Object.fromEntries(Object.entries(detail).filter(([key]) => !["positions", "indices", "uvs"].includes(key)));
		extrasBytes += projectedValueBytes(extras);
	}
	if (vertices > BigInt(PUNCHED_FACADE_BUDGETS.maxTotalVertices)) throw new RangeError("facade vertex budget exceeded");
	if (indices > BigInt(PUNCHED_FACADE_BUDGETS.maxTotalIndices)) throw new RangeError("facade index budget exceeded");
	const textureProjection = scene.details.length && scene.grammar?.system === PUNCHED_FACADE_SYSTEM ? 2n * 1024n * 1024n : 0n;
	const projectedBytes = 64n * 1024n + vertices * 20n + indices * 4n
		+ BigInt(scene.details.length + 1) * 2048n + extrasBytes + textureProjection;
	if (projectedBytes > BigInt(PUNCHED_FACADE_BUDGETS.maxProjectedGlbBytes)) throw new RangeError("projected GLB byte budget exceeded");
	return { vertices, indices, projectedBytes };
}

export async function writeEnrichedGlb(scene, outputPath, { approvedRoot } = {}) {
	assertEnrichedSceneBudget(scene);
	const document = new Document();
	const buffer = document.createBuffer("geometry");
	const punched = scene.details.length > 0 && scene.grammar?.system === PUNCHED_FACADE_SYSTEM;
	const usedMaterialNames = punched
		? ["concrete", "brick", "precast", "window-frame", "glass"]
		: scene.details.length ? ["concrete", "glass", "bronze", "opaque"] : ["concrete"];
	const pbrMaps = punched ? createFacadePbrMaps({ grammar: scene.grammar, resolution: 2048 }) : null;
	const pbrTextures = {};
	const textureProvenance = [];
	if (pbrMaps) for (const materialName of ["brick", "precast"]) {
		pbrTextures[materialName] = {};
		for (const channel of ["baseColor", "normal", "metallicRoughness"]) {
			const map = pbrMaps[materialName][channel];
			pbrTextures[materialName][channel] = document.createTexture(map.name)
				.setImage(map.data)
				.setMimeType(map.mimeType)
				.setExtras({ sha256: map.sha256, grammar_sha256: map.grammar_sha256, generator: map.generator });
			textureProvenance.push({ material: materialName, channel, width: map.width, height: map.height, sha256: map.sha256, grammar_sha256: map.grammar_sha256 });
		}
	}
	const materials = Object.fromEntries(usedMaterialNames.map((name) => [name, createMaterial(document, name, pbrTextures[name])]));
	const gltfScene = document.createScene("enriched-scene");
	document.getRoot().setDefaultScene(gltfScene);

	const baseMesh = document.createMesh("exact-mass");
	addPrimitive(document, buffer, baseMesh, "exact-mass", scene.base, materials.concrete);
	gltfScene.addChild(document.createNode("exact-mass").setMesh(baseMesh));

	if (scene.details.length) {
		const detailMesh = document.createMesh("facade-details");
		scene.details.forEach((detail, index) => {
			const { positions, indices, uvs, ...extras } = detail;
			addPrimitive(document, buffer, detailMesh, `detail-${index}`, detail, materials[detail.material], extras);
		});
		gltfScene.addChild(document.createNode("facade-details").setMesh(detailMesh));
	}

	const path = resolve(outputPath);
	const bytes = await new NodeIO().writeBinary(document);
	if (bytes.byteLength > PUNCHED_FACADE_BUDGETS.maxFinalGlbBytes) throw new RangeError("final GLB byte budget exceeded");
	if (approvedRoot) await atomicWrite(path, bytes, approvedRoot);
	else {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, bytes);
	}
	return {
		path,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		base_primitive: {
			positions: scene.base.positions,
			indices: scene.base.indices,
			vertex_count: scene.base.positions.length,
			triangle_count: scene.base.indices.length,
		},
		detail_primitives: scene.details.map((detail, index) => ({
			index, kind: detail.kind, view: detail.view, material: detail.material,
			vertex_count: detail.positions.length, triangle_count: detail.indices.length,
		})),
		materials: usedMaterialNames,
		texture_provenance: textureProvenance,
		bounds: geometryBounds(scene),
	};
}
