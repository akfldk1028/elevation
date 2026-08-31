import { TERMINAL_WORDS } from "../../facade-vocabulary.mjs";

export class FacadeGrammarError extends Error {
	constructor(message) {
		super(message);
		this.name = "FacadeGrammarError";
		this.code = "FACADE_GRAMMAR_INVALID";
	}
}

function fail(message) {
	throw new FacadeGrammarError(message);
}

export const TERMINALS = TERMINAL_WORDS;
// `storey` is not a direction, it is a datum. A split on it is cut by the slab lines that
// cross the scope rather than by sizes the author wrote, which is Muller's snap-line repeat
// ("the snap lines divide the scope into different parts and the repeat rule is invoked for
// each part separately", Procedural Modeling of Buildings, SIGGRAPH 2006 3.3). It exists
// because every author so far has had to compute slab-relative z by hand, per facet, over
// 37 facets whose bottoms sit at arbitrary heights - the arithmetic CGA does not have,
// because `comp(f)` hands each facet a frame of its own and floors are addressed by ordinal.
export const AXES = Object.freeze(["u", "z", "storey"]);
/**
 * The datums a member may be carried up to, past the top of its own facet.
 *
 * This is a deliberate loosening of the geometry lock and the only one: everywhere else a
 * primitive lives strictly inside its facet. It exists because the top edge of every
 * elevation this project has drawn is the mass's own stepped edge - a member is clamped to
 * its facet in `derive.mjs` and rejected outright by SEGMENT_BOUNDS_INVALID if it reaches
 * higher - so the one move real architecture uses to settle a stepped mass, a parapet run
 * level across the steps, could not be said at all.
 *
 * It is a datum and not a number on purpose. The author names the line; the engine knows
 * where it is. An arbitrary rise would be new massing authored by the facade, which is the
 * other agent's work and is not what this opens.
 */
export const RISE_DATUMS = Object.freeze(["building_top"]);
/** Terminals that cut a hole. None of them may be carried past the facet it belongs to. */
const OPENING_TERMINALS = new Set(["glass", "door", "arch"]);
export const BOUNDS = Object.freeze({
	// Derivation is bounded by depth and repeat, not by how many names the grammar
	// uses. A facade that varies by elevation, by parity and by zone needs the room.
	maxSymbols: 64,
	maxAlternatives: 8,
	maxParts: 16,
	// 12, because 8 rejected a design the brief itself asks for: per-facet routing, a
	// tripartite section, a bay, and the four-way opening nest is ten levels, and a blind
	// author lost an attempt to the ceiling before anything else could be measured. The
	// bound guards runaway recursion, not taste; 12 still does.
	maxDepth: 12,
	maxRepeat: 64,
	maxInsetM: 0.5,
	maxDepthM: 0.5,
	// The same ceiling `parseSize` puts on an absolute size: a guard is a size too, and one
	// larger than any scope could be would silently disable its alternative forever.
	maxSizeM: 1000,
});

const SYMBOL = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const VIEWS = new Set(["front", "back", "left", "right"]);

/**
 * CGA's `Floor(i)`: every symbol takes at most one argument, always named `param`.
 *
 * An argument is a *value*, never an expression. It is one of these words or a small
 * integer, and that is the whole language - there is no operator to combine two of
 * them, no way to compute one from the scope, and no way to name anything outside this
 * list. So a parameter can only ever choose an alternative; it can never say what to
 * do. The words mean nothing to the derivation, which compares tokens and no more:
 * only a rule's own `when` gives `top` or `wide` any architectural sense.
 *
 * Without this a variation costs a whole new rule name, and the run that drove this
 * change needed 54 of them to say what a dozen parameterised rules say.
 */
export const PARAM_WORDS = Object.freeze([
	"base", "shaft", "top", "wide", "narrow", "tall",
	"short", "open", "solid", "corner", "center", "service",
]);
export const MAX_PARAM_INDEX = 15;
/** Every literal an argument may carry, as strings, which is the shape a strict enum needs. */
export const PARAM_VALUES = Object.freeze([
	...Array.from({ length: MAX_PARAM_INDEX + 1 }, (_, index) => String(index)),
	...PARAM_WORDS,
]);
const PARAM_SET = new Set(PARAM_VALUES);

/** Normalise one argument literal to the type `predicateHolds` will compare it with. */
function parseParamValue(text, label) {
	if (!PARAM_SET.has(text)) fail(`${label} is not a supported symbol argument: ${text}`);
	return /^\d+$/.test(text) ? Number(text) : text;
}

function record(value, label, allowed) {
	if (!value || typeof value !== "object" || Array.isArray(value)
		|| Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain object`);
	for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label} has an unsupported field ${key}`);
	return value;
}

function list(value, label, minimum, maximum) {
	if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
		fail(`${label} must hold between ${minimum} and ${maximum} entries`);
	}
	return value;
}

/**
 * One of the three CGA size forms, kept as a tagged value.
 *
 *   "2.4"   absolute metres
 *   "'0.5"  fraction of the scope along the split axis
 *   "~1"    floating; leftover space is shared between floating parts by weight
 */
function parseSize(value, label) {
	if (typeof value !== "string" || !value.length) fail(`${label} must be a size string`);
	const kind = value[0] === "~" ? "float" : value[0] === "'" ? "relative" : "absolute";
	const number = Number(kind === "absolute" ? value : value.slice(1));
	if (!Number.isFinite(number) || number <= 0 || number > 1000) fail(`${label} is not a positive finite size`);
	if (kind === "relative" && number > 1) fail(`${label} relative size cannot exceed the scope`);
	return Object.freeze({ kind, value: number });
}

/**
 * `when` is a closed predicate set, parsed into a comparison rather than evaluated.
 * Nothing here can reach the host: no expressions, no identifiers beyond the four
 * scope fields, no arithmetic other than a modulus against a literal.
 */
function parsePredicate(text, label) {
	const [left, right, ...rest] = String(text).split("&&").map((part) => part.trim());
	if (rest.length) fail(`${label} joins more than two comparisons`);
	const terms = [left, right].filter(Boolean).map((term) => {
		let match = /^(index|storey)\s*%\s*(\d+)\s*==\s*(\d+)$/.exec(term);
		if (match) {
			const modulus = Number(match[2]);
			if (modulus < 2 || modulus > 32) fail(`${label} modulus is out of range`);
			return { field: match[1], modulus, value: Number(match[3]) };
		}
		match = /^(index|storey)\s*==\s*(\d+)$/.exec(term);
		if (match) return { field: match[1], value: Number(match[2]) };
		match = /^(index|storey)\s*==\s*(last|top)$/.exec(term);
		if (match) return { field: match[1], value: match[2] === "last" ? "last" : "last" };
		match = /^face_view\s*==\s*(front|back|left|right)$/.exec(term);
		if (match) return { field: "face_view", value: match[1] };
		// A rule reads its own argument the same way it reads the scope: as a comparison
		// against a literal drawn from the closed set. There is deliberately no
		// `param % n`, no `param > n` and no term with `param` on both sides, because
		// each of those would be the first step towards evaluating rather than matching.
		match = /^param\s*==\s*([a-z0-9]+)$/.exec(term);
		if (match) return { field: "param", value: parseParamValue(match[1], `${label} param comparison`) };
		return fail(`${label} is not a supported comparison: ${term}`);
	});
	if (!terms.length) fail(`${label} is empty`);
	return Object.freeze(terms.map(Object.freeze));
}

function parsePart(value, label, symbols) {
	const part = record(value, label, new Set(["size", "symbol", "arg", "repeat"]));
	if (typeof part.symbol !== "string" || !SYMBOL.test(part.symbol)) fail(`${label}.symbol is not a symbol name`);
	symbols.add(part.symbol);
	if (part.repeat !== undefined && part.repeat !== null && typeof part.repeat !== "boolean") fail(`${label}.repeat must be a boolean`);
	// The argument is written by the author as a constant, so an unknown or out of range
	// one is caught here rather than degrading to a branch that quietly never fires.
	// A number is accepted alongside its string because both normalise to the same value.
	const arg = (part.arg ?? null) === null
		? null
		: parseParamValue(typeof part.arg === "number" ? String(part.arg) : part.arg, `${label}.arg`);
	return Object.freeze({
		size: parseSize(part.size, `${label}.size`),
		symbol: part.symbol,
		arg,
		repeat: part.repeat === true,
	});
}

/**
 * The scope sizes an alternative is willing to be applied to.
 *
 * Wonka et al., Instant Architecture (SIGGRAPH 2003) 5.2: a rule declares the dimensional
 * interval it is valid for, the engine computes the shape's dimensions, and "rule 5 is
 * excluded because it requires a width larger than the shape associated with the symbol
 * provides". The rule is not repaired or shrunk - it is simply not selected.
 *
 * This grammar had no way to say it. Its predicates read `index`, `storey`, `face_view` and
 * `param`, none of which is a size, so an author facing a mass with centimetre slivers had
 * to enumerate them by index at the start rule - and `index` is readable only there, under a
 * cap of eight alternatives. Two authors reported that cap as the thing that decided their
 * design, and a third spent an attempt on a facet 32 mm tall. A guard says it once.
 */
function parseGuard(alternative, label) {
	const guard = {};
	for (const [key, axis] of [["min_u_m", "u"], ["min_z_m", "z"]]) {
		const value = alternative[key] ?? null;
		if (value === null) continue;
		if (!Number.isFinite(value) || value < 0 || value > BOUNDS.maxSizeM) fail(`${label}.${key} is out of range`);
		guard[axis] = value;
	}
	return Object.keys(guard).length ? Object.freeze(guard) : null;
}

function parseAlternative(value, label, symbols) {
	const alternative = record(value, label, new Set(["when", "split", "terminal", "inset_m", "depth_m", "min_u_m", "min_z_m", "rise_to"]));
	const when = alternative.when === undefined || alternative.when === null ? null : parsePredicate(alternative.when, `${label}.when`);
	const guard = parseGuard(alternative, label);
	if (alternative.terminal !== undefined && alternative.terminal !== null) {
		// Strict structured output requires every property to be present, so the unused
		// half of an alternative arrives as null rather than missing. Absent means
		// either, or the parser rejects every answer a strict provider can give.
		if ((alternative.split ?? null) !== null) fail(`${label} is both a split and a terminal`);
		if (!TERMINALS.includes(alternative.terminal)) fail(`${label}.terminal is not a supported terminal`);
		const inset = alternative.inset_m ?? 0;
		if (!Number.isFinite(inset) || inset < 0 || inset > BOUNDS.maxInsetM) fail(`${label}.inset_m is out of range`);
		const depth = alternative.depth_m ?? 0;
		if (!Number.isFinite(depth) || depth < 0 || depth > BOUNDS.maxDepthM) fail(`${label}.depth_m is out of range`);
		const riseTo = alternative.rise_to ?? null;
		// Only a solid may be carried past its facet. A hole above the mass is a hole in
		// nothing, and glass there would be a window onto the sky - the loosening is for a
		// parapet, not for openings that escape the buildability gates by leaving the facet.
		if (riseTo !== null) {
			if (!RISE_DATUMS.includes(riseTo)) fail(`${label}.rise_to must be one of ${RISE_DATUMS.join(", ")}`);
			if (OPENING_TERMINALS.has(alternative.terminal)) fail(`${label}.rise_to cannot carry a ${alternative.terminal} past its facet`);
		}
		return Object.freeze({ when, guard, terminal: alternative.terminal, inset_m: inset, depth_m: depth, rise_to: riseTo });
	}
	// Strict structured output forces both fields onto a split too, where zero is the
	// only sensible answer. Only a real offset here means the model confused the two.
	if ((alternative.inset_m ?? 0) !== 0 || (alternative.depth_m ?? 0) !== 0) fail(`${label}.inset_m and depth_m belong to a terminal`);
	if ((alternative.split ?? null) === null) fail(`${label} is neither a split nor a terminal`);
	const split = record(alternative.split, `${label}.split`, new Set(["axis", "parts"]));
	if (!AXES.includes(split.axis)) fail(`${label}.split.axis must be u, z or storey`);
	const parts = list(split.parts, `${label}.split.parts`, 1, BOUNDS.maxParts)
		.map((part, index) => parsePart(part, `${label}.split.parts[${index}]`, symbols));
	// A storey split carries no sizes of its own: the slab lines decide where the cuts fall,
	// so there is exactly one part and it is invoked once per storey the scope crosses. A
	// size written here would be a number the engine is about to ignore, which is worse than
	// a rejection - the author would believe it.
	if (split.axis === "storey") {
		if (parts.length !== 1) fail(`${label}.split on storey takes exactly one part; the slab lines decide the cuts and that part is invoked once per storey the scope crosses`);
		if (parts[0].repeat) fail(`${label}.split on storey is already a repeat over the storeys, so its part cannot carry one`);
	}
	const repeats = parts.filter((part) => part.repeat);
	if (repeats.length > 1) fail(`${label}.split holds more than one repeat part`);
	if (repeats.length && repeats[0].size.kind !== "float") fail(`${label}.split repeat part needs a floating size`);
	if (repeats.length && parts.some((part) => !part.repeat && part.size.kind === "float")) {
		fail(`${label}.split mixes a repeat part with other floating parts`);
	}
	return Object.freeze({ when, guard, split: Object.freeze({ axis: split.axis, parts: Object.freeze(parts) }) });
}

export function parseFacadeGrammar(input) {
	const program = record(input, "facade grammar", new Set(["schema_version", "concept_id", "start", "rules", "design_rationale"]));
	if (program.schema_version !== "arr.elevation3d.facade-grammar.v3") fail("schema_version is unsupported");
	if (typeof program.concept_id !== "string" || !ID.test(program.concept_id)) fail("concept_id is not a safe identifier");
	if (typeof program.start !== "string" || !SYMBOL.test(program.start)) fail("start is not a symbol name");
	// A provider that enforces strict structured output cannot describe an open map,
	// so a grammar may arrive as a list of named rules. Both shapes mean the same graph.
	const rules = Array.isArray(program.rules)
		? Object.fromEntries(list(program.rules, "rules", 1, BOUNDS.maxSymbols).map((entry, index) => {
			const named = record(entry, `rules[${index}]`, new Set(["name", "alternatives"]));
			if (typeof named.name !== "string" || !SYMBOL.test(named.name)) fail(`rules[${index}].name is not a symbol`);
			return [named.name, named.alternatives];
		}))
		: record(program.rules, "rules", new Set(Object.keys(program.rules ?? {})));
	const names = Object.keys(rules);
	if (!names.length || names.length > BOUNDS.maxSymbols) fail(`rules must define between one and ${BOUNDS.maxSymbols} symbols`);
	const referenced = new Set();
	const parsed = {};
	for (const name of names) {
		if (!SYMBOL.test(name)) fail(`rule name ${name} is not a symbol`);
		parsed[name] = Object.freeze(
			list(rules[name], `rules.${name}`, 1, BOUNDS.maxAlternatives)
				.map((alternative, index) => parseAlternative(alternative, `rules.${name}[${index}]`, referenced)),
		);
	}
	if (!parsed[program.start]) fail("start does not name a defined rule");
	// Name every hole at once. Reporting only the first makes a graph missing eight
	// rules look like a single slip, and the correction loop never sees the real gap.
	const dangling = [...referenced].filter((symbol) => !parsed[symbol]);
	if (dangling.length) fail(`these symbols are referenced but never defined: ${dangling.join(", ")}`);
	const rationale = program.design_rationale === undefined
		? []
		: list(program.design_rationale, "design_rationale", 0, 16).map((line, index) => {
			if (typeof line !== "string" || !line.trim() || line.length > 512) fail(`design_rationale[${index}] is invalid`);
			return line;
		});
	return Object.freeze({
		schema_version: program.schema_version,
		concept_id: program.concept_id,
		start: program.start,
		rules: Object.freeze(parsed),
		design_rationale: Object.freeze(rationale),
	});
}

export function predicateHolds(predicate, scope) {
	if (!predicate) return true;
	return predicate.every((term) => {
		const actual = term.field === "face_view" ? scope.face_view
			: term.field === "param" ? scope.param ?? null
				: term.field === "storey" ? scope.storey : scope.index;
		if (term.value === "last") return actual === scope.total - 1;
		if (term.modulus) return Number.isInteger(actual) && actual % term.modulus === term.value;
		return actual === term.value;
	});
}
