# Facade image to editable curve CAD

The active trace path preserves each observed opening boundary and its location.
It writes cubic Bezier SVG paths and native DXF SPLINE entities in editable
per-opening blocks. It does not recover construction depth or a latent repeat
grammar from one photograph. This is a local implementation using public
components, not IAAC's original code.

## Run from the repository root

Install geometry dependencies with `python -m pip install -r tools/facade-vision/requirements.txt`.
Neural adapters require the separately installed upstream repositories and
checkpoints under the sibling `clone/sam3` and `clone/Grounded-SAM-2` directories.

```powershell
node tools/facade-pipeline/cli.mjs trace creative-020 ../docs/the_broad.jpg broad-curves --roi ../docs/facade_audit_20260913/broad-roi.json --engine sam3 --tile-size 512 --prompt "hole . opening"
node tools/facade-pipeline/cli.mjs edit <facade_model.json> <output-directory> --edits tools/facade-vision/examples/radial-edit.json
node tools/facade-pipeline/cli.mjs cad <edited-facade_model.json> <output-directory>
python tools/facade-vision/verify_cad.py <output-directory>
```

The last command reads the actual DXF back, checks all instance transforms and
renders `cad-review.png`; it additionally requires matplotlib.

## Inputs and model choices

ROI JSON needs `polygon_px`, `width_m`, and `height_m`; optional
`image_sha256` binds the selection to exact source bytes. Coordinates use the
original image, not a display thumbnail. Dimensions are assigned design dimensions
unless measured independently. The mapping is affine, not perspective
rectification. Broad's sample uses an assigned 30 x 12.2 m frame, not survey data.

- `--engine sam3`: SAM3 concept segmentation, with its own text encoder; no DINO.
- `--engine sam2`: Grounding DINO boxes followed by SAM2.1 masks. Detector
  failures are errors. Unprompted automatic masks are not mixed into the result.
- `--engine classical`: explicit adaptive contrast baseline. Shadows and texture
  may be selected; this is not semantic opening recognition.
- `--mask path.png`: a provided full-resolution white-foreground binary mask.

`--tile-size 512` retains small components in dense facades. Zero (the default)
uses the full ROI. Overlapping tiles are deduplicated by actual mask IoU, retaining
the more confident observation. Tile size can affect both coverage and semantics;
inspect the overlay. Models are alternatives, not an ensemble run silently.

## Artifacts and acceptance

Each trace writes the source copy/hash, ROI, mask, observation JSON, segmentation
overlay, `facade_model.json`, `facade.svg`, `facade.dxf`, reprojection and report.
Curves retain internal holes; if smoothing changes loop count, that unit retains
its observed polyline, explicitly marked in the model. No convex hull or invented
hexagon substitutes for a detected shape.

The geometry gate is mask IoU >= 0.90 and symmetric boundary p95 <= 2 pixels.
Pixel coverage is evaluated at 8x sampling in cropped windows. Maximum error is
also reported. This compares exported curves with selected masks: it does not
measure missed openings, architectural identity, or semantic correctness.
`requires_semantic_review` remains true. A valid DXF alone is not full acceptance.

## Parameter edits

The editable source of truth is the curve document. Its `units` retain local
curves; `instances` retain measured centres/dimensions and editable scale,
rotation and offset. Global `parameters` provide size, rotation and spacing
about the facade centre. `edit` copies the document and records `design_edits`.

Explicit radial and linear fields drive `scale_u`, `scale_v`, and
`rotation_deg` through `grades`. Radial weight is
`max(0, 1 - distance/radius)^falloff`; linear weight is clamped projection from
`start_m` to `end_m`. Fields evaluate measured centres; scale grades multiply,
rotation grades add. These are authored design controls, not inferred original
rules. Unknown attributes, missing field references, invalid scales and broken
loops are rejected. Edits may overlap or exceed the frame; they need design
review and are not fabrication approval.

## Relationship to the existing 3D engine

`trace` now ends at faithful 2D curve CAD. It does not emit the old heuristic
grammar that replaced the source with floor-band rows and a median opening.
`grammar_synthesizer.py`, `field_fitter.py`, typology and brightness-based scoop
estimation remain legacy experiments and are not called by trace.
The existing `check/draw/render` grammar workflow remains available for authored
3D designs on the immutable mass. Curve-to-3D attachment and rule inference are
separate unfinished capabilities; no four-view 3D reconstruction is claimed here.

## Tests

```powershell
python -m pytest tools/facade-vision/test -q
node --experimental-strip-types --test test/elevation3d-outline-member.test.ts test/elevation3d-facade-field-grade.test.ts test/elevation3d-source-fidelity.test.ts test/elevation3d-source-check.test.ts
```
