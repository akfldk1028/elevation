# ADR-002: Reconstruct One 3D Object from One Existing Isometric Render

Status: accepted only as a bounded feasibility experiment; not accepted as the production architecture

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

## Validity review

The source dataset already contains an exact OBJ. Its current brown render contains no additional facade or geometric design information. Reconstructing that render cannot improve geometric truth and will generally discard scale, hidden surfaces, and topology.

The experiment is still useful as a benchmark for the professor's shortcut, but a successful-looking GLB proves only concept-render suitability. It does not prove suitability for measured architectural drawings. The approach becomes materially useful only after the source image contains new architectural design information that is not already present in the OBJ.
