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
    node tools/facade-pipeline/cli.mjs photo    <in.png> <out.png> --subject "..."

Candidates: `creative-020` (16-facet star prism, 5 storeys), `creative-004` (cleft block,
113 facets, 5 storeys), `creative-013` (bent bar, 37 facets, 3 storeys, a bridge - most of
it does not touch the ground).

Every subcommand prints one JSON object and **exits non-zero on failure**. Do not pipe it
through `tail`; that once masked two failed renders as successes.

Code lives here. Data does not: `elevation-agent.json` declares `dataset_root` and
`output_root`. Nothing depends on cwd.

    npm test        # 824 tests. Two are load-flaky (a file-lock race, a 287 s e2e);
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
    rise_to    building_top  building_underside  storey_line
    reach      facet_edge
    diagonal   rising  rising_upper  falling  falling_upper
    depth_m    SIGNED - positive stands out (bounded per terminal), negative sets in
               (bounded by the wall)
    materials  DECLARED, not chosen: substance / lightness / hue / finish / joint_m,
               under a name the author invents. The engine derives colour, roughness,
               metalness, joint family. Nobody writes a hex code.

A rule symbol with a `param` is a named composite - that is the library, and authors grow
their own elements out of it. When something cannot be said, ask whether the PRIMITIVE is
too narrow before adding a word. Four separate author requests turned out to be one missing
sign on `depth_m`.

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

## Adding a field to the grammar

Four links, and the last one is a whitelist that drops silently what it does not name:

1. `design/grammar/contract.mjs` - parse, validate, and RETURN it; refuse it where it would
   be ignored (on a split, on `wall`, on `arch`).
2. `design/grammar/derive.mjs` - copy it onto the primitive, conditionally, so older
   grammars stay byte-identical.
3. `punched-facade.mjs`, the `pushDetail` call in the design path - **the whitelist**.
4. `design/grammar/prompt.mjs` - the emitted schema (and its `required` list, or a strict
   provider 400s) AND the brief prose. A field no author can read about does not exist.

Then check the GLB, not the gate.
