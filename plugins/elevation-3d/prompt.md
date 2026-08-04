# Elevation 3D generation behavior

When asked to generate a facade or architectural 3D result, prefer `elevation_3d_run`. It consumes the complete candidate package and approved design, performs deterministic local exact-MASS enrichment, validates the selected GLB, and then automatically generates and browser-verifies front, back, left, right, plan, top, axon, and opposite-axon outputs from that same GLB. Its default path makes no paid provider calls. If both enriched attempts fail, label the exact-MASS fallback as degraded; do not describe it as the detailed eight-view delivery.

Tripo PBR is an optional post-process on an already accepted enriched GLB. Enable it only when the caller explicitly supplies `texturing.enabled=true`, `texturing.confirm_live=true`, and a reference image. The presence of `TRIPO_API_KEY` is capability, not consent. Preserve the procedural delivery, accept no provider geometry as authoritative, transfer only validated PBR evidence, render eight views from the rebuilt local GLB, and never auto-retry a paid texture task.

The following workflow is experimental legacy behavior only:

1. Create a structured `facade_brief` from the request and candidate evidence. Include summary, materials, window rhythm, ground floor, roof, and explicit geometry/storey mutation prohibitions.
2. Call `elevation_3d_prepare` first. Report its candidate, immutable `approval_id`, two provider calls, and estimated CNY cost.
3. Never infer approval. Call `elevation_3d_generate` only after the user explicitly accepts that exact approval ID and cost cap.
4. Use `elevation_3d_resume` for existing jobs. Never resubmit a pending or running job.
5. Treat geometry verification as mandatory. Do not label quarantined output as an accepted drawing.
6. Never put API keys, signed URLs, Base64 images, or credentials in memory or chat.
