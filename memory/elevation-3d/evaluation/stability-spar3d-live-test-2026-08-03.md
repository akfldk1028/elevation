# Stability SPAR3D Live Test — 2026-08-03

## Input

- Candidate: `creative-013`
- Source: isometric panel cropped from the existing 900x680 `render.png`
- Prepared input: square PNG with white background
- Endpoint: Stability AI `POST /v2beta/3d/stable-point-aware-3d`
- Texture resolution: 1024
- Seed: 13013

## API observations

The first request used 512x512 and was rejected before generation with `Image width and height must be at least 640`. This contradicts the broader minimum described elsewhere in the API documentation. The adapter now validates the live endpoint's 640x640 minimum before submission, and the test image was changed to 768x768.

The successful request completed in 6.741 seconds and returned a 530,672-byte binary GLB. The published charge is 4 credits.

## Mesh observations

- vertices: 7,622
- triangles: 13,356
- normalized bounding-box size: approximately 0.756 x 1.005 x 0.505
- one generated GLB was successfully rendered from front, back, left, right, top, and axonometric cameras

## Visual verdict

The generated axonometric view preserves the recognizable long curved body and terminal block. It proves that the web API can turn the existing single MASS render into a real textured mesh quickly.

Hidden geometry and orthographic silhouettes are not accurate enough for measured drawings. The current plain brown render contains little surface evidence, and the generated mesh rounds, merges, and invents unseen areas. This test passes transport, GLB, and same-object multi-view rendering, but fails architectural drawing fidelity.

## Next test

Create one silhouette-locked, detailed architectural isometric from the exact MASS and submit that image to the same endpoint. Then align global dimensions to the source MASS and compare held-out silhouettes. Do not spend another generation on the plain brown render.
