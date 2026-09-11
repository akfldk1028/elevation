/**
 * Where a facet continues, in its own plane, into the facet stacked above it.
 *
 * The extractor cuts a wall into courses wherever a floor line crosses it, and the whole
 * grammar then treats each course as a facet: nothing may leave it, because the fold
 * clearance's argument - a hole cut through a TURN breaks the mass - was written for the
 * corner. Between two coplanar courses there is no turn. A window that crosses that seam
 * crosses a line the extractor drew, not one the building has. So an opening may rise into
 * the course above exactly where that course is the same plane and where it is wide enough
 * to hold the opening under the same fold clearance the course below gave it.
 *
 * Measured before writing this, on all three candidates: creative-013 has five such pairs,
 * every one offset sideways so only part of the width continues; creative-020 has none (a
 * prism, every facet full height); creative-004 has THIRTY-NINE stacked pairs and not one
 * is coplanar - its courses alternate 4.13 and 7.34 degrees of batter, a 3.2 degree crease
 * between every course, and a window rising a FULL STOREY across that would stand 0.18 m proud
 * at its head. It does not follow that nothing may cross: a head reaching 0.2 m past the seam
 * deviates by 11 mm. How far is the question, not whether, and the answer is a formula rather
 * than a constant - see MAX_SURFACE_DEVIATION_M below.
 */

/**
 * How far a member may stand off the mass surface it has crossed onto. A pane is 15 mm and a
 * jamb 20 mm, so 30 mm is the point where a member stops being flush with the wall and starts
 * being a thing stuck to it.
 */
const MAX_SURFACE_DEVIATION_M = 0.03;
/**
 * Below this there is no rise worth having, so no continuation is offered at all. It is the
 * floor-band clearance: an opening that cannot even clear the slab line gains nothing by
 * crossing the seam. This is what replaces a hard cap on the crease angle - at 11.5 degrees
 * the admissible rise falls under 0.15 m and the continuation disappears on its own.
 */
const MIN_USEFUL_RISE_M = 0.15;
/** How far apart the top of one course and the bottom of the next may sit and still be a seam. */
const SEAM_TOLERANCE_M = 0.02;
const EPSILON = 1e-8;

function dot(left, right) {
	return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

/**
 * The continuations of one facet, in that facet's own local u, already inset by the fold
 * clearance at both sides of the course above. Each is `{ segment_id, u_min, u_max, z_max,
 * u_shift_m }` where `u_shift_m` converts a u on this facet to a u on the continuation
 * (`u_above = u - u_shift_m`). Empty when nothing coplanar stands on this facet's top.
 *
 * A facet's local u runs along its tangent `[-n1, n0]` and the face axis is `[-o1, o0]` of
 * the sheet's outward: both are the same quarter-turn, so they agree in sign exactly when
 * the facet faces the sheet - which is the condition `faces.mjs` grouped it there by. So
 * local u increases with `face_offset_m` on every facet of a face, and the offsets are
 * turned back into local metres by the facet's own projection scale alone.
 */
export function coplanarContinuations(segment, context) {
	const segments = context?.facade_segments ?? [];
	const fold = context?.exclusions?.fold_clearance_m ?? 0;
	const normal = segment.outward_normal;
	const top = segment.local_z?.[1];
	const scale = segment.length_m > 0 ? (segment.projected_length_m ?? 0) / segment.length_m : 0;
	if (!segment.face_id || !Array.isArray(normal) || !Number.isFinite(top) || !(scale > EPSILON)) return [];
	const toLocal = (offset) => (offset - segment.face_offset_m) / scale;
	const found = [];
	for (const above of segments) {
		if (above.segment_id === segment.segment_id || above.face_id !== segment.face_id) continue;
		if (!Array.isArray(above.outward_normal) || !Number.isFinite(above.local_z?.[0])) continue;
		if (Math.abs(above.local_z[0] - top) > SEAM_TOLERANCE_M) continue;
		// HOW FAR a member may cross, from the crease it crosses. A member is planar and the
		// mass is not: carried `d` metres past the seam into a course creased by `theta`, it
		// stands off that course's surface by
		//
		//     e = d * sin(theta)
		//
		// so the admissible reach is `d_max = MAX_SURFACE_DEVIATION_M / sin(theta)`, unbounded
		// when the two courses are truly coplanar. The old rule fixed theta at half a degree,
		// which is that same formula solved backwards for a FULL STOREY of rise: 3.3 m at 0.5
		// degrees is 29 mm. Fixing the height was the mistake - the same constant refused a
		// 0.2 m head crossing a 3 degree crease, which deviates by 10 mm, while admitting a
		// 3.3 m pane across a hairline. creative-004's courses crease 3.2 degrees and now offer
		// 0.54 m of rise each, where before they offered none.
		const cosine = Math.min(1, Math.max(-1, dot(normal, above.outward_normal)));
		const sine = Math.sin(Math.acos(cosine));
		const reach = sine <= EPSILON ? Infinity : MAX_SURFACE_DEVIATION_M / sine;
		if (!(reach >= MIN_USEFUL_RISE_M)) continue;
		const ends = [toLocal(above.face_offset_m), toLocal(above.face_offset_m + above.projected_length_m)];
		const uMin = Math.max(0, Math.min(...ends) + fold);
		const uMax = Math.min(segment.length_m, Math.max(...ends) - fold);
		if (uMax - uMin <= EPSILON) continue;
		found.push({
			segment_id: above.segment_id,
			u_min: Number(uMin.toFixed(8)),
			u_max: Number(uMax.toFixed(8)),
			z_max: Number(Math.min(above.local_z[1], top + reach).toFixed(8)),
			// Reported so the brief can print what a facet actually offers, and so the number
			// in a rejection is the one the author can act on.
			crease_deg: Number(((Math.acos(cosine) * 180) / Math.PI).toFixed(4)),
			max_rise_m: Number((Number.isFinite(reach) ? Math.min(reach, above.local_z[1] - top) : above.local_z[1] - top).toFixed(4)),
			u_shift_m: Number(Math.min(...ends).toFixed(8)),
		});
	}
	return found.sort((left, right) => left.u_min - right.u_min || left.segment_id.localeCompare(right.segment_id));
}

/** The continuation that holds `[uMin, uMax]` up to `zMax`, or null. */
export function continuationHolding(continuations, uMin, uMax, zMax) {
	return continuations.find((item) => item.u_min <= uMin + EPSILON && item.u_max >= uMax - EPSILON && item.z_max >= zMax - EPSILON) ?? null;
}
