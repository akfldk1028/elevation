import { prepareFacadeContext, resolveRoots } from "../../../tools/facade-pipeline/index.mjs";

const roots = resolveRoots({});
const COS = Math.cos((2 * Math.PI) / 180);
for (const candidateId of ["creative-004", "creative-013", "creative-020"]) {
	const { context } = await prepareFacadeContext({ candidateId, ...roots });
	const segments = context.facade_segments;
	const fold = context.exclusions.fold_clearance_m;
	let stacked = 0, coplanar = 0, contains = 0, dots = [];
	const rows = [];
	for (const a of segments) {
		const above = segments.filter((b) => b !== a && b.face_view === a.face_view
			&& Math.abs(b.local_z[0] - a.local_z[1]) <= 0.02);
		if (!above.length) continue;
		const dot = (b) => a.outward_normal.reduce((s, v, i) => s + v * b.outward_normal[i], 0);
		const scaleA = a.projected_length_m / a.length_m;
		const aMin = a.face_offset_m + fold * scaleA, aMax = a.face_offset_m + (a.length_m - fold) * scaleA;
		const overlapping = above.filter((b) => b.face_offset_m < aMax - 1e-6 && b.face_offset_m + b.projected_length_m > aMin + 1e-6);
		if (!overlapping.length) continue;
		stacked += 1;
		const best = overlapping.sort((l, r) => dot(r) - dot(l))[0];
		dots.push(dot(best));
		if (dot(best) >= COS) {
			coplanar += 1;
			const bMin = best.face_offset_m + fold * scaleA, bMax = best.face_offset_m + best.projected_length_m - fold * scaleA;
			if (bMin <= aMin + 1e-6 && bMax >= aMax - 1e-6) contains += 1;
			else rows.push({ a: a.segment_id.slice(-4), b: best.segment_id.slice(-4), aMin: aMin.toFixed(2), aMax: aMax.toFixed(2), bMin: bMin.toFixed(2), bMax: bMax.toFixed(2), h: (a.local_z[1] - a.local_z[0]).toFixed(2) });
		}
	}
	dots.sort((l, r) => l - r);
	console.log(candidateId, { segments: segments.length, stacked, coplanar, contains, worst_dot: dots[0]?.toFixed(5), median_dot: dots[dots.length >> 1]?.toFixed(5) });
	if (rows.length) console.log("  coplanar but narrower above:", rows.slice(0, 6));
}
