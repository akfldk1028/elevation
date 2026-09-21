# The cell budget on a pleated mass

**Verification update (2026-09-20):** see
[`2026-09-20-cell-budget-findings.md`](2026-09-20-cell-budget-findings.md).
The budget/section/selection changes were implemented and exercised, but acceptance
is still blocked: the fixed mass's placeable rectangles omit 30.3% of its wall area,
and an all-facet render still shows the bare patches. The findings preserve the
failed draw and the unresolved solid-parts/PBR checks; do not treat this task as done.

**A task for whichever agent picks it up next (Codex or Claude). Read `AGENTS.md` first.**
Everything below is measured, in this repo, on 2026-09-18/19. Nothing in it is a guess, and
nothing in it names a building: the numbers come from three masses and one base model.

## Why this matters

The lane is: a photograph of a parametric facade -> a ModelSpec (family + lattice + fields) ->
that BASE MODEL laid onto our mass -> gates -> drawings. The last step is the one that has to
work **on any mass the mass agent hands over**, because choosing the mass is not this agent's
job. Today it works on a prism (creative-020) and on a stepped bar (creative-013) and it does
NOT work on a pleated block (creative-004): the drawing passes every gate and a person looking
at it sees scattered lenses on bare wall, not a veil.

That gap is a budget, not a defect. This task closes it.

## What is already measured — do not re-derive these

| | creative-020 | creative-013 | creative-004 |
|---|---|---|---|
| facets | 16, uniform 2.21 m | 37, stepped, median 3.65 m | 113, pleated, median 1.76 m |
| unfolded run | 35 x 16.5 m | 120 x 9.9 m | 216 x 16.5 m |
| cell the sizer chose | 0.77 m (scale 1.00) | 0.77 m (scale 1.00) | **1.87 m (scale 2.42)** |
| parts per cell | 1.69 | 1.50 | **3.17** |
| veil that is solid panel | 41% | 37% | **60.4%** |
| the drawing | reads | reads | **confetti** |

- A **part** is a cell a fold cut. `apply` closes its fit on the EVALUATION and compares the
  part count against the 4,096 cap, so on a folded mass it scales the cell UP to reduce the
  count — and a bigger cell crosses more folds. 004 at scale 2.42 is 2.13 parts/cell, at 1.60
  it is 1.73. The loop only ever moves one way, so it walks away from the optimum.
- At 2.42 the cell is 2.82 m wide on 1.76 m pleats: **97% of the facets are narrower than one
  cell**, the throat is 1.45 m, and one lens lands per 1.6 facets.
- The cap is spent over the WHOLE RUN (four faces, 216 m) and an elevation shows one face.
- `face_view` is a DIMENSIONING assignment (one facet, one sheet, by best dot). It is NOT what
  a sheet shows: projected onto 004's front sheet the facets are 47% front-assigned and 49%
  back-assigned, so `--faces front` drew a CHECKERBOARD. Dressing front+back covers 96% of the
  sheet and doubles the run, which puts the cell back to 1.85 m and the veil back to 54.3% solid.
- Front-sheet arithmetic: 2,211 m2 at 0.55 m2 a cell wants about **7,400 cells**.
  `MAX_CELLS` is a bare `4096` in `tools/facade-parametric/facade_parametric/contracts.py:15`
  and `plugins/elevation-3d/lib/facade-agent/design/grammar/contract.mjs:5`, and the comment
  beside the second one already says the real ceiling is the per-facet primitive budget.
- Written-file byte evidence (7 vertex blocks a module, the cove section): 1,964 cells x 16
  points wrote 13.6 MB; 2,748 x 12 wrote 15.0 MB; 3,156 x 12 projected 16.15 MB and was
  refused. So cells x points is about **33,000** at the current per-cell cost, against a
  16 MB GLB budget.

## The task

**Make the veil affordable on a pleated mass, without tuning anything per building.**

1. **Measure the per-cell cost** of `funnelModuleGeometry` as a function of the section
   (`mouth.profile.rings`: a cove is 4 + rings vertex blocks, a linear section is 4) and of
   `mouth.points`. Write the measured bytes-per-cell into the code beside the number that uses
   it. Do not estimate: write GLBs and read their sizes, the way the 33,000 above was found.
2. **Derive `MAX_CELLS`** from the budgets that actually bind (the GLB byte budget and the
   vertex/index caps) instead of the bare 4,096 in the two files above. Both sides must agree,
   and the refusal must keep saying what was spent where. Precedent to follow:
   `maxTotalVertices` / `maxTotalIndices` were re-derived this way (CLAUDE.md, 2026-09-16).
3. **Give the sizer its third lever.** `veilForMass` in `tools/facade-pipeline/apply.mjs`
   chooses `scale` and `points`. Add the section: when the cell would have to be wider than the
   host's own pleat to fit the budget, spend the cove instead of the cell. State the rule in a
   comment with the number it is derived from — the host's facet widths, not this mass's 1.76.
4. **Let a face selection mean what the sheet shows.** `--faces front` currently filters on the
   `face_view` label. Decide, and say in a comment, whether the veil should take the facets the
   elevation SEES (normal facing that camera) instead; if it should, the projected-area
   measurement above is the test.

## Acceptance — a run is done when all of these hold

    node tools/facade-pipeline/cli.mjs apply creative-004 <base-spec.json> <name> --thickness 0.45
      (no --scale, no --points: the veil sizes itself)

- the chosen cell is **no wider than the host's median facet**, and the report says so;
- **under 25%** of the instances are solid pieces (004 is at 60.4% today);
- every design gate green, `draw` completes, the GLB under the 16 MB budget;
- creative-020 and creative-013 still draw, and their grammars and hashes are unchanged where
  the veil did not have to change;
- `npm test` green, run ALONE;
- and the last one is the one that counts: **crop the front elevation to the building's own
  bounds and look at it.** It has to read as one veil. Green gates have proved nothing here
  five times; see `CLAUDE.md`, "the self-sizing veil passed every gate and failed the eye".

## Rules while working

- The **mass is the authority** and comes from the mass agent. Never edit a mass to make a
  facade work, and never design one outside the `synthetic-*` test fixtures.
- **No constant fitted to one building.** Every number in the code carries the derivation that
  produced it, in the comment beside it.
- **One draw at a time**, and `npm test` alone: a draw over ~2,000 cells is memory-bound before
  it is budget-bound (32 GB here, and three draws have been killed by the machine, one of them
  returning a 2,400 x 2,400 black axon the gate correctly called empty).
- **Query the GLB, not the raster**, and read the material-id raster and the hero before the
  depth raster (it is packed RGB and its colour cycles with depth).
- A new field travels **five links**: `contract.mjs`, `grammar/lattice.mjs`, `derive.mjs`, the
  builder whitelist, and the file inline in `tools/facade-pipeline/lattice.mjs` — that last one
  has silently dropped a loop three times.
- Ask the POPULATION, never `instances[0]`: a solid edge panel sorting first once killed the
  veil's line-density waiver.
