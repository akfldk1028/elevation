# Competition Front Elevation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce and verify one competition-board-quality, dimensioned `front` elevation PNG from the exact selected creative-013 GLB before applying the system to any other view.

**Architecture:** A geometry-bound dimension manifest and swappable semantic material palette feed a dedicated orthographic elevation renderer. The renderer produces a clean material/depth-silhouette base image, then composites a separately generated SVG annotation layer so dimensions remain crisp and testable. Existing strict GLB, PNG, hash, component, and provenance validation remains authoritative.

**Tech Stack:** Node.js ESM, Three.js/WebGL/Puppeteer, Sharp, SVG, `@gltf-transform/core`, Node test runner.

## Global Constraints

- Selected GLB and parsed `exact-mass` accessors are the geometry authority; no image-generated geometry.
- Dimensions come only from parsed GLB/source mesh, facade planes, floor guides, or parsed semantic detail geometry.
- Dimension labels default to millimetres without unit; levels use `EL. +0.000` metre notation.
- Annotation agreement tolerance is 1 mm.
- `front` uses an orthographic camera fitted to actual loaded-GLB projected bounds with 8–10% content margin.
- Internal source-triangle and per-primitive clipping seams must not appear.
- Required semantic roles are `concrete`, `glass`, `bronze`, and `opaque`.
- The initial palette presets are `competition-warm`, `competition-neutral`, and `competition-stone`.
- Output is 2400 × 2400 PNG plus SVG annotations and JSON dimension/render manifests.
- Existing exact-base, GLB parsing, decoded-PNG, SHA-256, provenance, component, abort, retry, and durable-memory gates remain mandatory.
- First deliverable is `front` only. No remaining elevations or axon work belongs in this plan.

---

### Task 1: Geometry-Bound Dimensions and Material Palettes

**Files:**
- Create: `plugins/elevation-3d/lib/material-palettes.mjs`
- Create: `plugins/elevation-3d/lib/elevation-dimensions.mjs`
- Test: `test/elevation3d-elevation-contract.test.ts`

**Interfaces:**
- Produces: `resolveMaterialPalette(presetOrOverrides): ResolvedPalette`
- Produces: `deriveElevationDimensions({ sourceMesh, artifact, facadePlanes, floorGuides, view }): Promise<DimensionManifest>`
- `DimensionManifest` contains `schema_version`, `view`, `selected_glb_sha256`, `geometry_hash`, `projected_bounds_m`, `overall_width`, `overall_height`, `levels`, `floor_intervals`, `facade_extent`, `scale_bar`, and one source descriptor per value.

- [ ] **Step 1: Write failing palette tests**

```ts
test("resolves three complete competition palettes without changing semantic roles", () => {
  for (const id of ["competition-warm", "competition-neutral", "competition-stone"]) {
    const palette = resolveMaterialPalette(id);
    assert.deepEqual(Object.keys(palette.roles).sort(), ["bronze", "concrete", "glass", "opaque"]);
    assert.equal(palette.schema_version, "arr.elevation3d.material-palette.v1");
    assert.ok(palette.sha256);
  }
});

test("rejects an invisible structural material override", () => {
  assert.throws(() => resolveMaterialPalette({ preset: "competition-warm", roles: { concrete: { opacity: 0 } } }), /material visibility invalid/);
});
```

- [ ] **Step 2: Run palette tests and confirm missing-module RED**

Run: `node --test test/elevation3d-elevation-contract.test.ts --experimental-strip-types`

Expected: `ERR_MODULE_NOT_FOUND` for `material-palettes.mjs`.

- [ ] **Step 3: Implement immutable palette presets and override validation**

Each resolved role must contain elevation fill colour, axon PBR colour, opacity, roughness, metalness, line contrast, and texture/normal intensity. Hash `stableJson` of the fully resolved palette. Glass opacity must remain within `[0.25, 0.85]`; non-glass structural roles within `[0.85, 1]`.

- [ ] **Step 4: Write failing real-dimension tests**

```ts
test("derives front dimensions from parsed exact MASS and authored floor guides", async () => {
  const manifest = await deriveElevationDimensions(realCreative013Inputs);
  assert.equal(manifest.view, "front");
  assert.equal(manifest.overall_height.value_m, 9.9);
  assert.equal(manifest.overall_height.display_mm, 9900);
  assert.deepEqual(manifest.levels.map((x) => x.label), ["EL. +0.000", "EL. +3.300", "EL. +6.600", "EL. +9.900"]);
  assert.deepEqual(manifest.floor_intervals.map((x) => x.display_mm), [3300, 3300, 3300]);
  assert.equal(manifest.overall_height.source.field, "exact-mass.POSITION");
});

test("detects a facade extent or guide outside the exact MASS envelope", async () => {
  await assert.rejects(() => deriveElevationDimensions(outOfEnvelopeInputs), /dimension source outside exact MASS/);
});
```

- [ ] **Step 5: Implement parsed-accessor projection and dimension manifest**

Read `artifact.path` with `NodeIO`, locate named `exact-mass`, canonicalize Float32 positions, and project all positions using the front camera horizontal/vertical axes. Overall width/height use projected min/max. Floor intervals come from sorted unique authored guides after envelope checks. Convert display values with `Math.round(value_m * 1000)`.

- [ ] **Step 6: Run focused and existing validation tests**

Run:

```bash
node --test test/elevation3d-elevation-contract.test.ts test/elevation3d-enrichment-validation.test.ts --experimental-strip-types
```

Expected: all pass with no warnings.

- [ ] **Step 7: Commit**

```bash
git add plugins/elevation-3d/lib/material-palettes.mjs plugins/elevation-3d/lib/elevation-dimensions.mjs test/elevation3d-elevation-contract.test.ts
git commit -m "feat: add elevation dimension and palette contracts"
```

---

### Task 2: Orthographic Competition Front Renderer

**Files:**
- Create: `plugins/elevation-3d/lib/competition-elevation.mjs`
- Modify: `plugins/elevation-3d/web/viewer-app.mjs`
- Modify: `plugins/elevation-3d/lib/viewer.mjs`
- Modify: `plugins/elevation-3d/lib/results.mjs`
- Test: `test/elevation3d-competition-elevation.test.ts`
- Test: `test/elevation3d-viewer.test.ts`

**Interfaces:**
- Consumes: `ResolvedPalette`, `DimensionManifest`, selected GLB, front projection axes.
- Produces: `renderCompetitionElevationBase({ runDir, glbPath, sourceMesh, camera, palette, dimensions, view: "front", signal, lifecycle }): Promise<BaseElevationArtifact>`
- `BaseElevationArtifact` contains `path`, `sha256`, `width`, `height`, `camera`, `projected_bounds_m`, `content_bounds_px`, `palette_sha256`, `selected_glb_sha256`, and `viewer_config_sha256`.

- [ ] **Step 1: Write failing camera-fit and config tests**

```ts
test("fits the loaded GLB front projection inside a 9 percent margin", async () => {
  const artifact = await renderCompetitionElevationBase(realInputs);
  assert.equal(artifact.camera.type, "orthographic");
  assert.equal(artifact.width, 2400);
  assert.equal(artifact.height, 2400);
  assert.ok(artifact.content_bounds_px.min_x >= 192);
  assert.ok(artifact.content_bounds_px.max_x <= 2208);
});

test("viewer config contains one GLB and no alternate mesh geometry", async () => {
  const config = await readJson(configPath);
  assert.equal(config.mesh, undefined);
  assert.match(config.strategies.hunyuan.glb, /\.glb$/);
  assert.equal(config.competition_elevation.view, "front");
});
```

- [ ] **Step 2: Run focused test and confirm missing renderer RED**

Run: `node --test test/elevation3d-competition-elevation.test.ts --experimental-strip-types`

Expected: `ERR_MODULE_NOT_FOUND` for `competition-elevation.mjs`.

- [ ] **Step 3: Add loaded-scene projected fitting**

In competition-elevation mode, load the GLB first, compute world bounds, project all eight corners onto the authoritative front horizontal/vertical axes, reserve the annotation band, and create an orthographic camera with `margin_ratio: 0.09`. The camera manifest records axes, centre, frustum, near/far, world-to-pixel scale, and proves parallel projection.

- [ ] **Step 4: Write failing semantic-material and seam tests**

```ts
test("uses palette roles while suppressing triangle and primitive seam lines", async () => {
  const manifest = await readJson(renderManifestPath);
  assert.deepEqual(manifest.material_roles.sort(), ["bronze", "concrete", "glass", "opaque"]);
  assert.equal(manifest.line_pass.internal_triangle_edges, false);
  assert.equal(manifest.line_pass.per_primitive_edges, false);
  assert.equal(manifest.line_pass.depth_silhouette, true);
});
```

- [ ] **Step 5: Implement material fill and depth-silhouette compositing**

Traverse material names and replace appearance from the resolved palette without replacing geometry. Render colour to a WebGL target with a `DepthTexture`, then composite a depth-Sobel silhouette. Coplanar and same-depth primitive seams produce no line; only depth discontinuities exceed the configured threshold. Slab/parapet/mullion hierarchy remains visible through semantic fill colours and geometry depth rather than `EdgesGeometry` on every primitive.

- [ ] **Step 6: Add abort-safe 2400-square capture and pixel-bound measurement**

Extend the existing external render lifecycle so tests can capture competition elevation mode. Await progress before signal checks, close page/browser/preview in nested `finally`, decode the PNG with Sharp, and scan non-background pixels to report `content_bounds_px`.

- [ ] **Step 7: Run renderer, viewer, and abort tests**

Run:

```bash
node --test test/elevation3d-competition-elevation.test.ts test/elevation3d-viewer.test.ts test/elevation3d-results.test.ts --experimental-strip-types
```

Expected: all pass; no cropped content and no open preview handles.

- [ ] **Step 8: Commit**

```bash
git add plugins/elevation-3d/lib/competition-elevation.mjs plugins/elevation-3d/web/viewer-app.mjs plugins/elevation-3d/lib/viewer.mjs plugins/elevation-3d/lib/results.mjs test/elevation3d-competition-elevation.test.ts test/elevation3d-viewer.test.ts
git commit -m "feat: render competition front elevation"
```

---

### Task 3: SVG Dimensions, Final Composition, and Real Front Verification

**Files:**
- Create: `plugins/elevation-3d/lib/elevation-annotations.mjs`
- Create: `plugins/elevation-3d/lib/elevation-presentation-validation.mjs`
- Modify: `plugins/elevation-3d/lib/competition-elevation.mjs`
- Modify: `memory/elevation-3d/README.md`
- Test: `test/elevation3d-elevation-annotations.test.ts`
- Test: `test/elevation3d-competition-front-e2e.test.ts`

**Interfaces:**
- Consumes: `BaseElevationArtifact`, `DimensionManifest`, palette, selected GLB provenance.
- Produces: `renderCompetitionElevation(...): Promise<ElevationArtifacts>`
- Produces: `validateCompetitionElevation({ artifacts, sourceMesh, facadePlanes, floorGuides }): Promise<ValidationReport>`
- `ElevationArtifacts` contains final PNG, SVG annotations, dimensions JSON, render manifest, and validation report paths/hashes.

- [ ] **Step 1: Write failing SVG annotation tests**

```ts
test("lays out authoritative overall and level dimensions outside the building", () => {
  const annotation = buildElevationAnnotations({ dimensions, camera, contentBounds, canvas: [2400, 2400] });
  assert.equal(annotation.labels.includes("9900"), true);
  assert.deepEqual(annotation.level_labels, ["EL. +0.000", "EL. +3.300", "EL. +6.600", "EL. +9.900"]);
  assert.equal(annotation.overlaps_content, false);
  assert.equal(annotation.note, "ALL DIMENSIONS IN MILLIMETRES");
});
```

- [ ] **Step 2: Run focused test and confirm missing annotation module RED**

Run: `node --test test/elevation3d-elevation-annotations.test.ts --experimental-strip-types`

Expected: `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement deterministic SVG dimension layout**

Generate a 2400-square SVG with separate groups for title, ground line, overall width/height, floor levels, facade extent, and scale bar. Convert world coordinates through the camera manifest. Use collision boxes and fixed annotation lanes; fail rather than overlap the content area. Store each displayed label beside its source manifest ID.

- [ ] **Step 4: Composite SVG over the base PNG and write provenance**

Use Sharp to composite the SVG over the decoded base PNG. Hash the base, SVG, final PNG, dimension manifest, render manifest, palette, viewer config, and selected GLB. The final render manifest records every relationship and the preset ID.

- [ ] **Step 5: Write failing presentation validation tests**

```ts
test("rejects a one-millimetre dimension tamper and visible seam overload", async () => {
  const report = await validateCompetitionElevation(tampered);
  assert.equal(report.accepted, false);
  assert.ok(report.codes.includes("DIMENSION_MISMATCH"));
  assert.ok(report.codes.includes("LINE_DENSITY_EXCEEDED"));
});
```

- [ ] **Step 6: Implement presentation gates**

Recompute dimensions from source inputs and compare every displayed value. Validate orthographic camera dot products, vertical alignment, 8–10% composition margin, decoded 2400-square PNG, palette role visibility, SVG/content non-overlap, line-density thresholds, selected-GLB identity, and complete hashes. Emit the stable codes defined by the spec.

- [ ] **Step 7: Run real creative-013 front elevation once**

Use:

- Dataset: `D:/Data/50_ELE/MAAS_ELEVATION_TEST_SET_20260730`
- Candidate: `creative-013`
- Selected stable GLB: `D:/Data/50_ELE/elevation-3d-e2e-results/creative-013/final-fix-b-round1-20260803-190000/versions/v001/enriched.glb`
- Palette: `competition-warm`
- Explicit run ID: `competition-front-20260803-001`
- Stable output root: `D:/Data/50_ELE/elevation-3d-e2e-results/creative-013`

Verify final `front.png` opens, whole building is visible, labels include `9900`, floor levels match 0/3300/6600/9900, triangle seams are absent, all hashes resolve, and validation is accepted. No paid provider calls.

- [ ] **Step 8: Run full verification**

Run:

```bash
node --test test/elevation3d-elevation-annotations.test.ts test/elevation3d-competition-front-e2e.test.ts --experimental-strip-types
npm test
npm run build
git diff --check
```

Expected: all tests and build pass; diff check has no errors.

- [ ] **Step 9: Update durable memory and commit**

Record the front elevation run ID, selected palette, exact dimensions, validation metrics, final PNG/SVG/manifest locations, and hashes in durable memory without copying generated binaries into git.

```bash
git add plugins/elevation-3d test memory/elevation-3d
git commit -m "feat: deliver dimensioned competition front elevation"
```

---

## Plan Self-Review

- Spec coverage: front-only delivery, geometry-bound dimensions, three material palettes, actual projected camera fit, seam suppression, line hierarchy, SVG annotations, validation, abort cleanup, provenance, and real creative-013 output each have an implementation task.
- Placeholder scan: no deferred implementation placeholders are present.
- Type consistency: Task 1 produces `ResolvedPalette` and `DimensionManifest`; Task 2 consumes both and produces `BaseElevationArtifact`; Task 3 consumes all three and produces `ElevationArtifacts` plus validation.
- Scope: remaining elevations, plan/top refinement, context assets, and competition axon are deliberately excluded until the front PNG is visually approved.

