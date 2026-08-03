# Approach D: SPAR3D with MASS Point-Cloud Conditioning

## Goal

Turn one detailed architectural isometric into one textured 3D object while preserving the known coarse MASS as strongly as the available local model permits.

## Inputs

- authoritative `mass.obj`;
- one detailed isometric made from that MASS;
- stored camera and normalization transforms;
- held-out top, front, opposite, and locked views for validation.

## Model capability

SPAR3D exposes a user point-cloud path in its official demo and Python implementation. If a point cloud is supplied, it bypasses point-cloud diffusion and sends image features plus the supplied XYZ/RGB points to mesh generation. The demo samples or pads the cloud to 512 points and accepts `.ply`.

## Hosted API versus self-hosting

Stability AI also provides a preview SPAR3D REST endpoint at `/v2beta/3d/stable-point-aware-3d`. It returns a GLB in a few seconds and costs 4 credits per successful call. Its published request schema accepts an image and generation/remeshing parameters, but **does not accept a user point cloud**. It is therefore a fast image-only baseline, not the MASS-conditioned implementation described here.

The MASS-conditioned path must use the open-source Python/ComfyUI implementation on a local or hosted GPU. This is still web-deployable: a browser uploads the image and a very small 512-point PLY to a persistent GPU service. The paper reports about 0.7 seconds of warm inference per object. Expected production latency is dominated by container/model cold start and texture/GLB transfer, not by point-cloud size.

## Recommended adapter

- Sample the complete source surface rather than using OBJ vertices alone.
- Preserve detached components with stratified per-component sampling.
- Store source bbox center and maximum extent before normalization.
- Project the isometric image onto visible point colors; use neutral material colors for hidden points.
- Prefer a perspective re-render aligned with SPAR3D's expected conditioning camera for the first experiment.
- Inverse-normalize the generated mesh and compare landmarks as well as bbox dimensions.

## Resource envelope

The official repository reports roughly 6-10.5 GB of VRAM depending on inference settings, with a low-VRAM mode around 7 GB. A 12 GB RTX 4070 Ti should be a plausible test target. Model files are approximately 6.8 GB and gated by Hugging Face access.

## Acceptance boundary

Pass only if the same generated GLB preserves the candidate identity in held-out views and the required global and local measurements. Otherwise use the generated mesh only as an appearance/detail donor and keep the exact MASS as the drawing geometry.
