import { getBounds, NodeIO } from "@gltf-transform/core";

import { sha256, stableJson } from "./core.mjs";
import {
	deriveCompetitionAxonCameraAuthority, deriveCompetitionElevationCameraAuthority, deriveCompetitionPlanCameraAuthority,
	projectTechnicalGeometryBounds,
} from "./technical-camera-authority.mjs";

export const DELIVERY_VIEW_NAMES = Object.freeze(["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"]);

export function normalizeCameraValue(value) {
	if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 1e9) / 1e9 : null;
	if (Array.isArray(value)) return value.map(normalizeCameraValue);
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeCameraValue(value[key])]));
	return value;
}

export function cameraContractHash(contract) {
	return sha256(stableJson(normalizeCameraValue(contract)));
}

export function cameraValuesEqual(left, right) {
	return stableJson(normalizeCameraValue(left)) === stableJson(normalizeCameraValue(right));
}

function transformPoint(position, matrix) {
	const [x, y, z] = position;
	return [
		matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
		matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
		matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
	];
}

function sceneNodes(scene) {
	const nodes = [], pending = [...scene.listChildren()];
	while (pending.length) {
		const node = pending.shift();
		nodes.push(node);
		pending.push(...node.listChildren());
	}
	return nodes;
}

async function cameraGeometryFromGlb(bytes) {
	const document = await new NodeIO().readBinary(new Uint8Array(bytes));
	const root = document.getRoot();
	const scene = root.getDefaultScene() ?? root.listScenes()[0];
	if (!scene) throw new Error("selected GLB has no scene for camera authority");
	const bounds = getBounds(scene);
	if (!bounds.min.every(Number.isFinite) || !bounds.max.every(Number.isFinite)) {
		throw new Error("selected GLB has no finite geometry bounds for camera authority");
	}
	const points = [];
	for (const node of sceneNodes(scene)) {
		const mesh = node.getMesh();
		if (!mesh) continue;
		const matrix = node.getWorldMatrix();
		for (const primitive of mesh.listPrimitives()) {
			const position = primitive.getAttribute("POSITION");
			if (!position) continue;
			for (let index = 0; index < position.getCount(); index += 1) {
				points.push(transformPoint(position.getElement(index, [0, 0, 0]), matrix));
			}
		}
	}
	if (!points.length) throw new Error("selected GLB has no geometry points for camera authority");
	return { bounds: { min: [...bounds.min], max: [...bounds.max] }, points };
}

function buildingBounds(bounds) {
	const size = bounds.max.map((value, axis) => value - bounds.min[axis]);
	return {
		center: bounds.max.map((value, axis) => (value + bounds.min[axis]) / 2),
		radius: Math.max(Math.hypot(...size) * 0.75, 1),
	};
}

export async function cameraBuildingBoundsFromGlb(bytes) {
	return buildingBounds((await cameraGeometryFromGlb(bytes)).bounds);
}

export async function technicalCameraAuthorityFromGlb({ bytes, cameras } = {}) {
	const geometry = await cameraGeometryFromGlb(bytes);
	const authority = {};
	let commonPixelsPerMetre;
	for (const name of ["front", "back", "left", "right"]) {
		const view = cameras?.[name];
		const fitted = deriveCompetitionElevationCameraAuthority({
			view,
			projectedBounds: projectTechnicalGeometryBounds(geometry.points, view?.projection_axes),
			pixelsPerMetre: commonPixelsPerMetre,
		});
		authority[name] = fitted.manifest;
		commonPixelsPerMetre ??= fitted.manifest.px_per_m_x;
	}
	const top = cameras?.top;
	const topBounds = projectTechnicalGeometryBounds(geometry.points, top?.projection_axes);
	authority.plan = deriveCompetitionPlanCameraAuthority({ view: top, projectedBounds: topBounds }).manifest;
	authority.top = deriveCompetitionPlanCameraAuthority({ view: top, projectedBounds: topBounds }).manifest;
	for (const name of ["axon", "opposite-axon"]) {
		authority[name] = deriveCompetitionAxonCameraAuthority({ definition: cameras?.[name], worldBounds: geometry.bounds }).manifest;
	}
	return { cameras: authority, building_bounds: buildingBounds(geometry.bounds), geometry_bounds: geometry.bounds };
}

export function presentationCameraPresets(cameras) {
	const source = { ...(cameras ?? {}) };
	if (!source.plan && source.top) source.plan = { ...structuredClone(source.top), name: "plan" };
	return Object.fromEntries(DELIVERY_VIEW_NAMES.map((name) => {
		const preset = source[name];
		if (!preset) throw new Error(`presentation camera preset is missing: ${name}`);
		const cut = name === "plan"
			? { enabled: true, elevation_m: 1.2, plane_world: [0, 0, 1, -1.2] }
			: { enabled: false, elevation_m: null, plane_world: null };
		return [name, { ...structuredClone(preset), cut }];
	}));
}

export function deriveExpectedCameraContract({ name, preset, buildingBounds }) {
	const clipping = preset.cut ?? { enabled: false, elevation_m: null, plane_world: null };
	const type = preset.type ?? preset.projection;
	if (type === "perspective") return normalizeCameraValue({
		type: "perspective", position: preset.position, target: preset.target, up: preset.up,
		perspective: { fov: preset.fov_degrees, near: preset.near ?? 0.1, far: preset.far ?? 10000, aspect: preset.aspect ?? 1 }, orthographic: null,
		configured: { projection_axes: null, depth: preset.depth ?? null }, clipping,
	});
	if (type !== "orthographic") throw new Error(`unsupported camera preset: ${name}`);
	const center = buildingBounds.center;
	const rawDepth = preset.projection_axes.depth;
	const length = Math.hypot(...rawDepth);
	const depth = rawDepth.map((value) => value / length);
	const direction = name === "plan" || name === "top" ? 1 : -1;
	const position = center.map((value, index) => value + direction * depth[index] * buildingBounds.radius * 4);
	const projectedBounds = preset.projected_bounds_m;
	const projectedSpan = Array.isArray(projectedBounds) && projectedBounds.length === 2
		? Math.max(projectedBounds[1][0] - projectedBounds[0][0], projectedBounds[1][1] - projectedBounds[0][1]) * 1.08
		: buildingBounds.radius * 2;
	const frustum = preset.frustum ?? {
		left: -projectedSpan / 2, right: projectedSpan / 2, top: projectedSpan / 2, bottom: -projectedSpan / 2,
		near: 0.01, far: 10000,
	};
	return normalizeCameraValue({
		type: "orthographic", position, target: preset.target ?? center, up: preset.projection_axes.vertical,
		perspective: null, orthographic: { ...frustum, zoom: 1 },
		configured: { projection_axes: preset.projection_axes, depth: null }, clipping,
	});
}

export function cameraSourceMatches(actual, authoritative) {
	const actualType = actual?.type ?? actual?.projection;
	const expectedType = authoritative?.type ?? authoritative?.projection;
	if (actualType !== expectedType) return false;
	if (expectedType === "orthographic") {
		const frustum = actual?.frustum;
		return cameraValuesEqual(actual?.projection_axes, authoritative?.projection_axes)
			&& (!frustum || ["left", "right", "top", "bottom", "near", "far"].every((key) => Number.isFinite(frustum[key])))
			&& (!frustum || (frustum.left < frustum.right && frustum.bottom < frustum.top && frustum.near >= 0 && frustum.far > frustum.near));
	}
	const unit = (values) => {
		if (!Array.isArray(values) || values.length !== 3 || values.some((value) => !Number.isFinite(value))) return null;
		const length = Math.hypot(...values);
		return length > 0 ? values.map((value) => value / length) : null;
	};
	const subtract = (left, right) => left.map((value, index) => value - right[index]);
	const cross = (left, right) => [
		left[1] * right[2] - left[2] * right[1],
		left[2] * right[0] - left[0] * right[2],
		left[0] * right[1] - left[1] * right[0],
	];
	const actualForward = unit(Array.isArray(actual?.target) && Array.isArray(actual?.position) ? subtract(actual.target, actual.position) : null);
	const sourceForward = unit(Array.isArray(authoritative?.target) && Array.isArray(authoritative?.position) ? subtract(authoritative.target, authoritative.position) : null);
	const sourceUp = unit(authoritative?.up);
	const right = sourceForward && sourceUp ? unit(cross(sourceForward, sourceUp)) : null;
	const expectedAppliedUp = right && sourceForward ? unit(cross(right, sourceForward)) : null;
	return Boolean(actualForward && sourceForward && expectedAppliedUp)
		&& cameraValuesEqual(actualForward, sourceForward)
		&& cameraValuesEqual(actual?.target, authoritative?.target)
		&& cameraValuesEqual(unit(actual?.up), expectedAppliedUp)
		&& normalizeCameraValue(actual?.fov_degrees) === normalizeCameraValue(authoritative?.fov_degrees)
		&& (!Object.hasOwn(actual ?? {}, "near") || (Number.isFinite(actual.near) && actual.near >= 0))
		&& (!Object.hasOwn(actual ?? {}, "far") || (Number.isFinite(actual.far) && actual.far > (actual.near ?? 0)))
		&& (!Object.hasOwn(actual ?? {}, "aspect") || (Number.isFinite(actual.aspect) && actual.aspect > 0));
}

export function browserCameraMatchesCandidate({ name, preset, buildingBounds, actual }) {
	if (!buildingBounds || !Array.isArray(buildingBounds.center) || buildingBounds.center.length !== 3
		|| buildingBounds.center.some((value) => !Number.isFinite(value)) || !(buildingBounds.radius > 0)) return false;
	const contract = actual?.contract ?? actual;
	if (!contract) return false;
	let expected;
	try { expected = deriveExpectedCameraContract({ name, preset, buildingBounds }); }
	catch { return false; }
	if (expected.type === "perspective" && Number.isFinite(contract?.perspective?.aspect) && contract.perspective.aspect > 0) {
		expected = structuredClone(expected);
		expected.perspective.aspect = contract.perspective.aspect;
	}
	return cameraValuesEqual(contract, expected);
}
