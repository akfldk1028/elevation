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
 * between every course, and a window across that would stand 0.18 m proud or buried at its
 * head. That mass's cells are creased and the photograph of it that ignored the creases is
 * the perspective's error, not this rule's; the rule refuses there, by construction.
 */

/** Two facets closer than this in normal are one plane. Half a degree: a real crease is 3. */
const COPLANAR_COS = Math.cos((0.5 * Math.PI) / 180);
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
		if (dot(normal, above.outward_normal) < COPLANAR_COS) continue;
		const ends = [toLocal(above.face_offset_m), toLocal(above.face_offset_m + above.projected_length_m)];
		const uMin = Math.max(0, Math.min(...ends) + fold);
		const uMax = Math.min(segment.length_m, Math.max(...ends) - fold);
		if (uMax - uMin <= EPSILON) continue;
		found.push({
			segment_id: above.segment_id,
			u_min: Number(uMin.toFixed(8)),
			u_max: Number(uMax.toFixed(8)),
			z_max: above.local_z[1],
			u_shift_m: Number(Math.min(...ends).toFixed(8)),
		});
	}
	return found.sort((left, right) => left.u_min - right.u_min || left.segment_id.localeCompare(right.segment_id));
}

/** The continuation that holds `[uMin, uMax]` up to `zMax`, or null. */
export function continuationHolding(continuations, uMin, uMax, zMax) {
	return continuations.find((item) => item.u_min <= uMin + EPSILON && item.u_max >= uMax - EPSILON && item.z_max >= zMax - EPSILON) ?? null;
}
