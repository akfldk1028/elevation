import { TERMINAL_KINDS } from "../../facade-vocabulary.mjs";
import { continuationHolding } from "../geometry/continuation.mjs";
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
		// A graded repeat runs its tile size from `from` to `to` across the run; the nominal
		// size is then their mean, and the tiles are scaled together so the run still fills
		// the scope exactly, the way equal tiles always have. The count is the nearest whole
		// number of mean-sized tiles, never zero, capped like any repeat.
		const nominal = repeat.grade ? (repeat.grade.from + repeat.grade.to) / 2 : repeat.size.value;
		const count = Math.max(1, Math.min(BOUNDS.maxRepeat, Math.round(leftover / nominal)));
		if (leftover / count <= 1e-6) return { overrun: 0, fixed, starved: true };
		const tile = (index) => {
			if (!repeat.grade || count === 1) return leftover / count;
			const t = index / (count - 1);
			const raw = repeat.grade.from + (repeat.grade.to - repeat.grade.from) * t;
			// Sum of the linear ramp over the run, so the scale that fills the scope is exact.
			const sum = (count * (repeat.grade.from + repeat.grade.to)) / 2;
			return (raw * leftover) / sum;
		};
		for (const part of parts) {
			if (!part.repeat) {
				slots.push({ part, size: part.size.kind === "relative" ? part.size.value * length : part.size.value, index: 0, total: 1 });
				continue;
			}
			for (let index = 0; index < count; index += 1) slots.push({ part, size: tile(index), index, total: count });
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
/**
 * Where a scope sits in the FIELD, as the 0..1 a grade travels over.
 *
 * The parametric literature is unanimous on the shape of this: measure a scalar at each
 * unit's own position, normalise it over a stated range, remap it onto the parameter. The
 * scalar here is the distance from the member's centre to a declared attractor, in the
 * building's own developed face metres - `face_offset_m` plus the local u, so one field
 * spans every facet instead of restarting at each - and world height for z.
 *
 * Clamped at both ends, so `range_m` reads as "fully `from` this close, fully `to` this far"
 * and a member outside the range takes the nearer endpoint rather than an extrapolation.
 */
function fieldT(grade, scope, fields) {
	const place = fields?.find((entry) => entry.id === grade.field);
	if (!place || !scope.origin_m || !scope.tangent) return 0;
	// The member's own place in the mass's coordinates: its facet's corner, plus its centre
	// along that facet's own direction, at its own height.
	const u = (scope.u_min + scope.u_max) / 2;
	const here = [
		scope.origin_m[0] + scope.tangent[0] * u,
		scope.origin_m[1] + scope.tangent[1] * u,
		(scope.z_min + scope.z_max) / 2,
	];
	const distance = Math.hypot(here[0] - place.at[0], here[1] - place.at[1], here[2] - place.at[2]);
	const [near, far] = grade.range_m;
	return Math.min(1, Math.max(0, (distance - near) / (far - near)));
}

export function deriveFacadePrimitives({ grammar, segment, storeys, entrance = null, buildingUnderside = null, continuations = [], floorBandClearance = 0 } = {}) {
	if (!grammar?.rules || !segment) fail("a parsed grammar and a segment scope are required");
	const primitives = [];
	let layerCount = 0;
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
	// The next slab line strictly above a facet's own top, or null when the facet already ends
	// on one. Only a line the storeys already declare - this invents no datum of its own.
	const storeyLineAbove = (facetTop) => {
		if (!Number.isFinite(facetTop)) return null;
		const lines = storeys.map((storey) => round(storey.z_max)).filter((z) => z > facetTop + 1e-9);
		return lines.length ? Math.min(...lines) : null;
	};
	const risesToStoreyLine = (alternative, facetTop) => {
		if (alternative.rise_to !== "storey_line") return null;
		const line = storeyLineAbove(facetTop);
		return line !== null && line - facetTop <= maxRise + 1e-9 ? line : null;
	};
	const dropsTo = (alternative, facetBottom) => alternative.rise_to === "building_underside"
		&& underside !== null && Number.isFinite(facetBottom)
		&& facetBottom - underside > 1e-9 && facetBottom - underside <= maxRise + 1e-9;
	// An OPENING may take the storey line too, on one condition a solid is not held to: the
	// course above must be the same plane, and wide enough there. `continuations` is that
	// list, computed by the resolver from every facet together (geometry/continuation.mjs);
	// the deriver sees one facet and cannot know it. The head stops short of the line by the
	// floor-band clearance, as every opening head must, so the rise lands where a window may
	// legally end rather than on the slab itself. Nothing here applies to a solid, whose rise
	// is exactly what it was.
	const openingRisesToStoreyLine = (alternative, facetTop, uMin, uMax) => {
		const line = risesToStoreyLine(alternative, facetTop);
		if (line === null) return null;
		const head = round(line - floorBandClearance);
		return continuationHolding(continuations, uMin, uMax, head) && head > facetTop + 1e-9 ? head : null;
	};

	// A SPLIT may take the storey line, and this is how a composite opening - sill, pane, head
	// - crosses the seam as one thing: the scope extends to the line and the split lays itself
	// out over the taller scope, so the head member moves up instead of the pane growing
	// through it. Granted only from the top of the facet, only over a coplanar continuation
	// holding the scope's whole width, and the scope is marked so every member laid out inside
	// carries the datum. A scope with nothing coplanar above it is laid out exactly as before.
	const riseScope = (alternative, scope) => {
		if (alternative.terminal || alternative.rise_to !== "storey_line") return scope;
		const facetTop = segment.local_z?.[1];
		if (!Number.isFinite(facetTop) || Math.abs(scope.z_max - facetTop) > 1e-8) return scope;
		const line = risesToStoreyLine(alternative, facetTop);
		const held = line !== null && continuationHolding(continuations, scope.u_min, scope.u_max, line);
		return held ? { ...scope, z_max: line, risen: true } : scope;
	};

	const walk = (symbol, given) => {
		if (primitives.length > MAX_PRIMITIVES) fail("derived facade primitive budget exceeded");
		if (given.depth > BOUNDS.maxDepth) fail(`derivation exceeded depth ${BOUNDS.maxDepth} at ${symbol}`);
		const alternatives = grammar.rules[symbol];
		if (!alternatives) fail(`symbol ${symbol} has no rule`);
		const alternative = chooseAlternative(alternatives, given);
		if (!alternative) return;
		const scope = riseScope(alternative, given);
		if (alternative.terminal) {
			if (alternative.terminal === "wall") return;
			// A graded attribute interpolates along THE RUN - the nearest enclosing repeat
			// (or the storey stack, or failing both, the face's own facets), whose position
			// travels down the scope as `runT` and survives the member's own fixed split.
			// Without the inheritance a fin inside a [fin, pane] module always read index 0
			// of its two-part split and every instance came out at `from` - measured on the
			// first probe of this operator.
			// A grade naming a field is driven by WHERE the member is, not by how far along
			// its run it fell. That is the whole difference between a gradient and a field.
			const gradeT = !alternative.grade ? 0
				: alternative.grade.field ? fieldT(alternative.grade, scope, grammar.fields)
					: scope.runT ?? 0;
			const graded = (attr, base) => alternative.grade?.attr === attr
				? round(alternative.grade.from + (alternative.grade.to - alternative.grade.from) * gradeT)
				: base;
			const inset = graded("inset_m", alternative.inset_m);
			const uMin = scope.u_min + inset, uMax = scope.u_max - inset;
			const zMin = scope.z_min + inset, zMax = scope.z_max - inset;
			if (uMax - uMin <= 1e-6 || zMax - zMin <= 1e-6) return;
			const kind = TERMINAL_KINDS[alternative.terminal];
			// A skin member flush with the edge of the placeable field is carried out to the
			// facet itself, so the framing runs past the structure and turns the corner the way
			// a curtain wall does. It has to be flush already: a member the grammar deliberately
			// held back stays where it was put. A solid course may ask for the same carry with
			// `reach: "facet_edge"` - the clearance keeps OPENINGS off the fold, and a cornice
			// pausing 0.6 m at every corner was the gap its author named on first use.
			const reach = !inset && (SKIN_KINDS.has(kind) || alternative.reach === "facet_edge");
			const uStart = reach && Math.abs(uMin - placeable.u_min) <= 1e-8 ? 0 : uMin;
			const uEnd = reach && Math.abs(uMax - placeable.u_max) <= 1e-8 ? segment.length_m : uMax;
			const opening = kind === "window" || kind === "door";
			const storeyLine = opening
				? openingRisesToStoreyLine(alternative, segment.local_z?.[1], uStart, uEnd)
				: risesToStoreyLine(alternative, segment.local_z?.[1]);
			// Laid out inside a scope that rose (riseScope above): the member keeps whatever
			// height the split gave it, above the facet if that is where it landed, and says so.
			const inRisenScope = scope.risen === true && round(zMax) > (segment.local_z?.[1] ?? Infinity) + 1e-9;
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
					// building_top wins where both could apply: it is the building's own head, and
					// a member asking for one of the two is asking to stop being ragged.
					z_max: risesTo(alternative, segment.local_z?.[1])
						? Math.max(round(zMax), buildingTop)
						: storeyLine !== null
							? Math.max(round(zMax), storeyLine)
							: inRisenScope
								? round(zMax)
								: Math.min(segment.local_z?.[1] ?? Infinity, round(zMax)),
				},
				...(risesTo(alternative, segment.local_z?.[1]) || dropsTo(alternative, segment.local_z?.[0])
					|| storeyLine !== null
					? { rises_to: alternative.rise_to }
					: inRisenScope ? { rises_to: "storey_line" } : {}),
				depth_m: kind === "door" && entrance ? entrance.recess_m : graded("depth_m", alternative.depth_m),
				// Only when the author named one. Absent leaves the primitive exactly as every
				// grammar written before this field produced it, so the geometry builder's
				// terminal default stays the answer and nothing already drawn moves.
				...(alternative.material ? { material: alternative.material } : {}),
				// Same rule as material: only when the author named one, so a grammar written
				// before diagonals existed emits exactly the record it always did and the
				// geometry builder keeps drawing it as a box.
				...(alternative.diagonal ? { diagonal: alternative.diagonal } : {}),
				// WHICH ELEVATION THIS IS DRAWN IN. Distinct from the `view` the detail builder
				// stamps, which is the dominant axis of the member's own plane - the right
				// answer for the validation that measures along an axis, and the wrong one for
				// a reader asking which sheet to open. The two disagree on an oblique facet,
				// and three times now someone has read `view: front`, opened the front
				// elevation, found no entrance and reported it missing. The door was on the
				// back face every time. Carrying both ends the question.
				...(segment.face_view ? { face_view: segment.face_view } : {}),
				family_id: familyId(symbol, scope.param),
				storey: storeyOf(zMin),
				...(scope.layer ? { layer: scope.layer } : {}),
				...(kind === "door" ? { role: "primary_entrance" } : {}),
			});
			return;
		}
		const { axis, parts } = alternative.split;
		// A layer split hands EVERY part the whole scope: constructions stacked in depth,
		// not regions divided in the plane. Each part gets its own tag so the validator
		// knows the overlap is declared - members within one layer still collide as they
		// always did, and a grammar with no layer splits emits primitives with no tag at
		// all, byte-identical to what it emitted before this axis existed.
		if (axis === "layer") {
			for (const part of parts) {
				layerCount += 1;
				walk(part.symbol, { ...scope, layer: layerCount, param: part.arg, depth: scope.depth + 1 });
			}
			return;
		}
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
					// The storey stack is a run: a graded attribute climbs it floor by floor.
					runT: bands.length > 1 ? index / (bands.length - 1) : scope.runT,
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
			// Only a repeat's instances advance the run; a fixed split (a fin beside its
			// pane) passes the position through unchanged, so a member keeps the place of
			// the module that carries it.
			child.runT = slot.part.repeat && slot.total > 1 ? slot.index / (slot.total - 1) : scope.runT;
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
		// Where this facet begins along its sheet, in metres - the number an author measures
		// off a picture, and what `face_offset < n` compares. Inherited by every child scope.
		face_offset: Number.isFinite(segment.face_offset_m) ? segment.face_offset_m : null,
		// Where the facet IS, and which way its local u runs from there, so a field can be a
		// place in space rather than a position on a sheet. `face_offset` above restarts at 0
		// on every FACE, which is right for the predicate that reads a picture and wrong for a
		// field: one declared place produced four identical ramps on a four-faced mass.
		// Inherited by every child scope, like face_offset.
		origin_m: Array.isArray(segment.origin_m) && segment.origin_m.length === 3 ? segment.origin_m : null,
		tangent: Array.isArray(segment.outward_normal) && Math.hypot(segment.outward_normal[0], segment.outward_normal[1]) > 0
			? (() => {
				const horizontal = Math.hypot(segment.outward_normal[0], segment.outward_normal[1]);
				const unit = Math.abs(horizontal - 1) > 1e-6 ? horizontal : 1;
				return [-segment.outward_normal[1] / unit, segment.outward_normal[0] / unit, 0];
			})()
			: null,
		// With no repeat and no storey stack, the run is the face's own facets.
		runT: (segment.face_total ?? 1) > 1 ? (segment.face_index ?? 0) / ((segment.face_total ?? 1) - 1) : 0,
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
