# ADR-001: Evaluate Two Web Strategies

Status: accepted for design

## Decision

Implement comparable dry-run adapters for:

1. Tencent Hunyuan3D direct mesh texturing.
2. Alibaba Wan/Qwen multi-view generation followed by Three.js projection.

## Reason

The direct texture API is closer to the desired output but may mutate geometry or handle architectural facade structure poorly. The image-plus-projection path preserves local geometry control but may fail at seams and portable texture baking. A single-provider design would leave no credible fallback.

## Excluded first paths

- Blender/ComfyUI client installation: conflicts with zero-install web delivery.
- Tripo multi-view-to-3D: regenerates geometry.
- local Hunyuan3D-Paint: operational risk on the current Windows 12GB GPU environment.
