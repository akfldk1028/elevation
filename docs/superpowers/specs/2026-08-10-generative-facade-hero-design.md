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

## Output

- Generate one first-pass perspective hero image using the built-in image generation/editing path.
- Save the selected project asset non-destructively as `generated-presentation/hero-perspective-v1.png` under the retained run.
- Keep every verified source PNG unchanged.
- Treat the bitmap as presentation intent only. Any architectural change suggested by it must be rebuilt on the selected GLB and pass the elevation validation pipeline before becoming authoritative.

## Acceptance review

- Visually compare silhouette, floor count, roof outline, window grid, facade bays, and viewpoint against the axon source.
- Reject the image if it invents geometry or loses the building identity, even if its rendering quality is attractive.
- Accept the first pass only if material, glazing, lighting, landscape, and photographic realism improve materially without violating the locked invariants.
