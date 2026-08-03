# MASS-Conditioned SPAR3D vs Tripo Test Plan

## Candidate

Start with `creative-013`: 184 vertices, 364 triangles, one connected component, and an approximate source bounding box of 24.36 x 12.23 x 9.90.

## Shared input

Create one detailed architectural isometric from the exact MASS in a recorded camera. The image must retain the mass silhouette, major curvature, bridge span, and lower block.

## Track A: local SPAR3D

1. Sample a 512-point surface cloud from the exact MASS.
2. Normalize it and record the inverse transform.
3. Run SPAR3D with the detailed image and external point cloud.
4. Restore source coordinates and render held-out views.

## Track B: Tripo fallback

1. Send the same detailed image once to Tripo image-to-model.
2. Restore orientation and bbox dimensions with similarity/axis scaling.
3. Register source and result; apply anchored deformation only if needed.
4. Render the same held-out views.

## Gates

- global bbox error after restoration: effectively zero;
- source landmark error: reported separately for ends, curve extrema, roof breaks, concavities, and component boundaries;
- silhouette IoU on top/front/opposite and locked views;
- no lost component or filled major void;
- one GLB produces every presentation view;
- camera, transform, model version, seed, and input hashes are reproducible.

## Decision rule

Choose SPAR3D if its point-conditioned result materially improves local landmark and held-out silhouette accuracy. Choose Tripo only if it is visually better and its registration errors remain within the agreed presentation tolerance. If neither passes, retain exact source geometry and transfer only appearance/detail.
