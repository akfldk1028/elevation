# Paper Review

## Direct architectural precedent

`3D Synthesis for Architectural Design` (WACV 2025) separates coarse massing, facade texture generation, and optional detail geometry. It argues that general 3D synthesis creates background leakage and unnecessarily complex geometry that obstructs architectural editing. This is the closest direct precedent for keeping the MASS clean and adding facade appearance separately.

## Fixed-mesh texture generation

- `MVPainter` generates geometry-conditioned multi-view images using normal and depth controls, extracts PBR attributes, and projects them back to a mesh. Its evaluation dimensions map well to this project: reference alignment, geometry-texture consistency, and local texture quality.
- `MVPaint` synchronizes multi-view generation, fills unobserved 3D regions, and refines UV seams.
- `Paint3D` separates lighting from texture so the result can be relit.
- `TexPainter`, `TexGen`, and `ConTEXTure` confirm the same general pattern: generate or refine multiple views, then fuse them into a texture representation.

## Architecture-specific controls

- `Pro-DG` shows that facade generation benefits from hierarchical procedural guides rather than unconstrained prompting.
- `Generating Daylight-driven Architectural Design via Diffusion Models` uses massing sections and daylight-derived guides to place facade openings.
- `MeSS` uses an existing city mesh as a geometric prior and adds cross-view consistency and exposure alignment.

## Revised design consequence

The generator should receive explicit geometric evidence. SPAR3D makes a bounded geometry-generation experiment reasonable because it can accept the source MASS as a point-cloud condition together with one image. The exact OBJ still remains the dimensional reference, and floor guides remain constraints or validation evidence rather than permission to invent extra storeys.
