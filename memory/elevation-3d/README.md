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
