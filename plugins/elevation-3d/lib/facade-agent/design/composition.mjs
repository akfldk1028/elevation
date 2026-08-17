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
	/**
	 * Largest opening against the median one. Below this every opening is the same.
	 *
	 * This number has no source. It was picked to catch a flat grid and it does, but it is
	 * not a quantity anyone in the literature measures - Alexander's levels of scale are
	 * about the step between *neighbouring* sizes, not about the largest against the middle.
	 * `levels_of_scale` in the metrics reports that properly; see maxLevelStep.
	 */
	minScaleRatio: 1.5,
	/**
	 * The step between neighbouring size levels at which the hierarchy has broken.
	 *
	 * Alexander: a center helps another "at a scale which is perhaps half its size, or twice
	 * its size - but not enormously bigger, or enormously smaller", and below a tenth "it is
	 * less likely to help it in its intensity" (The Nature of Order, Book One, pp. 148-9).
	 * Ten is his failure threshold, not his target, so this rejects only a genuine gap - one
	 * enormous opening with nothing between it and the small ones, which reads as two
	 * unrelated buildings rather than as one with a subject.
	 *
	 * Measured on ten schemes the largest step seen was 3.96, so this rejects none of them.
	 * It is a guard, not a filter.
	 */
	maxLevelStep: 10,
	/**
	 * Storeys the tallest opening or pier must reach through. Two is the least that
	 * counts as crossing a floor at all, and the placement rules already allow it -
	 * only the two ends of an opening have to sit clear of a slab.
	 */
	minStoreySpan: 2,
});

const OPENING_KINDS = new Set(["door", "window"]);

/**
 * Sizes within this factor of each other are the same size, so they form one level.
 * Deliberately below Alexander's ideal adjacent ratio of about 2, so that a level is a
 * tight cluster and the ratios measured between levels are real steps rather than an
 * artefact of where the clustering cut.
 */
const LEVEL_TOLERANCE = 1.4;

/**
 * Levels of scale, after Alexander.
 *
 * The elevation's openings are grouped into size levels and the step between neighbouring
 * levels is what gets measured. Alexander puts the useful step at about half or twice the
 * size, out to roughly four, and says that below a tenth "it is less likely to help it in
 * its intensity" (The Nature of Order, Book One, pp. 148-9); Salingaros's formal version of
 * the same rule puts the ideal step at e, about 2.7 ("Hierarchical Cooperation in
 * Architecture", JAPR 17:221-235, 2000).
 *
 * Size is taken as the square root of area, because a level of scale is a linear dimension
 * - a window twice as big is twice as wide, not twice the area.
 */
function levelsOfScale(areas) {
	const sizes = areas.filter((value) => value > 0).map(Math.sqrt).sort((left, right) => left - right);
	if (!sizes.length) return { count: 0, steps: [], largestStep: 0 };
	const levels = [[sizes[0]]];
	for (const size of sizes.slice(1)) {
		const current = levels[levels.length - 1];
		if (size / current[current.length - 1] > LEVEL_TOLERANCE) levels.push([size]);
		else current.push(size);
	}
	const representative = levels.map((level) => median(level));
	const steps = representative.slice(1).map((value, index) => value / representative[index]);
	return {
		count: levels.length,
		steps: steps.map((value) => Number(value.toFixed(3))),
		largestStep: steps.length ? Number(Math.max(...steps).toFixed(3)) : 0,
		population: levels.map((level) => level.length),
	};
}

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
	// Ground-storey glazing, kept separate from the rest.
	//
	// The opening ratio this file already takes is over the whole face, and that quantity has
	// no support in the literature - no study was found regressing perception or behaviour on
	// whole-facade window share, and Gehl's A-E scale, which is usually cited for it, counts
	// doors per 100 m and contains no glazing figure at all. What is evidenced is the ground
	// storey specifically. Ewing & Handy, "Measuring the Unmeasurable", J. Urban Design 14(1),
	// 2009: transparency has three terms and the largest is the proportion of *first floor*
	// facade carrying windows (1.219, p = 0.002); the paper states outright that windows above
	// ground level do not raise perceived transparency once the others are controlled. Ewing
	// et al., J. Planning Education and Research 36(1), 2016: on 588 New York blocks, with
	// density, FAR, retail share and Walk Score controlled, the proportion of windows on the
	// street is one of only three streetscape features significantly related to observed
	// pedestrian counts.
	//
	// It is reported and not yet gated. The base it rests on is thin - 48 video clips rated by
	// 10 experts, ICC 0.499, 32% of total variance - and a threshold taken from a study of
	// American commercial streets has not been shown to transfer to this candidate.
	const groundOpenByView = new Map();
	const groundWallByView = new Map();
	const groundStorey = context.storeys[0];
	const openingAreas = [];
	let hasTermination = false;
	// How many storeys the tallest single element reaches through. One means every
	// opening and every pier was cut to fit inside a floor, which is the geometry of
	// stacked identical cells however much the openings differ within a storey.
	let maxStoreySpan = 0;
	const topStorey = context.storeys[context.storeys.length - 1];
	const storeySpan = (bounds) => context.storeys.filter((storey) => {
		const overlap = Math.min(bounds.z_max, storey.z_max) - Math.max(bounds.z_min, storey.z_min);
		return overlap > 0.35 * (storey.z_max - storey.z_min);
	}).length;
	// What each face is made of, so two faces can be compared by kind rather than by size.
	// A profile is the set of terminals the face uses, the shape of its typical opening and
	// how densely it is punched - the three things that make one wall a different sort of
	// wall from another, and none of which the opening ratio can see.
	const kindsByView = new Map();
	const aspectsByView = new Map();
	const countByView = new Map();
	const terminatedViews = new Set();
	for (const primitive of resolved.primitives) {
		if (primitive.kind === "cornice") hasTermination = true;
		const primitiveView = segments.get(primitive.segment_id)?.face_view ?? segments.get(primitive.segment_id)?.view;
		if (primitiveView) {
			if (primitive.kind === "cornice") terminatedViews.add(primitiveView);
			if (!kindsByView.has(primitiveView)) kindsByView.set(primitiveView, new Set());
			// The entrance is placed by deterministic code, always on the most visible ground
			// segment, so it appears on one face whatever the grammar says. Counting it makes
			// that face different from every other by construction and the comparison below
			// can never fail - which is exactly what it did before this line.
			if (primitive.kind !== "door") kindsByView.get(primitiveView).add(primitive.kind);
			if (OPENING_KINDS.has(primitive.kind)) {
				const width = primitive.local_bounds.u_max - primitive.local_bounds.u_min;
				const height = primitive.local_bounds.z_max - primitive.local_bounds.z_min;
				if (height > 0) (aspectsByView.get(primitiveView) ?? aspectsByView.set(primitiveView, []).get(primitiveView)).push(width / height);
				countByView.set(primitiveView, (countByView.get(primitiveView) ?? 0) + 1);
			}
		}
		// A pier counts as much as a window here: an order carried through three floors
		// is what breaks the storey lockstep, and it need not be glazed to do it.
		if (OPENING_KINDS.has(primitive.kind) || primitive.kind === "pilaster") {
			maxStoreySpan = Math.max(maxStoreySpan, storeySpan(primitive.local_bounds));
		}
		if (!OPENING_KINDS.has(primitive.kind)) continue;
		const view = segments.get(primitive.segment_id)?.face_view ?? segments.get(primitive.segment_id)?.view;
		const value = area(primitive.local_bounds);
		openByView.set(view, (openByView.get(view) ?? 0) + value);
		openingAreas.push(value);
		// The part of this opening that falls inside the ground storey, so a slot running past
		// the first slab contributes only the height it actually glazes at street level.
		if (groundStorey) {
			const overlap = Math.min(primitive.local_bounds.z_max, groundStorey.z_max) - Math.max(primitive.local_bounds.z_min, groundStorey.z_min);
			if (overlap > 0) {
				const width = Math.max(0, primitive.local_bounds.u_max - primitive.local_bounds.u_min);
				groundOpenByView.set(view, (groundOpenByView.get(view) ?? 0) + width * overlap);
			}
		}
	}

	if (groundStorey) {
		for (const segment of context.facade_segments) {
			const view = segment.face_view ?? segment.view;
			const low = Math.max(segment.local_z?.[0] ?? 0, groundStorey.z_min);
			const high = Math.min(segment.local_z?.[1] ?? 0, groundStorey.z_max);
			if (high > low) groundWallByView.set(view, (groundWallByView.get(view) ?? 0) + segment.length_m * (high - low));
		}
	}
	const openingRatios = {};
	for (const [view, wall] of wallByView) openingRatios[view] = wall > 0 ? Number(((openByView.get(view) ?? 0) / wall).toFixed(6)) : 0;
	const groundRatios = {};
	for (const [view, wall] of groundWallByView) groundRatios[view] = wall > 0 ? Number(((groundOpenByView.get(view) ?? 0) / wall).toFixed(6)) : 0;
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
	// Asked of every face, not of the building. The test used to be "is there a cornice
	// anywhere", which one terminated elevation satisfied on behalf of three that were left
	// sawn off - and the elevations are drawn and judged one at a time. Longstreth's
	// commercial typology reads a facade's zones off the horizontal members that divide it,
	// which is only meaningful if the members are actually on the face being read
	// (The Buildings of Main Street, Preservation Press, 1987).
	const unterminated = [...wallByView.keys()].filter((view) => !terminatedViews.has(view));
	if (unterminated.length) {
		note("TOP_TERMINATION_MISSING", unterminated.length === wallByView.size
			? `no cornice anywhere, so the building stops at storey ${topStorey?.storey ?? "?"} rather than terminating`
			: `${unterminated.join(", ")} ${unterminated.length === 1 ? "has" : "have"} no cornice, so ${unterminated.length === 1 ? "that elevation runs" : "those elevations run"} out of floors while the others terminate`);
	}
	const levels = levelsOfScale(openingAreas);
	if (levels.largestStep > COMPOSITION_BOUNDS.maxLevelStep) {
		note("SCALE_STEP_BROKEN", `the size levels jump by ${levels.largestStep.toFixed(1)}x, so the largest opening has nothing between it and the rest and reads as a separate building; keep neighbouring sizes within about three of each other`);
	}
	if (openingAreas.length > 1 && scaleRatio + 1e-9 < COMPOSITION_BOUNDS.minScaleRatio) {
		note("SCALE_HIERARCHY_FLAT", `the largest opening is only ${scaleRatio.toFixed(2)}x the median, so every opening is the same size and the elevation has no subject; make one element clearly dominant`);
	}
	// The street face and the service face have to differ in kind, not in window width. The
	// guidance has always asked for it and nothing measured it, so an elevation whose front
	// and back were the same wall - told apart only by the deterministic entrance - passed
	// with no faults at all. Density is per unit of wall so a longer face is not counted as
	// a different sort of face merely for holding more openings.
	const faceProfile = (view) => {
		const aspects = aspectsByView.get(view) ?? [];
		const wall = wallByView.get(view) ?? 0;
		return [
			[...(kindsByView.get(view) ?? [])].sort().join("+"),
			median(aspects).toFixed(1),
			wall > 0 ? ((countByView.get(view) ?? 0) / wall).toFixed(1) : "0",
		].join("|");
	};
	const frontProfile = wallByView.has("front") ? faceProfile("front") : null;
	const backProfile = wallByView.has("back") ? faceProfile("back") : null;
	const facesDiffer = frontProfile === null || backProfile === null || frontProfile !== backProfile;
	if (!facesDiffer) {
		note("FACE_KIND_UNIFORM", `the front and the back are the same wall - same terminals, same opening proportion, same density (${frontProfile}); give one of them a different device rather than a different window width`);
	}
	if (context.storeys.length > 1 && maxStoreySpan > 0 && maxStoreySpan < COMPOSITION_BOUNDS.minStoreySpan) {
		// The fault has to carry its own guard. Asked for the order on its own, the model
		// bought it by stripping openings until the elevation was a blank wall, which is a
		// worse answer than the lockstep. Naming the count it must not lose stops the trade.
		note("STOREY_LOCKSTEP", `nothing crosses a floor - the tallest opening or pier reaches through ${maxStoreySpan} storey of ${context.storeys.length}, so the facade is one floor drawn ${context.storeys.length} times; carry a pier or a glazed slot through two or three storeys in one or two bays, and keep all ${openingAreas.length} openings while doing it - removing openings to make room for the order fails the opening ratio instead`);
	}

	return {
		metrics: {
			opening_ratio_by_view: openingRatios,
			worst_opening_ratio: Number(worstRatio.toFixed(6)),
			ground_transparency_by_view: groundRatios,
			worst_ground_transparency: Object.values(groundRatios).length ? Number(Math.min(...Object.values(groundRatios)).toFixed(6)) : 0,
			opening_count: openingAreas.length,
			largest_opening_m2: Number(largest.toFixed(6)),
			median_opening_m2: Number(middle.toFixed(6)),
			scale_ratio: scaleRatio,
			levels_of_scale: levels,
			max_storey_span: maxStoreySpan,
			face_profiles: { front: frontProfile, back: backProfile },
			has_top_termination: hasTermination,
			terminated_views: [...terminatedViews].sort(),
			top_storey: topStorey?.storey ?? null,
		},
		codes,
		faults,
	};
}
