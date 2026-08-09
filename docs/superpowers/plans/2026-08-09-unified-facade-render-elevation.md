# Unified Facade Render and Elevation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce and recover one facade-enriched, PBR-finished, geometry-locked GLB whose identical hash drives the final beauty renders, four orthographic elevations, complete eight-view delivery, and browser evidence.

**Architecture:** Keep the existing facade harness responsible for provider proposals, grammar, geometry construction, validation, comparison, and technical all-view delivery. Add one local-only final-presentation boundary after technical winner selection; it renders the existing winning GLB through the embedded-PBR renderer, validates the shared GLB/camera/material evidence, and persists a crash-safe presentation receipt. A terminal winner missing this new receipt may run only the local presentation recovery path; it must never revisit image or grammar providers.

**Tech Stack:** Node.js 20+ ESM, Node test runner with TypeScript stripping, `@gltf-transform/core`, `sharp`, Three.js browser viewer, Puppeteer/Chrome, existing facade harness and all-view/PBR validators.

## Global Constraints

- Source MASS, storeys, floor guides, facade segment authority, and selected GLB bytes are immutable.
- Render and drawing outputs must reference one identical selected GLB SHA-256.
- Images may propose appearance but cannot authorize new massing, windows, doors, or openings.
- The unbound entrance door remains proposal intent only.
- Recovery and regression verification make zero paid provider calls.
- A succeeded or uncertain paid operation is never replayed.
- Missing, stale, tampered, cross-candidate, or path-escaping persisted state fails closed.
- PBR rendering may change lighting and presentation only; it cannot mutate the GLB.
- Use TDD for every behavior change and commit after every independently reviewed task.

---

## File structure

- Create `plugins/elevation-3d/lib/facade-agent/final-presentation.mjs`: local-only PBR presentation orchestration and validation for one selected GLB.
- Modify `plugins/elevation-3d/lib/facade-agent/production-dependencies.mjs`: expose the local final-presentation dependency without capturing or invoking provider transports.
- Modify `plugins/elevation-3d/lib/facade-agent/harness.mjs`: persist presentation execution/receipt, invoke it once for the technical winner, and recover it for an older terminal winner.
- Create `test/elevation3d-facade-agent-presentation.test.ts`: focused contract, hash-binding, failure, and path tests for the new boundary.
- Modify `test/elevation3d-facade-agent-harness.test.ts`: winner-only invocation, persistence, crash recovery, tamper rejection, and no-replay tests.
- Modify `test/elevation3d-facade-agent-e2e.test.ts`: real offline facade GLB to PBR beauty render plus same-GLB elevations and browser evidence.
- Modify `memory/elevation-3d/README.md`: document the recovered single-GLB output and the zero-paid-call recovery evidence.
- Append `.superpowers/sdd/2026-08-06-facade-provider-router/task-7-report.md`: local handoff evidence; this ignored report is not committed.

---

### Task 1: Final presentation contract

**Files:**
- Create: `plugins/elevation-3d/lib/facade-agent/final-presentation.mjs`
- Create: `test/elevation3d-facade-agent-presentation.test.ts`

**Interfaces:**
- Consumes: `deliverFacadeFinalPresentation({ runDir, presentationRoot, candidateId, artifact, validation, validationReceipt, technicalDelivery, input, signal, lifecycle, deps })`.
- `artifact` is `{ path: string, sha256: string }`; `technicalDelivery` is the accepted result of `deliverSelectedAllViews`.
- Produces: `{ schema_version, selected_glb, technical_delivery, render, memory_record, receipt }` with schema `arr.elevation3d.facade-final-presentation.v1`.
- `deps.renderEmbeddedPbrViews` defaults to the existing `renderEmbeddedPbrViews`; tests inject only this local renderer.

- [ ] **Step 1: Write the failing contract test**

Add a real temporary GLB fixture and inject a local renderer that records its arguments:

```ts
test("renders one validated facade GLB into a bound final presentation", async () => {
  const result = await deliverFacadeFinalPresentation({
    runDir, presentationRoot: join(runDir, "final-presentation"), candidateId: "creative-020",
    artifact: { path: glbPath, sha256: glbSha256 },
    validation: { accepted: true, codes: [] },
    validationReceipt: { path: receiptPath, sha256: receiptSha256 },
    technicalDelivery: acceptedTechnicalDelivery(glbSha256), input: candidate,
    deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, glbSha256) },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].glbPath, glbPath);
  assert.equal(result.selected_glb.sha256, glbSha256);
  assert.equal(result.render.selected_glb.sha256, glbSha256);
  assert.equal(result.memory_record.presentation.sha256.length, 64);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test test/elevation3d-facade-agent-presentation.test.ts --experimental-strip-types
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `final-presentation.mjs`.

- [ ] **Step 3: Implement containment and shared-authority checks**

Implement these checks before invoking the renderer:

```js
const glbBytes = await readFile(resolve(artifact.path));
const selectedGlbSha256 = sha256(glbBytes);
if (selectedGlbSha256 !== artifact.sha256) fail("FACADE_PRESENTATION_GLB_HASH_MISMATCH");
if (validation?.accepted !== true) fail("FACADE_PRESENTATION_VALIDATION_REQUIRED");
if (technicalDelivery?.manifest?.selected_glb?.sha256 !== selectedGlbSha256) {
  fail("FACADE_PRESENTATION_TECHNICAL_BINDING_MISMATCH");
}
```

Resolve `presentationRoot` beneath `runDir`, reject symlinks/reparse escapes with the repository path-safety helpers, derive cameras with `deriveDeliveryCameras(input)`, and invoke `renderEmbeddedPbrViews` with:

```js
{
  glbPath: artifact.path,
  runDir: presentationRoot,
  candidateId,
  cameras,
  baselineRunDir: technicalDelivery.run_dir,
  renderStyleId: "competition-daylight-v1",
  canonicalSelection: {
    candidate_id: candidateId,
    selected_glb_sha256: selectedGlbSha256,
    facade_validation_receipt_sha256: validationReceipt.sha256,
  },
  signal,
  lifecycle,
}
```

Require `render.validation.accepted === true`, `render.provider_calls === 0`, `render.credits_consumed === 0`, all eight exact view names, and the selected GLB hash on every view. Write `final-presentation.json` atomically and return its path/hash in `memory_record.presentation`.

- [ ] **Step 4: Add negative contract cases**

Add table-driven tests for:

```ts
[
  ["tampered GLB", "FACADE_PRESENTATION_GLB_HASH_MISMATCH"],
  ["rejected facade validation", "FACADE_PRESENTATION_VALIDATION_REQUIRED"],
  ["different technical GLB", "FACADE_PRESENTATION_TECHNICAL_BINDING_MISMATCH"],
  ["rejected PBR report", "FACADE_PRESENTATION_RENDER_REJECTED"],
  ["renderer reports provider calls", "FACADE_PRESENTATION_REMOTE_ACTIVITY"],
  ["presentation root escapes run", "FACADE_PRESENTATION_PATH_INVALID"],
]
```

Assert the renderer is not called for all pre-render failures.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Task 1 command. Expected: all presentation contract tests pass with zero network mocks.

- [ ] **Step 6: Commit Task 1**

```powershell
git add plugins/elevation-3d/lib/facade-agent/final-presentation.mjs test/elevation3d-facade-agent-presentation.test.ts
git commit -m "feat(elevation3d): bind facade final presentation"
```

---

### Task 2: Winner-only harness persistence

**Files:**
- Modify: `plugins/elevation-3d/lib/facade-agent/harness.mjs`
- Modify: `test/elevation3d-facade-agent-harness.test.ts`

**Interfaces:**
- Consumes: `deps.renderPresentation(input)` with the Task 1 input contract.
- Produces persisted `run.presentation_execution`, `run.presentation_receipt`, and `final.presentation_sha256`.
- Existing per-provider `renderDelivery` remains the technical all-view evidence used by evaluation.

- [ ] **Step 1: Write the failing winner-only test**

Extend the harness fixture with `calls.presentation` and `deps.renderPresentation`. For two accepted providers, assert:

```ts
assert.equal(result.final.status, "winner");
assert.deepEqual(calls.presentation.map((call: any) => call.provider), [result.final.selected_provider]);
assert.equal(result.presentation_execution.status, "succeeded");
assert.equal(result.presentation_receipt.receipt_sha256, result.final.presentation_sha256);
```

The nonwinner may retain technical delivery evidence but must not receive a beauty presentation.

- [ ] **Step 2: Run the harness test and verify RED**

```powershell
node --test test/elevation3d-facade-agent-harness.test.ts --experimental-strip-types
```

Expected: FAIL because the harness never calls `renderPresentation` or persists its receipt.

- [ ] **Step 3: Add the local presentation stage after winner selection**

After the technical `decision` and winning technical delivery are known, authorize the selected GLB again, then persist:

```js
run.presentation_execution = {
  status: "submitting",
  provider: decision.provider,
  selected_glb_sha256: artifact.sha256,
};
```

Call `deps.renderPresentation` exactly once with the winning artifact, accepted validation/receipt, technical delivery, candidate input, and contained `final-presentation` root. Atomically write a durable receipt containing:

```js
{
  schema_version: "arr.elevation3d.facade-presentation-receipt.v1",
  provider: decision.provider,
  selected_glb_sha256: artifact.sha256,
  presentation_manifest: result.memory_record.presentation,
  technical_manifest: result.memory_record.technical_manifest,
  provider_calls: 0,
  credits_consumed: 0,
}
```

Only after the receipt is durable set `presentation_execution.status = "succeeded"` and include its content hash in `final.presentation_sha256`.

- [ ] **Step 4: Persist safe presentation paths**

Extend `persistedDeliveryMemory` or add `persistedPresentationMemory` so absolute paths are converted to contained run-relative paths. Preserve only plain data:

```js
{
  presentation: { path, sha256 },
  contact_sheet: { path, sha256 },
  views: { [name]: { path, sha256, selected_glb_sha256 } },
  selected_glb: { sha256 },
}
```

Reject accessors, unsafe paths, missing hashes, or a presentation selected-GLB hash that differs from the winner.

- [ ] **Step 5: Add failure and cancellation tests**

Cover renderer rejection, abort before render, abort during render, tampered GLB immediately before presentation, and a forged returned report. Assert no final `winner` is written unless the presentation receipt is durable. Local failures produce `status: "presentation-failed"` with a redacted stable code and preserve the technical delivery.

- [ ] **Step 6: Run harness and presentation tests**

```powershell
node --test test/elevation3d-facade-agent-harness.test.ts test/elevation3d-facade-agent-presentation.test.ts --experimental-strip-types
```

Expected: all tests pass.

- [ ] **Step 7: Commit Task 2**

```powershell
git add plugins/elevation-3d/lib/facade-agent/harness.mjs test/elevation3d-facade-agent-harness.test.ts
git commit -m "feat(elevation3d): persist winning facade presentation"
```

---

### Task 3: Zero-paid-call terminal recovery

**Files:**
- Modify: `plugins/elevation-3d/lib/facade-agent/harness.mjs`
- Modify: `test/elevation3d-facade-agent-harness.test.ts`

**Interfaces:**
- Consumes an existing terminal `winner` run with valid provider state, accepted version, validation receipt, technical delivery, and no presentation receipt.
- Produces the same presentation execution/receipt as Task 2 without calling `providers[*].generate`, `grammarProvider.extract`, `build`, `validate`, `score`, or `renderDelivery`.

- [ ] **Step 1: Write the failing legacy-terminal recovery test**

Create a fixture run to `winner`, remove only the new presentation fields to represent a pre-feature run, then resume with counters on every dependency:

```ts
const recovered = await runFacadeHarness(config, recoveryDeps);
assert.equal(recovered.final.status, "winner");
assert.equal(recoveryCalls.presentation, 1);
assert.deepEqual(recoveryCalls.paid, { image: 0, grammar: 0 });
assert.deepEqual(recoveryCalls.pipeline, { build: 0, validate: 0, score: 0, delivery: 0 });
```

- [ ] **Step 2: Run the recovery test and verify RED**

Run the Task 2 focused command. Expected: the existing terminal early return leaves presentation absent.

- [ ] **Step 3: Implement a strict terminal-recovery gate**

Before returning a terminal run, permit local recovery only when all conditions hold:

```js
run.status === "winner"
&& run.final?.selected_provider
&& HEX_SHA256.test(run.final?.selected_glb_sha256)
&& !run.presentation_receipt
```

Reload and hash-verify the selected provider manifest, accepted version artifact, validation receipt, and technical delivery memory. Reload the candidate package only to obtain trusted cameras/facade authority, and verify its candidate identity/hash against preflight. Then invoke the Task 2 local presentation stage directly. Any mismatch fails closed with `FACADE_PRESENTATION_RECOVERY_UNSAFE` and never enters provider loops.

- [ ] **Step 4: Add uncertainty and idempotency tests**

Add cases for:

- valid presentation receipt: resume performs zero work;
- `presentation_execution.status === "submitting"` without a valid receipt: fail closed, no rerender;
- succeeded execution with a missing/tampered receipt: fail closed;
- replaced GLB, validation receipt, provider manifest, or technical manifest: fail closed;
- a local render failure before a durable return: mark retryable local failure and permit a later recovery attempt from the same GLB;
- a crash after the render returns but before receipt persistence: mark uncertain and require manual reconciliation rather than silently duplicating artifacts.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Task 2 focused command. Expected: all recovery, uncertainty, and idempotency tests pass.

- [ ] **Step 6: Commit Task 3**

```powershell
git add plugins/elevation-3d/lib/facade-agent/harness.mjs test/elevation3d-facade-agent-harness.test.ts
git commit -m "fix(elevation3d): recover local facade presentation"
```

---

### Task 4: Production dependency wiring

**Files:**
- Modify: `plugins/elevation-3d/lib/facade-agent/production-dependencies.mjs`
- Modify: `test/elevation3d-facade-agent-presentation.test.ts`
- Modify: `test/elevation3d-plugin.test.ts`

**Interfaces:**
- Produces `renderPresentation: (input) => deliverFacadeFinalPresentation(input)` on production dependencies.
- The function must close over no image/grammar credentials, registries, ledger capability, or fetch implementation.

- [ ] **Step 1: Write the failing production-shape test**

Construct dependencies with provider factories that throw if accessed, then assert:

```ts
assert.equal(typeof deps.renderPresentation, "function");
const result = await deps.renderPresentation(localPresentationInput);
assert.equal(result.selected_glb.sha256, selectedGlbSha256);
assert.equal(fetchCalls, 0);
assert.equal(credentialReads, 0);
```

Inject the local renderer through an explicit `presentationRenderer` option used only by tests.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
node --test test/elevation3d-facade-agent-presentation.test.ts test/elevation3d-plugin.test.ts --experimental-strip-types
```

Expected: FAIL because production dependencies do not expose `renderPresentation`.

- [ ] **Step 3: Wire the local dependency**

Import `deliverFacadeFinalPresentation` and return:

```js
renderPresentation: (input) => deliverFacadeFinalPresentation({
  ...input,
  deps: options.presentationRenderer
    ? { renderEmbeddedPbrViews: options.presentationRenderer }
    : undefined,
}),
```

Do not pass `env`, `fetchImpl`, provider registries, or the paid ledger into this function.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Task 4 command. Expected: all tests pass with fetch and credential counters at zero.

- [ ] **Step 5: Commit Task 4**

```powershell
git add plugins/elevation-3d/lib/facade-agent/production-dependencies.mjs test/elevation3d-facade-agent-presentation.test.ts test/elevation3d-plugin.test.ts
git commit -m "feat(elevation3d): wire local facade presentation"
```

---

### Task 5: Real single-GLB facade/render/elevation E2E

**Files:**
- Modify: `test/elevation3d-facade-agent-e2e.test.ts`
- Modify only if an observed RED proves a boundary defect: `plugins/elevation-3d/lib/enrichment.mjs`, `plugins/elevation-3d/lib/texturing/render-validator.mjs`, or `plugins/elevation-3d/web/viewer-app.mjs`

**Interfaces:**
- Consumes the existing offline Seedream/BytePlus fixture and real `creative-020` authoritative 3D package.
- Produces retained evidence containing one selected facade GLB, technical eight-view delivery, PBR render report/contact sheet, four elevations, and browser reports.

- [ ] **Step 1: Extend the E2E assertions before implementation fixes**

After the existing selected-GLB and technical-delivery assertions, require:

```ts
const presentation = JSON.parse(await readFile(join(runDir, persisted.presentation_receipt.presentation_manifest.path)));
assert.equal(presentation.schema_version, "arr.elevation3d.embedded-pbr-render.v2");
assert.equal(presentation.selected_glb.sha256, accepted.artifact.sha256);
assert.equal(presentation.validation.accepted, true);
assert.equal(presentation.provider_calls, 0);
assert.equal(presentation.credits_consumed, 0);
for (const name of VIEW_NAMES) {
  assert.equal(presentation.views[name].selectedGlbSha256, accepted.artifact.sha256);
}
for (const name of ["front", "back", "left", "right"]) {
  assert.equal(deliveryManifest.views[name].selected_glb_sha256, accepted.artifact.sha256);
  assert.equal(deliveryManifest.views[name].camera_type, "orthographic");
}
assert.deepEqual(fetchCounts, { image: 1, grammar: 1, unexpected: 0 });
```

Also assert non-empty embedded base-color/normal/metallic-roughness texture provenance for brick and precast, non-empty semantic material roles, eight distinct view hashes, zero console errors, and a valid contact-sheet hash.

- [ ] **Step 2: Run the real E2E and observe RED**

```powershell
node --test test/elevation3d-facade-agent-e2e.test.ts --experimental-strip-types
```

Expected: FAIL because no final PBR presentation is currently produced. Record any later validation code exactly; do not weaken a quality gate to make the test pass.

- [ ] **Step 3: Fix only evidence-backed PBR boundary defects**

The current punched-facade writer already embeds deterministic 2048px brick/precast base-color, normal, and metallic-roughness maps. If the E2E exposes missing renderer evidence, preserve these requirements:

```js
material_mode === "embedded-pbr"
render_style.id === "competition-daylight-v1"
transparent_depth_writers === 0
facade_detail_meshes > 0
deterministic_render_order === true
selected_glb_altered === false
```

Correct the producer or evidence binding named by the failing validation code. Do not replace the GLB, synthesize receipt fields, loosen pixel/material thresholds, or introduce post-hoc architectural geometry.

- [ ] **Step 4: Rerun E2E and focused render/elevation suites**

```powershell
node --test test/elevation3d-facade-agent-e2e.test.ts test/elevation3d-all-views-e2e.test.ts test/elevation3d-texturing-render.test.ts test/elevation3d-competition-front-e2e.test.ts --experimental-strip-types --test-concurrency=1
```

Expected: all tests pass; every technical and presentation view references the identical selected GLB hash.

- [ ] **Step 5: Persist one fresh offline recovery artifact set**

```powershell
$env:FACADE_AGENT_E2E_OUTPUT_ROOT='D:\Data\50_ELE\facade-agent-verification\unified-facade-render-elevation-20260809'
node --test test/elevation3d-facade-agent-e2e.test.ts --experimental-strip-types
Remove-Item Env:FACADE_AGENT_E2E_OUTPUT_ROOT
```

Expected: one retained run; fixture transport counts remain exactly one image and one grammar call, with no external network request.

- [ ] **Step 6: Commit Task 5**

Stage only code/tests, never retained artifacts:

```powershell
git status --short
git add test/elevation3d-facade-agent-e2e.test.ts
# Add only the producer/viewer files that were actually changed in Step 3, using their explicit paths.
git diff --cached --name-only
git commit -m "test(elevation3d): verify unified facade presentation"
```

---

### Task 6: Documentation, review, and full verification

**Files:**
- Modify: `memory/elevation-3d/README.md`
- Append ignored local report: `.superpowers/sdd/2026-08-06-facade-provider-router/task-7-report.md`

**Interfaces:**
- Produces a committed durable summary of the single-GLB workflow and an ignored detailed local verification report.

- [ ] **Step 1: Document the recovered contract**

Add the selected commit range, retained artifact root, selected GLB hash, technical manifest hash, PBR render-report hash, contact-sheet hash, four elevation hashes, browser-report hashes, exact fixture transport counts, and the statement that no live provider call occurred.

- [ ] **Step 2: Run amended focused suites**

```powershell
node --test test/elevation3d-facade-agent-presentation.test.ts test/elevation3d-facade-agent-harness.test.ts test/elevation3d-facade-agent-e2e.test.ts test/elevation3d-all-views-e2e.test.ts test/elevation3d-texturing-render.test.ts test/elevation3d-competition-front-e2e.test.ts test/elevation3d-plugin.test.ts --experimental-strip-types --test-concurrency=1
```

Expected: zero failures and zero cancellations.

- [ ] **Step 3: Run full completion verification**

```powershell
npm test -- --test-concurrency=1
npm run build
npm audit --audit-level=high
git diff --check
git status --short --branch
```

Expected: all tests pass, TypeScript exits 0, audit reports 0 high-or-greater vulnerabilities, diff check exits 0, and only intended files are modified.

- [ ] **Step 4: Review the complete diff**

Request an independent review covering selected-GLB authority, provider isolation, terminal recovery, crash windows, path containment, PBR evidence, elevation camera binding, no fake geometry, and test sufficiency. Fix every Critical or Important issue through a new RED/GREEN cycle and rerun Steps 2-3.

- [ ] **Step 5: Commit documentation**

```powershell
git add memory/elevation-3d/README.md
git commit -m "docs(elevation3d): record unified facade delivery"
```

- [ ] **Step 6: Finish the branch**

Use `superpowers:finishing-a-development-branch`; present merge, PR, or keep-as-is options only after fresh verification is green.
