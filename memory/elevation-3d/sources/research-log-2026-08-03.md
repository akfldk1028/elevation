# Research Log — 2026-08-03

## Final correction: single rendered image to 3D

The user clarified that the intended workflow is not multi-view elevation generation, multi-view submission, or fixed-mesh texturing. Each candidate already has a PNG that visibly depicts a 3D MASS. The primary experiment must crop the isometric object view from that existing render, submit it once to an image-to-3D provider, receive one GLB, and derive all later renders and drawings from the generated GLB.

The unused panels, original OBJ, camera matrices, and locked views are validation evidence. They are not separate provider inputs. Earlier Hunyuan direct-texture and Wan projection recommendations are superseded for the primary experiment.

## Initial correction

The original handoff described multi-view elevation proposals. User feedback clarified that the intended workflow is one textured 3D result followed by drawing extraction.

## Key discovery

Tencent Hunyuan3D 3.1 exposes a dedicated texture endpoint that accepts an existing OBJ/GLB and labelled multi-view images. This changed the primary recommendation from generic image generation to direct mesh texturing.

## Retained fallback

Alibaba Wan/Qwen remains valuable because direct texture APIs may mutate geometry or fail on architectural facade grammar. The fallback generates views while the original mesh and camera matrices stay under application control.

## Research-derived principles

- Separate geometry, appearance, and optional detail geometry.
- Use depth, normals, silhouettes, and floor guides as controls or review evidence.
- Never accept a provider promise as proof of geometry identity.
- Judge all views jointly.
- Prefer one controlled candidate and zero automatic retries for the first live test.
