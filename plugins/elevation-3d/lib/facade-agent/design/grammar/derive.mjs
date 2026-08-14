import { TERMINAL_KINDS } from "../../facade-vocabulary.mjs";
import { BOUNDS, FacadeGrammarError, predicateHolds } from "./contract.mjs";

const MAX_PRIMITIVES = 2048;

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
function layout(parts, length) {
	let fixed = 0;
	for (const part of parts) {
		if (part.size.kind === "absolute") fixed += part.size.value;
		else if (part.size.kind === "relative") fixed += part.size.value * length;
	}
	const leftover = length - fixed;
	if (leftover < -1e-9) return null;
	const repeat = parts.find((part) => part.repeat);
	const slots = [];
	if (repeat) {
		const count = Math.max(1, Math.min(BOUNDS.maxRepeat, Math.round(leftover / repeat.size.value)));
		if (leftover / count <= 1e-6) return null;
		for (const part of parts) {
			if (!part.repeat) {
				slots.push({ part, size: part.size.kind === "relative" ? part.size.value * length : part.size.value, index: 0, total: 1 });
				continue;
			}
			for (let index = 0; index < count; index += 1) slots.push({ part, size: leftover / count, index, total: count });
		}
		return slots;
	}
	const weight = parts.filter((part) => part.size.kind === "float").reduce((sum, part) => sum + part.size.value, 0);
	if (weight > 0 && leftover <= 1e-9) return null;
	for (const part of parts) {
		const size = part.size.kind === "absolute" ? part.size.value
			: part.size.kind === "relative" ? part.size.value * length
				: (leftover * part.size.value) / weight;
		slots.push({ part, size, index: 0, total: 1 });
	}
	return slots;
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
			primitives.push({
				kind,
				segment_id: segment.segment_id,
				local_bounds: { u_min: round(uMin), u_max: round(uMax), z_min: round(zMin), z_max: round(zMax) },
				depth_m: kind === "door" && entrance ? entrance.recess_m : alternative.depth_m,
				family_id: familyId(symbol, scope.param),
				storey: storeyOf(zMin),
				...(kind === "door" ? { role: "primary_entrance" } : {}),
			});
			return;
		}
		const { axis, parts } = alternative.split;
		const along = axis === "u" ? scope.u_max - scope.u_min : scope.z_max - scope.z_min;
		const slots = layout(parts, along);
		if (!slots) return;
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

	walk(grammar.start, {
		u_min: segment.placeable?.u_min ?? 0,
		u_max: segment.placeable?.u_max ?? segment.length_m,
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
		storey: storeys[0]?.storey ?? 1,
		depth: 0,
	});
	return primitives;
}
