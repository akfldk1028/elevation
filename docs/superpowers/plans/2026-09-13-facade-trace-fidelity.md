# Facade trace fidelity repair

The user explicitly requested changes to the existing engine and direct testing after the audit. Execute in the current working tree so the untracked vision implementation under review is included; preserve unrelated changes.

**Goal:** retain source boundaries and placements as editable 2D facade geometry, repair the existing adapter, and stop treating missing source evidence as successful transcription.

**Final design:** source observation and procedural design controls are separate. Trace requires an explicit facade ROI for unconstrained photographs. A curve document retains individual paths/holes and editable instance transforms; SVG and native DXF splines are generated from this document. Radial/linear fields drive these transforms. The existing grammar engine remains available for separately authored 3D designs; automatic curve-to-mass attachment is not implemented. Classical extraction is an explicit engine, never a silent substitute for a failed neural model. Semantic completeness remains subject to visual assessment.

**Scope/evidence:** `../../../../docs/facade_audit_20260913/review.md`; user brief `../../../../docs/facade_image_to_cad_verification_brief.md`.

- [x] Preserve rectangle/concave contours, reject invalid loops and enforce a polygon approximation budget without replacing shapes.
- [x] Add explicit ROI filtering, normalized area bounds, mask topology and confidence-ordered mask-IoU deduplication. Verify neighboring components, holes and complete overlapping tile coverage.
- [x] Export editable curve instances to SVG/DXF. Test cubic entities, loop count, coordinate scale, instance edits and actual CAD round-trip.
- [x] Replace the originally proposed heuristic grammar-field repair with explicit radial/linear fields driving the observed curve document. Test their effect on native DXF transforms. The old inferred-field/grammar path is excluded from trace; no latent-rule recovery is claimed.
- [x] Wire trace/cad/edit into the existing CLI, persist source identity and propagate failures. Verify immutable source copies through re-export.
- [x] Run 19 Python tests plus 5 subtests and 30 relevant Node tests. Run actual SAM3 and DINO+SAM2 inference. Verify final Broad 669-instance CAD and edited CAD, including actual DXF rendering. No new 3D preview was produced, so no new four-elevation verification is claimed.

Final evidence: `../../../../docs/facade_audit_20260913/implementation-results.md`.
The measured mask-to-curve fidelity passes; semantic completeness does not. Missing openings and false detections remain visible and flagged for review.

No retraining or paid service is needed. Small vector/CAD dependencies are installed and recorded. No commit/push is requested. No step may claim the original latent design rules or measured depth have been recovered merely because a valid file was written.
