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
- Goal: consume the complete candidate package and enrich the exact MASS into one detailed 360-degree GLB, then derive every render and 2D drawing from that object.
- Current decision: ADR-004. Keep the source `mass.obj` as authoritative visible/hidden geometry; derive appearance grammar from the approved isometric and create real facade/detail geometry plus PBR materials using camera matrices, facade planes, floor guides, and geometry program constraints.
- Hosted SPAR3D/Tripo generated meshes are rejected as production geometry because held-out plan/elevation views hallucinate local form. Local point-conditioned SPAR3D is research-only.
- The professor's shortcut is viable for concept and presentation output. Overall dimensions can be restored exactly, but local curves, voids, floor positions, and openings still require landmark validation or appearance transfer back to the exact MASS.
- The original OBJ supplies the SPAR3D point-cloud condition and remains the authoritative dimensional reference. Held-out views and camera matrices validate the generated model.
- Tripo credentials are configured locally, but the API balance was 0 credits at the last check and no paid generation has been submitted.
- Required ordering: exact MASS -> silhouette-locked photoreal architectural variant -> structured facade grammar -> deterministic 3D detailing on the exact MASS -> one enriched GLB -> all 2D drawings from that GLB.
- Architectural render variants may change facade system, material palette, and lighting, but must preserve camera, envelope, curvature, height changes, gaps, and detached components. Save every selected variant as a versioned asset.
- 2026-08-03 live result: the detailed concrete/glass isometric generated a textured 9,948-vertex SPAR3D GLB in 9.628 seconds. Its nearby axon view was recognizable, but held-out top/front views hallucinated geometry. Hosted image-only SPAR3D is therefore rejected for trustworthy plan/elevation extraction; use MASS-conditioned local SPAR3D or appearance transfer to the exact MASS next.
- Approved design reference: `memory/elevation-3d/assets/creative-013/approved-detailed-isometric-v1.png`. The user explicitly accepted its visual quality. Geometry still comes from the original MASS.
