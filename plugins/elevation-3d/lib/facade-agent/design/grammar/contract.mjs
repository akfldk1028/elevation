import { TERMINAL_MATERIAL_CHOICES, TERMINAL_PROJECTION, TERMINAL_WORDS } from "../../facade-vocabulary.mjs";
import { deriveDeclaredMaterials } from "../../declared-material.mjs";

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
export const AXES = Object.freeze(["u", "z", "storey", "layer"]);
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
 *
 * `building_underside` is the same move downward, and it exists because an author reading
 * this mass unaided asked for it in these words: "this mass steps at the BOTTOM far more
 * than at the top... what the bar wants at its base is what it gets at its head - one
 * continuous line, a level bottom edge carried across the steps so the beam reads as a beam
 * and not as a stack of shelves." The datum is the lowest facet bottom strictly above grade,
 * which on a lifted building is the line it flies at. On a building that sits on the ground
 * there is no such line and the datum does not exist, so the operator is inert - which is
 * correct, and is why it cannot be used to fill in the underside of a bridge down to grade.
 */
/**
 * The lines a solid may be carried up to, past the top of its own facet.
 *
 * `storey_line` is the third and it exists because the mass's own tessellation was setting
 * the design's cadence. On one candidate 94 of 113 facets are exactly 2.062 m tall and
 * stacked in eight courses, while the building it was transcribed from reads as five courses
 * of 3.3 m - so every author drew eight, not by choice but because a member cannot leave its
 * facet and the facet is 2.062 m. Measured on that mass: a member at z 0.20 and one at z 1.90
 * in the same column sit 10 mm apart in plan. The courses are the same wall, cut horizontally
 * by the extractor; the cadence limit was never geometry.
 *
 * This is what CGA calls a snap line and this language had made a boundary: Muller's rule is
 * that "the snap lines divide the scope into different parts and the repeat rule is invoked
 * for each part separately" - divide, not confine. A facet cut is a place a rule may notice,
 * not a wall it cannot cross.
 *
 * Guarded exactly as the other two are, and no further: solids only, so no opening is ever
 * carried through; at most one storey, the same `maxRise` a parapet gets; and inert when the
 * facet already ends on a slab line, so it can only ever close a gap the extractor opened.
 */
export const RISE_DATUMS = Object.freeze(["building_top", "building_underside", "storey_line"]);
export const REACH_EDGES = Object.freeze(["facet_edge"]);
/**
 * Which way a member's rectangle is cut in half.
 *
 * Every primitive in this language was a box, so a facade of triangles - the commonest
 * cladding pattern there is - could not be said at all. A transcribing author reading a
 * diagrid wrote one rectangle per facet and reported the loss plainly: "the photograph's
 * unit is a triangle and the alternation happens ACROSS the diagonal; the diagonal is the
 * building's entire signature." The reader put the concept beside the drawing and said the
 * same thing in fewer words.
 *
 * It is an ATTRIBUTE rather than two new terminals, for the reason `reach` and `grade` are:
 * a new word needs a role, a material and a purpose, and would have forced one answer for
 * all of them. A diagonal on the existing words lets a glazed triangle stay a window and a
 * stone one stay a panel, so material, role and every gate keep working unchanged.
 *
 * Four halves, because a diagonal cuts a rectangle into two and there are two diagonals.
 * `rising` is the half BELOW the diagonal from the bottom-left corner to the top-right and
 * `rising_upper` is the half above it; `falling` is the half below the one from top-left to
 * bottom-right and `falling_upper` the half above. A member and ITS OWN complement tile the
 * scope exactly and share only the cut - `rising` with `rising_upper`, `falling` with
 * `falling_upper`.
 *
 * The complements were missing at first, and the brief claimed instead that `rising` and
 * `falling` tile. They do not: both keep the bottom edge whole, so they overlap over the
 * lower-middle triangle and leave the upper-middle bare. Their areas sum to the rectangle,
 * which is what hid it. The author who followed that sentence drew bowties with a gap at the
 * top of every cell, measured it, and read the geometry to prove it.
 */
export const DIAGONALS = Object.freeze(["rising", "rising_upper", "falling", "falling_upper"]);
/** Terminals that cut a hole. None of them may be carried past the facet it belongs to. */
const OPENING_TERMINALS = new Set(["glass", "door", "arch"]);
export const BOUNDS = Object.freeze({
	// Derivation is bounded by depth and repeat, not by how many names the grammar
	// uses. A facade that varies by elevation, by parity and by zone needs the room.
	maxSymbols: 64,
	// 12, because 8 was a number nobody chose and three authors ran into it at the start
	// rule - the one rule that sees the whole face. On a 32-facet face with a door facet,
	// a coping course, two ranges for one photographed face and three for the other, the
	// eighth slot was spoken for and the two refinements the reviewer still asked for
	// (the inner column's ground pair, the band's eave facet) were each one alternative
	// over. Derivation is bounded by depth and by the primitive budget, not by how many
	// ways one rule may branch; a grammar written under 8 parses exactly as it did.
	maxAlternatives: 12,
	maxParts: 16,
	// 12, because 8 rejected a design the brief itself asks for: per-facet routing, a
	// tripartite section, a bay, and the four-way opening nest is ten levels, and a blind
	// author lost an attempt to the ceiling before anything else could be measured. The
	// bound guards runaway recursion, not taste; 12 still does.
	maxDepth: 12,
	maxRepeat: 64,
	maxInsetM: 0.5,
	// How far a member may be set back INTO the wall. The same number the context has
	// published as `max_recess_m` since before anything could spend it.
	maxRecessM: 0.5,
	// There is deliberately no maxDepthM here any more. How far a member may stand out of
	// the wall is a fact about the member, so it lives beside the member in
	// facade-vocabulary.mjs; a bound in this table would have to be right for a glazing bead
	// and for a cornice at once, and the one that was here was right for neither.
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

// The ids this grammar declares, set for the length of one parse. Parsing is synchronous
// and single-pass, so a module-scoped set is honest here and threading one lookup through
// parseRule and parseAlternative would be noise.
let declaredMaterialIds = new Set();

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
		// A RANGE along the face. Equality and modulus can name one facet or every n-th
		// facet; neither can say "the corner third of this face" - an author transcribing a
		// photograph whose windows stop two-thirds of the way along a 32-facet face had to
		// name the bare facets one by one against an eight-alternative cap, and ran out.
		// `index` counts facets from the face's start; `face_offset` is where the facet begins
		// in metres along the sheet (the `face_offset_m` every facet already reports), which
		// is the number an author measures off a picture. Still a comparison against a
		// literal: no arithmetic, no field on the right-hand side.
		match = /^(index|storey)\s*(<=|>=|<|>)\s*(\d+)$/.exec(term);
		if (match) return { field: match[1], op: match[2], value: Number(match[3]) };
		match = /^face_offset\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)$/.exec(term);
		if (match) return { field: "face_offset", op: match[1], value: Number(match[2]) };
		match = /^(index|storey)\s*==\s*(last|top)$/.exec(term);
		if (match) return { field: match[1], value: match[2] === "last" ? "last" : "last" };
		// Whether a storey band is the whole floor or a slice of one. Every member can only
		// measure from the edges of the scope it is in, and on a stepped mass those edges are
		// the steps - so a head placed "0.28 below the band top" lands at a different absolute
		// height on every facet that ends mid-floor, and the facade draws the staircase instead
		// of the building. Measured on an accepted scheme: seven windows on one face, seven
		// distinct head heights, none shared. Two authors asked for this in the same words -
		// a way to tell a cut edge from a slab. `band == full` is a floor the mass gives whole;
		// `band == cut` is one the facet ends inside, and the honest thing to do with it is
		// usually to leave it plain rather than to article it.
		match = /^band\s*==\s*(full|cut|cut_below|cut_above|cut_both)$/.exec(term);
		if (match) return { field: "band", value: match[1] };
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
	const alternative = record(value, label, new Set(["when", "split", "terminal", "inset_m", "depth_m", "min_u_m", "min_z_m", "rise_to", "reach", "material", "grade", "diagonal"]));
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
		// NEGATIVE IS INWARD. A member's whole relationship to the wall was one unsigned
		// number, so nothing could be set back into it: three authors on three different
		// masses each reported the same thing in their own words - "there is no way to push
		// an opening into the wall", "my reveals stand proud instead of returning in", "the
		// black frame stands proud where the photograph's is set in". They were not asking
		// for three features. `max_recess_m` has been declared in the exclusions all along
		// and nothing could spend it.
		//
		// The bound is still the terminal's on the way out - a single ceiling once let a
		// transom be written half a metre deep and refused a cornice the overhang that makes
		// it one; see the projection table in facade-vocabulary.mjs - and the recess bound on
		// the way in, because how far a thing may be buried is a property of the wall rather
		// than of the thing.
		if (!Number.isFinite(depth) || depth < -BOUNDS.maxRecessM || depth > TERMINAL_PROJECTION[alternative.terminal]) {
				fail(`${label}.depth_m is out of range: a ${alternative.terminal} may stand at most ${TERMINAL_PROJECTION[alternative.terminal]} m out of the wall, or be set back at most ${BOUNDS.maxRecessM} m into it (negative depth is inward)`);
			}
		const riseTo = alternative.rise_to ?? null;
		// Only a solid may be carried past the MASS. A hole above the building's top is a hole
		// in nothing, and glass there would be a window onto the sky - those two datums are for
		// a parapet and a soffit. The storey line is different: a facet ends there because the
		// extractor cut the wall at a floor, and where the course above is the same plane the
		// seam is a line the building does not have. Glass and a door may ask for it; the
		// deriver grants it only over a coplanar continuation wide enough to hold the opening
		// (geometry/continuation.mjs), and over a crease or a corner nothing happens. An arch
		// keeps the old refusal - its geometry is shaped to its own scope.
		if (riseTo !== null) {
			if (!RISE_DATUMS.includes(riseTo)) fail(`${label}.rise_to must be one of ${RISE_DATUMS.join(", ")}`);
			if (OPENING_TERMINALS.has(alternative.terminal) && (riseTo !== "storey_line" || alternative.terminal === "arch")) {
				fail(`${label}.rise_to cannot carry a ${alternative.terminal} past its facet`
					+ (alternative.terminal === "arch" ? "" : ": only storey_line is open to an opening, and only into a coplanar course above"));
			}
		}
		// The sideways twin of rise_to: carry a solid course through the fold clearance to
		// the facet's own edge, so a cornice or a band runs to the corner instead of pausing
		// 0.6 m at every fold. Skin members already do this without asking (derive.mjs); the
		// clearance exists to keep an OPENING off the turn, so openings are refused here for
		// the same reason they are refused a rise.
		const reach = alternative.reach ?? null;
		if (reach !== null) {
			if (!REACH_EDGES.includes(reach)) fail(`${label}.reach must be one of ${REACH_EDGES.join(", ")}`);
			if (OPENING_TERMINALS.has(alternative.terminal)) fail(`${label}.reach cannot carry a ${alternative.terminal} into the fold: the clearance exists to keep an opening off the turn`);
			// wall emits no geometry, so a reach on it would be a request the engine ignores.
			if (alternative.terminal === "wall") fail(`${label}.reach on a wall reaches with nothing: wall emits no geometry`);
		}
		// A parameter that varies along the run instead of repeating one number. This is the
		// field-sampled-attribute idiom the parametric literature converged on (Infinigen's
		// distribution-valued parameters; the panelization practice of attractor fields):
		// the value interpolates linearly from `from` at the first instance of the split
		// this terminal was laid out by to `to` at its last, on the instance's own
		// index/(total-1). One member alone reads `from`. Both endpoints obey exactly the
		// bounds the static field obeys, so nothing a grade can produce is outside what an
		// author could already write by enumerating instances by hand - the operator removes
		// the enumeration, not the bound.
		const grade = alternative.grade === undefined || alternative.grade === null ? null : (() => {
			const fields = record(alternative.grade, `${label}.grade`, new Set(["attr", "from", "to"]));
			const attr = fields.attr;
			if (attr !== "depth_m" && attr !== "inset_m") fail(`${label}.grade.attr must be depth_m or inset_m`);
			for (const key of ["from", "to"]) {
				const bound = attr === "depth_m" ? TERMINAL_PROJECTION[alternative.terminal] : BOUNDS.maxInsetM;
				if (!Number.isFinite(fields[key]) || fields[key] < 0 || fields[key] > bound) {
					fail(`${label}.grade.${key} is out of range: a ${alternative.terminal} ${attr} stays within 0..${bound}`);
				}
			}
			return Object.freeze({ attr, from: fields.from, to: fields.to });
		})();
		// Cut this member's rectangle on a diagonal and keep one half. `wall` emits nothing so
		// there is nothing to cut, and an arch already draws its own curved geometry inside its
		// bounding frame - cutting that frame would leave a half-arch, which is not a thing.
		const diagonal = alternative.diagonal ?? null;
		if (diagonal !== null) {
			if (!DIAGONALS.includes(diagonal)) fail(`${label}.diagonal must be one of ${DIAGONALS.join(", ")}`);
			if (alternative.terminal === "wall") fail(`${label}.diagonal on a wall cuts nothing: wall emits no geometry`);
			if (alternative.terminal === "arch") fail(`${label}.diagonal cannot cut an arch: its rectangle is already the frame its curve is drawn inside`);
		}
		// Absent means "whatever this member is usually made of", which is what every grammar
		// written before this field existed means, so the default has to stay the table's.
		const material = alternative.material ?? null;
		if (material !== null && !TERMINAL_MATERIAL_CHOICES.includes(material) && !declaredMaterialIds.has(material)) {
			fail(`${label}.material must be one of ${TERMINAL_MATERIAL_CHOICES.join(", ")} or a material this grammar declares`);
		}
		return Object.freeze({ when, guard, terminal: alternative.terminal, inset_m: inset, depth_m: depth, rise_to: riseTo, reach, material, grade, diagonal });
	}
	// Strict structured output forces both fields onto a split too, where zero is the
	// only sensible answer. Only a real offset here means the model confused the two.
	if ((alternative.inset_m ?? 0) !== 0 || (alternative.depth_m ?? 0) !== 0) fail(`${label}.inset_m and depth_m belong to a terminal`);
	// A reach or a grade on a split would be a request the engine silently ignores, which is
	// the silent-wrong-answer class this grammar keeps paying for; refuse both loudly.
	// (rise_to and material predate this rule and keep their old tolerance.)
	if ((alternative.reach ?? null) !== null) fail(`${label}.reach belongs to a terminal`);
	if ((alternative.grade ?? null) !== null) fail(`${label}.grade belongs to a terminal`);
	if ((alternative.diagonal ?? null) !== null) fail(`${label}.diagonal belongs to a terminal`);
	if ((alternative.split ?? null) === null) fail(`${label} is neither a split nor a terminal`);
	const split = record(alternative.split, `${label}.split`, new Set(["axis", "parts"]));
	if (!AXES.includes(split.axis)) fail(`${label}.split.axis must be u, z, storey or layer`);
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
	// A layer split does not divide the scope at all: every part receives the WHOLE scope
	// and derives its own construction over it, stacked in depth by the members' own
	// depth_m. This is the operator the vocabulary was missing every time an element was a
	// composition rather than a word - a louvre screen standing in front of glazing, a
	// balcony that is a slab plus a rail over an opening - and every one of those was
	// answered until now by an engineer hand-plumbing a new terminal. Sizes carry no
	// meaning across layers, so only the floating "~" form is accepted; an absolute or
	// fractional size here would be a number the engine ignores, which is the
	// silent-wrong-answer class this grammar keeps paying for.
	if (split.axis === "layer") {
		for (const part of parts) {
			if (part.size.kind !== "float") fail(`${label}.split on layer takes only floating "~" sizes: every layer receives the whole scope, so a sized layer would be a number the engine ignores`);
			if (part.repeat) fail(`${label}.split on layer cannot repeat a layer`);
		}
	}
	const repeats = parts.filter((part) => part.repeat);
	if (repeats.length > 1) fail(`${label}.split holds more than one repeat part`);
	if (repeats.length && repeats[0].size.kind !== "float") fail(`${label}.split repeat part needs a floating size`);
	if (repeats.length && parts.some((part) => !part.repeat && part.size.kind === "float")) {
		fail(`${label}.split mixes a repeat part with other floating parts`);
	}
	// A split may rise to the storey line - that is how a sill, a pane and its head cross the
	// seam between two coplanar courses as ONE opening: the scope extends and the split lays
	// itself out over it (derive.mjs riseScope). A scope may hold openings, so it gets only
	// the datum an opening may have. Until now the field was accepted here and dropped on the
	// floor, the silent-wrong-answer class this grammar keeps paying for.
	const riseTo = alternative.rise_to ?? null;
	if (riseTo !== null && riseTo !== "storey_line") {
		fail(`${label}.rise_to on a split may only be storey_line: a scope may carry openings, and those are not carried past the mass`);
	}
	return Object.freeze({
		when, guard, split: Object.freeze({ axis: split.axis, parts: Object.freeze(parts) }),
		...(riseTo !== null ? { rise_to: riseTo } : {}),
	});
}

export function parseFacadeGrammar(input) {
	const program = record(input, "facade grammar", new Set(["schema_version", "concept_id", "start", "rules", "design_rationale", "materials"]));
	if (program.schema_version !== "arr.elevation3d.facade-grammar.v3") fail("schema_version is unsupported");
	if (typeof program.concept_id !== "string" || !ID.test(program.concept_id)) fail("concept_id is not a safe identifier");
	if (typeof program.start !== "string" || !SYMBOL.test(program.start)) fail("start is not a symbol name");
	// The material list was four words an author could only choose among; one copying a bronze
	// rainscreen wrote `brick` to borrow its hue and said so. A grammar may now DECLARE its
	// materials in an architect's terms - substance, lightness, hue, finish, joint - and every
	// number the pipeline needs is derived from those words in declared-material.mjs.
	let declaredMaterials = [];
	if (program.materials !== undefined && program.materials !== null) {
		try { declaredMaterials = deriveDeclaredMaterials(program.materials); }
		catch (error) { fail(error.message); }
	}
	declaredMaterialIds = new Set(declaredMaterials.map((material) => material.id));
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
		// Absent unless the author declared any, so a grammar written before this exists is
		// the same frozen object it always was.
		...(declaredMaterials.length ? { materials: Object.freeze(declaredMaterials) } : {}),
	});
}

export function predicateHolds(predicate, scope) {
	if (!predicate) return true;
	return predicate.every((term) => {
		const actual = term.field === "face_view" ? scope.face_view
			: term.field === "param" ? scope.param ?? null
				// A scope that never went through a storey split has no band to speak of, and
				// answering `full` there would let a rule fire on a whole facet by accident.
				: term.field === "band" ? scope.band ?? null
					: term.field === "face_offset" ? scope.face_offset ?? null
						: term.field === "storey" ? scope.storey : scope.index;
		// A range comparison. A scope with no number to compare (no face, no offset) is
		// never inside a range, so the alternative falls through instead of firing.
		if (term.op) {
			if (!Number.isFinite(actual)) return false;
			return term.op === "<" ? actual < term.value
				: term.op === "<=" ? actual <= term.value
					: term.op === ">" ? actual > term.value
						: actual >= term.value;
		}
		if (term.value === "last") return actual === scope.total - 1;
		if (term.modulus) return Number.isInteger(actual) && actual % term.modulus === term.value;
		// `cut` is the family, not a fourth member of it: a band cut below, cut above or cut at
		// both ends is cut. Grammars written before the edge was distinguishable ask for `cut`
		// and must keep meaning what they meant, so the general word still matches all three.
		if (term.field === "band" && term.value === "cut") return typeof actual === "string" && actual.startsWith("cut");
		return actual === term.value;
	});
}
