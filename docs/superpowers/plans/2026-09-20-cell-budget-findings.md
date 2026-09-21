# Cell-budget repair: measured progress and remaining blockers

This is a continuation of `2026-09-20-cell-budget-on-a-pleated-mass.md`, not a
claim that its acceptance criteria have been met. The source masses and the
validation thresholds have not changed.

## Implemented

`measure-module-cost.mjs` writes actual GLBs with 10 and 100 copies of
`funnelModuleGeometry`, at 8/12/16/24 points and 0/1/3/6 intermediate rings.
The measurement bundle lives under the configured output root in
`module-cost-probe`. At 8 points the measured marginal cost is 2402.27 bytes
for the linear section and 3181.07 bytes for the three-ring cove. These include
the probe's metadata; actual scene metadata and texture costs are still checked
by the existing compiler. The geometry has `points * (4 + rings)` vertices and
six times that many indices.

The Python and JS allocation contracts now share `lattice-budgets.json`. Their
ceiling is derived from the unchanged byte, vertex and index limits using the
cheapest possible emitted prism. The actual scene retains its 10,000-detail,
419,430-vertex, 2,097,152-index and 16 MiB limits. Grid allocation is not the
same as emitted detail count: the evaluator also covers margins and heights
which the actual facets do not occupy.

The sizer can use a linear section before enlarging a parallelogram cell beyond
the host median facet. It reports the full U extent of the tile (the sum of the
absolute U components of its two sides), not just the lattice pitch or one side.
That distinction matters: the source base's tile width is 1.9391 m at scale 1,
although its first lattice pitch is approximately 0.77 m.

`--faces` selects potential sheet coverage using the supplied camera. The actual
viewer is double-sided, so the test is nonzero absolute normal/depth projection,
not a positive-dot facing test. It conservatively includes occluded patches.
On 004's front sheet the old label selection accounts for 46.93% of the projected
rectangle area; the new selection accounts for 100% (106 of 113 facets).

020 and 013 were both re-applied with no scale/point overrides. Their model
hashes and grammar contents remain identical to `auto-creative-020` and
`auto-creative-013`, excluding the new run's concept name. They retain scale 1
and 16/9 points respectively. Receipts are in `module-cost-probe/regression.json`.
Both were also compiled with the current code: 020 is 10,497,716 bytes and 013 is
5,840,280 bytes. The new 013 GLB is byte-identical to its retained render input.
No new full eight-view render of these unchanged grammars was run.

## Actual 004 run

`cell-budget-20260920` uses scale 0.9, eight points and a linear section. Its
tile width is 1.74519 m, below the 1.761642457 m median placeable facet. Design
checks accepted it and the GLB is 10,830,580 bytes (10.33 MiB).

The evaluation contains 15,008 parts, of which 6,387 (42.56%) are solid.
After clipping to the actual facet heights, the resolved drawing contains 3,112
lattice primitives, of which 983 (31.59%) have no throat. Neither denominator
meets the requested 25% limit. Do not replace one denominator with the other
without naming it.

The complete draw was attempted once, on its own. Technical views were written,
but the PBR stage rejected `PBR_SEMANTIC_ROLE_COLLAPSED`: on the top view the
concrete/glass color distance is 2.538737. All render evidence is retained under
the run's `pbr-render` directory. No palette change or waiver was introduced to
force acceptance. Since the PBR gate refused, the pipeline did not write its final
perspective hero.

## The budget was not the only cause

The old and new front elevations were cropped to their manifest's building bounds
and opened. Smaller cells are visible, but large alternating bare areas remain
even with **all facets selected**. Changing face selection therefore cannot fix
this symptom on its own.

`usableFaceRectangle` in `punched-facade.mjs` reduces every coplanar wall patch
to its largest inscribed rectangle. The actual 004 wall triangles have
1331.274090 m2 of surface area; the resulting rectangles cover 927.437663 m2,
or 69.6654%. Some 403.836427 m2 never enters the facade scopes. The measurement
uses the authority's own 15-degree wall/roof discriminator and accounts for
the battered planes. `facade-coverage.mjs` now reports this loss in `apply`;
it does not pretend this area measurement is an occlusion or fidelity score.

The visible-surface hypothesis was then checked independently by
`measure-visible-coverage.mjs creative-004 front`: rays through a 128-by-128
elevation grid hit the first surface of the unchanged, double-sided source mesh.
Of 14,855 visible wall samples, only 7,389 lie within any placeable rectangle.
Thus **50.26% of the sampled visible front wall has no facade scope**. This is
not a count of hidden back facets. The four cropped elevations were also opened;
the large bare regions persist on front/back/left, while the broad rectangular
right-hand region carries a continuous pattern.

The remaining work is therefore a geometry capability, not another increase in
the cell allowance: carry the **actual wall-patch polygon** into the parametric
host and clip the veil to it. The existing rectangular scope should remain for
ordinary punched openings. This requires coordinated authority-derived patch
data, evaluator clipping, derivation, bounds/backing validation and compilation;
extending member bounds without independently checking the true patch would be
a validation relaxation, not a repair. Keep source vertices and triangles exact.
Do not inflate or merge the mass, paint over the missing pattern, invent apertures
in solid slivers, or change the source to make this result pass.

The 25% solid-parts condition and PBR rejection remain separate unresolved
checks. A probe that only translated each cut throat toward its fragment's
centroid still left 44.65% solid at scale 1.45, so that experiment was not applied
to production. No shape changes were made to the evaluator's splitting logic.

## Verification

The focused Node suite passes 15 tests. The Python parametric suite passes 31
tests. The complete `npm test` ran alone and passed **926 tests, zero failures,
zero skipped**, in 325.364 seconds. Its complete output is recorded in
`module-cost-probe/npm-test.log`.

This run is **not accepted as the same facade**. The cropped drawing, the solid
fraction and the rejected PBR result are evidence against calling it finished.

## 2026-09-21: preserve the photographed pattern at cuts

The user's explicit priority is photograph pattern continuity over giving every
fold fragment an aperture. The new path intersects the original complete funnel
solid with the actual wall polygon. It does not translate, shrink, or invent a
throat to fit a fragment. A fragment outside the original throat remains solid.

The source-derived `wall_patch` carries polygon rings and source triangles in
canonical facet coordinates. The original rectangle authority and source mesh
remain unchanged. Python uses a closed-solid intersection and exports the same
evaluated mesh to CAD and the grammar. Parser, deriver, independent geometry
validator, builder, loader and authoring schema carry the new data. This scope
currently permits only solid louvre modules; it does not exempt openings from
fold, slab or bounds rules.

Sparse lattice indices allocate only cells touching the real wall domain. Cut
meshes on one facet are packed together in the GLB while retaining every vertex,
triangle and cell's provenance. This removes repeated mesh-object metadata,
not geometry. The new path is selected when the automatic sizer must spend the
curved section to keep the cell within the median facet width; ordinary 020/013
applications retain their existing path.

The 004 evaluation at `wall-patch-20260921` has 5,463 fragments, of which 1,585
are solid (**29.0134%**). Its cell width is 1.74519 m against a median facet width
of 1.761642457 m. The packed GLB is 9,532,640 bytes. Its model hash is
`bb8bdcaa22142cffd5c0a5d848532c3491a05abbf7d52772d52830551fa6c652`.
The 25% criterion remains unmet; preserving the image does not authorize hiding
solid fragments from the denominator.

The technical front now covers the large previously blank wall regions. It is
not yet accepted visually: fold junctions remain rough, and the glass backing
still follows the old rectangular scopes. The complete-cell clipping preserves
the pattern within the existing unfolded facet run; it is not a claim of a
globally seamless UV map on a nondevelopable mass. A trial of shared-edge phase
translations did not close consistently and was removed rather than presented
as exact continuity.

Render `wall-patch-render-20260921c` wrote all eight technical views, then timed
out during PBR capture. Automated still capture now pauses the viewer's live
animation loop and explicitly renders each requested frame. Cameras, lighting,
resolution and gate thresholds are unchanged. A fresh complete draw and full
regression results must be recorded below before declaring acceptance.

The subsequent `wall-patch-render-20260921d` completed all eight technical and
PBR captures without the timeout. PBR rejected `PBR_CONTACT_SHADOW_MISSING`:
the opposite axon's detected shadow covers 0.0014625 of the image and
0.002589731 of the building sample, below the unchanged 0.002 / 0.01 routes.
The axon passes those routes. Both axons visibly contain ground shadows, so
the failure is specifically the detector's measured coverage, not evidence
that no ground shadow was rendered. No waiver or lighting change was applied.
The final hero is not emitted after this rejection. All four elevations and
both axons were inspected in the saved PBR contact sheet; the backing and seam
limitations above remain visible.

Matched-input regressions (the original explicit `thickness: 0.45`) preserve
both 020/013 evaluation hashes, grammars except the run name, and compiled GLB
bytes exactly. Receipts: `module-cost-probe/wall-patch-regression-matched-20260921.json`.
020 remains 10,497,716 bytes, SHA-256
`9eeb0c7237973c89172ff4e0806419f181eb3e37672f3a8ad5d6a19d0e5c13cb`;
013 remains 5,840,280 bytes, SHA-256
`1ed0f147ef17d4a2e237b61b8dfa77e9e44745c144f1003d825315da91a0e954`.
An earlier regression invocation omitted the thickness edit and consequently
compared different designs; its unmatched receipt is not a regression verdict.
Briefs for 004, 020 and 013 have been regenerated with the new capability.

The 004 CAD bundle was regenerated from the retained evaluated instances,
without reevaluating or changing their model hash. Its 5,463 units now trace
the evaluated cut caps rather than the uncut prototype. The final technical
front was cropped to the manifest's building bounds and opened at
`wall-patch-render-20260921d/technical-render/front-building-crop.png`.
It still has visibly rough horizontal fold junctions and discontinuous glass
backing; do not equate the newly covered area with visual acceptance.

The first full Node run passed 920 tests and failed the browser mock when it
encountered the new pause-live-rendering call. The mock now accepts and asserts
that call before capture; its 26 tests pass independently. This was a test
adapter mismatch, not an out-of-memory failure. Full-suite rerun pending below.

The rerun finished with **929 tests: 928 passed, one failed** in 245.45 seconds.
The remaining failure was `production renderer checkpoints a completed view
before observing its abort`: its 2-second safety timer fired before the first
capture during the full run (the case took 3.53 seconds). The individual case
then passed in 0.149 seconds; its entire `elevation3d-unified-flow.test.ts` file
passed **41/41** alone in 6.30 seconds. No timer or gate was relaxed. Logs:
`npm-test-wall-patch-20260921-final.log`, `checkpoint-retest-20260921.log`, and
`unified-flow-retest-20260921.log`, all under `module-cost-probe`.
The Python parametric suite passed **33 tests**. `git diff --check` is clean.

This is still **partial implementation, not completion of the acceptance list**:
the 25% solid-fragment limit, seamless pattern placement across all fold
junctions, nonrectangular glass backing, and complete draw acceptance remain
open. The source pattern must take precedence over artificial apertures, per
the user's explicit instruction. Preserve these outstanding requirements in
the next implementation pass; do not close them because the budget and source
containment checks pass.

## 2026-09-21 continuation: registered pattern and drawing evidence

The preceding partial status describes `wall-patch-render-20260921d`, not the
subsequent implementation. The current application is `stitched-final-20260921`
and its drawing run is `stitched-final-render-20260921`, both under creative-004's
configured run directory.

- Automatic global scale: 0.70713; nominal tile width 1.371196 m against the
  unchanged 1.761642 m median facet width.
- Actual compiled cell fragments: 7,905, of which 1,950 are solid: **24.6679%**.
  No fragment receives an invented or independently squeezed aperture.
- Written GLB: **10,578,132 bytes**. Vertex/index/byte limits are unchanged.
  Packed provenance uses named columns and rows; all cell IDs, vertex/triangle
  ranges and original primitive indices remain recoverable.
- All eight technical views have been rendered. The high-resolution
  `architectural-sheet.png`, preview, and JSON provenance retain the original
  dimension annotations and verify all eight input image hashes.

Whole-design scale search first descends in 10% steps and then tests a bounded
ten-way subdivision of its final interval. This is not a monotone binary search:
fragment ratios fluctuate with phase. The coarse 0.6561 sample passed the solid
ratio but exceeded the projected file budget before provenance compaction;
refinement avoids spending that extra geometry. Legacy hosts and explicit scale
edits do not opt into this search.

The wall charts now register shared source edges across courses and greedily
stitch additional interfaces without increasing the initial worst affine
distortion or reversing orientation. On 004, 9 of 33 initial cuts are stitched,
with a maximum stitched-edge residual of 1.52e-9 m. The two remaining internal
front-visible cuts measured 0.253 mm maximum phase mismatch. Other cuts remain
explicit; this is not a claim of a globally periodic unfolding of a
nondevelopable closed mass. Common source-vertex offsets join the positive-depth
modules; sharp junctions taper locally to avoid inversion and excessive projection.

The glass backing is now clipped to the actual wall polygons, with the original
fold and slab clearances. It is a separate `wall_openings` capability, without
the veil's opening-clearance exceptions. The original slab courses remain.
Composition measures these new openings and walls by polygon/source-triangle
area, including clipped ground and skin bands, instead of ratios of bounding
rectangles. Legacy metrics remain unchanged.

Two rendering defects were isolated with geometry evidence. Packed RGB-depth
data exported through an antialiased framebuffer produced false depth jumps up
to about 0.93 m; diagnostic passes now use exact single-sample raw byte readback.
Presentation antialiasing remains enabled. Closed positive-depth modules also
no longer receive slope-scaled depth bias that can pull hidden side faces forward.
Contact-shadow analysis uses the actual semantic silhouette rather than excluding
the building's entire bounding rectangle. No ink, shadow, or acceptance threshold
was relaxed.

Two stalled full test trees from September 18 were identified and stopped after
checking their exact process identity and descendants; unrelated Chrome and MCP
processes were preserved. The cleanup audit is retained with the run artifacts.
An intermediate drawing had failed allocating a 7 MB image before this cleanup.

Fresh 020/013 compilation preserves the previously recorded GLB bytes and hashes
exactly. Receipt: `stitched-regression-20260921.json` under the creative-004 run
directory. All three grammar briefs were refreshed. The final Python suite passes
**46/46** tests. Full Node-suite and final PBR results are recorded below once complete.

## 2026-09-21 resumed verification after session recovery

The morning work was recovered from the resumed September 13 session file, which
contains September 21 events. The old September 13 failure/quota manifest does
not describe the current state. Continuation memory is in `memory/MEMORY.md`.

Fresh verification of the existing slope-aware ink, exact diagnostic raster and
module depth-bias changes passes 9/9 focused tests. The full Node run completed
949 tests: 947 passed and two failed (`continuation-20260921-node-tests.log` in
the workspace root). The paid-ledger ownership race passes all 13 cases on its
isolated file rerun; no paid submission was made by these fixture tests.

The other failure reproduced alone: the creative-013 fixture no longer contains
a small dark component classified solely as a non-semantic depth silhouette.
Saved render evidence (`continuation-front-evidence/diagnosis.json`) shows all
27 remaining small dark components, 184 pixels, have semantic material evidence
and complete depth coverage, with zero invalid pixels. The test now requires
complete depth coverage of EVERY component instead of requiring one particular
classification to exist. No renderer/acceptance threshold changed. All six
tests in the front-elevation end-to-end file pass after that correction.

The fresh creative-004 drawing is `continuation-verified-20260921`, using the
unchanged `stitched-final-20260921/grammar.json`. Four elevation ink reports show
member-edge pixel counts changing from 415320/366347/419369/317810 to
149485/108363/151186/159384 (front/back/left/right). These counts demonstrate the
effect of suppressing planar depth gradients; they are not a source-fidelity
score. PBR and final delivery are still being verified at this entry's creation.

The continuation draw subsequently completed with exit 0 and `stage: drawn`.
All eight technical views are accepted; embedded PBR and its final perspective
hero were produced. The GLB is byte-identical to the morning model, 10,578,132
bytes, SHA-256 `6238befc5937ce62e09aa45b24cd559ac5a8f50066e646ecc752af8ac819dcce`.
The architectural sheet and hero were opened for visual inspection. The pattern
now reads across the mass, but dense lines at folded/module boundaries and the
serrated upper termination remain visible; technical success is not universal
visual acceptance. This application transfers the Broad-derived unit to another
mass and has no `source_photograph`, so this draw is not evidence of an accepted
generated-perspective transcription. Fresh Python verification passes 46 tests
and 12 subtests. The full Node suite was not repeated after the six-test isolated
front-elevation correction; retain the exact full-run result stated above.
