import { sha256, stableJson } from "../../../core.mjs";
import { TERMINAL_VOCABULARY } from "../../facade-vocabulary.mjs";
import { AXES, BOUNDS, MAX_PARAM_INDEX, PARAM_VALUES, PARAM_WORDS, TERMINALS } from "./contract.mjs";

export const FACADE_GRAMMAR_PROMPT_REVISION = "arr.elevation3d.facade-grammar-prompt.v1";

const SYMBOL = { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{0,31}$" };

// Longest first, so `param == 15` cannot be read as `param == 1` with a stray 5 left over.
const PARAM_LITERALS = [...PARAM_VALUES].sort((a, b) => b.length - a.length).join("|");
const PREDICATE_TERM = `(?:(?:index|storey) *% *[0-9]+ *== *[0-9]+|(?:index|storey) *== *(?:[0-9]+|last|top)|face_view *== *(?:front|back|left|right)|param *== *(?:${PARAM_LITERALS}))`;

/**
 * The grammar the model answers in.
 *
 * Recursion lives in the rule graph rather than in nested literals, so the schema
 * stays one level deep and any provider that supports `$defs` can enforce it.
 */
export const FACADE_GRAMMAR_V3_SCHEMA = Object.freeze({
	type: "object",
	additionalProperties: false,
	required: ["schema_version", "concept_id", "start", "entrance", "rules", "design_rationale"],
	properties: {
		schema_version: { type: "string", const: "arr.elevation3d.facade-grammar.v3" },
		concept_id: { type: "string", pattern: "^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$" },
		start: { ...SYMBOL, description: "The rule a facet starts from." },
		entrance: {
			type: "object",
			additionalProperties: false,
			required: ["segment_selector", "preferred_bay", "door_family", "width_m", "height_m", "recess_m"],
			properties: {
				segment_selector: { type: "string", const: "primary_visible_ground_segment" },
				preferred_bay: { type: "string", enum: ["central_or_corner_focus", "central_focus", "corner_focus"] },
				door_family: { type: "string", pattern: "^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$" },
				width_m: { type: "number", minimum: 0.8, maximum: 6 },
				height_m: { type: "number", minimum: 1.8, maximum: 6 },
				recess_m: { type: "number", minimum: 0, maximum: 1.5 },
			},
		},
		rules: {
			type: "array",
			description: "Each entry names a symbol and its ordered alternatives. The first whose `when` holds is taken.",
			minItems: 1, maxItems: BOUNDS.maxSymbols,
			items: {
				type: "object", additionalProperties: false, required: ["name", "alternatives"],
				properties: {
					name: SYMBOL,
					alternatives: { type: "array", minItems: 1, maxItems: BOUNDS.maxAlternatives, items: { $ref: "#/$defs/alternative" } },
				},
			},
		},
		design_rationale: { type: "array", maxItems: 16, items: { type: "string", minLength: 1, maxLength: 512 } },
	},
	$defs: {
		alternative: {
			type: "object",
			additionalProperties: false,
			required: ["when", "split", "terminal", "inset_m", "depth_m"],
			properties: {
				when: {
					type: ["string", "null"],
					// The predicate set is closed, so the schema carries it too. A provider that
					// enforces patterns then cannot emit a malformed comparison at all.
					pattern: `^${PREDICATE_TERM}(?: *&& *${PREDICATE_TERM})?$`,
					description: "index % <n> == <m> | index == <n> | index == last | storey % <n> == <m> | storey == <n> | face_view == front|back|left|right | param == <the arg this symbol was called with>. Two may be joined with &&. Use null for the else branch.",
				},
				split: {
					type: ["object", "null"],
					additionalProperties: false,
					required: ["axis", "parts"],
					properties: {
						axis: { type: "string", enum: [...AXES] },
						parts: {
							type: "array", minItems: 1, maxItems: BOUNDS.maxParts,
							items: {
								type: "object",
								additionalProperties: false,
								required: ["size", "symbol", "arg", "repeat"],
								properties: {
									size: { type: "string", description: "\"2.4\" absolute metres, \"'0.5\" fraction of the scope, \"~1\" floating weight." },
									symbol: SYMBOL,
									// An enum rather than a pattern: it is the one constraint every strict
									// provider enforces, so an argument outside the set cannot be emitted.
									arg: {
										type: ["string", "null"],
										enum: [...PARAM_VALUES, null],
										description: "The single argument passed to that symbol, which its own alternatives read as `param`. Use null to pass none.",
									},
									repeat: { type: ["boolean", "null"], description: "Tile this part as many times as it fits. Requires a floating \"~n\" size, at most one per split, and no other floating part in that split. Use null otherwise." },
								},
							},
						},
					},
				},
				terminal: { type: ["string", "null"], enum: [...TERMINALS, null] },
				inset_m: { type: ["number", "null"] },
				depth_m: { type: ["number", "null"] },
			},
		},
	},
});

const OPERATORS = `A facade is a split grammar, not a list of windows.

rules maps a symbol to ordered alternatives; the first whose \`when\` holds is taken,
so an alternative without \`when\` is the else branch. An alternative is a split or a
terminal, never both. Recursion comes from parts naming other symbols.

Sizes: "2.4" is absolute metres, "'0.5" is a fraction of the scope along the split
axis, "~1" is floating and shares whatever is left over by weight. A part with
"repeat": true tiles as many times as its nominal size fits - that is how one rule
serves a five storey tower and a twenty storey one. A repeat part must carry a
floating size such as "~3.3", it is the only part in its split that may float, and a
split may hold at most one of them. Set "repeat": null on every other part.

Predicates: index % <n> == <m>, index == <n>, index == last, storey % <n> == <m>,
storey == <n>, face_view == front|back|left|right, param == <value>. Two may be joined
with &&. \`index\` is the position within the repeat that produced this scope, so
"index % 2 == 0" alternates floors and, at the top level, alternates facets across
one elevation.

Symbol arguments. Every symbol takes at most one argument. A part passes it with
"arg", and the rule it names reads it back as \`param\`:

  { "size": "~3.3", "symbol": "Floor", "arg": "top", "repeat": null }

then inside rule Floor an alternative with "when": "param == top" is the top floor,
and the alternative with "when": null is every other one. That is one Floor rule
instead of FloorTop and FloorTypical, and it composes: Bay with arg wide and Bay with
arg narrow are one rule, not two.

An argument is an integer 0 to ${MAX_PARAM_INDEX}, or one of these words:

  ${PARAM_WORDS.join(", ")}

It is a label and nothing more - the words carry no built-in meaning, so "arg": "top"
does nothing at all unless some alternative of that rule tests "param == top". Pass
null when a part needs no argument.

The argument reaches only the symbol it is passed to. It does not carry on to that
rule's own parts, so if a bay is wide and its opening should be too, pass "arg":
"wide" again on the part that names the opening.

Prefer one parameterised rule over several near-identical named ones. You have at
most ${BOUNDS.maxSymbols} symbols, and spending them on FloorA, FloorB, FloorC is how a grammar
runs out of room to say anything.

Terminals, and what each one is for:

${TERMINAL_VOCABULARY.map((terminal) => `  ${terminal.word} - ${terminal.purpose}`).join("\n")}

Each takes optional inset_m and depth_m, both at most ${BOUNDS.maxInsetM} m. On a split
alternative set terminal to null and both inset_m and depth_m to 0; on a terminal
alternative set split to null.

The start symbol is derived once per facet, not once per elevation. A folded elevation
is several facets side by side, so a pilaster at the two edges of the start rule puts a
pier on every fold of the building, which reads as stripes rather than structure. Use
\`index\` and \`total\` at the start rule to tell the facets apart, and place edge piers
only where the elevation actually turns a corner.

Before answering, check the rule graph closes: every symbol named by any part must
also appear as a rule name. A part pointing at a symbol you never defined is the
single most common way this answer is rejected.`;

const GUIDANCE = `Compose an elevation, do not vary a pattern.

Alternating opening sizes floor by floor is the device critics call pseudo-random
windows. It raises the variety count and still reads as a housing block, because the
facade has no parts. Give it parts instead.

- Tripartite: a base that meets the ground, a shaft, and a top that terminates. Decide
  which storeys each one covers, and change material between them. Material follows
  from the terminal you choose, so a base built from pilaster and band carries weight
  that a shaft of glass and reveal does not.
- Terminate the top. A cornice on the highest storey is what stops a building looking
  sawn off. Without one the elevation merely runs out of floors.
- One dominant element. An elevation needs a subject: an entrance bay carried up
  several storeys, one wide opening against many narrow ones, one recessed field. If
  every opening is within a hair of every other, there is nothing to look at.
- Cross the floors, and do not pay for it in openings. Nothing here confines an opening
  or a pier to one storey, and the placement rules pass a slot that runs past a slab -
  only the two ends have to sit clear of it. A grammar that splits every storey and then
  fills each one identically has written five copies of one floor, which is the
  definition of the building you are trying not to design. So add an order: one or two
  bays of the facet carry a pier or a glazed slot through three floors, while every
  other bay keeps its storey split and every window it already had. The order is a tall
  element added against the ordinary ones, never a blank field left where they used to
  be. Emptying the facade is not a way to satisfy this - an elevation that answers it by
  deleting windows fails the opening ratio below instead, and is a worse answer than the
  stacked cells it replaced.
- Vary the bay rhythm across the facet. Even spacing is the default the eye discards;
  a wide-narrow-narrow-wide, or one bay held open against a tight run, gives the
  elevation a measure.
- Openings should read as roughly a fifth to two fifths of the wall. Slits in a large
  blank wall read as a warehouse, not a designed elevation.
- Nest an opening into lintel, jamb reveals, pane and sill rather than leaving a bare
  rectangle - that is what separates a drawn facade from a painted one. All four, not
  a head and a shelf only: the reveals are the sides, and without them an opening has
  no thickness.
- Let the street face and the service face differ in kind, not only in window width.

Deterministic code owns all placement. Never name a segment, a coordinate or a path.
Every opening must sit clear of the folds and the floor bands, only one primary
entrance is allowed, and both the lowest and the highest storey must carry openings.
Two openings on one segment need clearance between them, so one pane per opening.`;

export function buildFacadeGrammarPrompt({ context, correctionCodes = [], attempt, previous = null }) {
	const boundedContext = {
		source: context.source,
		facade_faces: context.facade_faces,
		facade_segments: context.facade_segments,
		storeys: context.storeys,
		exclusions: context.exclusions,
		existing_openings: context.existing_openings,
		technical_thumbnails: context.technical_thumbnails,
	};
	const prompt = [
		"You are the architectural facade director. Return exactly one FacadeGrammarV3 object.",
		OPERATORS,
		GUIDANCE,
		`Attempt: ${attempt}.`,
		`Technical context: ${stableJson(boundedContext)}`,
		correctionCodes.length
			? `Correct these unchanged deterministic validation codes: ${correctionCodes.join(", ")}.`
			: "No prior validation failures.",
		// Without the previous answer the model rewrites the whole grammar every attempt
		// and each rewrite fails somewhere new. Repairing converges; reauthoring does not.
		previous
			? `Your previous answer follows. Return it again with only the faults above repaired, keeping every rule that was not at fault:\n${previous}`
			: "",
	].filter(Boolean).join("\n\n");
	return Object.freeze({ revision: FACADE_GRAMMAR_PROMPT_REVISION, prompt, sha256: sha256(prompt) });
}
