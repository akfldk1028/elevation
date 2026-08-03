# Approach A: Hunyuan3D Direct Mesh Texturing

## Summary

Use Tencent Hunyuan3D 3.1 `SubmitTextureTo3DJob` with the original OBJ/GLB and labelled multi-view evidence.

## Why it is the primary path

- It is a dedicated existing-mesh texturing endpoint rather than image-to-new-mesh generation.
- Version 3.1 accepts labelled multi-view images.
- It can request PBR output and preservation of existing UV/layout data.
- It returns a portable 3D artifact suitable for a browser renderer.

## Request policy

- candidate: begin with `creative-004`;
- model: pin `3.1`;
- primary reference: front;
- labelled views: left, right, back, top;
- use axon only after its orientation is mapped to a supported 45-degree label;
- texture size: 2048 for the first test;
- retries: zero;
- calls: one after explicit authorization.

## Geometry safety

`EnableKeepUV=true` is necessary but insufficient. The returned model must be compared with `indexed-mesh.json`. If the provider changes coordinates or topology, the output is quarantined even if the render looks better.

## Expected strengths

- least application-side texture plumbing;
- PBR-capable output;
- provider-side multi-view fusion;
- straightforward web delivery as GLB.

## Expected weaknesses

- generic 3D asset priors may not understand storeys or facade grammar;
- no arbitrary camera matrix parameter;
- one-job default concurrency;
- provider migration and regional account requirements create operational risk.

## Stop conditions

- output geometry differs beyond ordering normalization;
- windows or material bands contradict floor guides;
- unsupported input limits require destructive downsampling;
- API access cannot be obtained for the deployment region.
