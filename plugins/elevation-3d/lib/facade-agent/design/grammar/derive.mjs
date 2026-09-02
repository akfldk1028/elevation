import { TERMINAL_KINDS } from "../../facade-vocabulary.mjs";
import { BOUNDS, FacadeGrammarError, predicateHolds } from "./contract.mjs";

const MAX_PRIMITIVES = 2048;

/** Below this, shrinking a split to fit would leave members the author would not recognise. */
const MIN_SHRINK_SCALE = 0.25;

/**
 * The members of a glazed skin, which are allowed to reach the corner.
 *
 * `fold_clearance_m` keeps an *opening* off the fold, because a hole cut through a turn
 * breaks the mass, and only `door` and `window` are ever checked against it. But the
 * clearance is applied by insetting the whole derivation scope, so it confined the framing
 * too - a skin stopped 0.3 m short of the corner it exists to turn, 27% of the width on a
 * 2.2 m facet, and never raised a fault to say so.
 *
 * Widening the root scope is not available: every size fraction in every authored grammar
 * is a fraction *of that scope*, so all ten grammars written against it fail the moment it
 * moves. Instead a skin member that has already run to the edge of its scope is carried the
 * rest of the way to the facet edge. A grammar that writes no skin words derives exactly
 * what it derived before, to the last decimal.
 */
export const SKIN_KINDS = new Set(["mullion", "transom", "spandrel"]);

function fail(message) {
	throw new FacadeGrammarError(message);
}

function round(value) {
	return Number(value.toFixed(8));
}

/**
 * Two calls of one parameterised rule are two families, not one.
 *
 * Scoring counts distinct window families, so folding `Opening(wide)` and
 * `Opening(narrow)` into a single `opening` would score a parameterised grammar below
 * the duplicated rules it replaces - which is exactly the habit parameters remove.
 */
function familyId(symbol, param) {
	return param === null || param === undefined ? symbol.toLowerCase() : `${symbol.toLowerCase()}_${param}`;
}

/**
 * Lay one split out along an axis.
 *
 * Absolute and relative parts take their size first; whatever is left goes to the
 * floating parts by weight, or to the single repeat part, which tiles it as many
 * times as its nominal size fits. That is CGA's `~` and `*`, and it is why a rule
 * written once adapts to a 2.2 m facet and a 12 m one alike.
 */
function layout(parts, length, mayShrink = true) {
	let fixed = 0;
	for (const part of parts) {
		if (part.size.kind === "absolute") fixed += part.size.value;
		else if (part.size.kind === "relative") fixed += part.size.value * length;
	}
	const leftover = length - fixed;
	// Fixed parts that do not fit are shrunk to fit rather than thrown away, which is what
	// every author has assumed and what every layout engine does. Seven live runs died here
	// and each brief sentence only moved the failure: first to the facet width, then to a
	// leaf scope of a few centimetres, because a fractional nest can produce a scope no
	// absolute member was written for. Nothing that resolves today changes - a grammar with
	// room to spare never reaches this branch - so the shrink can only turn a hard failure
	// into a drawing. The scale is reported on the resolution, and a member squeezed below
	// a millimetre emits nothing rather than a sliver.
	if (leftover < -1e-9 && mayShrink) {
		// A scope with no room at all is not a squeeze, it is a facet the fold clearance has
		// eaten - `placeable` inverts on anything narrower than twice the clearance - and the
		// resolver already answers that with bare wall. Shrinking into it produced negative
		// scales and primitives with impossible bounds, which is how this guard was found.
		if (length <= 1e-9 || fixed <= 1e-9) return { overrun: fixed - length, fixed };
		const scale = length / fixed;
		// A squeeze is not a collapse. Measured on the schemes that reach this branch, the two
		// populations are far apart: the live runs' real overruns sit at 0.37, 0.61 and 0.93 of
		// what the author wrote, while a scope the fractional nest has cut to 3.7 mm or 30 mm
		// wants 0.006 and 0.126 - members squeezed past recognition. Below a quarter the thing
		// the author wrote no longer exists, so that stays a failure the resolver answers with
		// bare wall, which is what it already did before shrinking existed.
		if (scale < MIN_SHRINK_SCALE) return { overrun: fixed - length, fixed };

		const shrunk = parts.map((part) => ({
			...part,
			size: part.size.kind === "float"
				? part.size
				: { ...part.size, kind: "absolute", value: (part.size.kind === "relative" ? part.size.value * length : part.size.value) * scale },
		}));
		const slots = shrunk.map((part) => ({ part, size: part.size.kind === "float" ? 0 : part.size.value, index: 0, total: 1 }))
			.filter((slot) => slot.size > 1e-3);
		if (!slots.length) return { overrun: fixed - length, fixed };
		return { slots, shrunkBy: Number(scale.toFixed(6)) };
	}
	if (leftover < -1e-9) return { overrun: fixed - length, fixed };
	const repeat = parts.find((part) => part.repeat);
	const slots = [];
	if (repeat) {
		const count = Math.max(1, Math.min(BOUNDS.maxRepeat, Math.round(leftover / repeat.size.value)));
		if (leftover / count <= 1e-6) return { overrun: 0, fixed, starved: true };
		for (const part of parts) {
			if (!part.repeat) {
				slots.push({ part, size: part.size.kind === "relative" ? part.size.value * length : part.size.value, index: 0, total: 1 });
				continue;
			}
			for (let index = 0; index < count; index += 1) slots.push({ part, size: leftover / count, index, total: count });
		}
		return { slots };
	}
	const weight = parts.filter((part) => part.size.kind === "float").reduce((sum, part) => sum + part.size.value, 0);
	if (weight > 0 && leftover <= 1e-9) return { overrun: 0, fixed, starved: true };
	for (const part of parts) {
		const size = part.size.kind === "absolute" ? part.size.value
			: part.size.kind === "relative" ? part.size.value * length
				: (leftover * part.size.value) / weight;
		slots.push({ part, size, index: 0, total: 1 });
	}
	return { slots };
}

/**
 * Instant Architecture 5.2: an alternative that declares a size it needs is not selected on
 * a scope smaller than that. It is a dispatch decision, not a fault - the next alternative
 * gets its turn, and a rule whose last alternative is bare wall simply leaves the sliver bare.
 *
 * Before this the only way to keep a rule off a 32 mm facet was to name that facet by
 * `index` at the start rule, the one place `index` is readable, under a cap of eight
 * alternatives. Seven degenerate facets therefore ate six of the eight slots on this
 * candidate and two authors reported the cap as the thing that decided their design.
 */
function fitsGuard(guard, scope) {
	if (!guard) return true;
	if (guard.u !== undefined && scope.u_max - scope.u_min < guard.u - 1e-9) return false;
	if (guard.z !== undefined && scope.z_max - scope.z_min < guard.z - 1e-9) return false;
	return true;
}

function chooseAlternative(alternatives, scope) {
	for (const alternative of alternatives) {
		if (predicateHolds(alternative.when, scope) && fitsGuard(alternative.guard, scope)) return alternative;
	}
	return null;
}

/**
 * Derive a grammar against one segment scope and emit typed facade primitives.
 *
 * The primitives are the same shape `buildTypedFacadeDetails` already consumes, so
 * compilation, mass backing, rendering and scoring are untouched: v3 changes what the
 * model can say, not what the pipeline trusts.
 */
export function deriveFacadePrimitives({ grammar, segment, storeys, entrance = null, buildingUnderside = null } = {}) {
	if (!grammar?.rules || !segment) fail("a parsed grammar and a segment scope are required");
	const primitives = [];
	const storeyOf = (zMin) => storeys.find((storey) => zMin >= storey.z_min - 1e-6 && zMin < storey.z_max - 1e-6)?.storey ?? null;
	// The building's own top line, which is the storey table's and not any one facet's.
	// Rounded like every other emitted coordinate: three storeys of 3.3 sum to
	// 9.899999999999999, and an unrounded datum emitted beside rounded members is the
	// quantise-then-compare-exact fault this project has now made five times - here it would
	// have had the validator reject its own parapet for being a ten-billionth of a metre
	// above a line the same code drew.
	const buildingTop = round(Math.max(...storeys.map((storey) => storey.z_max)));
	// How far a member may be carried above its own facet to reach that line. A parapet is a
	// wall that settles a step; a wall standing eight metres above the mass is new massing,
	// authored by the facade, on a candidate whose low strips top out at 1.86 m against a
	// 9.9 m building - measured, on the first probe of this feature. One storey is the unit
	// architecture uses for an attic, and it is the tallest one this building has rather than
	// a number chosen here. A facet further below the line than that does not rise at all:
	// a partial rise would only trade one ragged top edge for another.
	const maxRise = Math.max(...storeys.map((storey) => storey.z_max - storey.z_min));
	// The same allowance mirrored downward. An author reading this mass unaided asked for it:
	// a lifted bar steps far more at its base than at its head, and a level bottom edge is what
	// makes it read as a beam rather than as a stack of shelves. The datum is passed in because
	// it is a fact about every facet together, and it is null on a building that sits on the
	// ground - so this cannot be used to fill in under a bridge.
	const underside = Number.isFinite(buildingUnderside) ? round(buildingUnderside) : null;
	const risesTo = (alternative, facetTop) => alternative.rise_to === "building_top"
		&& Number.isFinite(facetTop) && buildingTop - facetTop <= maxRise + 1e-9;
	const dropsTo = (alternative, facetBottom) => alternative.rise_to === "building_underside"
		&& underside !== null && Number.isFinite(facetBottom)
		&& facetBottom - underside > 1e-9 && facetBottom - underside <= maxRise + 1e-9;

	const walk = (symbol, scope) => {
		if (primitives.length > MAX_PRIMITIVES) fail("derived facade primitive budget exceeded");
		if (scope.depth > BOUNDS.maxDepth) fail(`derivation exceeded depth ${BOUNDS.maxDepth} at ${symbol}`);
		const alternatives = grammar.rules[symbol];
		if (!alternatives) fail(`symbol ${symbol} has no rule`);
		const alternative = chooseAlternative(alternatives, scope);
		if (!alternative) return;
		if (alternative.terminal) {
			if (alternative.terminal === "wall") return;
			const inset = alternative.inset_m;
			const uMin = scope.u_min + inset, uMax = scope.u_max - inset;
			const zMin = scope.z_min + inset, zMax = scope.z_max - inset;
			if (uMax - uMin <= 1e-6 || zMax - zMin <= 1e-6) return;
			const kind = TERMINAL_KINDS[alternative.terminal];
			// A skin member flush with the edge of the placeable field is carried out to the
			// facet itself, so the framing runs past the structure and turns the corner the way
			// a curtain wall does. It has to be flush already: a member the grammar deliberately
			// held back stays where it was put.
			const reach = SKIN_KINDS.has(kind) && !inset;
			const uStart = reach && Math.abs(uMin - placeable.u_min) <= 1e-8 ? 0 : uMin;
			const uEnd = reach && Math.abs(uMax - placeable.u_max) <= 1e-8 ? segment.length_m : uMax;
			primitives.push({
				kind,
				segment_id: segment.segment_id,
				// Clamped, because rounding a facet width up puts the member past the segment and
				// the validator reads that as SEGMENT_BOUNDS_INVALID. z gets the same clamp as u:
				// a stepped mass's segments carry unrounded local_z (e.g. 7.284812029999999), so
				// rounding an emitted top to 8 decimals lands a hair past it and the validator has
				// no epsilon - a fault no prism segment could ever produce.
				local_bounds: {
					u_min: Math.max(0, round(uStart)), u_max: Math.min(segment.length_m, round(uEnd)),
					z_min: dropsTo(alternative, segment.local_z?.[0])
						? Math.min(round(zMin), underside)
						: Math.max(segment.local_z?.[0] ?? -Infinity, round(zMin)),
					// The one place a member may leave its facet, and only upwards, and only as
					// far as a datum the engine knows. Everything else here clamps: that clamp is
					// why the top edge of every elevation drawn so far has been the mass's own
					// stepped edge, because a parapet run level across the steps was not sayable.
					z_max: risesTo(alternative, segment.local_z?.[1])
						? Math.max(round(zMax), buildingTop)
						: Math.min(segment.local_z?.[1] ?? Infinity, round(zMax)),
				},
				...(risesTo(alternative, segment.local_z?.[1]) || dropsTo(alternative, segment.local_z?.[0])
					? { rises_to: alternative.rise_to } : {}),
				depth_m: kind === "door" && entrance ? entrance.recess_m : alternative.depth_m,
				// Only when the author named one. Absent leaves the primitive exactly as every
				// grammar written before this field produced it, so the geometry builder's
				// terminal default stays the answer and nothing already drawn moves.
				...(alternative.material ? { material: alternative.material } : {}),
				family_id: familyId(symbol, scope.param),
				storey: storeyOf(zMin),
				...(kind === "door" ? { role: "primary_entrance" } : {}),
			});
			return;
		}
		const { axis, parts } = alternative.split;
		// The slab lines are the cut, not the author's arithmetic. Everything a storey split
		// hands down is bounded by two lines the mass already has, so a member placed inside
		// one cannot straddle a slab however its fractions land, and the author never writes
		// an absolute z. This is the snap-line repeat of Muller 2006 3.3 and the ordinal floor
		// addressing of CGA (`split(y){ ... : Floor(split.index) }`) in one operator: `index`
		// counts the storeys this scope crosses, from the bottom, and `storey` is the number
		// the storey table gives that band.
		if (axis === "storey") {
			const bands = [];
			for (const storey of storeys) {
				const zMin = Math.max(storey.z_min, scope.z_min);
				const zMax = Math.min(storey.z_max, scope.z_max);
				// A band is `full` when the mass gives the whole floor and `cut` when the facet
				// ends inside it. That distinction is the difference between a member measuring
				// from a slab and a member measuring from a step, and it is why every scheme on
				// a stepped mass has drawn the staircase: a head placed a fixed distance below
				// the band top lands at a different absolute height on every facet that stops
				// mid-floor. Two authors asked for exactly this, in the same words.
				// Which edge is the step is the part that matters and the part this used to
				// discard. `cut` alone says a band is not whole; it does not say whether the
				// facet ended at its top or began at its bottom, and those want opposite
				// treatment - a member is absolute when it measures from the slab edge and
				// staircases when it measures from the step. The brief's own advice, "put the
				// member against the edge that IS a slab", was unwritable without this, and
				// three blind authors said so independently, one of them naming these two words.
				const cutBelow = zMin > storey.z_min + 1e-6;
				const cutAbove = zMax < storey.z_max - 1e-6;
				const band = cutBelow && cutAbove ? "cut_both" : cutBelow ? "cut_below" : cutAbove ? "cut_above" : "full";
				if (zMax - zMin > 1e-6) bands.push({ zMin, zMax, storey: storey.storey, band });
			}
			bands.sort((left, right) => left.zMin - right.zMin);
			const [part] = parts;
			bands.forEach((band, index) => {
				walk(part.symbol, {
					...scope,
					z_min: band.zMin, z_max: band.zMax,
					index, total: bands.length, band: band.band,
					param: part.arg, depth: scope.depth + 1, storey: band.storey,
				});
			});
			return;
		}
		const along = axis === "u" ? scope.u_max - scope.u_min : scope.z_max - scope.z_min;
		// An over-subscribed split used to answer null here and the entire subtree vanished with
		// no code, no count and no warning. A repo-blind author lost 60% of an elevation to it and
		// was told only that its opening ratio was low; it cost that author an attempt out of three
		// and it would cost a paid provider the same. Writing parts that do not fit is an authoring
		// error, so it is reported as one - the correction loop hands a PROGRAM_INVALID reason back
		// to the author verbatim.
		// The facet's own split does not shrink. There the author was handed the exact width
		// in `punched_scope_m`, so an overrun is an authoring error with a number attached -
		// and letting it through would hand a punched wall the scope the fold clearance took
		// off it, which is the one thing the inset exists to prevent. Everything below the
		// facet is a scope the author's own fractions produced rather than one they were
		// told, so a squeeze there is layout, not a mistake.
		const laid = layout(parts, along, scope.depth > 0);
		if (!laid.slots) {
			const have = round(along);
			fail(laid.starved
				? `split of ${symbol} on ${axis} leaves nothing for its repeat: its fixed parts already use ${round(laid.fixed)} m of ${have} m`
				: `split of ${symbol} on ${axis} does not fit: its parts need ${round(laid.fixed)} m but the scope is ${have} m,`
					+ ` ${round(laid.overrun)} m too little. On a facet the u scope is the facet width, and the fold clearance`
					+ ` has already been taken off it for a punched wall - do not budget for it twice.`);
		}
		const { slots } = laid;
		let cursor = axis === "u" ? scope.u_min : scope.z_min;
		for (const slot of slots) {
			const next = cursor + slot.size;
			const child = axis === "u"
				? { ...scope, u_min: cursor, u_max: next }
				: { ...scope, z_min: cursor, z_max: next };
			child.index = slot.index;
			child.total = slot.total;
			// The argument binds to the invoked symbol and stops there; it is an argument,
			// not an ambient mode. A part that passes nothing rebinds `param` to null, so a
			// nested reveal cannot silently inherit the `top` its grandparent was given and
			// every `param ==` in a rule answers for the call that rule was made by.
			child.param = slot.part.arg;
			child.depth = scope.depth + 1;
			child.storey = storeyOf(child.z_min) ?? scope.storey;
			cursor = next;
			walk(slot.part.symbol, child);
		}
	};

	const placeable = {
		u_min: segment.placeable?.u_min ?? 0,
		u_max: segment.placeable?.u_max ?? segment.length_m,
	};
	walk(grammar.start, {
		u_min: placeable.u_min,
		u_max: placeable.u_max,
		z_min: segment.local_z[0],
		z_max: segment.local_z[1],
		segment_id: segment.segment_id,
		face_view: segment.face_view ?? segment.view,
		// The root scope is a facet, and it starts life knowing which facet of its
		// elevation it is. Without that a rule can only vary down the building and
		// between elevations, so every bay across one face comes out identical.
		index: segment.face_index ?? 0,
		total: segment.face_total ?? 1,
		// Nothing calls the start symbol, so it is the one rule with no argument to read.
		param: null,
		// The facet's own storey, not the ground one. Hardcoding storey 1 here told every
		// facet of a stepped mass it stood on the ground: a facet spanning 7.26 to 9.9 m
		// answered `storey == 1` and could never answer `storey == 3`, so the natural way
		// to cap the top of the building - route the top facets to a cornice at the start
		// rule - silently produced nothing. Two repo-blind authors reached for exactly that
		// and lost attempts to it, one of them diagnosing it precisely. Children already
		// derive their storey from their own bottom edge; the root now does the same.
		storey: storeyOf(segment.local_z?.[0] ?? storeys[0]?.z_min ?? 0) ?? storeys[0]?.storey ?? 1,
		depth: 0,
	});
	return primitives;
}
