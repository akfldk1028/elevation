# Gitagent Memory

## Recent Tasks

### Flappy Bird Game with Webcam Integration
- Created `flappy_bird_webcam.html` - A complete Flappy Bird style game with webcam overlay
- Features:
  - Full Flappy Bird game mechanics (gravity, pipes, collision detection, scoring)
  - Webcam feed overlay in top-right corner showing player's face
  - Enable/Disable webcam controls
  - Mirror effect on webcam for natural viewing
  - Responsive controls: SPACE, UP arrow, or click/tap to flap
  - Game restart functionality
  - Visual styling with gradient background
- Opened in Safari for testing
- File location: `flappy_bird_webcam.html`

## Files Created
- `flappy_bird_webcam.html` (13.5KB) - Flappy Bird game with webcam integration

## Active Research

### Single Render to Architectural 3D Reconstruction

- Research index: `memory/elevation-3d/README.md`
- Goal: crop one existing isometric MASS render, reconstruct one actual 3D GLB from that single image, then derive all renders and drawings from the generated 3D object.
- Current decision: the primary test is local SPAR3D using one detailed isometric plus a 512-point surface cloud sampled from the exact MASS. This constrains generation with the source geometry, then restores exact global dimensions.
- Tripo `image_to_model` followed by rigid/scale registration and optional source-anchored deformation is the API fallback.
- The professor's shortcut is viable for concept and presentation output. Overall dimensions can be restored exactly, but local curves, voids, floor positions, and openings still require landmark validation or appearance transfer back to the exact MASS.
- The original OBJ supplies the SPAR3D point-cloud condition and remains the authoritative dimensional reference. Held-out views and camera matrices validate the generated model.
- Tripo credentials are configured locally, but the API balance was 0 credits at the last check and no paid generation has been submitted.
- Required ordering: exact MASS render -> silhouette-locked photoreal architectural variant -> one image-to-3D call -> dimension alignment -> all drawing views from the same GLB. Do not test final visual quality using the plain brown MASS render.
- Architectural render variants may change facade system, material palette, and lighting, but must preserve camera, envelope, curvature, height changes, gaps, and detached components. Save every selected variant as a versioned asset.
- 2026-08-03 live result: the detailed concrete/glass isometric generated a textured 9,948-vertex SPAR3D GLB in 9.628 seconds. Its nearby axon view was recognizable, but held-out top/front views hallucinated geometry. Hosted image-only SPAR3D is therefore rejected for trustworthy plan/elevation extraction; use MASS-conditioned local SPAR3D or appearance transfer to the exact MASS next.
