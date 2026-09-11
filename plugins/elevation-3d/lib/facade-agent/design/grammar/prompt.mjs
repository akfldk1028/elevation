import { sha256, stableJson } from "../../../core.mjs";
import { TERMINAL_MATERIAL_CHOICES, TERMINAL_VOCABULARY } from "../../facade-vocabulary.mjs";
import { AXES, BOUNDS, DIAGONALS, MAX_PARAM_INDEX, PARAM_VALUES, PARAM_WORDS, REACH_EDGES, RISE_DATUMS, TERMINALS } from "./contract.mjs";
import { DECLARED_MATERIAL_AXES, DECLARED_MATERIAL_ID_PATTERN } from "../../declared-material.mjs";
import { coplanarContinuations } from "../geometry/continuation.mjs";
import { rankedSegments } from "../resolver.mjs";
import { PBR_MIN_ROLE_COLOR_DISTANCE } from "../../../texturing/render-style-evidence.mjs";
import { MIN_ROLE_COLOR_DISTANCE as AXON_MIN_ROLE_COLOR_DISTANCE } from "../../../competition-axon.mjs";

export const FACADE_GRAMMAR_PROMPT_REVISION = "arr.elevation3d.facade-grammar-prompt.v1";

const SYMBOL = { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{0,31}$" };

// Longest first, so `param == 15` cannot be read as `param == 1` with a stray 5 left over.
const PARAM_LITERALS = [...PARAM_VALUES].sort((a, b) => b.length - a.length).join("|");
// Longest alternatives first inside the band group, or `cut` matches and leaves `_below`
// stranded. The schema and the parser have drifted apart here once already - an author
// found `band` absent from the prose list while the schema admitted it - so the two are
// written to the same set deliberately.
// The RANGE comparisons and `face_offset` were documented in the brief, implemented in the
// contract, and missing from this pattern - so a provider held to the schema could not emit a
// feature the brief spends a paragraph teaching. Two transcribers hit it independently and
// both reported the two documents contradicting each other; the second tested it and wrote
// down that `storey >= 5` and `face_offset < 7` are refused while `storey == 5` passes.
const PREDICATE_TERM = `(?:(?:index|storey) *% *[0-9]+ *== *[0-9]+|(?:index|storey) *== *(?:[0-9]+|last|top)|(?:index|storey) *(?:<=|>=|<|>) *[0-9]+|face_offset *(?:<=|>=|<|>) *[0-9]+(?:\.[0-9]+)?|band *== *(?:cut_below|cut_above|cut_both|full|cut)|face_view *== *(?:front|back|left|right)|param *== *(?:${PARAM_LITERALS}))`;

/**
 * The grammar the model answers in.
 *
 * Recursion lives in the rule graph rather than in nested literals, so the schema
 * stays one level deep and any provider that supports `$defs` can enforce it.
 */
export const FACADE_GRAMMAR_V3_SCHEMA = Object.freeze({
	type: "object",
	additionalProperties: false,
	required: ["schema_version", "concept_id", "start", "entrance", "rules", "design_rationale", "materials", "fields", "source_photograph"],
	properties: {
		schema_version: { type: "string", const: "arr.elevation3d.facade-grammar.v3" },
		source_photograph: {
			type: ["string", "null"],
			description: "If this grammar TRANSCRIBES a photograph, its file name (e.g. concept-020-param.png). Four gates then record instead of refuse: HIERARCHY_MISSING, OPENING_RATIO_LOW, PBR_PRESENTATION_RANGE_INVALID, LINE_DENSITY_EXCEEDED (and its plan/roof twin PLAN_TOP_LINE_DENSITY_EXCEEDED) - each has refused something a client's photograph showed. Every other gate holds. Null when designing from an intent.",
		},
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
				// 0.5 is the exclusions' max_recess_m. The schema used to allow 1.5 while the
				// validator held every recess to 0.5, and a blind author lost its final attempt
				// to exactly that gap - the schema said yes and the gate said no.
				recess_m: { type: "number", minimum: 0, maximum: 0.5 },
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
		fields: {
			type: ["array", "null"],
			maxItems: 8,
			description: "Places in SPACE that a parameter can be measured from. Declare one here, then a terminal's `grade` may name it and vary depth_m or inset_m with the DISTANCE from that place - an aperture that opens toward one corner, a relief that dies out away from the entrance, a screen that closes where the sun strikes. This is the difference between a gradient and a field: a graded run varies along ONE run and restarts in the next, while a field is measured from a fixed place and means the same thing on every facet of the building.",
			items: {
				type: "object", additionalProperties: false,
				required: ["id", "at"],
				properties: {
					id: { type: "string", description: "A name you invent, which a grade then refers to." },
					at: {
						type: "array", minItems: 3, maxItems: 3, items: { type: "number" },
						description: "[x, y, z] - a PLACE IN SPACE, in the metres the mass itself is written in. The context summary gives every facet its `origin_m` (its corner) and `outward_normal` (which way it faces), so you can read a place straight off the building: a corner it names, the mid-point between two of them, or a point out in front of one face to make the field arrive nearly flat across it. Distance is measured in three dimensions from the centre of each member, so a point placed on one side of a building genuinely leaves the far side alone, whatever the plan.",
					},
				},
			},
		},
		materials: {
			type: ["array", "null"],
			maxItems: 8,
			description: "The materials this facade is built of, DECLARED rather than chosen: you name each one and say what it is, and the engine derives its colour, how it takes light, its metalness and the joint it comes in. Four substances plus at most one accent is a facade; past six a schedule stops being a design. A terminal then names one in its `material` field.",
			items: {
				type: "object", additionalProperties: false,
				required: ["id", "substance", "lightness", "hue", "finish", "joint_m", "reads_as"],
				properties: {
					id: { type: "string", pattern: DECLARED_MATERIAL_ID_PATTERN, description: "Your own name for it. Not from any list." },
					substance: { type: "string", enum: [...DECLARED_MATERIAL_AXES.substance], description: "What it IS. It sets METALNESS and opacity, which is what most changes how the material renders: a metal loses about half its luminance on an elevation with no sun, where a dielectric loses a sixth. It also supplies a semantic role and a joint family, but the presentation gates read the role off the TERMINAL first - see the brief." },
					lightness: { type: "string", enum: [...DECLARED_MATERIAL_AXES.lightness] },
					hue: { type: "string", enum: [...DECLARED_MATERIAL_AXES.hue] },
					finish: { type: "string", enum: [...DECLARED_MATERIAL_AXES.finish], description: "How it takes light." },
					joint_m: { type: ["number", "null"], description: "The module it comes in, in metres, or null for monolithic. Joint frequency, not hue, is what separates sheet metal from cast concrete in a drawing." },
					reads_as: { type: ["string", "null"], description: "One line of specification prose, as you would write it for a contractor." },
				},
			},
		},
	},
	$defs: {
		alternative: {
			type: "object",
			additionalProperties: false,
			// Strict structured output demands EVERY property be required (nullable types
			// carry the "absent" case), and a key listed under properties but not here is a
			// 400 from the provider before any model output. min_u_m and min_z_m drifted out
			// of this list on 2026-08-31 and rise_to, material and reach followed - no live
			// call ran in between, which is the only reason it never fired.
			required: ["when", "split", "terminal", "inset_m", "depth_m", "min_u_m", "min_z_m", "rise_to", "reach", "material", "grade", "diagonal", "outline", "outline_far", "standoff_m", "scoop_deg", "mix"],
			properties: {
				when: {
					type: ["string", "null"],
					// The predicate set is closed, so the schema carries it too. A provider that
					// enforces patterns then cannot emit a malformed comparison at all.
					pattern: `^${PREDICATE_TERM}(?: *&& *${PREDICATE_TERM})?$`,
					description: "index % <n> == <m> | index == <n> | index == last | index/storey < <= > >= <n> | face_offset < <= > >= <metres> | storey % <n> == <m> | storey == <n> | band == full|cut|cut_below|cut_above|cut_both (inside a storey split: full means the mass gave this floor whole; cut_below means the facet begins inside it so its BOTTOM edge is a step and its top is a slab; cut_above means the facet ends inside it so its TOP edge is a step and its bottom is a slab; cut matches any of the three) | face_view == front|back|left|right | param == <the arg this symbol was called with>. Two may be joined with &&. Use null for the else branch.",
				},
				min_u_m: {
					type: ["number", "null"],
					description: "Decline this alternative on any scope narrower than this. Not a fault - the next alternative is tried, so end such a rule with a plain one. Use it to keep a design off the slivers instead of naming them by index.",
				},
				min_z_m: {
					type: ["number", "null"],
					description: "Decline this alternative on any scope shorter than this.",
				},
				rise_to: {
					type: ["string", "null"],
					enum: [...RISE_DATUMS, null],
					description: "Carry this terminal past an edge of its facet to a datum the engine knows. building_top is the building's top line, so a stepped mass ends on one level parapet; building_underside is the line a lifted building flies at, for a level bottom edge across steps in the base - both SOLIDS only, and building_underside does not exist on a mass that sits on the ground. storey_line is the next slab line above the facet: a solid reaches it; glass or a door reaches it (less the floor-band clearance) ONLY where the facet's continues_above_m says the course above is the same plane and wide enough there, and does nothing otherwise. Ignored beyond one storey. Null everywhere else.",
				},
				reach: {
					type: ["string", "null"],
					enum: [...REACH_EDGES, null],
					description: "Carry this SOLID terminal sideways through the fold clearance to its facet's own edge - but only the side(s) where it already stands flush with its scope. A full-width course (a cornice, a band, a lintel run) then meets the corner instead of pausing 0.3 m short of every fold; two facets writing it meet there. Skin members (mullion/transom/spandrel) already do this without asking. Refused for openings: the clearance exists to keep a hole off the turn. Null everywhere else.",
				},
				outline: {
					type: ["array", "null"],
					minItems: 3, maxItems: 32,
					items: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" } },
					description: "This member's OUTLINE, as [u, v] points in its own square: [0,0] is its bottom-left corner and [1,1] its top-right, so an outline is a SHAPE and not a size - the same hexagon serves a 0.4 m cell and a 4 m one. One closed loop, in order, not repeating the first point at the end; it may be concave (a star, a slot with returns, a scooped cell) but it may not cross itself. This is how a member becomes something other than a box: a hexagon, a rhombus, a circle written as a ring of points, a triangle with a returned edge. Refused on `wall` (emits nothing to shape) and on `arch` (already a curve inside its rectangle), and refused together with `diagonal`, which is an outline the language names for you. Null draws the usual box.",
				},
				mix: {
					type: ["object", "null"],
					additionalProperties: false,
					required: ["field", "range_m"],
					properties: {
						field: { type: "string", description: "A declared field." },
						range_m: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" } },
					},
					description: "Take this alternative for SOME of the members, more of them the further they sit from the named field: 0 of them within range_m[0], all of them past range_m[1], an even halftone between. Written instead of `when`, not beside it. This is how a facade changes CONSTRUCTION across an elevation - a punched wall becoming a screen, solid becoming glazed - because a field varies a number and cannot turn one construction into another. Every built facade that makes that transition dithers two discrete conditions rather than morphing one. The mix is ordered, not random, so a grammar draws the same way every time.",
				},
				outline_far: {
					type: ["array", "null"],
					minItems: 3, maxItems: 32,
					items: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" } },
					description: "The member's FAR end, when it is a different shape from its near one - a funnel, a hood, a scoop, a cell whose mouth is wider than its throat. Same number of points as `outline`, in the same order, because vertex i travels to vertex i. Needs `outline`. Null makes both ends the same shape, which is what every member was before this.",
				},
				standoff_m: {
					type: ["number", "null"],
					description: "How far IN FRONT of the wall this member's near face sits, in metres, 0 to 2 - so a screen can have air behind it: a veil, a brise-soleil, a rainscreen standing clear of the enclosure. `depth_m` is then its own thickness, measured from there. Refused on an opening, which cannot float in front of the wall it is a hole in, on `wall`, and on a member with no thickness. Null or 0 sits it on the wall as before.",
				},
				scoop_deg: {
					type: ["number", "null"],
					description: "The ANGLE a recess is cut at, -45 to 45 degrees off the wall's own normal, positive tilting the cut upward in the facet's plane. A recess written without it is DRILLED - straight in, both inner surfaces the same, and in a frontal elevation it draws as a flat dark polygon with no depth in it. A scooped cell opens one inner surface wide to the sky and closes the opposite lip to a blade, which is what makes a veil read as a veil. The mouth shifts along the wall by recess x tan(angle), so leave that much clear of the neighbouring opening. Needs a negative `depth_m`; refused on anything that is not an opening. Null cuts straight in, as every recess did before.",
				},
				grade: {
					type: ["object", "null"],
					additionalProperties: false,
					required: ["attr", "from", "to", "field", "range_m"],
					properties: {
						attr: { type: "string", enum: ["depth_m", "inset_m"] },
						from: { type: "number" },
						to: { type: "number" },
						field: {
							type: ["string", "null"],
							description: "Name a declared field and the grade is driven by DISTANCE to it instead of by position along the run: `from` at range_m[0] and nearer, `to` at range_m[1] and beyond, interpolating between. This is the parametric operator - one unit repeated, one parameter varying with where the unit sits. Null to grade along the run as before.",
						},
						range_m: {
							type: ["array", "null"],
							minItems: 2, maxItems: 2, items: { type: "number" },
							description: "[near, far] in metres: how far the parameter takes to travel from `from` to `to`. Required with `field` and refused without it, because a field normalised over whatever scope it lands in would mean something different on every facet - which is a gradient again. Null when field is null.",
						},
					},
					description: "Vary this terminal's attribute along the run it is laid out by, instead of repeating one number: the value interpolates linearly from `from` at the first instance of its split to `to` at the last (a single member reads `from`). Grade depth_m on a fin repeat and the fins deepen along the facade; grade inset_m on a storey split's window and the openings shrink as they rise. A terminal that no repeat stands between and the facet itself takes the FACE as its run - it varies facet to facet across one elevation, wherever in the rule graph it sits. Both endpoints obey the same bounds as the plain field. Null for a constant attribute.",
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
								required: ["size", "symbol", "arg", "repeat", "grade"],
								properties: {
									size: { type: "string", description: "\"2.4\" absolute metres, \"'0.5\" fraction of the scope, \"~1\" floating weight." },
									grade: {
										type: ["object", "null"],
										additionalProperties: false,
										required: ["from", "to"],
										properties: {
											from: { type: "number", description: "Size in metres of the FIRST tile of this repeat." },
											to: { type: "number", description: "Size in metres of the LAST tile; every tile between interpolates, and the run still fills its scope exactly." },
										},
										description: "Only on a part with repeat: true. Tiles change size along the run - a fin screen densest at one end and opening out toward the other, a bay rhythm that widens toward the entrance. The nominal size is ignored (the count comes from the mean of from and to). Null everywhere else.",
									},
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
				material: {
					// An enum here listed only the four legacy words while the description told the
					// author to name a declared id, so the schema forbade the thing it asked for -
					// and under strict structured output that makes a declared material unreachable
					// for a live call. A declared id is the author's own word, so no enum can hold
					// it; the pattern the parser already uses is the constraint.
					type: ["string", "null"],
					pattern: DECLARED_MATERIAL_ID_PATTERN,
					description: "What this member is made of. Name one of the materials this grammar declares in its top-level `materials` list - that is the free way to say it - or one of the legacy words when a declaration would add nothing. Null takes the terminal's own. A pilaster's default is the mass's own material, so a pier left at default shares a material with the wall behind it and the plan cut draws no line between them.",
				},
				diagonal: {
					type: ["string", "null"],
					enum: [...DIAGONALS, null],
					description: "Cut this member's rectangle in half on a diagonal and keep one half, instead of drawing a box. Four halves: rising is below the cut from bottom-left to top-right and rising_upper is above it; falling is below the cut from top-left to bottom-right and falling_upper above. A member and ITS OWN COMPLEMENT tile the scope and share only the cut - rising with rising_upper, falling with falling_upper. rising and falling do NOT tile: both keep the bottom edge, so they overlap below and leave the top bare. A layer split is how you put two members in one scope. Null draws the usual box. Refused on wall, which emits nothing, and on arch, whose rectangle is already the frame its curve is drawn inside.",
				},
				inset_m: { type: ["number", "null"] },
				depth_m: {
					type: ["number", "null"],
					description: "How far the member stands OUT of the wall, in metres, bounded per terminal. Negative means set INTO the wall, bounded by max_recess_m, and a set-back OPENING is drawn as a real hole: the pane at the bottom of the recess, the recess lined with jamb faces in the shell material, the wall surface cut away in every view. A set-back solid (a band, a reveal) is still a solid inside the wall and only its exposed faces show.",
				},
			},
		},
	},
});

const OPERATORS = `A facade is a split grammar, not a list of windows.

rules maps a symbol to ordered alternatives; the first whose \`when\` holds is taken,
so an alternative without \`when\` is the else branch. An alternative is a split or a
terminal, never both. Recursion comes from parts naming other symbols.

Parts are laid out in the order you write them, from the start of the axis: the first
part of a z split is the one that meets the ground and the last is the one under the
roof, and the first part of a u split is at the low-u edge of the scope. So a tripartite
section is written base, shaft, top, in that order.

Sizes: "2.4" is absolute metres, "'0.5" is a fraction of the scope along the split
axis, "~1" is floating and shares whatever is left over by weight. A part with
"repeat": true tiles as many times as its nominal size fits - that is how one rule
serves a five storey tower and a twenty storey one. The nominal size is a target, not
a promise: the count is the nearest whole number of tiles BUT NEVER ZERO, and every
tile is drawn at an equal share of what the fixed parts leave, so tiles stretch or
shrink to fill the scope exactly and no remainder strip is ever left. The never-zero
matters on a small scope: a repeat cannot be used to make a rule vanish on a narrow
facet - it will squeeze one tile into whatever is left, however badly the nominal fits.
An absolute or fractional part that does not fit is a HARD failure, not a member that
shrinks away: if the fixed parts of a split need more than the scope has, the whole
derivation stops with that split named. Only floating "~n" parts absorb what is left. So
a narrow facet cannot be handled by letting absolute members overflow into nothing - it
has to be routed to a simpler rule.
A repeat part must carry a floating size such as "~3.3", it is the only part in its
split that may float, and a split may hold at most one of them. Set "repeat": null on
every other part.

There is a third axis, and it is usually the one to reach for first.
"axis": "storey" is not a direction - it is the floor structure. The engine cuts the
scope at the slab lines that cross it and invokes your part once per storey, so the
split carries no sizes at all: write exactly one part, give it any size (it is ignored),
and set "repeat": null. Inside each of those scopes index counts the storeys from the
bottom (0, 1, 2 ...) with the topmost answering index == last, and storey is that band's
number. There is no count to read, here as anywhere else.
Reach for it whenever a rule wants to say "per floor". The reason is arithmetic you
otherwise have to do yourself: a facet begins wherever the mass puts it, so "one storey
up from the bottom of THIS facet" is a different absolute z on every facet that starts at
a different height, and authors before you spent attempts computing it per facet and
missing a slab line by centimetres. A member placed inside a storey scope is bounded by
two lines the mass already has, so it cannot straddle a slab however its fractions land.
Write the opening as wall, glass, wall down that scope, and give the two walls ABSOLUTE
sizes of at least the floor-band clearance - that is now worth doing, because the edge of
the scope IS the slab line, which it never was on a raw facet. A fraction will not do: on
a facet that crosses a storey by only a few centimetres, a fraction of it is smaller than
the clearance and the opening still intrudes.

There is a fourth axis, and it does not divide the scope at all. "axis": "layer" hands
EVERY part the WHOLE scope: constructions stacked in depth, not regions side by side.
Write two or more parts, give each a floating "~" size (any other size is refused - a
layer has no width to take), and each part derives its own full composition over the same
rectangle; members of different layers are allowed to overlap by declaration, while
everything inside one layer still obeys every collision and clearance rule it always did.
This is how an element that is a COMPOSITION gets said without waiting for a new word: a
screen of louvres standing in front of a glazed wall is a layer split of [Glazing, Screen];
a balcony is a slab band and a rail layered over the opening behind it. Depth is yours to
separate - give the front layer's members the projection that puts them in front, because
two members at the same depth in the same place will fight in the drawing, and the render
gates will show it. And glass belongs to ONE layer: the opening ratio sums every pane you
draw, so glazing repeated in two layers counts twice and reports a ratio the elevation
does not have. Keep a front layer POROUS, and keep the glass it covers spread across the
building: the render gates check that every material role shows pixels in EVERY view,
including both diagonal axons, and a screen dense enough to hide the glass behind it - or
glazing confined to the faces one diagonal cannot see - fails as a solid wall from that
angle. Measured: 0.30 m pitch with 0.30 m deep fins showed no glass at all in one axon,
and thinning the screen alone did not save a scheme whose glazing sat only on the wide
facets.

This is also how a building gets a line that runs right through it. Put a band or a
cornice hard against the top of a storey scope and every facet draws it at the SAME
height, because that height is the slab and not each facet's own top. Without the datum a
facet can only place a band relative to its own bottom, so on any mass whose facets do not
all start at the same height the bands scatter and the elevation reads as separate patches
rather than one building. The more the facet bottoms differ, the more this matters; on a
mass whose facets all start together it costs nothing.

Inside a storey scope you can also ask HOW the band was made. "band == full" is a floor
the mass hands you whole, slab to slab. "band == cut" is one the facet ends inside - the
mass steps there, and what you have is a slice of a floor rather than a floor.

This matters more than it sounds. Every member measures from the edges of the scope it is
in, and on a cut band one of those edges is not a slab, it is the step. So a head placed a
fixed distance below the band top lands at a different absolute height on every facet that
stops mid-floor, and the elevation ends up drawing the mass's staircase instead of the
building. Measured on an accepted scheme: seven windows on one face, seven different head
heights, not one shared.

So decide deliberately what a cut band should be. Usually the honest answer is plain wall:
a 0.6 m slice under a step is not a storey and articulating it draws a shelf. Route it with
"band == cut" and leave it bare, and the steps read as the mass moving rather than as rows
of little ledges. On a mass that does not step, every band is full and this changes nothing.

If you do want to draw in one, put the member against the edge that IS a slab and let the
cut edge be the one that varies - and the grammar tells you which edge that is. "band ==
cut_below" is a band the facet BEGINS inside: its bottom edge is the step and its TOP edge
is a slab, so measure downward from the top. "band == cut_above" is a band the facet ENDS
inside: its bottom edge is a slab and its top is the step, so stack upward from the bottom.
"band == cut_both" has no slab edge at all and is honest only as bare wall. Plain "band ==
cut" still matches all three when you do not care which.

This is not only how a head holds its line. It is also the only way to ask whether a facet
is the top of the building WHERE IT STANDS: a band whose top edge is the building's own top
slab answers "cut_below" there, and a facet with more building above it on the next plane
does not. A size guard cannot substitute - on a stepped mass the facets that crown are
routinely SHORTER than the facets that must not, so min_z_m selects the wrong set. Three
authors reported that as unsolvable before these two words existed.

An alternative may also declare the smallest scope it is willing to be used on, with
"min_u_m" and "min_z_m". Below that it is simply not selected and the next alternative is
tried, so end such a rule with a plain one - often bare wall. This is how you keep a design
off a facet too small to carry it. Do NOT enumerate the slivers by index instead: index is
readable only at the start rule, there are at most ${BOUNDS.maxAlternatives} alternatives there, and spending them
on slivers is what stops you routing the design itself.

Everything you draw lives inside its own facet, with one exception, and it is the only way
the elevation can answer the shape of the mass rather than only accept it. A SOLID terminal
may carry "rise_to": "building_top", and it then continues up to the building's top line
instead of stopping at the top of its facet. That is a parapet: the wall that runs level
across a mass whose roof steps, so the building ends on one line instead of on the steps.
Give it its own part at the top of the FACET's z split - outside the storey split, spanning
the full width - and put everything else, piers included, in the part below it.

Four things bound it, and none of them is yours to set. The height is the datum, never a
number you write. A facet sitting more than one storey below that line does not rise at
all - a partial rise only trades one ragged top edge for another, and a wall standing
several storeys above the mass is new massing rather than a parapet. Only solids rise: a
window or a door carried above the mass would be a hole in nothing.

There is a second datum for the same move downward. "rise_to": "building_underside" carries
a SOLID down to the line the building lifts off at - the lowest facet bottom above the
ground. Use it when the mass flies: a bar that touches down in one place steps far more at
its base than at its head, and a level bottom edge carried across those steps is what makes
it read as a beam rather than as a stack of shelves. The same four bounds apply, and the
same one-storey limit. On a building that sits on the ground there is no such line, the
datum does not exist, and nothing happens - so this can never be used to fill in underneath
a bridge.

The third datum is the seam the extractor drew, not one the building has. A wall is cut
into a facet per course wherever a floor line crosses it, so on a stacked mass "the top of
the facet" is often just the next slab, and a member ends there whether the design wanted a
course or not. "rise_to": "storey_line" carries a SOLID up to the next slab line the storeys
declare. It is also the ONE rise an OPENING may take - glass or a door, never an arch - and
only where the course above is the same plane: every facet lists \`continues_above_m\`, the u
ranges (in that facet's own u, fold clearance already taken off) and the z it may rise to.
Put the opening inside one of those ranges and it rises to the slab line less the
floor-band clearance, where a head may legally end; put it anywhere else, or on a facet
whose list is empty, and it stays in its facet and nothing happens. A crease between two
courses - three degrees is a crease - is a fold, not a seam, and an opening does not cross
it: a pane across a crease would stand proud or buried at its head, and this mass is never
cut. If the list is empty on every facet, the mass is either a prism or a creased one and
this datum is not for it.

If the mass does not step, none of the three datums changes anything and none costs anything.

If you are TRANSCRIBING A PHOTOGRAPH, name it: "source_photograph": "<file name>". Four
gates then record their measurement instead of refusing - HIERARCHY_MISSING (a top storey
with no opening), OPENING_RATIO_LOW (a face under 10% glass), PBR_PRESENTATION_RANGE_INVALID
(a face with too little tonal spread for a hero) and LINE_DENSITY_EXCEEDED (a sheet with more
line than the typed limit). Each was set to refuse a design nobody asked for and each has
since refused a thing a client's photograph showed: a blank crown, a closed monolith with
narrow slots, a pale face with ten windows, fifteen fins per facet. The picture is the
decision; draw what it shows and let the report say what was waived. Every other gate
holds exactly as before - buildability, bounds, collisions, the plan cut - and a grammar
designed from an intent, with no photograph, leaves the field null and faces all four.

The same idea runs sideways. On a punched wall the derivation scope is pre-inset by the
fold clearance, so a course written across the full scope still pauses 0.3 m short of every
fold - a cornice crossing six facets reads as six lintels. A SOLID terminal may carry
"reach": "facet_edge", and the side(s) of it that stand flush with the edge of their scope
are then carried the rest of the way to the facet's own edge, where the neighbouring facet's
course meets it. Openings are refused - keeping a hole off the turn is the clearance's whole
job - and a member you deliberately held back from the edge stays where you put it. Skin
members already reach without asking.

A repeated member need not repeat its numbers. A terminal may carry "grade": { "attr":
"depth_m" | "inset_m", "from": a, "to": b }, and the attribute then interpolates linearly
along the run its split laid out - "from" at the first instance, "to" at the last, a single
member reading "from". Grade depth_m on a fin and the fins deepen across the facade; grade
inset_m on a window inside a storey split and the openings tighten as they rise. Written at
no repeat between a terminal and the facet, the run is the face's own
facets and the attribute varies facet to facet across one elevation - the terminal does not
have to sit at the start rule to get that, it only has to be reached without passing through
a repeat (a grade cannot be written on a split, and at the start rule every useful
alternative is one). Both endpoints obey exactly the bounds the plain field obeys - a grade never
reaches a number you could not have written by hand; it removes the hand-enumeration, not
the bound.

A depth grade is real in the geometry and INVISIBLE on an orthographic elevation: the sheet
looks straight at the wall and a fin 0.30 m deep draws the same 0.04 m face as one 0.16 m
deep. The gradient an elevation can actually show is SPACING, and that is written on the
repeat part itself: { "size": "~0.14", "symbol": "Fin", "arg": null, "repeat": true,
"grade": { "from": 0.10, "to": 0.20 } } lays the first tile out at 0.10 m and the last at
0.20 m with every tile between interpolating, the run still filling its scope exactly and
the count coming from the mean of the two. A screen densest at the corner and opening out
toward the centre of a face is two facets, one graded 0.10 to 0.20 and its mirror 0.20 to
0.10, routed by index parity. "grade" on a part is only legal with "repeat": true, and
takes two metres, not an attr; set it null everywhere else.

A GRADE ALONG A RUN IS NOT A FIELD, and if what you are drawing is parametric it is
probably a field you want. A graded run varies along ONE run and starts over in the next,
so a screen that should read as one continuous change across a whole building comes out as
a set of per-facet ramps with a seam at every corner. A FIELD is measured from a fixed place
on the building instead, so it means the same thing wherever the member lands.

Declare the place at the top of the grammar:

    "fields": [ { "id": "sun", "at": [0.0, -24.0, 8.25] } ]

\`at\` is [x, y, z]: a PLACE IN SPACE, in the metres the mass is written in. The context
summary gives every facet its \`origin_m\` (its own corner) and \`outward_normal\` (which way it
faces), so you read a place off the building rather than inventing one. Distance is measured
in three dimensions from the centre of each member, so a point on one side of a building
genuinely leaves the far side alone, whatever the plan does in between.

Then a terminal's grade names it:

    "grade": { "attr": "inset_m", "from": 0.02, "to": 0.30, "field": "sun", "range_m": [4, 26] }

which reads: this member's inset is 0.02 m within 4 m of that place, 0.30 m at 26 m and
beyond, interpolating between - so an aperture opens toward the point and closes away from
it, across every facet and around every corner, in one rule. \`field\` and \`range_m\` come
together or not at all: a field with no stated range would have to normalise itself over
whatever scope it landed in, which is a per-facet gradient wearing a field's name.

TWO THINGS ABOUT THE SHAPE OF IT, both of which cost the first author who used it real work.
A point makes CIRCULAR level sets. If you want a parameter that depends only on which way
round the building you are and not on height, put the point well outside the building - at
twenty or thirty metres the arcs arrive nearly straight across a face - and spend \`range_m\`
on that distance plus the run you actually want. A point placed ON the facade instead draws
a bull's-eye, which is right for "brightest at this window" and wrong for "open toward the
south". And a field varies a NUMBER, not a construction: it can open an aperture from a slot
to a window, but it cannot turn a punched wall into a curtain wall along the way, because a
face is classified punched or skin as a whole.

What a field cannot do yet, so you do not spend an attempt finding out: it cannot drive TILE
SIZE on a repeat part (that grade still runs along its run, and the grammar refuses \`field\`
there rather than accepting the word and dropping it), and there is one kind of field, a
point. Distance to a LINE, and a direction like solar orientation, are not sayable - the
distant-point trick above is how you approximate a line, and it costs you most of your range.
If your design needs one, say so in your report rather than approximating it with zones.

A MEMBER NEED NOT BE A BOX. Write "outline" on a terminal and its shape is yours: a list of
[u, v] points in the member's own square, [0,0] its bottom-left corner and [1,1] its
top-right. It is a SHAPE and not a size, so one hexagon serves a 0.4 m cell and a 4 m one:

    "outline": [[0.5,0],[1,0.25],[1,0.75],[0.5,1],[0,0.75],[0,0.25]]

is a hexagon; [[0.5,0],[1,0.5],[0.5,1],[0,0.5]] is a rhombus; twenty-four points on a circle
is a circle. One closed loop, in order, and do not repeat the first point at the end. It may
be CONCAVE - a star, a slot with returns, a cell scooped back on itself - which is the half of
this that a diagonal could never reach. It may not cross itself, and every point lies within
0..1; both are refused at \`check\`, which is free, rather than at the render.

Refused on \`wall\`, which emits nothing to shape, on \`arch\`, which is already a curve inside
its rectangle, and together with \`diagonal\`, which is an outline the language names for you.
Material, role, depth, grade and every gate work exactly as they do on a box: an outlined
member is still whatever terminal it is, so a hexagonal \`window\` is still glass and counts as
glass, and a hexagonal \`spandrel\` is still opaque.

AND THE TWO ENDS NEED NOT MATCH. Write "outline_far" and the member tapers to it: same number
of points, same order, because vertex i travels to vertex i. That is a funnel, a hood, a
scoop - a cell whose mouth is wider than its throat, which is the unit of half the screens
worth drawing and could only be drawn as a lump before.

    "outline":     [[0.5,0],[1,0.25],[1,0.75],[0.5,1],[0,0.75],[0,0.25]]
    "outline_far": [[0.5,0.35],[0.65,0.42],[0.65,0.58],[0.5,0.65],[0.35,0.58],[0.35,0.42]]

is a hexagonal mouth closing to a small hexagonal throat. The taper must stay a polygon the
whole way along, so two outlines that would fold through each other in the middle are refused.

A RECESS CAN BE CUT ON A SLANT. Write "scoop_deg" and the hole goes in at that angle off the
wall's normal instead of straight, positive tilting it upward: one inner surface opens wide and
the opposite lip closes to a blade. Without it a recess is DRILLED, and a drilled hole in a
frontal elevation is a flat dark polygon - the depth is real in the model and invisible in the
drawing. The mouth shifts along the wall by \`recess x tan(angle)\`, so a 0.40 m recess at 20
degrees moves its mouth 0.15 m; leave that much between neighbouring openings or they meet.

AND A MEMBER CAN STAND OFF THE WALL. Write "standoff_m" and its near face sits that far in
FRONT of the wall, with air behind it, \`depth_m\` becoming its own thickness measured from
there. A veil, a brise-soleil, a rainscreen clear of the enclosure: every member began at the
wall plane until now, which is why a screen could only be drawn stuck to the surface it exists
to stand clear of. Refused on an opening, which cannot float in front of the hole it is, on
\`wall\`, and on a member with no thickness of its own.

A FIELD VARIES A NUMBER. TO CHANGE THE CONSTRUCTION, MIX TWO. A field can open an aperture
from a slit to a window, but it cannot turn a punched wall into a screen along the way -
whether a face is punched or glazed is decided for the face as a whole. What real buildings do
instead is DITHER: they keep two discrete conditions and vary which one appears. The halftone
facades all work this way, and one of them runs its entire gradient on four discrete shades.
Nobody morphs the unit.

Write \`mix\` on an alternative instead of \`when\`:

    { "mix": { "field": "sun", "range_m": [6, 24] }, "terminal": "spandrel", ... }
    { "when": null,                                  "terminal": "glass",    ... }

The first alternative is taken by NONE of the members within 6 m of that place, by ALL of them
past 24 m, and by an even halftone of them in between - so the elevation reads as glass at one
end, solid at the other, and a legible mix across the middle, from two rules. The mix is
ordered rather than random, so the same grammar always draws the same building.

What none of it gives you, so you do not spend an attempt: the surface a member sits on is
still the mass's, and the mass is fixed. A veil that lifts off the ground on a raking line, or
that warps away from the building, is the mass's shape and not the facade's.

One thing to get right, because the elevation will not show you the mistake: put the rise on
a member that SPANS the facet, and never on a run of separate piers. Above the roof there is
no wall behind anything, so spaced members rise as detached posts and the building ends in a
fence. In an orthographic elevation that still draws as a level top edge, because the
projection flattens the gaps against the wall below; it is only wrong when you look at the
building. That is why the parapet is a part of the facet's own z split and never a member
inside a bay.

One more thing the one-storey rule does not decide for you. It admits any facet within a
storey of the line, including one in the middle of the mass that has more building standing
above it on another plane - a rise there is a blind wall in front of the storey above, not a
parapet. Crown only the facets that are the top of the building where they stand. A size
guard is the tool: on a mass whose upper facets are the tall ones, min_z_m on the crown
alternative selects them and nothing else. \`index\` is in scope only at the start rule (the facet's position on
its face) and inside a rule a repeat expands (the tile's position in the run); a rule
reached through an ordinary split does not inherit its parent's index, so route
facet-specific behaviour at the start rule and pass intent down through \`arg\`.
Derivation depth is capped at 12 levels from the start symbol, so a router, a section,
a bay and a fully nested opening fit with room to spare - but a rule that only forwards
to another rule spends a level for nothing. \`storey\` is the storey containing the
scope's BOTTOM edge (inherited from the parent when the bottom falls outside every
storey) - it is not "any storey the scope touches", and at the start rule it reads the
facet's own bottom, so a facet that begins on the third storey answers storey == 3.

Predicates: index % <n> == <m>, index == <n>, index == last, storey % <n> == <m>,
storey == <n>, index < <n> (also <=, >, >=), storey < <n> (also <=, >, >=),
face_offset < <metres> (also <=, >, >=), band == full|cut|cut_below|cut_above|cut_both,
face_view == front|back|left|right,
param == <value>. Two may be joined with &&. \`index\` is the position within the
repeat that produced this scope, so "index % 2 == 0" alternates floors and, at the top
level, alternates facets across one elevation. \`index == top\` is accepted as a synonym
for \`index == last\`; prefer \`last\`. The comparisons are for RANGES: "the corner third
of this face" is \`face_view == front && face_offset < 7\`, one alternative, where
\`face_offset\` is the facet's \`face_offset_m\` - where it begins in metres along that
sheet, the number you measure off a picture. Before these existed an author naming the
bare two-thirds of a 32-facet face had to spend one alternative per facet and ran out.

This list is complete - if a comparison is not on it, it is not a predicate, and
\`band\` being on it is the point of the storey section above.

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

${TERMINAL_VOCABULARY.map((terminal) => `  ${terminal.word} (depth_m up to ${terminal.projection_m}) - ${terminal.purpose}`).join("\n")}

What a member is MADE OF is yours to choose, and it is separate from what it is. The
word above gives each terminal the material it is usually made of; write "material" on
an alternative to say otherwise, and omit it to get the usual one. A precast pier against
a brick wall, a base and a shaft that differ in substance and not only in what is cut into
them - none of those were sayable until recently, which is why the older schemes in this
project's corpus all carry the same four materials in the same places.

NAME ONE OF THE MATERIALS YOU DECLARE in the top-level "materials" list. That is the
free way to say it and it is the one to reach for: you invent the name and say what the
thing is, and the engine derives its colour, how it takes light, its metalness and the
joint it comes in. The four legacy words - ${TERMINAL_MATERIAL_CHOICES.join(", ")} -
still work and are there for the case where a declaration would add nothing, but they are a
fallback, not the menu. An author transcribing a bronze rainscreen with only those four
wrote "brick" to borrow its hue and called it "a lie on a construction document"; that is
the situation the declaration exists to end, so do not settle for the nearest legacy word.

DEPTH IS SIGNED, AND A SET-BACK OPENING IS A HOLE. A negative depth_m means set INTO the
wall, bounded by max_recess_m. For glass or a door it draws as a real recess in every view:
the pane sits at the BOTTOM of the recess, the recess is lined with jamb faces in the shell's
own material (the wall's thickness, not a surround - you do not need a reveal terminal to get
them), and the wall surface inside the opening is cut away, so the reveal reads at oblique
angles and the pane never fights the wall. The mass mesh itself is untouched; the cut is
made when the sheet is drawn. Write the depth the photograph shows - 0.2 to 0.35 m is an
ordinary punched reveal - and let the frame, if any, sit proud of the wall face as before.
A set-back SOLID (a band, a sill) is different: it is a solid inside the wall and only its
exposed faces show, so a recessed course reads as a groove, not as a member.

A MEMBER MAY BE A TRIANGLE. Write "diagonal" on a terminal and its rectangle is cut in half
on a diagonal. There are four halves, because there are two diagonals and each has two
sides: "rising" is the half BELOW the cut from the bottom-left corner to the top-right and
"rising_upper" is the half above it; "falling" is the half below the cut from top-left to
bottom-right and "falling_upper" the half above.

A member and ITS OWN COMPLEMENT tile the scope exactly and share only the cut - rising with
rising_upper, falling with falling_upper - and the layer axis is what puts two members in
one scope. **"rising" and "falling" do NOT tile**: both keep the bottom edge whole, so they
overlap below and leave the top of the cell bare. Their areas do sum to the rectangle, which
is exactly why this is worth stating - an author who assumed they tiled drew bowties with a
gap at the top of every cell and had to read the geometry to find out why. The other way to
fill a cell is a whole rectangle behind and one diagonal member in front, which is also
sayable and is what that author shipped.

So a diagrid, a folded or faceted panel field, a chevron, a gable, a sawtooth are all
sayable now. It is an attribute
and not a word, so the member keeps being whatever terminal it is: a glazed triangle is
still a window and counts as glass, a stone one is still a panel. Refused on wall, which
emits nothing to cut, and on arch, whose rectangle is already the frame its curve sits in.

This exists because a facade of triangles is one of the commonest cladding patterns there
is and this language could not say it at all. An author transcribing one wrote a rectangle
per facet and reported the loss exactly: the alternation happens ACROSS the diagonal, and
the diagonal was the building's entire signature. If a picture in front of you has a
diagonal in it, you can now draw it - do not flatten it to squares.

WHERE THE SEMANTIC ROLE ACTUALLY COMES FROM, because the obvious reading is wrong and it
has cost a render. A substance does map to a role, but the presentation resolver does not
reach for it first: it reads the PRIMITIVE, and on a primitive the terminal word wins. So a
member LOOKS like; the terminal you chose decides which role it is COUNTED as. The whole
table, because a partial one cost an author its only rejected render - it gave one material
to a reveal and to a sill and could not see why they collapsed:

    glass      window, door
    bronze     mullion, REVEAL, louvre
    opaque     sill, band, transom
    concrete   spandrel, lintel, cornice, pilaster - and the mass itself

Two things follow that are not obvious. A reveal and a sill are DIFFERENT roles, so one
declared material on both puts one material in two roles and collapses the pair; that is what
cost the render. And a cornice is counted in the mass's own role, which makes the coping
and the roof one material id in the seam raster - so a cornice declared a lightness step away
from the shell is a same-material seam BY CONSTRUCTION and the roof plan will reject it. A
cornice takes the mass's material. Two authors paid two renders each learning that one.

And the shell's own SUBSTANCE decides which role the whole building lands in - the table
above reads for a member, but the mass takes the role its declared shell implies, not
\`concrete\`. Declare the shell a sheet metal and the mass is \`opaque\`: on one transcription
that put 94.8% of the plan raster in one role, left \`concrete\` at 0.9%, and collapsed the
glass:opaque pair at 3.3 against a floor of 5 - on a grammar whose design gates were all
green. If your building is metal, the roles you have left to separate are fewer than you
think, and glass is the one to move.

The mass's material is yours to declare, and there is exactly one place to say it: the
material on a \`wall\` terminal. \`wall\` draws nothing, so what it names is what the
building is MADE of - the mass, the roof, the coping, and the jamb faces of every set-back
opening. One shell per building: the first \`wall\` that names a declared material wins. A
grammar that names none leaves the mass in the palette's concrete, which is why a dark
building whose author clad the piers and left the wall undeclared drew a pale roof.

If a gate tells you a role is missing or two roles collapsed, look at your terminals, not
only at your materials.

One consequence to know rather than to rely on: a declared id that happens to contain a
role word is matched by that word before anything else is consulted, so naming a material
warm-vision-glass lands it on glass and blackened-bronze on bronze. Do not use this to
steer a gate. Name the material for what it is.

Two more things to know before you declare, because between them they have cost two renders.

WHAT SUBSTANCE REALLY CONTROLS IS METALNESS, and metalness is the single biggest lever on
how a facade renders:

    masonry 0.00   cast 0.00   stone 0.00   timber 0.00   glazing 0.00
    sheet 0.55     metal 0.72  extrusion 0.72

Metalness deletes the diffuse term, so on the elevation that gets no sun a metal renders a
dim environment reflection instead of the lightness you declared. Measured across one
building's four faces: the two dielectrics lost 16-19% of their luminance from the sunlit
face to the shaded one, and the two metals lost 49% each. That inverted an author's whole
value ladder - a panel declared a full step LIGHTER than the glass beside it rendered three
times darker on the shaded face - and failed the luminance floor. If you want a mid-grey
field to stay mid-grey where there is no sun, declare it masonry or cast, not sheet.

The luminance gate has a CEILING as well as a floor: the building's P05 must be at least 10
and its P95 at most 248. A pale metal at a satin finish has overrun the ceiling; the same
pale material matte has cleared it. Both ends are steered by the same five lightness steps,
so a very pale building and a very dark one are equally constrained.

TWO gates compare materials, they measure different things, and their numbers differ.
PBR_SEMANTIC_ROLE_COLLAPSED wants every pair of roles visible in a PBR view at least
${PBR_MIN_ROLE_COLOR_DISTANCE} apart in colour distance; MATERIAL_ROLE_COLLAPSE wants the
closest pair on an axon at least ${AXON_MIN_ROLE_COLOR_DISTANCE} apart on a 10 percent trimmed
mean. Design to the larger one.

And DEEP SHADE COMPRESSES THE DIFFERENCE BY ROUGHLY FIVE. Measured: two materials whose
derived tints were 24 apart in RGB arrived at 4.76 on the elevation that faces away from the
sun. Hue does not survive that at all - a stone declared warm-neutral, R-B = 17 in its
tint, rendered at chroma 0.09 on a shaded face - and neither finish nor metalness is visible
to either metric. If two materials must be told apart, put a full LIGHTNESS step between
them - and ONE STEP IS NOT ALWAYS ENOUGH when the role covers a small area. Measured: a
pale wall against a mid cill gave a role colour distance of 2.27 on the axon, against a
threshold of 5 there and 10 for the axon gate; the same wall against a dark cill gave 31 to
79. A large field can hold its own on one step; a thin line under every window cannot. The corollary is worth having as design advice rather
than as a gate note: a material that lives in permanent self-shadow - a deep reveal liner, a
soffit - has to be specified brighter than the same alloy on an open wall, or it stops being
a material and becomes the shadow it stands in.

One consequence worth knowing: pilaster is the only terminal whose usual material is the
mass's own, so a pier left at its default shares a material with the wall behind it. In
the plan cut that draws no line between pier and wall, and that has failed real schemes.
Writing a pier as precast is both an architectural choice and the repair.

How far a member may stand out of the wall is a fact about the member, so the bound is
the one written beside each terminal above rather than one number for all of them. A
cornice may overhang 1.2 m because overhanging is what makes it a cornice; a transom is a
profile between two panes and 0.25 m is already generous for one. Depth is a design
decision within that bound, not a value to max out - the corpus writes most members
between 0.1 and 0.3 m and reserves the deep end for the elements doing the projecting.

Every alternative carries inset_m and depth_m - they are required fields, not optional
ones - and inset_m is at most ${BOUNDS.maxInsetM} m. inset_m shrinks the member in its plane: the
drawn rectangle is the scope pulled in by inset_m on all four sides, so an inset of 0.12
takes 0.24 m off the width AND 0.24 m off the height, and a member shorter than twice its
inset vanishes into a sliver or into nothing. depth_m is its thickness out of the plane.
Use inset_m: 0 where a member wants its whole scope. depth_m: 0 is legal only for glass
and the door, which are cut rather than built; every other terminal needs a thickness
(the rule and its reason are below). On a split alternative set terminal to null and both
inset_m and depth_m to 0; on a terminal alternative set split to null.

What gets drawn, and the drawing that is not an elevation. Your grammar is compiled and
then rendered as eight views: the four elevations, an axonometric from each side, a roof
plan, and a PLAN CUT through the building. Every one of them is checked, and a scheme
that satisfies every rule above can still be rejected by the plan. Its fault reads
TRIANGULATION_VISIBLE, and unlike every other fault in this system it names no member,
no elevation and no number - it reports that two surfaces of the same material met in
the plan raster and left a visible line.

Be told plainly what is and is not known about it, INCLUDING which half of it depth
reaches, because a flat claim here cost an author an attempt by telling them not to try
the thing that worked.

ON THE PLAN, depth is not the lever. It fires where members on two different facets meet
at a fold, and two separate authors have cut the projections at the seam by more than half
and got back seam boxes identical to the pixel. It does not fire on every fold - on one
sixteen-fold mass exactly three folds produced it - and nobody has identified what
distinguishes those three. If you hit it on the plan, say so in your report and spend your
remaining attempts on the rest of the design; a scheme that fails only the plan is a more
useful result to us than one redesigned blind.

AND THE FIRST THING TO LOOK FOR IS A LINE YOU AUTHORED. The fault needs same-material
surfaces AND a visible line between them, and the line is usually yours: a lightness step
declared across a junction the building has no joint at. An author who read a LIGHTING
difference in a photograph as a material one - a cap plate looked brighter than the wall,
so they declared it a step lighter - put a step at the head of a wall that is one pour, and
the detector prosecuted it. Deleting that false distinction took the top view from two
visible segments to zero.

That same author had first cleared it by cutting the cornice oversail from 0.75 m to 0.10 m
and reported that depth was the lever after all. They then retracted it themselves: with
the false material step removed they re-ran the identical 0.75 m geometry and it passes at
seam fraction zero. Shrinking the projection had only shortened and softened the line until
it fell under the threshold, which looks exactly like a depth lever and is not one - and it
cost them seven and a half times their oversail. So check your materials across every
junction before you touch a depth, on the plan and on the top view alike.

The start symbol is derived once per facet, not once per elevation. A folded elevation
is several facets side by side, so a pilaster at the two edges of the start rule puts a
pier on every fold of the building, which reads as stripes rather than structure. Use
\`index == 0\` and \`index == last\` at the start rule to tell the end facets from
the ones between them, and place edge piers only where the elevation actually turns a
corner. There is no \`total\`; \`last\` is how you name the far end whatever the count is.

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
  sawn off. Without one the elevation merely runs out of floors. This is gated, per
  elevation, as TOP_TERMINATION_MISSING - a skin face needs its literal cornice course
  too, the spandrel head does not stand in for it.
- One dominant element, on a face built as a wall with openings cut into it. Such an
  elevation needs a subject: an entrance bay carried up several storeys, one wide opening
  against many narrow ones, one recessed field. If every opening is within a hair of every
  other, there is nothing to look at. This is not asked of a glazed skin - a unitised
  system's panes are identical because that is what unitised means, and the check knows
  which construction each face is in. Do not add one oversized pane to a skin to satisfy
  it; that is the answer this paragraph exists to prevent. Measured exactly: on the faces
  built as punched wall, the largest opening's area must be at least 1.5x the median
  opening's area (reported as scale_ratio, largest_opening_m2 / median_opening_m2; below
  1.5 is SCALE_HIERARCHY_FLAT). And the hierarchy must be a ladder, not a cliff: openings
  are clustered into size levels by sqrt(area), and if one level is more than 10x the next
  (levels_of_scale in the metrics) the subject reads as a separate building and
  SCALE_STEP_BROKEN fires - keep neighbouring sizes within about two or three of each
  other, which is also the step that reads as deliberate.
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
  stacked cells it replaced. This is gated as STOREY_LOCKSTEP, and "through" is measured,
  not implied: a storey counts toward the span only when the member covers at least 35%
  of that storey's height, so a slot that pokes a metre past a slab has crossed nothing
  yet - reach well into the next storey, not just over its line.
- Vary the bay rhythm across the facet. Even spacing is the default the eye discards;
  a wide-narrow-narrow-wide, or one bay held open against a tight run, gives the
  elevation a measure. A unitised skin is the exception: it is evenly spaced on purpose,
  and its measure comes from the base, the top and the corner instead.
- Openings should read as roughly a fifth to two fifths of the wall, and that is measured
  exactly: the door and window rectangles you draw, summed, against the area of that
  face's wall, where that area is the sum over the face's segments of segment length_m
  times the height in local_z - the real folded surface, not the frontage it projects
  onto. On a pleated face that surface is larger than the elevation looks, so the same
  glass reads as a smaller share than you would judge by eye. Nothing else counts towards it - a lintel, a sill, a reveal, a band, a
  pilaster, a mullion, a transom and a spandrel are all wall for this purpose, however much of the surface they cover. It is
  taken per face and the poorest face is judged, so a generous street front does not
  carry a mean back. Size the panes themselves to reach a fifth: an author who sizes so
  that the panes-only and the panes-plus-trim readings both land in range ends up at a
  twentieth, which is a blank wall with slits in it. A fifth to two fifths is the range for
  a wall with openings cut into it; the checker rejects only below 10% on the poorest face
  (OPENING_RATIO_LOW), so a deliberately closed face may sit between the two numbers - but
  that gap is headroom for a decision, not the target. A glazed skin runs higher - half to
  two thirds of the face is vision glass on a real curtain wall - and that figure is
  reported as skin_transparency_by_view, not gated: overshooting the punched range on a
  face built as a skin is not a fault, and undershooting the skin range fails nothing but
  the drawing.
- Nest an opening into lintel, jamb reveals, pane and sill rather than leaving a bare
  rectangle - that is what separates a drawn facade from a painted one. All four, not
  a head and a shelf only: the reveals are the sides, and without them an opening has
  no thickness. In a glazed skin the mullion and the transom do that job instead: the
  mullion is the side, so a pane held between two mullions already has its thickness.
- \`louvre\` is the one terminal allowed to stand IN FRONT of glass: a thin screen member
  (40-150 mm) proud of the wall, and a repeat of them over a glazed field is a layered
  screen - the construction that reads as slatted timber or metal brise-soleil. Give the
  screen its own depth (0.15-0.35 m) so it separates from the glass behind, keep members
  thin and the rhythm tight (0.1-0.3 m pitch via repeat), and let the screen skip where
  the facade wants a clear view. A screen is one gesture per face, not decoration
  scattered on every opening. To actually put the screen IN FRONT of a glazed field -
  both occupying the same scope - use the layer axis: a split partitions its scope
  exactly once, so without a layer the screen and the glazing would have to share the
  width, which is a striped wall and not a screen over glass.
- \`arch\` is the one terminal that is not a box: the rectangle you give it is the arch's
  bounding frame, drawn as a curved band whose springings sit at the bottom corners and
  whose crown touches the top edge. Use it where a lintel would go - directly over an
  opening, the opening's head at the arch's springing line, the arch about half as tall
  as it is wide for a segmental arch and as tall as its half-width for a round one. It
  is solid and needs a depth_m like a lintel. An arched opening is a scale event: one
  arched entrance bay or an arcade at the base outranks scattering arches everywhere.
- There are two constructions available, not one. Punched masonry is a hole cut in a
  wall - wall, glass, reveal, lintel, sill - and it is what every one of these facades
  has been so far. A curtain wall is the other: a continuous glazed skin hung in front of
  the structure, written as mullion, transom, spandrel and glass. Mullions run vertically
  past the floors, transoms divide one pane from the next, and the spandrel is the opaque
  panel that closes the slab zone between a window head and the sill above. Drawn that way
  the glass is the field and the solid is what is left over, which is the reverse of
  punching holes in a wall. Choose one per face and commit to it - a mullion inside a
  punched reveal is neither construction - and note that a skin still needs its base and
  its top, so the storey it meets the ground at and the course that terminates it are
  still yours to compose. A face is classified by the stronger claim: one skin word
  anywhere on it - mullion, transom or spandrel - and the whole face is measured as a
  skin, so a masonry base under a glazed top answers to the skin figures, not the
  punched ones.
- Let the street face and the service face differ in kind, not only in window width.

\`visibility_score\` on a segment is how squarely it faces the axonometric viewpoint the
presentation is rendered from, not how prominent it is on the street. It is 0 for a
segment turned away from that viewpoint, so a face reading 0 throughout is not a face
nobody sees - it is a face the hero image looks at edge-on or from behind. Deterministic
code puts the single entrance on the most visible ground segment by this score; you do
not choose where the entrance goes. Nor do you draw it: a \`door\` terminal you write is
discarded, the entrance object at the top of your answer is the only door there is. Where
the placed entrance lands, an opening of yours within 0.3 m of it is omitted, and a solid
member that crosses it is cut at the door head - what stands above the door survives - so
a grid whose mullion happens to meet the centred door is not an error.

Deterministic code owns all placement. Never name a segment, a coordinate or a path.
Every solid member needs a thickness: give any terminal that is not glass or the door a
\`depth_m\` above zero. A member with no thickness is not a flush one, it is nothing, and it
cannot be built. Glass and the door may sit at zero because they are cut rather than built.
(\`wall\` emits nothing, so its depth_m is ignored; 0 is fine there.)
Openings must clear the floor bands: neither end of an opening may land within 0.15 m of
a slab line - exactly 0.15 m clears, the same boundary rule as the fold - though an
opening may pass a slab on its way, which is how a double-height lobby and a vertical
slot are drawn. The ground line z=0 is a slab line too (only the placed entrance may sit
on it), so glass that should read as meeting the ground stands on a thin bare-wall
shadow gap rather than on z=0 itself. The fault is FLOOR_BAND_INTRUSION and it reports how far from the slab
line the offending end sat. You do not have to work these out: every facet in the
technical context carries \`open_zones_m\`, the z intervals inside that facet where both
ends of an opening are already clear of every slab line and of the ground. Put your
openings inside those bands and this fault cannot fire; a facet whose list is empty is
too short to hold one at all and wants bare wall. Only one primary entrance is allowed,
and both the lowest and the highest storey must carry openings.

How an opening meets a fold depends on which construction you are drawing, because the
two are not doing the same thing there. A hole punched in a solid wall must stay 0.3 m
clear of the fold: cutting one through a turn breaks the mass. The fault is
FOLD_CLEARANCE_INVALID, and what it measures is the distance from the opening's nearest
edge to the facet edge; exactly 0.3 m clears, the fault fires only short of it. On a
punched facet the clearance is taken off BEFORE your rule runs: the u scope handed to
your split is already inset 0.3 m at each fold, and that width is stated per facet as
\`punched_scope_m\` - fit your parts to that number, not to \`length_m\`, and never budget
the clearance twice. A facet whose \`punched_scope_m\` is 0 cannot be punched at all.
A facet that derives skin members gets the whole width instead, which is what lets a skin
frame the fold - and that cuts both ways: put one skin word on a facet and every punched
window on that same facet loses its automatic inset and has to keep the 0.3 m itself. A glazed skin does not pierce the mass at the corner, it replaces
it, so its glass may run right to the fold as long as the strip is framed. Framed means a
mullion or a spandrel pier that reaches the facet edge itself - its own rectangle starting
at the very edge of the facet, not merely near it - overlaps the glass in height, and
**touches the glass**: the member's inner face and the pane's outer edge must be the same
coordinate. A gap between them, even a few millimetres, is bare wall at the corner and is
rejected exactly as bare glass is. A skin member written with \`inset_m: 0\` and flush with
the edge of its scope is carried out to the facet edge automatically; any nonzero inset
cancels that carry and leaves the member short of the edge, which fails the framing test
however exactly it touches the pane. So write the corner member with \`inset_m: 0\` and
flush with the edge of its scope, and put the pane immediately beside it in the same
split, so no arithmetic can open a sliver between the two.

Two openings on one segment need 0.3 m of clear wall between them wherever they overlap
in height - unless a mullion stands between them, which counts as the separation. So a
facet may be divided into a grid of vision panes side by side, which is what a curtain
wall is, and a punched wall still needs real pier between its holes.`;

/**
 * The z intervals inside one facet where an opening may begin and end.
 *
 * Every storey boundary carries a skirt of `clearance` on both sides that an opening end
 * may not land in; the ground line and the top of the highest storey are boundaries too.
 * What is left are the open bands. Intervals shorter than twice the clearance are dropped:
 * nothing useful fits in them, and offering one invites a sliver.
 */
export function openingZones(segment, storeys = [], clearance = 0) {
	const bottom = segment?.local_z?.[0];
	const top = segment?.local_z?.[1];
	if (!Number.isFinite(bottom) || !Number.isFinite(top) || top <= bottom) return [];
	const lines = new Set();
	for (const storey of storeys) { lines.add(storey.z_min); lines.add(storey.z_max); }
	const blocked = [...lines].sort((left, right) => left - right)
		.map((line) => [line - clearance, line + clearance]);
	const zones = [];
	let cursor = bottom;
	for (const [from, to] of blocked) {
		if (to <= cursor) continue;
		if (from > cursor) zones.push([cursor, Math.min(from, top)]);
		cursor = Math.max(cursor, to);
		if (cursor >= top) break;
	}
	if (cursor < top) zones.push([cursor, top]);
	return zones
		.filter(([from, to]) => to - from > clearance * 2)
		.map(([from, to]) => [Number(from.toFixed(4)), Number(Math.min(to, top).toFixed(4))]);
}

export function buildFacadeGrammarPrompt({ context, correctionCodes = [], attempt, previous = null }) {
	const boundedContext = {
		source: context.source,
		facade_faces: context.facade_faces,
		// `view` is the segment's own authority field and `face_view` is the face it was
		// grouped into; they disagree on every segment, and only `face_view` is what the
		// predicate tests. Sending both invites an author to design against the wrong one,
		// which is the same one-name-two-measurements drift this codebase keeps paying for.
		// Each facet carries the z bands an opening may legally end in, computed here rather
		// than left to the author. Every live run on the stepped mass died on exactly this
		// arithmetic - an opening end landing inside the 0.15 m skirt of a slab line, on one
		// of thirty-seven facets with different bottoms - and the model has three attempts to
		// get all of them right. A repo-blind author solves it by hand-computing per facet
		// before writing anything; a provider seeing a prompt cannot. So the prompt states
		// the answer: `open_zones_m` is the list of intervals inside the facet where both
		// ends of an opening are clear of every slab line, and anything outside them is a
		// FLOOR_BAND_INTRUSION waiting to happen.
		facade_segments: context.facade_segments.map(({ view: _view, ...segment }) => ({
			...segment,
			open_zones_m: openingZones(segment, context.storeys, context.exclusions?.floor_band_clearance_m ?? 0),
			// The u twin of open_zones_m. A punched facet's rule is handed a scope already
			// inset by the fold clearance at both edges, so the width its parts must fit is
			// not `length_m` - it is this. Two live attempts in a row wrote a bay run of
			// 0.98 m for a facet whose scope was 0.767 m, which is `length_m` minus 0.6
			// arithmetic the model should not have to do. Zero means the facet is narrower
			// than the two clearances and cannot be punched at all.
			punched_scope_m: Number(Math.max(0, (segment.length_m ?? 0) - 2 * (context.exclusions?.fold_clearance_m ?? 0)).toFixed(4)),
			// Where this facet is the same plane as the course above it, in this facet's own u
			// and already inset by the fold clearance: the only place an opening may take
			// `rise_to: "storey_line"`. Empty on a prism (every facet is full height) and on a
			// creased mass (every seam is a fold), which is the honest answer on both.
			continues_above_m: coplanarContinuations(segment, context)
				.map(({ u_min, u_max, z_max }) => ({ u_min, u_max, z_max: Number(z_max.toFixed(4)) })),
		})),
		storeys: context.storeys,
		exclusions: context.exclusions,
		existing_openings: context.existing_openings,
		technical_thumbnails: context.technical_thumbnails,
	};
	// Which face is the street is not a guess the author should have to make: deterministic
	// code puts the entrance on the highest-visibility ground segment that can hold it, so
	// the face that segment belongs to is knowable here. Two authors given the same brief
	// guessed it differently until it was stated.
	// The ordering is the RESOLVER'S OWN, not a second copy of it. The copy that used to live
	// here filtered on a hardcoded 0.8 m door - the minimum - while the resolver filters on the
	// door the grammar actually declares, so the two could rank differently and the brief stated
	// its answer as fact. An author measured the placed door landing on `back` while this
	// sentence said `left`, and nothing catches that: the brief asserts, the pipeline
	// contradicts, no gate is involved.
	const groundRanked = rankedSegments(context, 0.8, true);
	const entranceSegment = groundRanked[0] ?? null;
	const entranceFace = entranceSegment ? (entranceSegment.face_view ?? entranceSegment.view) : null;
	// And the claim is only worth making when the ordering is not a coin toss. On this mass the
	// top two ground segments tie at visibility 0.63370366 and are separated by 5e-9 of length,
	// on opposite faces - so which face the brief names is decided by floating-point noise, and
	// a door one centimetre wider can move it. Where the top two are that close, say so instead
	// of asserting a street face an author would then design around.
	const runnerUp = groundRanked[1] ?? null;
	const entranceIsContested = Boolean(runnerUp && entranceSegment
		&& Math.abs(runnerUp.visibility_score - entranceSegment.visibility_score) < 1e-6
		&& (runnerUp.face_view ?? runnerUp.view) !== entranceFace);
	// A stepped or battered mass has facets of very different sizes, and the first live run
	// on one spent its attempts finding that out: a z split written for the building height
	// overran a 3.7 m facet, and fractional sizes that drew windows on the wide facets drew
	// centimetre slivers on the narrow ones, which then failed the clearance gates. The
	// numbers are computable here, so say them - but only when they vary, because on a prism
	// this sentence is noise.
	const spans = (context.facade_segments ?? []).map((segment) => ({
		width: segment.length_m, height: (segment.local_z?.[1] ?? 0) - (segment.local_z?.[0] ?? 0),
	})).filter((span) => Number.isFinite(span.width) && Number.isFinite(span.height));
	const buildingTop = Math.max(0, ...(context.storeys ?? []).map((storey) => storey.z_max));
	const widthMin = spans.length ? Math.min(...spans.map((span) => span.width)) : 0;
	const widthMax = spans.length ? Math.max(...spans.map((span) => span.width)) : 0;
	const heightMin = spans.length ? Math.min(...spans.map((span) => span.height)) : 0;
	const facetsVary = spans.length > 0 && (widthMax / Math.max(widthMin, 1e-9) > 1.5 || buildingTop - heightMin > 1e-6);
	// The guard sentence at the end is not decoration. Without it the first live provider
	// answered this advisory by emptying the building - seven primitives, one window - the
	// same trade the giant-order bullet caused before it carried the same guard: told what
	// to avoid, the model avoids it by deleting the design, and OPENING_RATIO_LOW relayed
	// twice did not bring the windows back.
	const wideCount = spans.filter((span) => span.width >= 1.2).length;
	const facetAdvisory = facetsVary
		? `On this candidate the facets are not uniform: widths run ${widthMin.toFixed(2)} to ${widthMax.toFixed(2)} m and the shortest facet is ${heightMin.toFixed(2)} m tall against a ${buildingTop.toFixed(2)} m building, so most facets see only part of the height. The start symbol derives once per facet at ITS OWN size: a z split must fit the facet's own height, not the building's, and a fractional size scales with each facet - a fraction that draws a window on the widest facet draws a centimetre sliver on the narrowest, and slivers fail the clearance gates. Use absolute sizes for members that must not shrink, and give the narrow facets a simpler rule or bare wall by declaring the size your rule needs - put min_u_m and min_z_m on the alternative that carries the design and end the rule with a plain alternative. Do not enumerate the narrow facets by index; that spends the start rule's alternatives on slivers rather than on the design. That caution is for the narrow facets only: ${wideCount} of the ${spans.length} facets are 1.2 m or wider and they are where the design lives - every one of them must carry its openings and its storey split, because retreating to bare wall everywhere fails the opening-ratio floor, not the clearance gates.`
		: "";
	const prompt = [
		"You are the architectural facade director. Return exactly one FacadeGrammarV3 object.",
		OPERATORS,
		GUIDANCE,
		entranceFace
			? (entranceIsContested
				? `On this candidate the entrance is CONTESTED between the ${entranceFace} and ${runnerUp.face_view ?? runnerUp.view} faces: their best ground segments tie on visibility and are separated by less than a micrometre of length, so which one gets the door depends on the width you declare and you cannot know it from here. Do not design a street face around either. Either keep both plausible, or resolve the ambiguity in your own design by giving one of them something the other has not.`
				: `On this candidate the entrance lands on the ${entranceFace} face - it holds the ground segment that ranks first on the visibility-then-length ordering the placement code uses, and only a door too wide for that segment could move it. Treat ${entranceFace} as the street face; the differ-in-kind asked for above is between it and the face opposite.`)
			: "",
		facetAdvisory,
		`Attempt: ${attempt}.`,
		`Technical context: ${stableJson(boundedContext)}`,
		correctionCodes.length
			// Named, numbered, and scoped to the member that failed. The literature on
			// LLM-driven layout finds constraint satisfaction to be the bottleneck rather
			// than the design - top models sit near half on strict numeric constraints -
			// and the loops that converge are the ones that ask for an adjustment to the
			// offending element, not for another answer. Ours sends the previous grammar
			// back below; this line says what to do with it.
			? `Correct these unchanged deterministic validation codes: ${correctionCodes.join(", ")}.
`
				+ "Repair, do not redesign. Each fault names the elevation, the member and its"
				+ " bounds: move or resize THAT member only, by the smallest amount that clears"
				+ " the number quoted, and leave every other rule byte-identical. A fault that"
				+ " names a z bound is asking you to put that end inside one of the facet's"
				+ " `open_zones_m` bands; a fault that names a u bound is asking you to fit"
				+ " within `punched_scope_m` or to keep 0.3 m off the fold. Changing a rule that"
				+ " was not at fault is how an attempt trades one violation for another."
			: "No prior validation failures.",
		// Without the previous answer the model rewrites the whole grammar every attempt
		// and each rewrite fails somewhere new. Repairing converges; reauthoring does not.
		previous
			? `Your previous answer follows. Return it again with only the faults above repaired, keeping every rule that was not at fault:\n${previous}`
			: "",
	].filter(Boolean).join("\n\n");
	return Object.freeze({ revision: FACADE_GRAMMAR_PROMPT_REVISION, prompt, sha256: sha256(prompt) });
}
