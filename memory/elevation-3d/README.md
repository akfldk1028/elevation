# Render-to-3D Architectural MASS Research

This folder is the durable research memory for reconstructing one 3D architectural MASS from an existing isometric render and deriving all later renders and drawings from that shared 3D object.

## Current conclusion

Current recommended feasibility experiment:

1. Produce one detailed architectural isometric from the exact MASS.
2. Sample a 512-point surface cloud from the source `mass.obj`.
3. Run local SPAR3D with the image and point cloud together.
4. Restore the original coordinates and dimensions.
5. Render every presentation view and drawing from the same generated GLB.
6. Compare local landmarks and held-out views against the source.

This is not per-elevation image generation. It is a test of the professor's proposed shortcut with a geometric scaffold supplied at reconstruction time.

Tripo image-to-model plus source registration remains the API fallback. The current brown `render.png` is suitable only for pipeline validation because it contains no added architecture detail; the meaningful test needs a newly authored or AI-generated detailed isometric.

## Reading order

1. `contract/problem-definition.md`
2. `contract/input-data-map.md`
3. `decisions/ADR-003-mass-conditioned-single-render-to-3d.md`
4. `approaches/approach-d-spar3d-mass-conditioned.md`
5. `evaluation/spar3d-vs-tripo-test-plan.md`
6. `research/providers.md`
7. `research/single-image-validity-review-2026-08-03.md`
8. `sources/bibliography.md`

## Status

- Current architecture correction: MASS-conditioned reconstruction recorded on 2026-08-03.
- SPAR3D weights: not downloaded; gated Hugging Face access is required.
- Official Stability SPAR3D API: fast image-only baseline (4 credits), but it cannot receive the source MASS point cloud.
- MASS-conditioned SPAR3D remains web-deployable through a persistent self-hosted GPU API; avoid scale-to-zero cold starts.
- Tripo credential: configured in ignored local `.env`.
- Tripo API balance at last check: 0 credits.
- Paid generation calls: none submitted.
- Existing Hunyuan/Wan implementation: retained as superseded experimental work, not the current primary workflow.
