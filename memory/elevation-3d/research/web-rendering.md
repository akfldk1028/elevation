# Web Rendering and Drawing Extraction

## Renderer

Three.js can load GLB/OBJ, reconstruct orthographic cameras, render to offscreen targets, and read pixels for image export. The original matrices must be converted carefully between the source convention and Three.js column-major transforms.

## Strategy A rendering

Load the verified textured GLB and render it with the locked cameras. PBR lighting is for presentation renders; material-neutral or unlit passes are preferred for facade evidence.

## Strategy B rendering

Use a custom projective material with one source image and depth map per view. The material should expose per-view confidence and coverage masks so seam failures are inspectable.

## Drawing output

- orthographic material pass;
- silhouette and crease line pass;
- optional floor-guide overlay;
- composite PNG for the first milestone;
- SVG only after edge visibility and occlusion are deterministic.

## Browser feasibility

The source meshes contain only tens to hundreds of vertices and triangles, so browser rendering and BVH-based visibility checks are comfortably within scope. Model generation remains a provider task; rendering and verification remain local/browser tasks.
