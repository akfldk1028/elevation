# Vision-to-Grammar Facade Pipeline Design (2026-09-12)

## 1. Executive Summary & Problem Definition

The `ElevationAgent` pipeline generates verified architectural drawings (four elevations, plan, roof plan, two axons, PBR hero) on an immutable 3D mass (`selected.glb`).

Previously, the bridge between an AI concept photograph (`cli.mjs concept`) and the deterministic grammar compiler was the `facade-transcriber`: a human or VLM manually estimating opening sizes, proportions, coordinates, and parameters by eye.
Against complex parametric facades (e.g. *The Broad* veil, diagrids, graded louvres, attractor perforations), visual estimation fails because:
1. Subtle Bezier curvature and non-rectangular contours (`outline`) cannot be accurately transcribed as numeric arrays by eye.
2. 2D parametric distribution gradients (attractor distance, field falloff, scoop angle) require geometric curve-fitting over hundreds of opening centroids, not manual guesses.

Inspired by the IAAC *From Pixels to Parameters* research, this specification introduces the **Vision-to-Grammar Pipeline**: an automated computer-vision workflow that extracts precise pixel segmentation masks from facade concept renderings, vectorizes opening contours into normalized `0..1` unit outlines, fits 2D field parameters, and emits valid, compile-ready `ElevationAgent` v3 facade grammars.

---

## 2. Architecture & 5-Stage Pipeline

```text
[Stage 1: AI Concept Image]
  │  Generated via `cli.mjs concept` or user photo (e.g. `the_broad.jpg`)
  ▼
[Stage 2: Semantic Facade Segmentation]
  │  Model: Grounded-SAM-2 / MobileSAM / OpenCV Adaptive Contour Detector
  │  Task: Detect all facade opening/veil masks without bounding box collapse
  ▼
[Stage 3: Normalization & Contour Vectorization]
  │  Tool: VTracer / OpenCV findContours + polygon simplification
  │  Extract:
  │    - Representative unit contour normalized to 0..1 bounding box -> `outline`
  │    - Far-end contour if tapered/funneled -> `outline_far`
  │    - Scoop cut angle from inner floor highlight -> `scoop_deg`
  │    - All centroid coordinates (u_i, z_i), widths, heights, rotations
  ▼
[Stage 4: 2D Field Parameter Fitting & Grammar Synthesis]
  │  Algorithm: Least-squares / radial distance regression on centroids & sizes
  │  Extract:
  │    - Attractor point(s) `at: [cx, cz]` or plane `normal: [nx, nz]`
  │    - Field falloff & range bounds `range_m: [near, far]`
  │    - Repeat tiling sizes and splits (`axis: "u"`, `axis: "z"`)
  │  Emit: `grammar.json` adhering strictly to `arr.elevation3d.facade-grammar.v3`
  ▼
[Stage 5: Deterministic 3D Compilation & Verification]
  │  Local CLI: `cli.mjs check` -> `cli.mjs render`
  │  Compiles onto exact-mass, cuts polygon holes, runs crease & edge passes,
  │  and validates 8-view competition drawings.
```

---

## 3. Component Specification

### Component A: Unit Contour Normalizer (`extract_unit_outline.py`)
- Takes raw opening segmentation masks.
- Computes convex hull / Douglas-Peucker / Bezier curves.
- Normalizes coordinates to `[u, v] in [0, 1] x [0, 1]`.
- Enforces grammar contract rules:
  - Exactly one closed loop.
  - No self-intersection.
  - Winding direction consistency.
  - Vertex count bounded (e.g., 8 to 32 points).

### Component B: Field Gradient Fitter (`fit_facade_field.py`)
- Analyzes spatial distribution of opening metrics:
  - Metric $S_i$: opening scale/area ratio at centroid $(u_i, z_i)$.
  - Metric $\theta_i$: scoop angle or rotation at centroid $(u_i, z_i)$.
- Detects field kind:
  - `point`: single radial attractor (e.g. centered oculus in The Broad).
  - `plane`: directional gradient along horizontal or vertical sweep.
  - `sun`: incident angle dependent facade shading.
- Computes `from`, `to`, `range_m`, and `falloff`.

### Component C: Pipeline Integration (`tools/facade-pipeline/trace-vision.mjs`)
- Exposes CLI command:
  ```bash
  node tools/facade-pipeline/cli.mjs trace <concept.png> <candidate> [--prompt "veil opening"]
  ```
- Automates the transcription step, passing verified grammar directly to `check` and `render`.

---

## 4. Contract Guarantees & Constraints
1. **MASS Lock**: The mass is immutable. The vision extractor extracts facade detail logic, never modifying `selected.glb`.
2. **Schema Compliance**: Output is guaranteed valid `arr.elevation3d.facade-grammar.v3`.
3. **No Hallucinated Depth**: 3D depth and recesses remain bounded by candidate context parameters (`max_recess_m`, `facet_edge_clearance_m`).
4. **Deterministic Local Fallback**: If GPU/SAM is unavailable, a high-fidelity OpenCV contour fallback extracts clean geometric outlines locally with zero dependencies.
