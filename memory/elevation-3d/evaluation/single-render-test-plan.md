# Single Render to 3D Test Plan

Status: bounded concept-feasibility benchmark. Passing this test does not authorize technical drawing use.

## Hypothesis

A single isometric render may be sufficient to generate a visually recognizable concept GLB faster than building facade views independently. It is not expected to reproduce measured hidden geometry.

## First candidate

Use `creative-013`, matching the user-provided example. Its curved bridge form, separated lower block, and held-out top/front views make reconstruction errors easy to detect.

## Preparation

1. Verify dataset manifest and source hashes.
2. Crop only the isometric panel from `candidate/render.png`.
3. Remove the word `isometric`, panel border, and excess blank margin.
4. Record crop coordinates and SHA-256.
5. Keep opposite/top/front and all `mass/views/*.png` out of the provider request.
6. Record the intended task body with secrets redacted.

## One live request

- provider: Tripo;
- type: `image_to_model`;
- input count: one PNG;
- texture: false;
- PBR: false;
- automatic retries: zero;
- candidate count: one;
- output: download GLB immediately after success.

## Validation

1. Load the generated GLB and source OBJ.
2. Determine a rigid orientation transform and uniform scale.
3. Compare bounding-box proportions and component count.
4. Compare silhouettes against held-out isometric/opposite/top/front evidence.
5. Review curve continuity, bridge span, lower block separation, openings, and major corners.
6. Render all standard views from the aligned generated GLB.

## Pass criteria

- one coherent 3D object is returned;
- dominant proportions and curvature remain recognizable;
- major voids and separated components are not lost;
- held-out top/front/opposite silhouettes are recognizably consistent;
- all final images are rendered from the same generated GLB;
- no manual mesh remodeling is required for the proof of concept.

Exact vertex count, face count, and topology identity are recorded but are not pass criteria.

## Interpretation

- Pass: the method may be used for concept visualization and presentation-view generation.
- Near pass: test one detailed architectural render before rejecting the method.
- Fail: do not add more seeds automatically; return to the exact source OBJ workflow.
- Never infer: a visually convincing pass does not make dimensions, floor plates, elevations, or sections technically authoritative.
