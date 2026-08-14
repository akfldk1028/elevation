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

export const TERMINALS = Object.freeze(["wall", "glass", "door", "band", "reveal", "pilaster"]);
export const AXES = Object.freeze(["u", "z"]);
export const BOUNDS = Object.freeze({
	// Derivation is bounded by depth and repeat, not by how many names the grammar
	// uses. A facade that varies by elevation, by parity and by zone needs the room.
	maxSymbols: 64,
	maxAlternatives: 8,
	maxParts: 16,
	maxDepth: 8,
	maxRepeat: 64,
	maxInsetM: 0.5,
	maxDepthM: 0.5,
});

const SYMBOL = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const VIEWS = new Set(["front", "back", "left", "right"]);

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
		return fail(`${label} is not a supported comparison: ${term}`);
	});
	if (!terms.length) fail(`${label} is empty`);
	return Object.freeze(terms.map(Object.freeze));
}

function parsePart(value, label, symbols) {
	const part = record(value, label, new Set(["size", "symbol", "repeat"]));
	if (typeof part.symbol !== "string" || !SYMBOL.test(part.symbol)) fail(`${label}.symbol is not a symbol name`);
	symbols.add(part.symbol);
	if (part.repeat !== undefined && part.repeat !== null && typeof part.repeat !== "boolean") fail(`${label}.repeat must be a boolean`);
	return Object.freeze({
		size: parseSize(part.size, `${label}.size`),
		symbol: part.symbol,
		repeat: part.repeat === true,
	});
}

function parseAlternative(value, label, symbols) {
	const alternative = record(value, label, new Set(["when", "split", "terminal", "inset_m", "depth_m"]));
	const when = alternative.when === undefined || alternative.when === null ? null : parsePredicate(alternative.when, `${label}.when`);
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
		return Object.freeze({ when, terminal: alternative.terminal, inset_m: inset, depth_m: depth });
	}
	// Strict structured output forces both fields onto a split too, where zero is the
	// only sensible answer. Only a real offset here means the model confused the two.
	if ((alternative.inset_m ?? 0) !== 0 || (alternative.depth_m ?? 0) !== 0) fail(`${label}.inset_m and depth_m belong to a terminal`);
	if ((alternative.split ?? null) === null) fail(`${label} is neither a split nor a terminal`);
	const split = record(alternative.split, `${label}.split`, new Set(["axis", "parts"]));
	if (!AXES.includes(split.axis)) fail(`${label}.split.axis must be u or z`);
	const parts = list(split.parts, `${label}.split.parts`, 1, BOUNDS.maxParts)
		.map((part, index) => parsePart(part, `${label}.split.parts[${index}]`, symbols));
	const repeats = parts.filter((part) => part.repeat);
	if (repeats.length > 1) fail(`${label}.split holds more than one repeat part`);
	if (repeats.length && repeats[0].size.kind !== "float") fail(`${label}.split repeat part needs a floating size`);
	if (repeats.length && parts.some((part) => !part.repeat && part.size.kind === "float")) {
		fail(`${label}.split mixes a repeat part with other floating parts`);
	}
	return Object.freeze({ when, split: Object.freeze({ axis: split.axis, parts: Object.freeze(parts) }) });
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
			: term.field === "storey" ? scope.storey : scope.index;
		if (term.value === "last") return actual === scope.total - 1;
		if (term.modulus) return Number.isInteger(actual) && actual % term.modulus === term.value;
		return actual === term.value;
	});
}
