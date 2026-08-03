# Single-Image-to-3D Validity Review

Date: 2026-08-03

## Question

Is it reasonable to crop the isometric panel from `render.png`, generate one 3D model in a single API request, and derive drawings from that model?

## Finding

It is reasonable as a fast concept-visualization experiment. It becomes substantially more defensible when the exact source MASS is supplied as a point-cloud condition rather than used only for post-hoc comparison.

## Evidence from the local candidate

`creative-013` contains an exact mesh with 184 vertices, 364 triangles, one connected component, and a bounding box of approximately 24.36 by 12.23 by 9.90 source units. The isometric crop shows only one projection of this geometry. The rear surface, underside, depth of concavities, exact curve, scale, and camera calibration are not recoverable uniquely from that projection.

The current brown render also contains no facade design or material information absent from the OBJ. A render-to-3D call would therefore replace known geometry with a plausible estimate without adding useful design content.

## Provider mismatch

Tripo `image_to_model` accepts one image and generic model-generation controls. Its documented request does not accept this dataset's camera matrices, geometry program, or source OBJ as simultaneous constraints. Known camera pose can align a result but cannot resolve geometry hidden by a single view.

## Better local match: SPAR3D

SPAR3D's official implementation accepts an external point cloud together with one conditioning image. When supplied, the point cloud bypasses the model's point-cloud diffusion stage and conditions mesh generation along with image features. Sampling this cloud from the exact MASS carries known coarse geometry into the reconstruction instead of relying only on single-view inference.

This does not make the output automatically dimensionally authoritative. The implementation uses 512 points, has a perspective-camera assumption in its high-level image path, and is not architecture-specific. It does, however, directly support the intended one-render-to-one-3D workflow better than image-only Tripo.

## Architectural evidence

The WACV 2025 paper `3D Synthesis for Architectural Design` reports that general off-the-shelf 3D synthesis is poorly matched to architecture because it is trained mainly on isolated objects, can blend facade and background, and can produce overly complex geometry. The paper instead keeps a clean coarse mass and adds appearance in a geometry-aware pipeline.

Single-image reconstruction research likewise treats unseen surfaces as learned inference. Shape-pose ambiguity means more than one 3D shape and camera pose can explain the same 2D image.

## When the professor's shortcut is valid

- the source is one clear three-quarter/isometric render of one object;
- the image contains new architectural design information worth transferring;
- the required result is a concept asset or presentation model;
- hidden sides may be plausible rather than measured;
- all derived drawings are labelled conceptual and visually reviewed.

## When it is not valid

- the source PNG is merely a render of an already available exact OBJ;
- dimensions, floor count, openings, sections, or hidden courtyards must be authoritative;
- camera matrices and program data must constrain the provider request;
- drawings will be used as measured or technical outputs.

## Recommended interpretation

Use a detailed architectural isometric plus a source-MASS point cloud as the primary local experiment. Keep Tripo plus registration as the API fallback. Global dimensions may be restored after generation, but local geometry must pass landmark and silhouette gates; if it does not, transfer appearance/detail onto the exact MASS and derive technical geometry from the source.
