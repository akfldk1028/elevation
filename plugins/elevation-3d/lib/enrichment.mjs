import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Document, Material, NodeIO } from "@gltf-transform/core";

const DETAIL_LIMITS = {
	frame_depth_m: [0.05, 0.25],
	mullion_depth_m: [0.03, 0.12],
	glazing_recess_m: [0.03, 0.20],
};

function clamp(value, [minimum, maximum]) {
	return Math.min(maximum, Math.max(minimum, Number(value)));
}

function createPrism(plane, { start_m, width_m, bottom_m, height_m, depth_m }) {
	const [nx, ny] = plane.normal;
	const tangent = [-ny, nx, 0];
	const point = (offset, elevation, depth) => [
		plane.origin[0] + tangent[0] * offset + nx * depth,
		plane.origin[1] + tangent[1] * offset + ny * depth,
		plane.origin[2] + elevation,
	];
	return {
		positions: [
			point(start_m, bottom_m, 0), point(start_m + width_m, bottom_m, 0),
			point(start_m + width_m, bottom_m + height_m, 0), point(start_m, bottom_m + height_m, 0),
			point(start_m, bottom_m, depth_m), point(start_m + width_m, bottom_m, depth_m),
			point(start_m + width_m, bottom_m + height_m, depth_m), point(start_m, bottom_m + height_m, depth_m),
		],
		indices: [
			[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
			[0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
			[2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
		],
	};
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
		if (!groups.has(root)) groups.set(root, []);
		groups.get(root).push(mesh.vertices[index]);
	}
	return [...groups.values()];
}

function facadeSegments(components, plane) {
	const [width, height] = plane.extent_m;
	const [nx, ny] = plane.normal;
	const tangent = [-ny, nx];
	const segments = [];
	for (const points of components) {
		const signedDistances = points.map((point) => (point[0] - plane.origin[0]) * nx + (point[1] - plane.origin[1]) * ny);
		if (Math.max(...signedDistances) < -1e-5) continue;
		const offsets = points.map((point) => (point[0] - plane.origin[0]) * tangent[0] + (point[1] - plane.origin[1]) * tangent[1]);
		const elevations = points.map((point) => point[2] - plane.origin[2]);
		if (Math.max(...elevations) < 0 || Math.min(...elevations) > height) continue;
		const start = Math.max(0, Math.min(...offsets));
		const end = Math.min(width, Math.max(...offsets));
		if (end - start > 1e-8) segments.push([start, end]);
	}
	if (!segments.length) return [[0, width]];
	segments.sort((left, right) => left[0] - right[0]);
	const merged = [];
	for (const segment of segments) {
		const previous = merged.at(-1);
		if (previous && segment[0] <= previous[1] + 1e-8) previous[1] = Math.max(previous[1], segment[1]);
		else merged.push([...segment]);
	}
	return merged;
}

function facadeDetails(mesh, floorGuides, facadePlanes, grammar) {
	const details = [];
	const components = connectedComponents(mesh);
	const frameDepth = clamp(grammar.frame_depth_m, DETAIL_LIMITS.frame_depth_m);
	const mullionDepth = clamp(grammar.mullion_depth_m, DETAIL_LIMITS.mullion_depth_m);
	const panelDepth = clamp(grammar.glazing_recess_m, DETAIL_LIMITS.glazing_recess_m);
	for (const plane of facadePlanes.facade_planes) {
		const [width, height] = plane.extent_m;
		const segments = facadeSegments(components, plane);
		for (const elevation of floorGuides.floor_guides_m) {
			const bottom = Math.max(0, elevation - 0.06);
			const top = Math.min(height, elevation + 0.06);
			if (top <= bottom) continue;
			for (const [segmentStart, segmentEnd] of segments) details.push({
				kind: "floor-band", view: plane.view, elevation_m: elevation, depth_m: frameDepth,
				material: "bronze", ...createPrism(plane, {
					start_m: segmentStart, width_m: segmentEnd - segmentStart,
					bottom_m: bottom, height_m: top - bottom, depth_m: frameDepth,
				}),
			});
		}
		const bayCount = Math.max(1, Math.round(width / grammar.bay_width_m));
		const spacing = width / bayCount;
		const mullionWidth = Math.min(0.08, spacing);
		for (let bay = 0; bay <= bayCount; bay++) {
			const offset = spacing * bay;
			const start = Math.max(0, Math.min(width - mullionWidth, offset - mullionWidth / 2));
			for (const [segmentStart, segmentEnd] of segments) {
				const clippedStart = Math.max(start, segmentStart);
				const clippedEnd = Math.min(start + mullionWidth, segmentEnd);
				if (clippedEnd <= clippedStart) continue;
				details.push({
					kind: "mullion", view: plane.view, offset_m: offset, depth_m: mullionDepth,
					material: "bronze", ...createPrism(plane, {
						start_m: clippedStart, width_m: clippedEnd - clippedStart,
						bottom_m: 0, height_m: height, depth_m: mullionDepth,
					}),
				});
			}
		}
		for (let floor = 0; floor + 1 < floorGuides.floor_guides_m.length; floor++) {
			const bottom = floorGuides.floor_guides_m[floor];
			const top = Math.min(height, floorGuides.floor_guides_m[floor + 1]);
			if (top <= bottom) continue;
			for (let bay = 0; bay < bayCount; bay++) {
				const start = spacing * bay + mullionWidth / 2;
				const end = spacing * (bay + 1) - mullionWidth / 2;
				for (const [segmentStart, segmentEnd] of segments) {
					const panelStart = Math.max(start, segmentStart);
					const panelEnd = Math.min(end, segmentEnd);
					const panelWidth = panelEnd - panelStart;
					const opaqueBottom = Math.min(top, bottom + 0.06);
					const opaqueTop = Math.min(top, bottom + 0.45);
					if (panelWidth > 0 && opaqueTop > opaqueBottom) details.push({
						kind: "opaque-panel", view: plane.view, floor_m: bottom, bay, depth_m: frameDepth,
						material: "opaque", ...createPrism(plane, {
							start_m: panelStart, width_m: panelWidth, bottom_m: opaqueBottom,
							height_m: opaqueTop - opaqueBottom, depth_m: frameDepth,
						}),
					});
					const glassBottom = opaqueTop;
					const glassTop = Math.max(glassBottom, top - 0.06);
					if (panelWidth > 0 && glassTop > glassBottom) details.push({
						kind: "glazing", view: plane.view, floor_m: bottom, bay, depth_m: panelDepth,
						material: "glass", ...createPrism(plane, {
							start_m: panelStart, width_m: panelWidth, bottom_m: glassBottom,
							height_m: glassTop - glassBottom, depth_m: panelDepth,
						}),
					});
				}
			}
		}
	}
	return details;
}

export function buildEnrichedScene({ mesh, floorGuides, facadePlanes, grammar, safeFallback }) {
	return {
		base: { positions: mesh.vertices, indices: mesh.triangles },
		details: safeFallback ? [] : facadeDetails(mesh, floorGuides, facadePlanes, grammar),
	};
}

const MATERIAL_FACTORS = {
	concrete: { color: [0.62, 0.58, 0.52, 1], metallic: 0, roughness: 0.85 },
	glass: { color: [0.72, 0.86, 0.92, 0.28], metallic: 0, roughness: 0.12 },
	bronze: { color: [0.16, 0.10, 0.06, 1], metallic: 0.75, roughness: 0.30 },
	opaque: { color: [0.18, 0.20, 0.22, 1], metallic: 0.20, roughness: 0.55 },
};

function createMaterial(document, name) {
	const factors = MATERIAL_FACTORS[name];
	const material = document.createMaterial(name)
		.setBaseColorFactor(factors.color)
		.setMetallicFactor(factors.metallic)
		.setRoughnessFactor(factors.roughness);
	if (name === "glass") material.setAlphaMode(Material.AlphaMode.BLEND).setDoubleSided(true);
	return material;
}

function indexArray(indices) {
	const flat = indices.flat();
	const maximum = flat.reduce((value, index) => Math.max(value, index), 0);
	return maximum <= 65535 ? new Uint16Array(flat) : new Uint32Array(flat);
}

function addPrimitive(document, buffer, mesh, name, geometry, material) {
	const positions = document.createAccessor(`${name}-positions`, buffer)
		.setType("VEC3")
		.setArray(new Float32Array(geometry.positions.flat()));
	const indices = document.createAccessor(`${name}-indices`, buffer)
		.setType("SCALAR")
		.setArray(indexArray(geometry.indices));
	mesh.addPrimitive(document.createPrimitive().setAttribute("POSITION", positions).setIndices(indices).setMaterial(material));
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

export async function writeEnrichedGlb(scene, outputPath) {
	const document = new Document();
	const buffer = document.createBuffer("geometry");
	const usedMaterialNames = scene.details.length ? ["concrete", "glass", "bronze", "opaque"] : ["concrete"];
	const materials = Object.fromEntries(usedMaterialNames.map((name) => [name, createMaterial(document, name)]));
	const gltfScene = document.createScene("enriched-scene");
	document.getRoot().setDefaultScene(gltfScene);

	const baseMesh = document.createMesh("exact-mass");
	addPrimitive(document, buffer, baseMesh, "exact-mass", scene.base, materials.concrete);
	gltfScene.addChild(document.createNode("exact-mass").setMesh(baseMesh));

	if (scene.details.length) {
		const detailMesh = document.createMesh("facade-details");
		scene.details.forEach((detail, index) => addPrimitive(
			document, buffer, detailMesh, `detail-${index}`, detail, materials[detail.material],
		));
		gltfScene.addChild(document.createNode("facade-details").setMesh(detailMesh));
	}

	const path = resolve(outputPath);
	await mkdir(dirname(path), { recursive: true });
	await new NodeIO().write(path, document);
	const bytes = await readFile(path);
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
		bounds: geometryBounds(scene),
	};
}
