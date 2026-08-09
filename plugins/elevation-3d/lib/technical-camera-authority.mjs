const DEFAULT_OUTPUT_SIZE = 2400;
const ELEVATION_MARGIN_RATIO = 0.09;
const PLAN_MARGIN_RATIO = 0.09;
const AXON_MARGIN_RATIO = 0.15;

function finiteVector(value, label) {
	if (!Array.isArray(value) || value.length !== 3 || value.some((item) => !Number.isFinite(item))) {
		throw new Error(`${label} must be a finite three-vector`);
	}
	return value;
}

function add(left, right) {
	return left.map((value, axis) => value + right[axis]);
}

function subtract(left, right) {
	return left.map((value, axis) => value - right[axis]);
}

function scale(value, amount) {
	return value.map((item) => item * amount);
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

function normalize(value, label) {
	finiteVector(value, label);
	const length = Math.hypot(...value);
	if (!(length > 0)) throw new Error(`${label} must have non-zero length`);
	return value.map((item) => item / length);
}

function boundsCorners(bounds) {
	const min = finiteVector(bounds?.min, "geometry bounds minimum");
	const max = finiteVector(bounds?.max, "geometry bounds maximum");
	if (min.some((value, axis) => value > max[axis])) throw new Error("geometry bounds are inverted");
	const corners = [];
	for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) corners.push([x, y, z]);
	return corners;
}

export function projectTechnicalGeometryBounds(points, axes) {
	const horizontal = finiteVector(axes?.horizontal, "camera horizontal axis");
	const vertical = finiteVector(axes?.vertical, "camera vertical axis");
	const depth = finiteVector(axes?.depth, "camera depth axis");
	if (!Array.isArray(points) || points.length === 0) throw new Error("selected GLB geometry points are required");
	const bounds = { minH: Infinity, maxH: -Infinity, minV: Infinity, maxV: -Infinity, minD: Infinity, maxD: -Infinity };
	for (const point of points) {
		finiteVector(point, "selected GLB geometry point");
		const h = dot(point, horizontal), v = dot(point, vertical), d = dot(point, depth);
		bounds.minH = Math.min(bounds.minH, h); bounds.maxH = Math.max(bounds.maxH, h);
		bounds.minV = Math.min(bounds.minV, v); bounds.maxV = Math.max(bounds.maxV, v);
		bounds.minD = Math.min(bounds.minD, d); bounds.maxD = Math.max(bounds.maxD, d);
	}
	return bounds;
}

function orthographicApplied({ center, vertical, depth, direction, distance, frustum }) {
	return {
		position: add(center, scale(depth, direction * distance)), target: [...center], up: [...vertical], frustum: { ...frustum },
	};
}

export function deriveCompetitionElevationCameraAuthority({
	view, projectedBounds, size = DEFAULT_OUTPUT_SIZE, marginRatio = ELEVATION_MARGIN_RATIO, pixelsPerMetre,
} = {}) {
	if (view?.projection !== "orthographic") throw new Error("competition elevation authority requires an orthographic candidate camera");
	const axes = view.projection_axes;
	const width = projectedBounds.maxH - projectedBounds.minH;
	const height = projectedBounds.maxV - projectedBounds.minV;
	const usable = 1 - marginRatio * 2;
	const reservedLaneTop = size - 550;
	const annotationVerticalUsable = (reservedLaneTop - 192) / size;
	const span = pixelsPerMetre == null
		? Math.max(width / usable, height / Math.min(usable, annotationVerticalUsable))
		: size / pixelsPerMetre;
	if (!(Number.isFinite(span) && span > 0 && span >= width && span >= height)) {
		throw new Error("competition elevation authority would clip selected GLB geometry");
	}
	const centerH = (projectedBounds.minH + projectedBounds.maxH) / 2;
	let centerV = (projectedBounds.minV + projectedBounds.maxV) / 2;
	const centerD = (projectedBounds.minD + projectedBounds.maxD) / 2;
	const pxPerM = size / span;
	const projectedBottom = (size + height * pxPerM) / 2;
	if (projectedBottom > reservedLaneTop) centerV += (reservedLaneTop - projectedBottom) / pxPerM;
	const horizontal = finiteVector(axes?.horizontal, "camera horizontal axis");
	const vertical = finiteVector(axes?.vertical, "camera vertical axis");
	const depth = finiteVector(axes?.depth, "camera depth axis");
	const center = add(add(scale(horizontal, centerH), scale(vertical, centerV)), scale(depth, centerD));
	const depthSpan = Math.max(projectedBounds.maxD - projectedBounds.minD, 1);
	const distance = depthSpan + 100;
	const frustum = { left: -span / 2, right: span / 2, top: span / 2, bottom: -span / 2, near: 0.1, far: distance + depthSpan + 100 };
	return {
		manifest: {
			type: "orthographic", projection_axes: structuredClone(axes), center_m: [centerH, centerV, centerD],
			frustum, px_per_m_x: pxPerM, px_per_m_y: pxPerM, margin_ratio: marginRatio,
		},
		applied: orthographicApplied({ center, vertical, depth, direction: -1, distance, frustum }),
		bounds: { ...projectedBounds },
	};
}

export function deriveCompetitionPlanCameraAuthority({
	view, projectedBounds, size = DEFAULT_OUTPUT_SIZE, marginRatio = PLAN_MARGIN_RATIO,
} = {}) {
	if (view?.projection !== "orthographic") throw new Error("competition plan authority requires an orthographic candidate camera");
	const axes = view.projection_axes;
	const width = projectedBounds.maxH - projectedBounds.minH;
	const height = projectedBounds.maxV - projectedBounds.minV;
	const span = Math.max(width, height) / (1 - marginRatio * 2);
	if (!(Number.isFinite(span) && span > 0)) throw new Error("competition plan authority has invalid selected GLB bounds");
	const centerH = (projectedBounds.minH + projectedBounds.maxH) / 2;
	const centerV = (projectedBounds.minV + projectedBounds.maxV) / 2;
	const centerD = (projectedBounds.minD + projectedBounds.maxD) / 2;
	const horizontal = finiteVector(axes?.horizontal, "camera horizontal axis");
	const vertical = finiteVector(axes?.vertical, "camera vertical axis");
	const depth = finiteVector(axes?.depth, "camera depth axis");
	const center = add(add(scale(horizontal, centerH), scale(vertical, centerV)), scale(depth, centerD));
	const distance = Math.max(projectedBounds.maxD - projectedBounds.minD, 1) + 100;
	const frustum = { left: -span / 2, right: span / 2, top: span / 2, bottom: -span / 2, near: 0.1, far: distance * 2 + 100 };
	return {
		manifest: {
			type: "orthographic", projection_axes: structuredClone(axes), center_m: [centerH, centerV, centerD],
			frustum, px_per_m_x: size / span, px_per_m_y: size / span, margin_ratio: marginRatio,
		},
		applied: orthographicApplied({ center, vertical, depth, direction: 1, distance, frustum }),
		bounds: { ...projectedBounds },
	};
}

export function deriveCompetitionAxonCameraAuthority({ definition, worldBounds, marginRatio = AXON_MARGIN_RATIO } = {}) {
	if (definition?.projection !== "perspective") throw new Error("competition axon authority requires a perspective candidate camera");
	const center = worldBounds.min.map((value, axis) => (value + worldBounds.max[axis]) / 2);
	const forward = normalize(subtract(definition.target, definition.position), "candidate camera direction");
	const sourceUp = normalize(definition.up, "candidate camera up");
	const right = normalize(cross(forward, sourceUp), "candidate camera right axis");
	const up = normalize(cross(right, forward), "candidate camera applied up");
	const tanHalf = Math.tan(definition.fov_degrees * Math.PI / 360);
	const usable = 1 - marginRatio * 2;
	let distance = 0;
	for (const corner of boundsCorners(worldBounds)) {
		const relative = subtract(corner, center);
		const depthOffset = dot(relative, forward);
		distance = Math.max(distance,
			Math.abs(dot(relative, right)) / (tanHalf * usable) - depthOffset,
			Math.abs(dot(relative, up)) / (tanHalf * usable) - depthOffset);
	}
	const size = worldBounds.max.map((value, axis) => value - worldBounds.min[axis]);
	const diagonal = Math.hypot(...size);
	distance = Math.max(distance, diagonal);
	const position = subtract(center, scale(forward, distance));
	const horizontalDepth = normalize([position[0] - center[0], position[1] - center[1], 0], "technical axon horizontal depth");
	const manifest = {
		type: "perspective", position, target: [...center], up,
		fov_degrees: definition.fov_degrees, near: Math.max(0.05, distance - diagonal * 0.75), far: distance + diagonal * 0.75, aspect: 1,
		depth: horizontalDepth, margin_ratio: marginRatio,
	};
	return { manifest, center, size, diagonal, world_bounds: { min: [...worldBounds.min], max: [...worldBounds.max] } };
}

export const TECHNICAL_CAMERA_LAYOUT = Object.freeze({
	output_size: DEFAULT_OUTPUT_SIZE,
	elevation_margin_ratio: ELEVATION_MARGIN_RATIO,
	plan_margin_ratio: PLAN_MARGIN_RATIO,
	axon_margin_ratio: AXON_MARGIN_RATIO,
});
