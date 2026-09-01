import { sha256, stableJson } from "../../../core.mjs";
import { TERMINAL_VOCABULARY } from "../../facade-vocabulary.mjs";
import { AXES, BOUNDS, MAX_PARAM_INDEX, PARAM_VALUES, PARAM_WORDS, RISE_DATUMS, TERMINALS } from "./contract.mjs";

export const FACADE_GRAMMAR_PROMPT_REVISION = "arr.elevation3d.facade-grammar-prompt.v1";

const SYMBOL = { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{0,31}$" };

// Longest first, so `param == 15` cannot be read as `param == 1` with a stray 5 left over.
const PARAM_LITERALS = [...PARAM_VALUES].sort((a, b) => b.length - a.length).join("|");
const PREDICATE_TERM = `(?:(?:index|storey) *% *[0-9]+ *== *[0-9]+|(?:index|storey) *== *(?:[0-9]+|last|top)|band *== *(?:full|cut)|face_view *== *(?:front|back|left|right)|param *== *(?:${PARAM_LITERALS}))`;

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
					description: "index % <n> == <m> | index == <n> | index == last | storey % <n> == <m> | storey == <n> | band == full|cut (inside a storey split: whether the mass gave this floor whole or the facet ends inside it) | face_view == front|back|left|right | param == <the arg this symbol was called with>. Two may be joined with &&. Use null for the else branch.",
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
					description: "Carry this SOLID terminal past an edge of its facet to a datum the engine knows. building_top is the building's top line, so a stepped mass ends on one level parapet. building_underside is the line a lifted building flies at, for a level bottom edge across steps in the base. Refused for openings, ignored beyond one storey, and building_underside does not exist on a mass that sits on the ground. Null everywhere else.",
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
of little ledges. If you do want to draw in one, put the member against the edge that IS a
slab and let the cut edge be the one that varies. On a mass that does not step, every band
is full and this changes nothing.

An alternative may also declare the smallest scope it is willing to be used on, with
"min_u_m" and "min_z_m". Below that it is simply not selected and the next alternative is
tried, so end such a rule with a plain one - often bare wall. This is how you keep a design
off a facet too small to carry it. Do NOT enumerate the slivers by index instead: index is
readable only at the start rule, there are at most 8 alternatives there, and spending them
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

If the mass does not step, neither datum changes anything and neither costs anything.

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

Every alternative carries inset_m and depth_m - they are required fields, not optional
ones - and both are at most ${BOUNDS.maxInsetM} m. inset_m shrinks the member in its plane: the
drawn rectangle is the scope pulled in by inset_m on all four sides, so an inset of 0.12
takes 0.24 m off the width AND 0.24 m off the height, and a member shorter than twice its
inset vanishes into a sliver or into nothing. depth_m is its thickness out of the plane.
Use inset_m: 0 where a member wants its whole scope. depth_m: 0 is legal only for glass
and the door, which are cut rather than built; every other terminal needs a thickness
(the rule and its reason are below). On a split alternative set terminal to null and both
inset_m and depth_m to 0; on a terminal alternative set split to null.

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
  scattered on every opening.
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
	const fold = context.exclusions?.fold_clearance_m ?? 0;
	const entranceSegment = (context.facade_segments ?? [])
		.filter((segment) => segment.ground_access && segment.length_m >= 0.8 + fold * 2)
		.sort((left, right) => right.visibility_score - left.visibility_score
			|| right.length_m - left.length_m || left.segment_id.localeCompare(right.segment_id))[0] ?? null;
	const entranceFace = entranceSegment ? (entranceSegment.face_view ?? entranceSegment.view) : null;
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
			? `On this candidate the entrance lands on the ${entranceFace} face - it holds the ground segment that ranks first on the visibility-then-length ordering the placement code uses, and only a door too wide for that segment could move it. Treat ${entranceFace} as the street face; the differ-in-kind asked for above is between it and the face opposite.`
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
