# ADR-003: Condition Single-Render Reconstruction with the Source MASS

Status: accepted as the next local feasibility test

Date: 2026-08-03

## Decision

Use one detailed architectural isometric render together with a surface point cloud sampled from the exact source `mass.obj` as inputs to local SPAR3D. Generate one textured GLB, restore the source coordinate system and dimensions, and extract all presentation elevations, plans, and axonometric views from that same GLB.

Keep Tripo image-to-model followed by registration as the API fallback. Do not generate each elevation independently.

## Why this supersedes image-only generation as the first choice

SPAR3D's official implementation accepts an externally supplied point cloud in addition to the conditioning image. Its point-cloud intermediate is therefore able to carry the known MASS into reconstruction rather than asking a provider to infer all hidden geometry from one view. This directly fits the intended shortcut:

`exact MASS -> one detailed isometric -> one conditioned 3D -> all drawings`

The source point cloud is a geometric scaffold, while the render supplies architectural appearance and visible detail.

## Geometry procedure

1. Sample 512 surface points from the source OBJ, including narrow ends, concavities, roof changes, and detached components.
2. Normalize them with the same bounding-box convention used by SPAR3D; store the inverse transform.
3. Render the exact MASS with a camera compatible with the model's conditioning camera.
4. Generate or edit one detailed isometric image without changing its silhouette or camera.
5. Submit that image and the sampled point cloud to SPAR3D.
6. Apply the stored inverse transform and a rigid registration to the result.
7. If necessary, use source-anchored non-rigid deformation or transfer appearance onto the exact MASS.
8. Reject any result that fails held-out silhouettes or local landmark tolerances.

## What dimension matching can and cannot do

Restoring the inverse normalization can make overall width, depth, height, origin, and orientation exact. A bounding-box scale alone cannot recover a courtyard, curved spine, opening, floor position, or detached block that the generated mesh got wrong. Those require point-cloud conditioning, landmark constraints, non-rigid fitting, or retaining the source mesh for technical geometry.

## Known risks

- SPAR3D uses only 512 conditioning points and is trained mainly on isolated objects, not architectural BIM.
- Its high-level image path assumes a perspective camera; the dataset views are orthographic. The first test should re-render the MASS in the expected perspective or inject a tested low-level camera batch.
- Gated model weights are about 6.8 GB and require accepting the Hugging Face terms. No weights should be downloaded until that access is available.
- A visually strong result is a concept/presentation model unless all required local dimensions pass explicit checks.

## Fallback

Create one detailed isometric from the exact MASS, call Tripo once, then perform orientation, scale, rigid registration, and source-anchored deformation. This is acceptable for presentation drawings when dimensions are checked or annotated from the source MASS, but it is weaker than conditioning generation with the source point cloud.
