# Elevation agent — entry point

Read this before touching anything. `CLAUDE.md` beside it is a 1400-line running log
of how the system got here; it is evidence, not an introduction. This file is the
introduction.

## What this is

Given a **mass** (a GLB of a building volume, authored elsewhere), produce **verified
architectural drawings** of a facade on it: four elevations, plan, roof plan, two axons,
a PBR pass and a perspective hero.

The design step is an LLM writing a **split grammar** — a CGA-lineage rule language.
Everything after it is deterministic local code that refuses what it cannot verify.

    MASS (fixed, authority)  ->  PERSPECTIVE (an image model dresses that exact mass)
                             ->  DRAWING (an author transcribes the picture into grammar)
                             ->  gates -> compile -> render

## Run it

    node tools/facade-pipeline/cli.mjs roots                       # where the data lives
    node tools/facade-pipeline/cli.mjs prepare  <candidate>        # mass -> verified context
    node tools/facade-pipeline/cli.mjs brief    <candidate>        # the brief + schema an author answers
    node tools/facade-pipeline/cli.mjs check    <candidate> <grammar.json>
    node tools/facade-pipeline/cli.mjs render   <candidate> <grammar.json> <run-name> --palette competition-material
    node tools/facade-pipeline/cli.mjs concept  <candidate> <name> --idea "..."   # mass -> perspective (codex image lane)
    node tools/facade-pipeline/cli.mjs draw     <candidate> <grammar.json> <run-name>   # check + render, one verdict
    node tools/facade-pipeline/cli.mjs photo    <in.png> <out.png> --subject "..."

`concept` reads the storey count, height, facet count and ground contact from the prepared
context and states them as facts to the image model; the `--idea` is the open brief and is
passed through verbatim. It writes `concept-<name>.png` into the run directory. The lane is
the user's Codex CLI; on a quota refusal the error names the limit and the date it lifts.

## The roles

Three roles do the work an engineer cannot do by reading code, and each is a file under
`.claude/agents/` that any agent - Claude Code, Codex, a person - plays by reading it:

| file | plays | reads | must not read |
|---|---|---|---|
| `facade-author.md` | designs a facade from the brief alone (programme-led briefs, and the cheapest test of whether the brief works) | brief, schema, context, mass pictures | `plugins/`, `tools/`, `.superpowers/` |
| `facade-transcriber.md` | turns a concept photograph into a grammar with `source_photograph` set; the standard lane | the photograph, brief, schema, context, mass pictures | the engine |
| `facade-reviewer.md` | says YES / ROUGHLY / NO to "same building?" from a manifest of concept / elevation / hero paths | images only | code, grammars, reports, notes |

The standard lane is `prepare` -> `brief` -> `concept` -> transcriber -> `draw` -> reviewer,
and it loops: the reviewer's list of what a person could still point at goes back to the
transcriber (a defect or an honest limit) or to the engineer (a missing capability). The
reviewer's manifest is a JSON file of relative paths per building - `concept`, `elevation`,
optional `elevation_second_face`, `hero`, and `photographed_faces` in words; the role file
says why that last field exists.

Candidates: `creative-020` (16-facet star prism, 5 storeys), `creative-004` (cleft block,
113 facets, 5 storeys), `creative-013` (bent bar, 37 facets, 3 storeys, a bridge - most of
it does not touch the ground).

Every subcommand prints one JSON object and **exits non-zero on failure**. Do not pipe it
through `tail`; that once masked two failed renders as successes.

Code lives here. Data does not: `elevation-agent.json` declares all three roots -
`dataset_root` (the masses), `output_root` (authored schemes and their drawings) and
`fixture_root` (finished e2e runs the TESTS read fixtures from). Nothing depends on cwd and
**nothing outside that file may name a drive**: nine test files used to have the absolute
path typed into them, which is the eleven-copies problem the config module exists to end.
Tests reach their data through `test/helpers/roots.ts` and name a candidate and a file, never
a path. Override any root with `ELEVATION_AGENT_{DATASET,OUTPUT,FIXTURE}_ROOT`.

    npm test        # 878 tests. Two are load-flaky (a file-lock race, a 287 s e2e);
                    # if one fails, re-run that file alone before believing it.

## The four rules that are not negotiable

1. **The mass is the authority.** Polygons, planes, cameras come from `selected.glb` and
   are byte-canonical. A facade is drawn on it, never edits it.
2. **The LLM authors intent only.** Geometry and views are approved by verifiable code.
3. **The gates stay green.** `test/elevation3d-facade-*`.
4. **The drawing must reflect the perspective.** A run is finished when a person shown the
   photograph and the drawing agrees they are the same building — not when the checks pass.
   Every serious failure here passed every gate. See "How this goes wrong" below.

## The language

    terminals  wall glass door reveal lintel sill band cornice
               pilaster mullion transom spandrel arch louvre
    axes       u  z  storey  layer
    grade      on a terminal: depth_m | inset_m from..to along the run
               on a repeat PART: tile size from..to metres along the run (spacing gradient)
    predicates index/storey == n, % n == m, == last; index/storey < <= > >= n;
               face_offset < <= > >= metres; band ==; face_view ==; param ==
    rise_to    building_top  building_underside  storey_line
               (solids; storey_line also for glass/door, only into a coplanar course
               above - the facet's `continues_above_m` - never across a crease)
    reach      facet_edge
    diagonal   rising  rising_upper  falling  falling_upper
    outline    the member's own shape, [u,v] points in its 0..1 square - a hexagon, a
               rhombus, a circle as a ring of points, a concave slot. One closed loop,
               may not cross itself. Refused on wall and arch and with diagonal.
    outline_far the member's FAR end, when it differs: a funnel, a hood, a scoop. Same
               point count and same winding, because vertex i travels to vertex i.
    standoff_m how far IN FRONT of the wall the member sits, 0..2 - a veil, a brise-
               soleil with air behind it. Refused on an opening and on wall.
    mix        on an alternative, instead of `when`: take it for NONE of the members
               within range_m[0] of a field, ALL past range_m[1], an ordered halftone
               between. How a facade changes CONSTRUCTION across an elevation, since a
               field varies a number and cannot turn a wall into a screen.
    depth_m    SIGNED - positive stands out (bounded per terminal), negative sets in
               (bounded by the wall)
    source_photograph  the file a grammar TRANSCRIBES; then HIERARCHY_MISSING,
               OPENING_RATIO_LOW, PBR_PRESENTATION_RANGE_INVALID, LINE_DENSITY_EXCEEDED (+ its plan twin)
               are recorded as waived, not refused (TRANSCRIPTION_WAIVERS). Null = intent.
    materials  DECLARED, not chosen: substance / lightness / hue / finish / joint_m,
               under a name the author invents. The engine derives colour, roughness,
               metalness, joint family. Nobody writes a hex code.

A rule symbol with a `param` is a named composite - that is the library, and authors grow
their own elements out of it. When something cannot be said, ask whether the PRIMITIVE is
too narrow before adding a word. Four separate author requests turned out to be one missing
sign on `depth_m`.

A parameter may vary with WHERE a member sits, not only with how far along a run it fell.
Declare a place in SPACE - `"fields": [{ "id": "sun", "at": [0.0, -24.0, 8.25] }]`, in the
metres the mass is written in, read off `origin_m` in the context summary -
and a terminal's `grade` names it: `{ "attr": "inset_m", "from": 0.02, "to": 0.30, "field":
"sun", "range_m": [4, 26] }`. That is the parametric operator the literature converged on:
one unit repeated, one parameter driven by distance to a fixed place, so it means the same
thing on every facet and around every corner instead of restarting at each. `field` and
`range_m` come together or not at all. **The coordinate was face metres first and that was
wrong** - `face_offset_m` restarts on every FACE, so one place made four identical ramps on a
four-faced mass; the first outside author proved it and it is a place in space now. Two
shapes to know: a point makes CIRCULAR level sets, so a u-only field wants the point twenty
or thirty metres off the building; and a field varies a NUMBER, not a construction, because a
face is classified punched or skin as a whole. It cannot drive a repeat's TILE SIZE yet and
is refused there rather than dropped; there is one kind of field, a point.

**The pipeline reads the photograph now, and until 2026-09-08 it never did.**
`source_photograph` had eleven uses in this engine and every one spent it turning a gate OFF;
nothing opened the file. So rule 4 above was enforced by nobody but a person, while eight
gates checked a drawing against itself. `source-fidelity.mjs` measures the two pictures on the
same axes and `draw` reports `source_fidelity`: SOURCE_COLOUR_INVENTED (the drawing's boldest
surface is far more saturated than anything in the photograph) and SOURCE_VARIATION_LOST (the
photograph changes markedly along its length and the drawing does not). Checked against three
runs a person had already judged: the one called the same building is clean, the one called
not the same trips both, the one called roughly trips one. It is a report, not a refusal.

## How this goes wrong, every time

**A green gate is not evidence the drawing is right.** Measured examples from one day:

- 799 primitives "accepted", zero faults, and not one triangle drawn - a new field passed
  the parser, the deriver and the geometry, and a **whitelist** in `punched-facade.mjs`
  dropped it one step before the mesh.
- Every declared window rendered as a flat grey tile for a day - glTF multiplies
  baseColorFactor by baseColorTexture and both carried the tint.
- Five buildings with five declared shells all rendered the same cream, because `wall`
  emits no geometry and a material on it was inert prose.
- An entrance reported missing five times. It was on the back face; only the front
  elevation was ever opened.

So: **query the compiled GLB, and open all four elevations.** `check` validates the design
and never reaches the compiler; only a render exercises the geometry path.

The elevation sheet is a flat fill plus a LINE PASS (`elevation-ink.mjs`), three kinds of
line: a declared material's `joint_m` drawn as its module over its own fill; member edges
wherever the depth raster steps 30 mm or more; and CREASES, where the surface turns 2 degrees
or more with the depth continuous through the turn - a folded panel, a pleat, the arris
between two facets of the mass. The ink footprint persists as `<view>-ink.png` and the seam
detector skips it. A material with `joint_m: null` draws no joint - that is what monolithic
means - so a wall that should show panels needs its module declared.

The crease pass reads its OWN raster, `<view>-normal-flat.png`, flat-shaded. The compiled GLB
carries positions and indices and no normals, so three computes them per vertex and averages
across every triangle sharing one; on a faceted mass that smooths its own folds into ramps
fifteen pixels wide, and a reviewer called the resulting flat grey wall the disqualifying
difference on a building whose every panel is a folded diamond. Two degrees is low because
flat shading has no quantisation floor: one triangle, one normal, one encoded value. It is a
second raster because `<view>-normal.png` has two readers calibrated against its smoothing -
the ink pass's facing cull, and the seam detector's 2-degree coplanarity test - and flat
shading moved both, the second into a false TRIANGULATION_VISIBLE on a drawing that had not
changed by a pixel. **Do not merge the two rasters without re-measuring both readers.**

A RECESSED opening (negative `depth_m`) is a hole. The mass mesh is never cut, so the hole is
cut at render time: the builder emits the pane at the bottom of the recess plus four jamb
faces in the shell material, and the viewer (`holeCut`) subtracts the hole volume from every
mass material per pixel before every render. The PLACED entrance takes the same hole: its
`entrance.recess_m` is a magnitude and `depth_m` is signed, so the resolver negates it. Passed
through unnegated it stood every entrance proud of the wall by its own recess, which two
reviewers named on three buildings before anyone read the sign. Query the compiled GLB and you will find the
pane and the jambs; the hole itself exists only in the rasters.

## Adding a field to the grammar

Five links. The third drops silently what it does not name, and the fourth is the one
`outline` stopped at after clearing the other four:

1. `design/grammar/contract.mjs` - parse, validate, and RETURN it; refuse it where it would
   be ignored (on a split, on `wall`, on `arch`) and where its precondition fails (`scoop_deg`
   needs a recess, `rotate_deg` an outline). If the field is `grade`-able, the grade must
   inherit both the bound AND the refusals, or it becomes the way round them.
2. `design/grammar/derive.mjs` - copy it onto the primitive, conditionally, so older
   grammars stay byte-identical. Through `graded(attr, literal)` if a field may drive it.
3. `punched-facade.mjs`, the `pushDetail` call in the design path - **the whitelist**.
4. **The RENDERER, wherever it rebuilds geometry of its own from a primitive.** Only fields
   it re-derives something from - so far `outline`, `recess_m` and `recess_axis` - and easy to
   miss, because links 1 to 3 make the member itself draw correctly. `holeCut` in
   `web/viewer-app.mjs` built every hole from a fixed list of BOX indices over the four
   deepest vertices of the pane: a lens pane has sixteen, four were picked by depth order, and
   the scoops came out square on a drawing whose own geometry was perfect and whose every gate
   was green.
5. `design/grammar/prompt.mjs` - the emitted schema (and its `required` list, or a strict
   provider 400s) AND the brief prose. A field no author can read about does not exist.

Then check the GLB, not the gate - and regenerate the three briefs, because `brief` writes a
file per candidate and nothing regenerates it when the prompt changes. `check` and `draw`
report `brief_stale` when they differ.

## What a field can drive, and what it can be measured from

Both were one-line answers and both are now sets. Five attributes take a `grade`: `inset_m`,
`depth_m`, `standoff_m`, `scoop_deg`, `rotate_deg` - which is the list the panelization
practice varies (size, depth, rotation, the angle of a cut) with `mix` covering the fifth,
which module appears. Five field KINDS, each a formula:

    point   d = |p - a|
    line    d = |p - (a + s(b-a))|,  s = clamp(((p-a).(b-a))/|b-a|^2, 0, 1)   a segment
    plane   d = (p - a) . n          SIGNED, so one side clamps out and it reads as a horizon
    sun     t = (1 - n_face . s)/2   Lambert, on the facet's own outward normal
    mix     product | min | max | mean of two fields declared above it
    falloff t -> t^k, k in 0.25..4   applied after normalising; k = 2 is inverse-square

A field either carries its own `range_m` and answers 0..1, or takes one from the grade naming
it. Only the first may go inside a `mix`: combining raw metres with a cosine is a category
error, and a point field inside a product saturated one metre from its attractor before the
rule existed.

**To tell a field from a gradient, sample the attribute per FACE.** A gradient ramps along one
run and restarts in the next, so every face comes out identical; a field disagrees with itself
because one term is a property of the face and the other of the place.

## Crossing a fold is a formula, not a tolerance

A member is planar and the mass is not, so carried `d` metres past a seam creased by `theta`
it stands off that course's surface by `e = d sin(theta)`. The admissible reach is therefore
`d_max = 0.03 / sin(theta)`, unbounded when the courses are truly coplanar, and the hard angle
cap falls out rather than being chosen: under 0.15 m of reach, at 11.5 degrees, no continuation
is offered at all. The rule this replaced fixed `theta` at 0.5 degrees, which is the same
formula solved backwards for a FULL STOREY of rise - and fixing the height made it wrong in
both directions at once.

**The pattern to look for:** a bare constant whose comment explains where it came from. Both of
today's were that. Still standing: `fold_clearance_m: 0.3`, `edge_clearance_m: 0.3`,
`SEAM_TOLERANCE_M: 0.02`, the 2048-primitive and 16 MB budgets, `P05 >= 10`, `colorDistance >= 5`.
