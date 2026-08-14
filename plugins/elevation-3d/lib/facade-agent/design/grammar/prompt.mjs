import { sha256, stableJson } from "../../../core.mjs";
import { AXES, BOUNDS, TERMINALS } from "./contract.mjs";

export const FACADE_GRAMMAR_PROMPT_REVISION = "arr.elevation3d.facade-grammar-prompt.v1";

const SYMBOL = { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{0,31}$" };

const PREDICATE_TERM = "(?:(?:index|storey) *% *[0-9]+ *== *[0-9]+|(?:index|storey) *== *(?:[0-9]+|last|top)|face_view *== *(?:front|back|left|right))";

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
					description: "index % <n> == <m> | index == <n> | index == last | storey % <n> == <m> | storey == <n> | face_view == front|back|left|right. Two may be joined with &&. Use null for the else branch.",
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
								required: ["size", "symbol", "repeat"],
								properties: {
									size: { type: "string", description: "\"2.4\" absolute metres, \"'0.5\" fraction of the scope, \"~1\" floating weight." },
									symbol: SYMBOL,
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
storey == <n>, face_view == front|back|left|right. Two may be joined with &&.
\`index\` is the position within the repeat that produced this scope, so
"index % 2 == 0" alternates floors and, at the top level, alternates facets across
one elevation.

Terminals: ${TERMINALS.join(", ")}. \`wall\` emits nothing. Each takes optional
inset_m and depth_m, both at most ${BOUNDS.maxInsetM} m. On a split alternative set
terminal to null and both inset_m and depth_m to 0; on a terminal alternative set
split to null.

Before answering, check the rule graph closes: every symbol named by any part must
also appear as a rule name. A part pointing at a symbol you never defined is the
single most common way this answer is rejected.`;

const GUIDANCE = `Design, do not decorate:

- branch on index so floors alternate instead of repeating
- branch on face_view so the street side differs from the service side
- change opening proportion between base, middle and top; storey height is usually
  far more available than facet width
- nest one more level so an opening becomes jamb, pane and sill rather than a bare
  rectangle - that is what separates a drawn facade from a painted one

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
