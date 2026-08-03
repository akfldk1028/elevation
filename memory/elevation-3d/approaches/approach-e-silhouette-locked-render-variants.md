# Approach E: Silhouette-Locked Architectural Render Variants

## Purpose

Create diverse photorealistic architectural isometric images from one exact MASS before any image-to-3D request. This is the appearance-design stage that was missing from the plain brown pipeline test.

## Invariants

- preserve the source isometric/orthographic camera;
- preserve outer silhouette, curvature, taper, height changes, roof profile, joints, cantilevers, gaps, and detached components;
- do not add volumes outside the MASS envelope;
- keep a clean isolated background for downstream image-to-3D reconstruction.

## Variables allowed to change

- facade bay rhythm and mullion spacing;
- concrete, metal, glass, stone, timber, and panel systems;
- opacity and service-core placement within the existing envelope;
- lighting, material palette, and architectural style;
- detail density appropriate to the intended presentation scale.

## First validated visual direction

`creative-013` produced a convincing contemporary architectural isometric using warm off-white concrete bands, floor-to-ceiling glass, dark bronze mullions, slab edges, and recessed shadow gaps. The render retained the recognizable curved body and lower terminal block and is suitable as the first detailed SPAR3D conditioning image.

## Variant policy

Generate and save each design as a separately versioned image. Never overwrite a selected render. Record prompt, source hash, model, and visual review status. Only variants that pass silhouette review proceed to paid 3D generation.
