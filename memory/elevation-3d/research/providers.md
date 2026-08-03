# Provider Review

## Tripo image-to-model — current primary

Best operational match for the corrected goal. Submit one cropped isometric render and receive one reconstructed GLB. It is web-native and requires no local model installation. It infers new geometry, so exact source topology preservation is neither expected nor required; the result must instead pass MASS-identity and held-out-view checks.

Do not use `texture_model` for this experiment. Do not use `multiview_to_model` unless the single-image experiment fails and a later decision explicitly authorizes a fallback.

## Tencent Hunyuan3D 3.1

Superseded as the primary path. It textures an existing mesh, which is a different task from reconstructing a rendered object into a new 3D model.

## Alibaba Wan 2.7 / Qwen Image

Superseded for the first experiment. These tools generate images, not the requested 3D object.

## Volcengine Seedream

Useful low-cost multi-image generation comparison. It can accept multiple reference images and generate coherent series, but it remains an image API rather than a mesh texture API.

## Local Hunyuan3D-Paint

Not applicable to the primary reconstruction test because it paints an existing mesh. Retained only as later research.
