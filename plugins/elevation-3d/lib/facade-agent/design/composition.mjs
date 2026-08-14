/**
 * Composition metrics: the difference between a designed elevation and a housing block,
 * measured rather than eyeballed.
 *
 * The earlier metric rewarded variety - alternating opening sizes storey by storey - and
 * a facade can score well on it while still reading as an apartment slab. Critics have a
 * name for exactly that device, pseudo-random windows, and call it fake difference: it
 * raises the variety count without giving the facade parts. So variety is not measured
 * here at all. These three are, because they are what the elevation was actually missing:
 *
 *   - openings that read as a share of the wall rather than slits in a blank field
 *   - a top that terminates instead of the building simply running out of floors
 *   - one element larger than the rest, so there is something to look at
 *
 * The thresholds are deliberately slack. They are meant to catch a warehouse, not to
 * arbitrate taste, and a facade that was genuinely composed clears all three at once.
 */

export const COMPOSITION_BOUNDS = Object.freeze({
	/** Guidance asks for a fifth to two fifths. Reject only what is plainly a blank wall. */
	minOpeningRatio: 0.1,
	/** Largest opening against the median one. Below this every opening is the same. */
	minScaleRatio: 1.5,
});

const OPENING_KINDS = new Set(["door", "window"]);

function area(bounds) {
	return Math.max(0, bounds.u_max - bounds.u_min) * Math.max(0, bounds.z_max - bounds.z_min);
}

function median(values) {
	if (!values.length) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = sorted.length >> 1;
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * @returns {{ metrics: object, codes: string[], faults: string[] }} both empty when the
 * facade composes. `codes` are stable identifiers for the record, `faults` are the same
 * codes carrying their measurement, which is what the model is shown.
 */
export function measureComposition({ context, resolved } = {}) {
	if (!context?.facade_segments || !resolved?.primitives) throw new TypeError("composition needs a context and a resolution");
	const segments = new Map(context.facade_segments.map((segment) => [segment.segment_id, segment]));

	// Opening share is read per elevation, not over the whole building. One generous
	// street face averaging out three blank ones is exactly the facade this is here to
	// catch, so the worst elevation is the one that counts.
	const wallByView = new Map();
	for (const segment of context.facade_segments) {
		const view = segment.face_view ?? segment.view;
		const height = (segment.local_z?.[1] ?? 0) - (segment.local_z?.[0] ?? 0);
		wallByView.set(view, (wallByView.get(view) ?? 0) + segment.length_m * height);
	}
	const openByView = new Map();
	const openingAreas = [];
	let hasTermination = false;
	const topStorey = context.storeys[context.storeys.length - 1];
	for (const primitive of resolved.primitives) {
		if (primitive.kind === "cornice") hasTermination = true;
		if (!OPENING_KINDS.has(primitive.kind)) continue;
		const view = segments.get(primitive.segment_id)?.face_view ?? segments.get(primitive.segment_id)?.view;
		const value = area(primitive.local_bounds);
		openByView.set(view, (openByView.get(view) ?? 0) + value);
		openingAreas.push(value);
	}

	const openingRatios = {};
	for (const [view, wall] of wallByView) openingRatios[view] = wall > 0 ? Number(((openByView.get(view) ?? 0) / wall).toFixed(6)) : 0;
	const ratios = Object.values(openingRatios);
	const worstRatio = ratios.length ? Math.min(...ratios) : 0;
	const largest = openingAreas.length ? Math.max(...openingAreas) : 0;
	const middle = median(openingAreas);
	const scaleRatio = middle > 0 ? Number((largest / middle).toFixed(6)) : 0;

	const codes = [];
	// `faults` is what the model is shown. A bare code leaves it guessing how far off it
	// is and by how much to move, so each one carries its measurement.
	const faults = [];
	const note = (code, text) => { codes.push(code); faults.push(`${code}: ${text}`); };
	if (worstRatio + 1e-9 < COMPOSITION_BOUNDS.minOpeningRatio) {
		note("OPENING_RATIO_LOW", `openings are ${(worstRatio * 100).toFixed(1)}% of the poorest elevation, which reads as a blank wall with slits in it; aim for 20-40%`);
	}
	// A cornice is the only terminal that means "this is where the building stops".
	// Without one the elevation reads as cut off at whatever storey it happened to reach.
	if (!hasTermination) {
		note("TOP_TERMINATION_MISSING", `no cornice anywhere, so the building stops at storey ${topStorey?.storey ?? "?"} rather than terminating`);
	}
	if (openingAreas.length > 1 && scaleRatio + 1e-9 < COMPOSITION_BOUNDS.minScaleRatio) {
		note("SCALE_HIERARCHY_FLAT", `the largest opening is only ${scaleRatio.toFixed(2)}x the median, so every opening is the same size and the elevation has no subject; make one element clearly dominant`);
	}

	return {
		metrics: {
			opening_ratio_by_view: openingRatios,
			worst_opening_ratio: Number(worstRatio.toFixed(6)),
			opening_count: openingAreas.length,
			largest_opening_m2: Number(largest.toFixed(6)),
			median_opening_m2: Number(middle.toFixed(6)),
			scale_ratio: scaleRatio,
			has_top_termination: hasTermination,
			top_storey: topStorey?.storey ?? null,
		},
		codes,
		faults,
	};
}
