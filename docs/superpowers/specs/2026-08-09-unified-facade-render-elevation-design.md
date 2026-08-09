# Unified Facade Render and Elevation Design

## Goal

Recover one complete architectural flow in which an authoritative 3D candidate receives real facade geometry and PBR materials, becomes one validated final GLB, and produces both high-quality presentation renders and technical orthographic elevations from that same artifact.

The result must look intentionally designed while remaining geometrically faithful. A visual feature may appear in a render or elevation only when it exists in the selected GLB and is backed by the approved 3D input or an approved facade grammar bound to that input.

## Non-goals

- Do not infer new massing, storeys, windows, doors, or openings from a generated image.
- Do not maintain separate render and drawing models.
- Do not alter the source MASS to improve composition.
- Do not make a paid provider call during recovery or regression verification. A later live facade proposal requires separate explicit confirmation and exact cost ceilings.
- Do not claim an entrance door until authoritative segment and local-bound geometry exists.

## Authoritative inputs

The flow consumes one complete candidate package:

- source MASS mesh and its immutable identity/hash;
- floor guides and facade plane or segment authority;
- approved cameras and candidate bounds;
- approved facade grammar or an already durable facade proposal result;
- material palette and texture inputs whose provenance is known.

The source MASS, floor guides, and facade authority define geometry. Images can propose appearance and rhythm but cannot create spatial authority.

## Architecture

### 1. Candidate verification

Load the candidate package and verify identity, hashes, containment, finite coordinates, floor ordering, facade bounds, and camera contracts before enrichment. Reject stale or mixed candidate inputs before producing an artifact.

### 2. Geometry-locked facade enrichment

Bind facade grammar to approved facade segments. Construct supported elements such as punched windows, glazing recesses, frames, masonry bands, floor bands, parapets, and corner transitions as actual GLB geometry. Preserve the exact MASS envelope and storey datums.

Proposal-only intent remains metadata. Unsupported or spatially unbound elements are omitted rather than approximated.

### 3. PBR material finish

Assign architectural material roles to the enriched geometry: masonry, concrete, metal, glazing, roof, and other approved roles. Embed or bind textures deterministically, retain provenance, and verify that every rendered material maps to an existing mesh primitive. Material work may change appearance but not geometry.

### 4. Final artifact selection

Validate each candidate GLB against MASS identity, facade receipts, primitive metadata, bounds, floors, material roles, texture integrity, and artifact hashes. Select exactly one accepted GLB. If detailed enrichment fails, retain an explicitly degraded exact-MASS fallback; never present it as the completed facade result.

### 5. Presentation rendering

Render the selected GLB with a controlled architectural presentation style. Required outputs are a primary axonometric view, opposite axonometric view, and at least one facade-focused perspective. Lighting, exposure, shadows, background, and camera framing may improve presentation, but post-processing cannot add architectural content absent from the GLB.

### 6. Elevation generation

Generate front, back, left, and right elevations directly from the selected GLB with locked orthographic cameras and a common scale. Produce readable material separation, silhouette and facade-detail linework, floor datums, overall facade dimensions, and source-bound annotations. Plan, top, and axon views remain part of the complete eight-view delivery, but the four elevations are the primary technical output.

### 7. Shared provenance

Every render and drawing manifest records the same selected GLB path and SHA-256, candidate identity, facade validation receipt, material report, camera contract, and output hash. A mismatch invalidates the delivery.

## Data flow

1. Verify the 3D candidate package.
2. Resolve an approved, durable facade grammar without making an unapproved paid call.
3. Build geometry-locked facade enrichment.
4. Apply and validate PBR materials and textures.
5. Select one accepted final GLB.
6. Render presentation views from that GLB.
7. Generate four orthographic elevations and the remaining all-view outputs from that GLB.
8. Browser-verify the viewer and persisted artifacts.
9. Publish one manifest linking every output to the selected GLB and validation receipts.

## Failure handling and recovery

- All stages are resumable from durable state and content hashes.
- A succeeded or uncertain paid operation is never resubmitted automatically.
- Missing, stale, tampered, or cross-candidate inputs fail closed.
- A facade geometry validation failure stops final selection and downstream delivery.
- A rendering failure can be retried locally from the same selected GLB.
- A drawing or browser-verification failure cannot invalidate geometry, but it blocks delivery until regenerated and reverified.
- Recovery reuses durable provider results and makes no live provider call.

## Testing strategy

### Contract and unit tests

- Candidate identity, path containment, finite geometry, camera, and facade-segment contracts.
- Grammar-to-segment binding and rejection of unbound openings.
- MASS-envelope, storey, primitive metadata, and facade validation.
- Material-role, texture, and GLB hash integrity.
- Orthographic camera scale, dimensions, annotations, and line-depth behavior.

### Integration tests

- Real candidate package to enriched GLB.
- Enriched GLB to PBR validation and selected artifact.
- Selected GLB to presentation renders.
- The same GLB to front/back/left/right elevations and complete all-view manifests.
- Resume from durable facade and ledger state without replay.

### End-to-end verification

- Persist a fresh offline recovery artifact set.
- Confirm all render and elevation manifests reference one identical GLB hash.
- Decode output images and verify dimensions, non-empty foreground, distinct views, stable material signatures, and authoritative camera evidence.
- Load the viewer in a browser, exercise view controls, and reject console or asset errors.
- Run focused suites, the full test suite with resource-safe concurrency, TypeScript build, dependency audit, and diff check.

## Acceptance criteria

- One validated geometry-locked, facade-enriched, PBR-finished GLB is selected.
- Presentation renders visibly contain the facade geometry and material roles present in that GLB.
- Front, back, left, and right elevations are orthographic, dimensioned, readable, and generated from the identical selected GLB.
- No rendered or drawn architectural element exists only in an image or post-processing layer.
- All eight views, manifests, hashes, receipts, and browser evidence pass validation.
- Resume performs no duplicate provider submission.
- Recovery verification makes zero paid API calls.
