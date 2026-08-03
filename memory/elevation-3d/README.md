# Render-to-3D Architectural MASS Research

This folder is the durable research memory for reconstructing one 3D architectural MASS from an existing isometric render and deriving all later renders and drawings from that shared 3D object.

## Current conclusion

Primary workflow:

1. Extract the isometric panel from the candidate's existing `render.png`.
2. Submit that single image once to Tripo `image_to_model`.
3. Download one generated GLB.
4. Render every presentation view and drawing from that GLB.
5. Compare the generated GLB against the source OBJ and the unused reference panels.

This is not per-elevation image generation, multi-view image submission, or fixed-mesh texturing. The source mesh remains the geometric reference, but exact vertex/topology identity is not required because image-to-3D reconstructs new geometry. MASS identity is judged by proportion, silhouette, curvature, voids, and view agreement.

## Reading order

1. `contract/problem-definition.md`
2. `contract/input-data-map.md`
3. `decisions/ADR-002-single-render-to-3d.md`
4. `approaches/approach-c-tripo-single-image.md`
5. `evaluation/single-render-test-plan.md`
6. `research/providers.md`
7. `sources/bibliography.md`

## Status

- Current architecture correction: recorded on 2026-08-03.
- Tripo credential: configured in ignored local `.env`.
- Tripo API balance at last check: 0 credits.
- Paid generation calls: none submitted.
- Existing Hunyuan/Wan implementation: retained as superseded experimental work, not the current primary workflow.
