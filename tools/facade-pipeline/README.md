# Generated perspective to architectural drawings

The `agent` command runs the complete workflow on a prepared, immutable building mass:

```
mass -> image generation -> source feature inventory -> SAM observations
     -> FacadeGrammarV3 transcription -> compile and render -> visual review
                                     ^                       |
                                     +---- located repairs --+
```

```powershell
npm run facade:perspective -- creative-020 my-facade --idea "Pale panels with curved diagonal openings and gradual size variation"
```

To continue from an existing generated concept without generating another design:

```powershell
npm run facade:perspective -- creative-020 my-transcription --idea "Reproduce this facade" --concept <concept.png> --engine sam3 --tile-size 512 --attempts 3
```

Use a new run name per invocation. Default maximum is three transcription attempts (configurable 1–5).
To continue a stopped job after fixing the engine or prompt, use the same name with `--resume`
and `--idea`. This verifies the original mass/image hashes, reuses observation and segmentation,
and appends up to `--attempts` new attempts. It refuses an active or already accepted job.
Add `--rerender` with `--resume` to rebuild the last authored grammar after an engine fix,
without another author call. The rebuilt drawings still undergo source comparison and visual review.
Prepared mass data and output roots follow `elevation-agent.json`. Existing generation artifacts are copied
into the run; changing the source or mass during a run fails the authority check. This command uses the
local Codex CLI/image tool lane, not the old paid provider ledger. Its runtime and model must be available.

## What actually feeds the drawing

The transcriber receives the **generated perspective**, current v3 schema and mass brief, an image-based
feature inventory, the SAM overlay, measured positions, and representative observed unit outlines.
The original bare mass thumbnail is not substituted for the designed perspective. A feature-to-rule map
accounts for visible source features, and each grammar must name the exact source image.

SAM3 and Grounding DINO+SAM2 are selectable observation engines (`--engine sam3` or `sam2`). Their
failures are recorded, not relabeled as another model's success. Observations are auxiliary evidence;
perspective pixel coordinates and their traced DXF are not orthographic facade metres.

The v3 compiler builds on the fixed mass and produces the actual orthographic drawing pack. The reviewer
sees the concept, all four elevations, plan, roof plan, two axons and hero. A failed review returns to the
transcriber with the same concept. It does not regenerate a different facade to conceal a mismatch.

## Receipts and completion

`<run-name>.agent/workflow.json` records stages, source/mass hashes, model prompt/answer receipts,
attempts, checks, render paths and reviews. Each actor's prompt, JSON answer and events are retained.
Every successful drawing pack has artifact hashes. `ok: true` requires:

- source and mass identity preserved;
- a valid v3 grammar accounting for source features;
- all eight technical views plus hero;
- source comparison accepted;
- visual review `YES`, all supplied views checked, zero discrepancies;
- no declared unrepresented source features.

`needs_correction`, `concept_rejected`, or `failed` exits nonzero and keeps evidence for engineering work.
An automated visual reviewer is evidence, not a guarantee that every facade or construction detail is correct.
Hidden faces remain inferred; a single perspective does not establish them. Curves outside the v3 polygon
budget require an engine extension instead of a fake rectangle/hexagon substitution.

Source transcriptions preserve equal-sized openings, repeated floors and flush roof edges. The design
hierarchy metrics are recorded instead of forcing extra piers or cornices. The presentation does not
demand an added opaque trim role solely to show a fourth material; required glass/frame/wall evidence
and geometry checks remain active. `entrance.segment_id` and `entrance.u_min_m` can locate the primary
entrance on a verified ground facet. Additional authored ground doors survive as secondary entrances.
Outlined recessed openings receive contour frames and continuous wall returns in the compiled mesh.

The earlier `trace/cad/edit` commands remain available for source-plane curve CAD. They are not the full
perspective-to-orthographic workflow. The older paid brick harness and the design-only director are separate
specialized routes; changing their brick text alone would not change their typed geometry contracts.

## Parametric modules on nonrectangular walls

When automatic sizing must simplify the module section to fit a pleated mass,
`apply` uses the source wall polygon instead of its inscribed opening rectangle.
The host has `boundary_policy: "preserve_pattern"`; its segments carry `rings_m`,
`u_min_m`, and a registered `chart_affine` mapping into the shared pattern.
Sparse `active_indices` retain the lattice basis and phase while
omitting cells that never touch the wall domain.

The evaluator intersects each complete funnel solid with that polygon. The
resulting `mesh_uzn` uses canonical segment u, host z, and fractional outward
depth. `aperture_area_m2` measures the original throat surviving the cut. A cut
does not reposition or shrink the aperture, and solid fragments remain in the
reported instance count. CAD exports the evaluated cap boundaries; 3D uses the
same vertices and triangles under the same model hash.

The grammar opts in through `lattice.scope: "wall_patch"`, currently restricted
to positive-depth louvres on the whole facet. The validator and compiler check
closed topology and containment against independently recovered source wall
triangles. This does not enlarge the mass, the ordinary rectangular opening
scope, or its clearance permissions. Polygonal glass backing uses the separate
`lattice.scope: "wall_openings"` capability: actual wall boundaries are inset by
the existing fold clearance and clipped to the existing slab-clear zones. It
does not inherit the veil's opening-clearance exceptions. Slab courses remain.
Same-facet module packing preserves every triangle and records cell provenance
as a table (`cell_columns` and `cells`) rather than repeating JSON field names.

Automatic sizing tests complete-design scales against the fixed 25% maximum
solid-fragment share, then refines the last search interval. Fractions are not
monotonic, so it records every tested scale and does not claim a global optimum.
Explicit scale edits and legacy hosts retain their established behavior. Exact
vertex, index, and GLB byte gates still apply after this inexpensive 2D search.

Chart registration stitches additional source edges only when orientation and
the existing worst affine distortion are preserved. Remaining cuts are explicit
in `chart-registration.json`; a connected chart is not a claim of periodic wrap.
Shared source-vertex offsets close the projected module joints, with local taper
where a full-depth offset would invert geometry or exceed the projection bound.

Technical material, normal, and packed-depth images are exported as exact
single-sample byte rasters. Multisample averaging of packed depth bytes creates
false creases; presentation images retain their normal antialiasing.

This is a clipping capability, not a guarantee of globally seamless mapping on
a nondevelopable mass. Check the cropped elevations and the retained solid-part
ratio; a valid mesh or small GLB is not evidence of photographic fidelity.
