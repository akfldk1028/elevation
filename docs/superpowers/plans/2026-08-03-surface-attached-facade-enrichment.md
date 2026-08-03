# Surface-Attached Facade Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate complete facade grammar as per-triangle surface-clipped prisms that pass strict creative-013 validation while preserving the exact MASS base.

**Architecture:** Replace envelope segments with component-owned, view-facing source triangles. Clip each triangle independently by floor, bay, storey, and parapet scalar bands, then extrude the resulting polygon by bounded signed depth and export identity extras.

**Tech Stack:** Node.js ESM, `@gltf-transform/core`, Node test runner, existing unified flow/validator.

## Global Constraints

- Never modify or transform source base positions or indices.
- Never merge source connected components or their projected intervals.
- Glass uses negative signed recess; other details use bounded outward depth.
- No paid providers are called.

---

### Task 1: Surface-clipped detail generation

**Files:**
- Modify: `plugins/elevation-3d/lib/enrichment.mjs`
- Modify: `test/elevation3d-enrichment.test.ts`

**Interfaces:**
- Consumes: existing `buildEnrichedScene` input contract.
- Produces: existing scene/artifact contracts with richer per-detail extras.

- [ ] Add failing tests for overlapping detached components, inward glass, parapet height, concrete floor bands, and maximum detail-sample distance to actual source triangles.
- [ ] Run `node --test test/elevation3d-enrichment.test.ts --experimental-strip-types`; verify failures name envelope bridging, positive glass depth, missing parapet, bronze bands, and floating corners.
- [ ] Implement component triangle grouping, outward view selection, scalar polygon clipping, and closed signed-depth polygon prisms.
- [ ] Generate concrete bands/parapets, bronze nominal-grid mullions, recessed glass, and opaque spandrels with component/source-triangle extras.
- [ ] Run focused enrichment and enrichment-validation tests until green without changing validator tolerances.

### Task 2: Real creative-013 verification

**Files:**
- Create: retained unique output under `results/final-fix-b/`.
- Append: `.superpowers/sdd/2026-08-03-unified-mass-enrichment-agent/final-fix-b-report.md`.

- [ ] Run a disposable direct enrichment/validation probe on creative-013 and use exact validator codes/metrics to correct only generator defects through additional RED/GREEN tests.
- [ ] Run `runElevation3d` once with unique run/output IDs and no injected providers.
- [ ] Require selected `v001` or `v002`, exact base evidence, accepted validation, and seven retained drawings.
- [ ] Run focused tests, `npm test`, `npm run build`, and `git diff --check`.
- [ ] Record RED/GREEN, commands, retained artifact paths, validation metrics, files, and concerns; commit implementation separately from the design.
