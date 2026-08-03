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
- Final PNG: `D:/Data/50_ELE/elevation-3d-e2e-results/creative-013/competition-front-20260803-001/competition-elevation/front/front.png` (`1e852025748d909e8d43980cb42cc1d9612f010ad53a8d6036a7835d1c9cd787`, 2400 x 2400).
- SVG: `front-annotations.svg` (`c68e9226554057b4808d4b6cf726673dcbf1d6c84881ab83ec26f5fb1be09f47`); dimensions: `front-dimensions.json` (`1fee69d36a532ee450c4e351fa7367b06867a8bbc6a28d808fd719a24ecea054`); base manifest: `front-base-render-manifest.json` (`c9a20de8e168530ee870c77a9ea523d11b8feef8ce59d0cecc865d28286dbeba`); final manifest: `front-render-manifest.json` (`78fa597227b754f28533e3d380cd234be8260f88394c51cac0b90671249b29bf`); validation: `front-validation.json` (`7e3940539bf62be215db2e28f8149dd84eebb99359cfd11eb1aeeb3741c28f6b`). The presentation base and material-ID/depth/normal passes are also retained and hash-bound for independent validation.
- Validation: accepted with no codes. Loaded-scene bounds are `x=215..2184`, `y=805..1594`; equal scale is `79.60685862 px/m`; total/strong base edge densities are `1.6074%/1.4953%`; same-material seams and connected seam segments are zero; annotations have no content/text-box collisions and retain 48 px page clearance.
- Dark-detail decision: six narrow components / 733 pixels are retained. Four components / 723 pixels are bronze/opaque geometry; the remaining 7-pixel (`1455..1461, y=807`) and 3-pixel (`356..358, y=1016`) components have finite selected-GLB depth and are therefore preserved as authored depth silhouettes. Suppressed pixels: zero; invalid pixels: zero; selected GLB unchanged.
- Adversarial validation: changing visible SVG `9900` to `9901` while retaining authoritative data attributes and rehashing/recompositing all dependent files is rejected with `DIMENSION_MISMATCH`. Hiding authoritative `9900` with `opacity=0` and overlaying an unbound visible `9901` is also rejected because the persisted SVG must byte-match the authoritative deterministic rebuild. A rehashed black seam-heavy final PNG is rejected with `LINE_DENSITY_EXCEEDED` and `MATERIAL_VISIBILITY_INVALID`. Camera, content bounds, dark/edge/seam metrics, SVG text/layout, and protrusion evidence are recomputed from persisted bytes.
- Visual review: the front reads as a materially filled competition elevation with separate annotation lanes. It remains an orthographic drawing rather than the later photoreal axon stage. Remaining elevations and axon must wait for human approval of this front layout.

## Competition all-views delivery v1 — 2026-08-04

- Stable run/candidate: `D:/Data/50_ELE/elevation-3d-e2e-results/creative-013/competition-all-views-20260803-001` / `creative-013`. Packaging reused the reviewed Task 2–4 pixels and evidence; it did not rerender the eight accepted drawings.
- Geometry authority: run-local `enriched.glb` is 1,723,256 bytes with SHA-256 `cc6c6bdc80f4bfe163959286d1e74525fc367c16509b77c0b17dfaf99d270986`. Every view and the viewer config bind to this hash; no alternate mesh/GLB is present.
- Manifest: `all-views-manifest.json` (`553a703ba3a052fbb442a900697aa0bafae1f5c250d4db6b067670298af2f636`). Validation: `validation.json` (`5c74517de5abb15d73f676788cdf8fbd607b25797dc18266639544fb16d82f55`), accepted with no codes. All eight PNGs are 2400 x 2400.
- View PNG SHA-256: front `1e852025748d909e8d43980cb42cc1d9612f010ad53a8d6036a7835d1c9cd787`; back `deaab0a82c7e95fef34ee6b124419c73ec556d3ea9ee49d881e1aa2f66f9a6c0`; left `6642d32941e8c3b3e5cc8f6dfdc42140000d684112dd20e032483d55edcb4088`; right `8ef57e584d4008f6748ef9719ea851ffb94eb618084e21f1fdccbedd5fcbbf25`; plan `e1de87d9cf962480a015b7739599ac99ca390fa92011e0095147b064aa6ca15f`; top `2fd7836e520fc25ad8dc90e54884cf1dc5cbe7dc7577fce7258997ad9a7d35aa`; axon `dd088f9b1dd48770e4718a6342c147be3caf7c05bd69aa18056acbedd96fbf0e`; opposite axon `e9890e7abfc1e57d2094b83465cc09c4f350fb61ddae391ff37b0167a788a711`.
- Metrics: elevations share `79.60685861961869 px/m`; front/back bounds are `215,805–2184,1594`, left/right `698,805–1701,1594`; plan/top seam fractions are `3.5444707e-6` / `1.5213475e-6` with zero 12 px seam components; axon/opposite minimum margins are `18.500%` / `17.125%`, with horizontal depth dot approximately `-1`.
- Material preset: `competition-warm`, SHA-256 `63de5b10ead4a122f7f3a3cac9a12f4226b0ea6d93d6da9047e28573003366d1`. Viewer switches warm/neutral/stone materials in memory without reloading geometry.
- Viewer: `viewer/index.html`; config SHA-256 `2d91164a1b3807226bff20d306ef3c696e0c4f541df0349e63eb3995308cf0cd`. It exposes OrbitControls orbit/pan/zoom, reset, eight presets, palette selector, GLB download, artifact links, selected SHA/current state, and validation badge.
- Browser evidence: `browser-verification/browser-verification.json` (`f0b9506e6c8df9f6a99a9f223c622ad02d98b99f15d61962978182e9b1a803c0`). Chrome loaded one GLB, activated eight views and three palettes, rotated/zoomed/reset, opened eight PNGs with HTTP 200, and recorded zero console errors. Screenshot hashes: initial `21eadc92093ae964fb0f1e3f9482f323e0fb71b393492c95d468411836029ca5`; interacted `470e980c89b628e6e6b771d0e049f90cfa37cc93a87910bc8c3474588a35f508`.
- Failure history: required RED was `ERR_MODULE_NOT_FOUND`; first browser run exposed a legacy `config.cameras.views` dereference; verification then exposed a favicon-only 404. The all-views branch guard and inline favicon resolved both before final GREEN.
