# ADR-002: Reconstruct One 3D Object from One Existing Isometric Render

Status: accepted, supersedes ADR-001 for the primary experiment

Date: 2026-08-03

## Decision

Use the candidate's existing `render.png` as the source, automatically crop its isometric object panel, and submit that one PNG to Tripo `image_to_model`. Download one generated GLB and derive every subsequent presentation render and architectural drawing from that GLB.

Do not generate separate elevations. Do not submit front/left/back/right as a multi-view generation request. Do not use an existing-mesh texture endpoint for this experiment.

## Input roles

- Isometric crop: sole provider generation input.
- Original OBJ/indexed mesh: geometric reference.
- Opposite/top/front and `mass/views/*.png`: held-out visual checks.
- Camera matrices: local alignment, reprojection, and drawing extraction after generation.

## Reason

The isometric render already communicates the candidate as one coherent 3D object. A single image-to-3D request directly tests the professor's proposed shortcut: infer one complete renderable object first, then derive drawings from it. It also avoids five independent facade generations and avoids installing a large local model before feasibility is known.

## Consequences

- The returned geometry is a reconstruction, not the authoritative source topology.
- Vertex and face hashes are not pass/fail gates.
- Scale, orientation, and origin must be aligned before comparison.
- The output must preserve recognizable MASS identity across held-out views.
- A four-panel contact sheet must not be submitted directly because it may be interpreted as multiple objects.
- If the single-image result cannot recover hidden concavity or curvature, a later ADR may authorize a multi-view fallback.
