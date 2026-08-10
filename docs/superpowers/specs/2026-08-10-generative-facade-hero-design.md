# Generative Facade Hero Design

## Goal

Create a high-end warm-daylight architectural hero image from the verified perspective axon render of the retained 2026-08-10 facade winner. The result should feel suitable for a competition board or architecture publication while remaining recognizably the same building.

## Authoritative inputs

- Primary edit target: `final-presentation/views/axon/axon.png` from the retained winner.
- Supporting references: `final-presentation/contact-sheet.png` and `final-presentation/views/front/front.png`.
- Geometry and dimensions remain authorized only by the selected GLB and technical elevations.

## Visual direction

- Preserve the existing three-quarter perspective and use corrected architectural verticals.
- Use warm natural daytime sunlight, soft directional shadows, a restrained bright sky, and realistic global illumination.
- Enrich the existing dark red facade as tactile premium brick or masonry with subtle tonal variation.
- Give glazing physically plausible reflections and depth; keep frames and stone accents crisp and restrained.
- Add only non-authoritative presentation context: minimal paving, understated planting, and a few small people for scale.
- Produce a polished photoreal architectural visualization, not a diagram, illustration, fantasy scene, or night render.

## Locked invariants

- Do not change the building silhouette, mass, floor count, roof outline, camera side, or perspective direction.
- Do not add, remove, move, resize, or redesign windows, doors, openings, bays, or facade divisions.
- Do not add balconies, canopies, signs, rooftop equipment, adjacent buildings, or invented architectural elements.
- Do not crop the building; retain comfortable presentation margins and show its grounding.
- No text, logo, watermark, border, or annotation.

## Exact image-generation prompt

```text
Use case: sketch-to-render
Asset type: high-end architectural competition hero perspective
Input images: Image 1 is the authoritative edit target and fixes the camera, silhouette, mass, storey count, roof outline, facade bays, and every window/opening; Image 2 is the eight-view identity grid; Image 3 is the orthographic front identity reference.
Primary request: transform Image 1 into a polished photoreal architectural visualization of exactly the same building. Preserve its existing three-quarter perspective and corrected architectural verticals.
Scene/backdrop: restrained premium urban forecourt with light stone paving, sparse low planting, a clean bright sky, and only a few small people for scale; do not obscure the facade.
Subject: the exact five-storey faceted building from Image 1, unchanged in geometry and opening layout.
Style/medium: competition-winning professional architectural photography, realistic rather than illustrative.
Lighting/mood: warm natural daytime sunlight, soft directional shadows, realistic global illumination, inviting and calm.
Color palette: retain the existing deep warm red facade identity with refined brick and masonry tonal variation; pale stone accents; neutral glazing.
Materials/textures: tactile premium brick or masonry, crisp restrained frames and lintels, physically plausible glass reflections and interior depth, subtle weathering only.
Composition/framing: keep the same camera side and perspective direction as Image 1, show the complete building and its grounding with comfortable margins, no crop.
Constraints: preserve exactly the silhouette, mass, five storeys, roof outline, facade divisions, window count, window positions, opening sizes and proportions. Change only material realism, glazing, light, shadows, landscaping, atmosphere, and photographic finish.
Avoid: added or removed windows, doors, balconies, canopies, signs, rooftop equipment, adjacent buildings, changed roof or mass, warped verticals, fantasy styling, dramatic dusk, excessive vegetation, cars blocking the building, text, logo, watermark, border, annotations.
```

## Output

- Generate one first-pass perspective hero image using the built-in image generation/editing path.
- Save the selected asset non-destructively as `D:/Data/50_ELE/facade-agent-verification/generative-facade-presentation-20260810/hero-perspective-v1.png`. This sibling root keeps the immutable 212-file retained evidence tree unchanged.
- Keep every verified source PNG unchanged.
- Treat the bitmap as presentation intent only. Any architectural change suggested by it must be rebuilt on the selected GLB and pass the elevation validation pipeline before becoming authoritative.

## Acceptance review

- Visually compare silhouette, floor count, roof outline, window grid, facade bays, and viewpoint against the axon source.
- Reject the image if it invents geometry or loses the building identity, even if its rendering quality is attractive.
- Accept the first pass only if material, glazing, lighting, landscape, and photographic realism improve materially without violating the locked invariants.
