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

function chooseAlternative(alternatives, scope) {
	for (const alternative of alternatives) if (predicateHolds(alternative.when, scope)) return alternative;
	return null;
}

/**
 * Derive a grammar against one segment scope and emit typed facade primitives.
 *
 * The primitives are the same shape `buildTypedFacadeDetails` already consumes, so
 * compilation, mass backing, rendering and scoring are untouched: v3 changes what the
 * model can say, not what the pipeline trusts.
 */
export function deriveFacadePrimitives({ grammar, segment, storeys, entrance = null } = {}) {
	if (!grammar?.rules || !segment) fail("a parsed grammar and a segment scope are required");
	const primitives = [];
	const storeyOf = (zMin) => storeys.find((storey) => zMin >= storey.z_min - 1e-6 && zMin < storey.z_max - 1e-6)?.storey ?? null;

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
					z_min: Math.max(segment.local_z?.[0] ?? -Infinity, round(zMin)),
					z_max: Math.min(segment.local_z?.[1] ?? Infinity, round(zMax)),
				},
				depth_m: kind === "door" && entrance ? entrance.recess_m : alternative.depth_m,
				family_id: familyId(symbol, scope.param),
				storey: storeyOf(zMin),
				...(kind === "door" ? { role: "primary_entrance" } : {}),
			});
			return;
		}
		const { axis, parts } = alternative.split;
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
