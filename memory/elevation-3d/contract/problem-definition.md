# Problem Definition

## Correct task

The task is to use one existing PNG that already looks like a rendered 3D object, reconstruct one actual 3D object from it, and then obtain every later render and drawing from that shared 3D result.

The primary generation input is the isometric panel extracted from `candidate/render.png`. Do not generate or submit separate elevation images. Do not use the four-panel contact sheet as-is because an image-to-3D model may interpret it as four objects.

## Inputs

- one isometric object render cropped from `candidate/render.png`;
- authoritative mesh and geometry program for validation;
- opposite, top, front, right, back, left, and axon evidence for validation only;
- view/projection matrices and projected bounds for validation and drawing cameras;
- facade planes and surface normals;
- pre-legal floor guides;
- candidate identity and manifest hashes;
- candidate identity and morphology metadata.

## Outputs

- one reconstructed 3D GLB generated from the isometric PNG;
- reproducible axonometric and orthographic renders;
- drawing images using the same camera definitions;
- evidence recording provider calls and MASS-identity verification.

## Non-goals

- generating individual facade/elevation images before 3D generation;
- multi-view-to-model as the primary request;
- fixed-mesh texture generation as the primary request;
- treating camera matrices as provider inputs when the provider does not support them;
- intentionally redesigning the MASS;
- legal, planning, parking, FAR, or BCR approval;
- requiring exact vertex or topology equality from an image-to-3D reconstruction;
- launching a paid multi-candidate batch by default.
