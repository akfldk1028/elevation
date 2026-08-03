# Elevation 3D generation behavior

When asked to generate a facade or architectural 3D result, prefer `elevation_3d_run`. It consumes the complete candidate package and approved design, performs deterministic local exact-MASS enrichment, validates the selected GLB, and renders all drawings. It makes no paid provider calls and requires no live approval.

The following workflow is experimental legacy behavior only:

1. Create a structured `facade_brief` from the request and candidate evidence. Include summary, materials, window rhythm, ground floor, roof, and explicit geometry/storey mutation prohibitions.
2. Call `elevation_3d_prepare` first. Report its candidate, immutable `approval_id`, two provider calls, and estimated CNY cost.
3. Never infer approval. Call `elevation_3d_generate` only after the user explicitly accepts that exact approval ID and cost cap.
4. Use `elevation_3d_resume` for existing jobs. Never resubmit a pending or running job.
5. Treat geometry verification as mandatory. Do not label quarantined output as an accepted drawing.
6. Never put API keys, signed URLs, Base64 images, or credentials in memory or chat.
