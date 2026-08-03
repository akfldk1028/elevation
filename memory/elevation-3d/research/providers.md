# Provider Review

## Tencent Hunyuan3D 3.1

Best functional match. Its texture endpoint accepts OBJ/GLB plus reference or multi-view images. It supports PBR, requests UV preservation, and produces a 3D result. Primary risk: provider output still requires independent geometry verification.

## Alibaba Wan 2.7 / Qwen Image

Best generic image fallback. Wan supports larger multi-image reference packages; Qwen supports strong editing controls, negative prompts, and multiple variants. Neither consumes arbitrary 3D camera matrices or guarantees UV-consistent output.

## Volcengine Seedream

Useful low-cost multi-image generation comparison. It can accept multiple reference images and generate coherent series, but it remains an image API rather than a mesh texture API.

## Tripo

Good web-native multi-view-to-3D and GLB delivery, but its normal workflow infers new geometry. It is excluded from the primary test because geometry identity is immutable.

## Local Hunyuan3D-Paint

Potential later fallback with no per-call provider fee. Current Windows and VRAM issue reports make it a poor first deployment path on a 12GB workstation. It is retained as a research option, not one of the first two web paths.
