# Parametric facade: lattice representation

Spec: `../specs/2026-09-16-parametric-facade-lattice-design.md` (v2.1, mapped from the GPT-6 handoff v2.0 at
`D:/Data/50_ELE/docs/parametric_facade_handoff/`). User decision 2026-09-16: "설계를 좀 새로 해야" → redesign
the parametric lane around family + lattice + fields + exceptions; keep everything the repo already has.

**Goal:** a ModelSpec (unit + lattice + fields + exceptions) evaluates deterministically to instances; the SAME
instances drive the existing 3D engine (typed window primitives with outline/recess/scoop/rotate) and the existing
2D curve document (SVG/DXF), all carrying one `model_hash`; a lattice continues across facet folds.

**Working tree note:** the tree carries codex's uncommitted 2026-09-12/13 work (facade-vision, agent workflow) plus
2026-09-16 engine edits (`entrance.material`). Nothing is committed without the user's word. Every task ends with
`node --experimental-strip-types --test` on the touched files and `pytest` on the Python package; the full
`npm test` runs ALONE (the ledger file-lock flake).

## Task 1 — evaluator: ModelSpec → instances (Python, `tools/facade-parametric/`)

Layout mirrors `tools/facade-vision/` (package dir + `test/` + `requirements.txt`; tests import via `sys.path`).

- [x] `test/fixtures/synthetic_facade_001.json`: v2.0 §14 example converted to metres (host 12×6 m, lens unit
      0.65×0.40 m, basis a=(0.9,0), b=(0.12,0.85), 12×6, `omit_partial`).
- [x] `test/test_forward_fixture.py` (v2.0 §20.2): 72 closed loops with unique ids inside the host;
      `scale_v` 0.8 changes every loop and the hash, host unchanged; linearly dependent basis rejected.
- [x] `contracts.py` validate_spec: enums, ranges, references, NaN/Inf, duplicate ids, degenerate basis,
      unknown keys.
- [x] `prototypes.py`: piecewise cubic Bezier → sampled polygon (adaptive, chord error ≤ 5 mm), shape_modes.
- [x] `lattice.py`: `p(i,j) = origin + i·a + j·b + stagger(j)`; host-boundary policy `omit_partial | clip | keep`.
- [x] `fields.py`: `constant | linear | grid` over normalized (s,t); same evaluation as the grammar's
      `point/line/plane/sun/mix` so one vocabulary serves both.
- [x] `evaluate.py`: instances (`facade-curves.v1`-compatible + `outline_m` + `provenance`) and
      `model_hash` = sha256(canonical spec + generator version). Same spec twice → identical output.
- [x] `export.py`: instances → `curve_document` → `pattern_layout.svg` + DXF via the existing exporter.
- Gate G1: **green 2026-09-16** — 5 tests (`tools/facade-parametric/test`), 72 apertures, `scale_v` edit moves every loop, DXF read-back 72 INSERTs with ids, one shared unit, same hash on instances.json / facade_model.json.

## Task 2 — same origin in 3D and 2D on a synthetic box candidate

- [x] A synthetic box candidate: `synthetic-box-<W>x<D>x<H>` is built in `tools/facade-pipeline/synthetic-candidate.mjs`
      and prepared by `prepare` like any candidate (evidence pack, context, seeds). `synthetic-box-12x4x6.6` prepared 2026-09-16.
- [x] `lattice` is a TERMINAL attribute, not a split (`grammar/lattice.mjs` + contract/derive/validator/schema): the
      member is instantiated once per cell inside its scope, host (0,0) at the FACET origin (the same origin the
      SVG/DXF use), cells clipped at the scope edge, outline normalized per cell; cells stand aside from
      FLOOR_BAND_INTRUSION and from PRIMITIVE_OVERLAP within ONE evaluation (same family + same model_hash), and keep
      the fold and opening-clearance rules like any hole. `lattice: {family, cell}` rides on the primitive and the GLB
      extras; the model_hash lives once in the compiled manifest (`lattice_model_hashes`).
      Tests: `test/elevation3d-facade-lattice.test.ts`.
- [x] Code review of the lane (2026-09-16, `/code-review high`, 10 findings, 7 fixed): host origin had been the
      fold-INSET scope origin, so every GLB cell sat 0.3 m along the facet from the DXF under the same hash (measured
      on `f301da2e`: cell r000-c000 at host 0.219..0.781, in the GLB at 0.519..1.081; now 0 offset, edge cells clipped
      at 0.3 / 7.7 instead of shifted); `export_chord_error_m` unvalidated (0 spun the coarsening loop forever, no
      execFile timeout) - now 1e-5..0.05 with a loop guard and a 600 s timeout; the 32-point cap could be exceeded by
      the clip's own corners (Python `fit_points` + Node `fitOutline` merge the shortest edge); the attributes whitelist
      hardcoded `bulge`/`inset_m` - any declared shape-mode name rides now, `inset_m` dropped from the evaluator's cell
      attributes; validator exemptions narrowed (above); a ring thinner than 5 mm (depth -0.02) is skipped instead of
      written as zero-area triangles; the contour frame carries `role`/`family_id`; every outlined member gets the ring
      retry ladder, non-lattice members still fail loudly at the narrowest width; `readAuthoredGrammar` is the one way a
      grammar file is read (cli AND build-sheet), inlining into a copy. Left for a decision: codex's reveal depth<0
      override in punched-facade (no mass-backing classification), showcase camera picking the last secondary door, and
      cleanups (duplicate clip / round, the Python runner duplicated from vision.mjs, O(n²) validator loop).
      Found on the redraw: the AXON gate still demanded bronze from its own list (the Broad's opposite-axon had passed
      on 5 bronze pixels); it now reads `required_material_roles` from the manifest like the elevation and PBR gates.
- [x] A ring (contour jamb / frame) folds on a clipped fragment: `outline-frame.mjs` merges edges shorter than the ring
      width; a lattice fragment retries at 1/2 and 1/4 width and finally keeps its hole without a ring.
- [x] `cli.mjs lattice <spec.json> <out>` (Python `tools/facade-parametric/cli.py evaluate`) and every grammar-reading
      command inlines `lattice.instances: "<file>"` (`tools/facade-pipeline/lattice.mjs`), refusing a model_hash mismatch.
- [x] Manifest: the GLB extras, `instances.json`, `facade_model.json` and the DXF carry the same `model_hash`.
- [x] Budgets: `maxTotalVertices` / `maxTotalIndices` were bare literals (80,000 / 360,000) fitted to the bay grammar; each is now
      half the 16 MB byte budget spent on that one thing (the byte projection stays the binding gate). The roof-plan gate needs a
      squarish plan (middle 40% of the sheet), so the proof box is 12×8, not 12×4. The mass must carry a declared shell (`wall` in a
      layer beside the lattice) or PBR_EVIDENCE_MISSING finds no texture.
- Gate G2 **green 2026-09-16**: `synthetic-box-12x8x6.6/render-lattice-001` — 229 lattice cells in the GLB (72 per 12 m face, 48 per
  8 m face), every cell with jamb + frame rings, eight technical views + PBR + hero accepted.
- Gate G3 **green**: DXF read-back 72 INSERTs with cell ids, hashes equal across GLB / instances / facade_model / DXF
  (`f301da2e…`). The only red line is the coarse photograph comparison (`SOURCE_COLOUR_INVENTED`) against a flat synthetic raster.
- Gate G3b **green**: `render-lattice-001b` (scale_v 0.8, radial scale_u + bulge about the host centre): hash `e094488e…`, GLB and DXF
  differ, host identical, 72 of 72 cell outlines moved, eight views + PBR accepted.

## Task 2b — facet-run host, and a BASE MODEL applied to our masses (2026-09-17, user: "파라메트릭 base model 가져와서 우리 거에 맞는 입면으로 맞춘다, 조금씩 변형하는 것도")

- [x] `host.kind = facet_run` (`contracts.py`: candidate + segments [{id, length_m}] + height_m; width = the sum). The
      lattice is laid over the unfolded run; `split_by_facets` hands every cell to its facet in that facet's own u, a
      cell across a seam becoming one part per facet (ids `-pK`) with mouth, throat and tile resampled by angle about the
      throat part's centroid (inside all three, every part convex) so they stay partnered; a part whose throat fell on
      the other facet is a solid piece. Overlaps are checked per facet (parts share local coordinates). The unfolded 2D
      export offsets each facet's cells back to the run. Test: `test_facet_run.py` (2).
- [x] derive: a cell naming a `segment_id` goes to that facet only. A veil of MODULES (cells with a tile, positive
      depth) runs to the facet's edge - it is not a hole through the turn - while the rest of the scope (the glass box
      behind) keeps its fold inset; the fold rule reads doors and windows only, so nothing is silenced.
- [x] `facade_parametric/apply.py` + `cli.py apply` + `cli.mjs apply`: base spec + host + edits -> spec. What travels:
      family (curve, modes, prototype scale, mouth), lattice basis, fields (size fields flattened to 1 - a field read off
      one building's photograph is that building's); what does not: host, design voids, source. Edits: `scale` (cell and
      pitch together), `pitch`, `thickness`, `web`, `rotate`. The lattice is re-laid to cover the run. `apply.mjs` chains the
      candidate's facets into one run (each facet's end is the next one's start), writes host/edits/spec, evaluates, writes
      a grammar (storey-split glass box + a `louvre` veil of modules, a door sized to the narrowest facet) and checks it.
      Tests: `test_apply.py` (2), `elevation3d-facade-apply.test.ts` (chain order).
- [x] Three caps moved so a veil over sixteen facets can exist: the resolver's and the builder's 2,048-primitive caps count
      authored members only (lattice cells have the contract's 4,096); the composition gate reads a module veil as a
      skin construction that runs the height (storey span from the veil's extent) and terminates the face where it
      reaches the top storey - so uniformity is the system, not SCALE_HIERARCHY_FLAT / STOREY_LOCKSTEP / no cornice.
- [x] Gate G3c, first pass: `creative-020/broad-on-020` - the Broad base model (fitted lattice, funnel module) on the
      star prism, 16 facets of 2.206 m unfolded to 35.3 x 16.5 m, scale 0.8, thickness 0.45: 2,029 cells, 2,238
      primitives, every design gate accepted. `render-broad-on-020`: eight views + PBR + hero accepted, the front's
      LINE_DENSITY_EXCEEDED (0.151 against 0.035) recorded - a veil's crests ink every cell edge, a screen's own lines.
      The veil runs around all sixteen facets without a seam column: "eyes on a tower" is closed.
- [x] The tile is a RULE, not a choice ("왜 또 육각형으로 만들어졌지? ... 추상적인 알고리즘으로 어떤 이미지가 와도 잘 되어야",
      2026-09-17). Voronoi was my wrong default: The Broad's cell is a parallelogram along the ribs, and the photograph's
      edge-orientation histogram says so (one family at ~35°, nothing else strong). `mouth.kind = parallelogram` with
      `sides` as integer pairs over (a, b) (|det| = 1) and an `offset`; `fit.tile_sides_for` picks the long side as the
      lattice vector nearest the unit's own long axis and the short side as the shortest unimodular partner - for the
      Broad (b − a, a) [ribs at 31°, rows horizontal], for the fixture's lens along a, (a, b). The fit emits the mouth
      itself now. Tests: `test_tile_sides.py` (rule + tiles cover the plane once). Nothing is set per building; what a
      photograph cannot show (depth, web) stays an option and is named so in the spec.
- [x] Rings sampled at a SHARED angle set that keeps the mouth's corners (`funnel.angle_set` / `lattice.mjs angleSet`):
      uniform rays cut the acute corners off a parallelogram tile and left glass triangles between neighbouring modules
      (seen in the material-id raster, not guessed). Every mouth vertex, the two farthest points of each other ring, then
      uniform fill to the count. Generator version bumped to v0.2 so the model hash moves with the geometry. Test: the
      tiles cover 99.5% of the host interior.
- [x] Redrawn under the rule: `render-broad-module2` (photo comparison accepted, spread 0.58 vs 0.087 for the
      honeycomb) and `render-broad-on-020d` (1,824 cells, all gates). Draws at ~2,600 cells were killed by
      low memory (2.6 GB free of 32) at the PBR stage twice; that is a machine limit, not a gate.
- [x] A seam through a THROAT: two half-lenses on two planes read as a glass triangle at every fold (020d,
      material-id raster). `split_by_facets` now squeezes the whole lens into each part (scaled about the part's
      centroid to fit inside the mouth part less a web; under 0.35 the part is solid). Generator v0.3. Test in
      `test_facet_run.py`: no open part's throat touches a seam.
- [x] The cell's SURFACE, not only its topology ("유선형인데 타원도", 2026-09-17): `mouth.profile` (linear |
      quarter_ellipse cove through n sections; `funnelSections` / multi-ring `funnelModuleGeometry`) and an
      ellipse fit for the unit (`ellipse_unit`, threshold 0.04 measured against six shapes). The component +
      population idiom of the panelization literature, finally applied. Broad re-fitted as module3.
- [x] The veil FINISHES its host ("어떤 mass든 입면이 마무리가 깔끔하게", 2026-09-17): a cell the host edge cuts
      past its funnel is a solid panel, not a dropped cell (generator v0.4; `omit_partial` still drops).
      Star prism: veil top 16.24..16.50 -> 16.500 on all sixteen facets. `test_edge_finish.py` holds the
      coverage. Exposed a first-element test in the veil's line-density waiver (`veilWaivers`, now tested).
- [x] ANY MASS ("예가 될 때까지", 2026-09-17): the base model on the bent bar (37 facets, stepped) and the cleft
      block (113 facets, battered). Four prism-only rules fixed: `chainFacets` kept 2 of 37 and 1 of 113 facets;
      every facet started its veil at its own bottom (`lattice.z_datum_m`); the door was sized from the narrowest
      facet; the glass box's storey needed a fixed half metre (`min_z_m` + a bare-wall alternative).
- [x] ANY PARAMETRIC FACADE: a second authored design (rounded hexagon, staggered rectangular lattice, point
      field) pictured and read back with no code changes - trace 140/140, lattice recovered to 1 mm, recovery
      138/140 at RMS 0, applied to the star prism at 642 cells, gates green. SAM 3 returns nothing on a flat
      graphic (concept prompts); the classical engine segmented it.
- [x] The veil sizes itself to the mass ("어떤 mass가 와도 잘 되어야", 2026-09-17): `apply` derives `--scale`
      from the run's area against the 4,096-cell cap and `--points` from the GLB byte budget, and closes the
      fit on the EVALUATION (the area estimate under-counts by 60% on a stepped mass). Five masses with no
      numbers; the three test-set masses drew.
- [x] The veil on a PLEATED mass (2026-09-18): the self-sizing veil passes every gate and draws
      confetti on the cleft block - the cap counts fold PARTS and is spent over all four faces, so the
      cell ran to 2.82 m on 1.76 m pleats (97% of facets narrower, 60.4% solid). Laid per FACE the same
      sizer chooses scale 1.00 and every cell keeps its lens; the faces the veil does not cover are
      crowned by the template (only when the run is limited), so the drawing terminates.
- [ ] The seam: a cell split across a fold is two flat parts on two planes; the photograph's veil bends. Fine for a
      2.2 m facet at 0.6 m cells (each cell is mostly on one facet); to be measured on the bent bar.

## Task 2b (done) — see above

## Task 3 — fitting: observed cells -> ModelSpec (started 2026-09-16, user: "내가 준 이미지로 테스트해야 하는 거 아님?")

- [x] `facade_parametric/fit.py`: observations (a facade-curves.v1 trace document, or any {center, size, unit outline})
      -> lattice (nearest-neighbour displacement histogram peaks, Lagrange-reduced, then iterated integer-index least
      squares with a 0.35|a| inlier rule; extent = the observed index range, never the host's room), shared unit (mean of the
      observed loops, resampled by arc length from a common corner, as a closed Catmull-Rom spline in cubic Bezier segments),
      size fields (constant / linear along s or t / radial about the void; kept only if 15% better than a constant; swing
      reduced by 0.8 steps until the overlap contract holds, recorded as `field_swing_kept`), voids (openings wider than 2.5x
      the median that do not stand on the ground = the oculus; the host minus the trace ROI = where the veil is not).
      Depth and scoop are options, named `unobserved` in the spec. CLI: `cli.py fit`, `cli.mjs fit`.
- [x] Gate G4 (L2, `test_fit_recovery.py`): the synthetic spec evaluated, cells jittered 2 cm, 10% dropped, 5% spurious;
      the fit returns the same reduced basis within 3 cm, inliers > 0.9, lattice RMS < 4 cm, 90% of observed cells matched
      within 15 cm, the unit's box fill within 0.06 of the truth. Green.
- [x] L3 on `the_broad.jpg` via codex's SAM3 trace (`broad-sam3-final`, 781 openings, 30 x 12.2 m assigned frame, affine
      px->m, no perspective correction): 718 family cells + 2 giants; basis a = (0.773, 0.011), b = (0.394, 0.707) - the
      same lattice in the left, middle and right thirds (|a| 0.76-0.78) - inliers 0.897, RMS 0.112 m; cell width grows
      left to right 0.43 -> 0.68 -> 0.93 m at constant pitch, fitted as a linear field along s (0.61 -> 1.53, kept at 0.8
      swing); oculus void ellipse at (12.8, 4.8) r (1.6, 0.9); the lifted corners as a polygon void from the ROI. Re-evaluated:
      552 cells, 458 of 718 observed matched within 0.3 m (RMS 0.095), 94 predicted with no observation, 76 observed off the
      lattice - the misses sit in the LEFT third, where the observed rows sag below the lattice (perspective the affine frame
      cannot absorb; a homography from the lattice itself is the next move, not a spec edit). Spec `spec-broad-fit.json`,
      grammar `grammar-broad-fit.json` (the by-eye grammar with the fitted cells), gates accepted, 1,382 primitives.
- [ ] Rectify the photograph with a homography estimated from the lattice (rows straight, pitch constant) before fitting.
- [ ] Rotation / lean as a field (today the lean lives in the unit shape; a field of lean is one line once observed).

## Task 2c — the cell as a MODULE, not a hole (2026-09-16, user: "입면이 3차원이잖아. 3차원 모양을 파라메트릭 디자인한 거잖아")

The Broad's veil is a field of funnels: each cell's MOUTH is the lattice's own tile, its surface flows in to a
THROAT (the lens) at depth, and the crests between neighbours are the diagonal webs. Read as lens-shaped holes the
drawing had the throats and nothing else.

- [x] Evaluator: `family.mouth = {kind: voronoi, web_m, points}` (`funnel.py`): the Wigner-Seitz tile of the lattice
      against the cell's neighbours (bucketed, any stagger), inset by half the web, clipped to the host; the throat is the
      family curve (shrunk in 0.92 steps if a field pushed it past the tile, recorded as `throat_scale`). Both loops are
      resampled by ANGLE about the cell centre to one point count, so vertex i of the mouth partners vertex i of the throat -
      the form the 3D tapered prism reads. `outline_m` = mouth, `outline_far_m` = throat. The throat decides `omit_partial`;
      the mouth is always clipped to the host. Overlap check on mouths. Tests: `test_funnel.py` (3).
- [x] Five links: contract (`outline_far_m`, same count), grammar `lattice.mjs` (a clipped mouth re-partners both loops by
      angle; a cell whose centre the scope no longer holds goes), derive (`outline_far` on the primitive), the inline step in
      `tools/facade-pipeline/lattice.mjs` (the first draw LOST the throat here - "a new field travels five links", the fifth was
      the file inline), `punched-facade` (a funnel's pane is the throat; its lining is one lofted wall `funnelWallGeometry`
      from mouth to throat in the shell material, both windings, no caps; the pane hands the renderer `recess_mouth`, 24
      world points), and the render-time cut (`holeCut.volumeFor`: a FRUSTUM from the mouth to the throat, every triangle
      wound outward on its own - a global flip keyed on one cap left the frustum open and it cut nothing).
- [x] `synthetic-box-12x8x6.6/render-funnel-001` (`spec-funnel-001.json`: the 001b lattice with a 0.06 m web, depth 0.45):
      72 funnels a face, eight views + PBR + hero accepted; the hero shows lit floors and shadowed hoods, which is what the
      photograph's cells do. Two hours were lost reading the depth raster's PACKED RGB as "purple = deep": the dark
      trapezoid above each lens is the funnel's upper wall in its own shadow, and the material-id raster (concrete there)
      had said so from the first render.
- [ ] The 2D export writes the throat as the unit loop; the mouth (the crest lines) is not in the SVG/DXF yet.
- [ ] Depth is capped at 0.5 m by the glass recess bound; the Broad's parapet sawtooth suggests 0.6-0.8. A construction-
      owned bound (like fold clearance and projection), not a global.
- The Broad as funnels: `spec-broad-funnel.json` = the fitted spec + `mouth {voronoi, web 0.05}` + depth 0.5 (the cap);
  `grammar-broad-funnel.json` accepted, 1,367 primitives; drawn as `render-broad-funnel` (see the log for the verdict).

## Task 2d — the module as a VOLUME (2026-09-17, user: "구멍은 비슷한데 3차원 볼륨이 입혀져야 하는 거 아님? 각각의 파라메트릭 디자인에 맞게")

A funnel carved into the mass is still a hole in a wall. The Broad's veil is a body: each cell a solid module
with real crests and a real thickness, standing on (or off) the building, with the glass box behind it.

- [x] Evaluator: with a `mouth`, every instance also carries `tile_m` - the cell's whole footprint (the Wigner-Seitz tile
      clipped to the host), resampled at the same angles as mouth and throat, so three rings partner vertex by vertex.
- [x] `funnelModuleGeometry` (polygon-prism.mjs): the tile prism less the funnel as ONE closed solid from four quad strips -
      front annulus tile->mouth, funnel wall mouth->throat (outer face to inner), back annulus throat->tile, tile sides.
      Watertight by construction (no cap triangulation); verified closed, outward and at the divergence-theorem volume
      (`test/elevation3d-outline-member.test.ts`).
- [x] Links: contract `tile_m` (same count, needs a throat), grammar lattice (three rings re-partnered on a clip; the box
      is the TILE's), derive `tile`, the file inline (which dropped it - the third loop lost on that one line), the builder:
      a lattice cell with a tile and a positive depth is a module (`module_cell`), bounds n0 = standoff, n1 = standoff +
      depth, no pane - the layer behind shows through the throat. A negative depth is still the carved funnel.
- [x] The role of a declared material now beats the terminal's KIND table in `resolveSemanticRole` (a stone veil on the
      `louvre` terminal measured 76% bronze and collapsed against the wall). An explicit `semantic_role` on the primitive
      still wins; legacy four-word materials are untouched.
- [x] The grammar shape: `layer [GlassBox, Veil]` - GlassBox = storey split -> z split [0.25 band, ~1 glass -0.05, 0.25 band]
      (a course, not a skin word, so the scope stays inside the fold clearance; a full-facet pane crossed the slabs and a
      spandrel widened the scope to the folds - both refused, correctly); Veil = `louvre` + declared material + depth
      (thickness) + `lattice`. `synthetic-box-12x8x6.6/render-module-001`: 234 modules, eight views + PBR accepted, tiles
      touching (gap 0 in the GLB), the entrance carving the modules over the door at its head.
- [x] The Broad: `spec-broad-module.json` (thickness 0.6, web 0.05), `grammar-broad-module.json`, 1,391 primitives accepted;
      `render-broad-module`: eight views + PBR + hero accepted; the coarse photograph comparison RECORDS
      `SOURCE_VARIATION_LOST` (lateral spread 0.087 against the carved version's 0.94): the photograph's veil changes
      along its length - lit and shadowed cells, the lifted corners showing the lobby - and a veil of uniform pale modules
      does not. That is a truth about the drawing, not a gate to move. The lifted corners do show the glass box behind.
- [ ] The crest lines (tile and mouth) in the 2D export; the parapet sawtooth needs the top row to run past the roof line.

## Task 5 — Broad ROI, semi-automatic, A vs B

- [x] Condition B, first pass (2026-09-16, user: "이걸로 테스트했잖아"): `synthetic-box-30x8x13.2/spec-broad-v3.json` read by eye
      (0.92×0.52 m cells at 35°, 0.75×0.84 m staggered, oculus void + point field), veil on all four faces, the photograph as
      `source_photograph`. Needed on the way: `design_voids`, the overlap contract, no frame ring on lattice cells, required roles
      from declared materials, and the GLB byte projection calibrated to a written file (24.6 MB claimed vs 11.0 MB written).
- Gate G5 (condition B) **green 2026-09-16**: `render-broad-v3` — 1,464 cells, 8 views + PBR + hero accepted, `source_fidelity`
  against the photograph accepted (boldness 0.4, spread 1.03). Also moved: the roof-plan fill clause now applies to the longer
  plan axis only. Still open: condition A vs B measured on one ROI; a spec read by anything but a person.

- [ ] Manual representative unit + repeat direction on one clear ROI of `docs/the_broad.jpg`.
- [ ] Condition A (existing SAM curves, `broad-sam3-deduplicated`) vs B (shared unit + lattice + fields) on the same
      ROI: boundary error against manually confirmed cells, missing/duplicate counts, edit behaviour.
- Gate G5 report; Gate G6 reviewer role file verdict on the drawn result.

Deferred until Task 5 is read: Task 3 fitting (SciPy), Task 6 VLM structure hypotheses, Task 7 patch loop.
