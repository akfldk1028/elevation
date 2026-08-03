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
- Current decision: Tripo `image_to_model` is the first experiment. Separate elevation generation, multi-view submission, and fixed-mesh texturing are not the primary workflow.
- The original OBJ, held-out views, and camera matrices validate the reconstructed model; they are not separate provider inputs.
- Tripo credentials are configured locally, but the API balance was 0 credits at the last check and no paid generation has been submitted.
