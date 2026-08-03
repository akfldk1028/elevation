# Render-to-3D Architectural MASS Research

This folder is the durable research memory for enriching an exact architectural MASS into one complete detailed 3D object and deriving all later renders and drawings from that shared GLB.

## Current conclusion

Current production direction:

1. Keep the exact `mass.obj` as the full visible/hidden geometric envelope.
2. Use an approved detailed architectural isometric as the appearance target.
3. Consume camera matrices, facade planes, floor guides, and the geometry program.
4. Generate real shallow facade/detail geometry and PBR materials on the exact MASS.
5. Extend the facade grammar to hidden surfaces under deterministic geometric constraints.
6. Export one complete enriched GLB in source coordinates.
7. Render all 2D plans, elevations, and axonometric views from that same GLB.

This is not per-elevation image generation and not image-only mesh reconstruction. The image supplies architectural design; the complete candidate package supplies geometry and constraints.

Hosted SPAR3D and Tripo are rejected as production geometry sources after the held-out-view failure. They remain optional research baselines.

## Reading order

1. `contract/problem-definition.md`
2. `contract/input-data-map.md`
3. `decisions/ADR-004-exact-mass-architectural-enrichment.md`
4. `approaches/approach-e-silhouette-locked-render-variants.md`
5. `evaluation/detailed-render-spar3d-test-2026-08-03.md`
6. `research/providers.md`
7. `research/single-image-validity-review-2026-08-03.md`
8. `sources/bibliography.md`

For reusable appearance generation and future material/facade variants, also read `approaches/approach-e-silhouette-locked-render-variants.md`.

## Status

- Current architecture correction: exact-MASS architectural enrichment recorded on 2026-08-03.
- SPAR3D weights: not downloaded; gated Hugging Face access is required.
- Official Stability SPAR3D API: fast image-only baseline (4 credits), but it cannot receive the source MASS point cloud.
- MASS-conditioned SPAR3D remains web-deployable through a persistent self-hosted GPU API; avoid scale-to-zero cold starts.
- Live API test: succeeded on `creative-013` in 6.741 seconds and returned a 530,672-byte GLB; see `evaluation/stability-spar3d-live-test-2026-08-03.md`.
- Detailed-render stage: first photorealistic concrete/glass isometric variant generated and selected for the next SPAR3D comparison.
- Detailed hosted-SPAR3D result: near-camera axonometric appearance passed, but held-out plan/elevation geometry failed; see `evaluation/detailed-render-spar3d-test-2026-08-03.md`.
- Tripo credential: configured in ignored local `.env`.
- Tripo API balance at last check: 0 credits.
- Stability paid generation calls: two successful 4-credit SPAR3D tests; 17 credits remained after the detailed-image test.
- Existing Hunyuan/Wan implementation: retained as superseded experimental work, not the current primary workflow.

## Unified production E2E — 2026-08-03

- Candidate/run: `creative-013` / `task6-e2e-20260803-001`.
- Invocation: `elevation_3d_run` used the source dataset at `D:/Data/50_ELE/MAAS_ELEVATION_TEST_SET_20260730` and committed approved design `assets/creative-013/approved-detailed-isometric-v1.png`.
- Selection: `v001` passed on attempt 1; no correction was required and fallback was false.
- Validation: accepted with no failure codes. Source and artifact base primitive hashes both equal `f58ae54ce4bbb6397db2a20fb3ec610e75656572625b75726d54c9a1c1ed132b`; maximum bounds excess was `0.18000025 m` within the `0.19 m` allowance; no drawings were missing.
- GLB: `D:/Data/50_ELE/elevation-3d-e2e-results/creative-013/task6-e2e-20260803-001/versions/v001/enriched.glb` (`716d8c26934d862ac8b6b7966afae36f63275aa4de4b960d524a687630310fc9`, 239,540 bytes). It parsed successfully with `NodeIO`.
- Drawings: all seven outputs are under `D:/Data/50_ELE/elevation-3d-e2e-results/creative-013/task6-e2e-20260803-001/versions/v001/drawings/hunyuan` (`plan`, `front`, `back`, `left`, `right`, `top`, `axon`).
- Final/report: `D:/Data/50_ELE/elevation-3d-e2e-results/creative-013/task6-e2e-20260803-001/final.json` and `D:/Data/50_ELE/elevation-3d-e2e-results/creative-013/task6-e2e-20260803-001/versions/v001/validation.json`.
- Provider impact: zero provider calls. The autonomous path is local-only, so no paid-provider balance query or mutation was performed.
- Durable event: `runs/creative-013.jsonl` contains the single redacted outcome, including metrics, empty failure codes, correction state, fallback state, and exact artifact locations. Its `run_dir` is an explicit machine-local absolute base, not a portable path; selected GLB, validation report, and all seven drawing paths are stable paths relative to that base on this machine.

Durable run and candidate events use the v2 memory schema. Each attempted version appears exactly once with its terminal status, relative artifact paths and SHA-256 values, validation result, structured failure summary, and correction/grammar delta. Free-form exception objects are never retained; all persisted strings are recursively credential-redacted. Cancellation after run creation records the active version as `cancelled`, writes one final event, and does not start another version.

## Competition front elevation v1 — 2026-08-03

- Run/candidate: `competition-front-20260803-001` / `creative-013`; palette `competition-warm`; provider calls: zero.
- Geometry authority: selected GLB `cc6c6bdc80f4bfe163959286d1e74525fc367c16509b77c0b17dfaf99d270986`. Presentation cleanup did not crop, transform, or alter the GLB.
- Exact displayed dimensions: overall width `24361`, overall height `9900`, levels `EL. +0.000/+3.300/+6.600/+9.900`, three floor intervals `3300`, facade `24361 x 9900`, scale bar `5 m`. Values were recomputed from `exact-mass.POSITION`, authored facade planes, and floor guides with a 1 mm annotation tolerance.
- Final PNG: `D:/Data/50_ELE/elevation-3d-e2e-results/creative-013/competition-front-20260803-001/competition-elevation/front/front.png` (`3f0b66408c18a963b15be4e0be6a746f3bc9db89469f8d1fd4aaac7e75ab7fff`, 2400 x 2400).
- SVG: `front-annotations.svg` (`a6db347beaa2eef6d405f83efba1da9e11ea906eeb7248745aad562e9b2e6fd9`); dimensions: `front-dimensions.json` (`1fee69d36a532ee450c4e351fa7367b06867a8bbc6a28d808fd719a24ecea054`); render manifest: `front-render-manifest.json` (`b880b18e5d32d71db78dc58c7809a0b8b43eadd5b1a9014528e0020b0a0dbfbb`); validation: `front-validation.json` (`a11b0d911a3014f6a6a9e9fe3e61f35a6c28347011b319b79f509ba7893f412b`). All files share the final PNG directory.
- Validation: accepted with no codes. Loaded-scene bounds are `x=215..2184`, `y=805..1594`; equal scale is `79.60685862 px/m`; total/strong base edge densities are `1.6074%/1.4953%`; same-material seams and connected seam segments are zero; annotations have no content/text-box collisions and retain 48 px page clearance.
- Dark-detail decision: four narrow components / 723 pixels were proved authored bronze/opaque geometry through material-ID plus finite metric depth. Two disconnected post-process speckles / 10 pixels with no semantic material were suppressed only in the final screen composite; invalid authored-geometry pixels are zero and the selected GLB remains untouched.
- Visual review: the front reads as a materially filled competition elevation with separate annotation lanes. It remains an orthographic drawing rather than the later photoreal axon stage. Remaining elevations and axon must wait for human approval of this front layout.
