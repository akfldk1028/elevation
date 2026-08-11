import { sha256, stableJson } from "../../../core.mjs";

export const ELEVATION_NAMES = Object.freeze(["front", "back", "left", "right"]);

// Facet projections accumulate float residue, so a run that tiles exactly still
// measures a gap of a few nanometres. Anything below a micrometre is reported as
// continuous; no architectural recess is that small.
const GAP_TOLERANCE_M = 1e-6;

export class FacadeFaceError extends Error {
	constructor(message) {
		super(message);
		this.name = "FacadeFaceError";
		this.code = "FACADE_FACE_INVALID";
	}
}

function fail(message) {
	throw new FacadeFaceError(message);
}

function round(value) {
	return Number(value.toFixed(8));
}

/**
 * Resolve how each elevation camera sees the model.
 *
 * `camera-authority` places an elevation camera at `centre - depth * radius`, so the
 * camera looks along `+depth` and draws the facets that face `-depth`. The drawing's
 * rightward axis is `cross(look, up)` with `up = +Z`, which reduces to `[dy, -dx]`.
 * Deriving both from the authored depth keeps the design layer agreeing with the
 * sheet the reviewer actually sees, whatever the candidate authored.
 */
function elevationFrames(elevationDepths) {
	const frames = {};
	for (const view of ELEVATION_NAMES) {
		const depth = elevationDepths?.[view];
		if (!Array.isArray(depth) || depth.length !== 3 || !depth.every(Number.isFinite)) {
			fail(`elevation ${view} needs a finite projection depth axis`);
		}
		const length = Math.hypot(...depth);
		if (!(length > 0)) fail(`elevation ${view} depth axis has no direction`);
		const unit = depth.map((value) => value / length);
		const axis = [unit[1], -unit[0]];
		if (!(Math.hypot(...axis) > 0)) fail(`elevation ${view} has no horizontal drawing axis`);
		frames[view] = { outward: unit.map((value) => -value), axis };
	}
	return frames;
}

function projection(plane, axis) {
	const tangent = [-plane.normal[1], plane.normal[0]];
	const start = [plane.origin[0], plane.origin[1]];
	const end = [start[0] + tangent[0] * plane.extent_m[0], start[1] + tangent[1] * plane.extent_m[0]];
	const first = start[0] * axis[0] + start[1] * axis[1];
	const last = end[0] * axis[0] + end[1] * axis[1];
	return { min: Math.min(first, last), max: Math.max(first, last) };
}

/**
 * Group the facets of an envelope into the faces an elevation drawing shows.
 *
 * A face is every facet drawn on one elevation. Its axis is that sheet's horizontal
 * axis, so each facet lands at a projected offset along the face even when the
 * envelope folds between facets. A pleated plan therefore keeps its folds while
 * still exposing one continuous coordinate per elevation.
 */
export function deriveFacadeFaces(facadePlanes, elevationDepths) {
	if (!Array.isArray(facadePlanes) || !facadePlanes.length) fail("facade planes are required");
	const frames = elevationFrames(elevationDepths);
	const grouped = new Map();
	for (const plane of facadePlanes) {
		if (!Array.isArray(plane?.normal) || !Array.isArray(plane.origin) || !Array.isArray(plane.extent_m)
			|| !Number.isFinite(plane.extent_m[0]) || plane.extent_m[0] <= 0) fail("facade plane geometry is invalid");
		let drawn = null;
		let best = 0;
		for (const view of ELEVATION_NAMES) {
			const score = plane.normal.reduce((sum, value, index) => sum + value * frames[view].outward[index], 0);
			if (score > best + 1e-9) { best = score; drawn = view; }
		}
		if (!drawn) fail(`facade plane ${String(plane.segment_id)} faces no elevation`);
		const entry = grouped.get(drawn) ?? [];
		entry.push(plane);
		grouped.set(drawn, entry);
	}

	const faces = [];
	const bySegment = {};
	for (const view of ELEVATION_NAMES) {
		const planes = grouped.get(view);
		if (!planes?.length) continue;
		const { axis } = frames[view];
		const spans = planes
			.map((plane) => ({ plane, ...projection(plane, axis) }))
			.sort((left, right) => left.min - right.min || left.plane.segment_id.localeCompare(right.plane.segment_id));
		const origin = spans[0].min;
		const extent = Math.max(...spans.map((span) => span.max)) - origin;
		const covered = spans.reduce((sum, span) => sum + (span.max - span.min), 0);
		const gap = Math.abs(extent - covered) <= GAP_TOLERANCE_M ? 0 : extent - covered;
		const segmentIds = spans.map((span) => span.plane.segment_id);
		const faceId = `facade-face-${sha256(stableJson({ view, segment_ids: segmentIds })).slice(0, 20)}`;
		faces.push(Object.freeze({
			face_id: faceId,
			view,
			axis: Object.freeze(axis.map(round)),
			length_m: round(extent),
			covered_length_m: round(covered),
			gap_m: round(gap),
			segment_ids: Object.freeze([...segmentIds]),
		}));
		spans.forEach((span, index) => {
			bySegment[span.plane.segment_id] = Object.freeze({
				face_id: faceId,
				face_view: view,
				face_index: index,
				face_offset_m: round(span.min - origin),
				projected_length_m: round(span.max - span.min),
			});
		});
	}
	if (!faces.length) fail("no facade face could be derived");
	return Object.freeze({ faces: Object.freeze(faces), bySegment: Object.freeze(bySegment) });
}
