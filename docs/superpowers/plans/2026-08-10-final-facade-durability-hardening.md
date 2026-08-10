# Final Facade Durability Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the final three facade-delivery durability blockers: server/browser bounds parity, single-read JSON closure verification, and zero-call orphan-receipt recovery.

**Architecture:** Canonical geometry bounds are derived from the same transformed vertex semantics in Node and Three.js. Content-addressed JSON is hashed and parsed from one immutable buffer. Presentation resume recognizes only one deterministic orphan-receipt checkpoint (`returned`, exact authority, missing state reference), fully verifies it, and finalizes without replay.

**Tech Stack:** Node.js 20+ ESM, Node test runner with TypeScript stripping, `@gltf-transform/core`, Three.js, Puppeteer/Chrome, existing facade artifact-closure and harness state machine.

## Global Constraints

- Source MASS, storeys, floor guides, facade authority, selected GLB bytes, PBR style, and validation thresholds are immutable.
- Render and drawing outputs reference one identical selected GLB SHA-256.
- No fake massing, window, opening, or door geometry may be introduced.
- Images do not authorize architecture.
- Paid image/grammar operations remain one-shot; succeeded or uncertain work is never replayed.
- Orphan-receipt recovery performs zero provider, renderer, build, validation, score, or delivery calls.
- Missing, stale, tampered, cross-candidate, path-escaping, or wrong-checkpoint state fails closed.
- The untouched legacy `results.mjs` drawing/finalization junction paths remain out of scope.
- Every behavior change follows RED/GREEN TDD and receives an independent task review.

---

## File structure

- Modify `plugins/elevation-3d/lib/camera-authority.mjs`: derive Node bounds from transformed `POSITION` vertices rather than a different aggregate algorithm.
- Modify `plugins/elevation-3d/web/viewer-app.mjs`: use precise transformed-vertex `Box3` bounds everywhere authoritative viewer bounds are captured.
- Modify `test/elevation3d-unified-flow.test.ts`: transformed/indexed/unreferenced-position bounds parity and coherent-mutation rejection.
- Modify `plugins/elevation-3d/lib/facade-agent/artifact-closure.mjs`: read each JSON leaf once and parse the exact hashed bytes.
- Modify `test/elevation3d-facade-agent-presentation.test.ts`: one-read JSON closure and tamper regressions.
- Modify `plugins/elevation-3d/lib/facade-agent/harness.mjs`: deterministic orphan receipt discovery, verification, adoption, and zero-call finalization.
- Modify `test/elevation3d-facade-agent-harness.test.ts`: post-receipt/pre-state crash plus wrong-authority/checkpoint rejection.
- Modify `memory/elevation-3d/README.md`: record the follow-up commit range and refreshed retained evidence.
- Append ignored reports under `.superpowers/sdd/2026-08-10-final-facade-durability-hardening/`.

---

### Task 1: Canonical server/browser geometry bounds

**Files:**
- Modify: `plugins/elevation-3d/lib/camera-authority.mjs`
- Modify: `plugins/elevation-3d/web/viewer-app.mjs`
- Modify: `test/elevation3d-unified-flow.test.ts`

**Interfaces:**
- `cameraGeometryFromGlb(bytes)` continues producing `{ bounds, points }`, but `bounds` is computed from the exact transformed points used for camera fitting.
- Browser `building_bounds` uses `THREE.Box3().setFromObject(root, true)` so it expands transformed vertex positions precisely.
- `technicalCameraAuthorityFromGlb({ bytes, cameras })` and durable schemas remain unchanged.

- [ ] **Step 1: Write the transformed/indexed parity RED**

Add a GLB fixture with:

- a non-identity parent transform (translation plus Z rotation);
- indexed triangle geometry;
- one finite unreferenced `POSITION` vertex that is present in the rendered buffer;
- authoritative eight-view candidate cameras.

Construct the geometry with the existing glTF test utilities using these literal values:

```ts
const positions = new Float32Array([
  0, 0, 0,
  2, 0, 0,
  0, 1, 0,
  4, 3, 2, // finite unreferenced POSITION vertex; still present in the rendered buffer
]);
const indices = new Uint16Array([0, 1, 2]);
const parentTransform = {
  translation: [7, -3, 5],
  rotationZRadians: Math.PI / 3,
};
```

The hand-derived transformed points are:

```ts
const expectedWorldPoints = [
  [7, -3, 5],
  [8, -1.2679491924311228, 5],
  [6.133974596215562, -2.5, 5],
  [6.401923788646684, 1.9641016151377544, 7],
];
```

Use their literal axis minima/maxima to assert the Node result before starting the browser so the test does not derive both expectations through production helpers.

Run the real all-views/browser path and independently call `cameraBuildingBoundsFromGlb(bytes)`. Assert literal normalized equality:

```ts
assert.deepEqual(
  normalizeCameraValue(browser.camera_building_bounds.axon),
  normalizeCameraValue(await cameraBuildingBoundsFromGlb(glbBytes)),
);
for (const name of DELIVERY_VIEW_NAMES) {
  assert.deepEqual(
    normalizeCameraValue(browser.camera_building_bounds[name]),
    normalizeCameraValue(authority.building_bounds),
  );
}
```

Also mutate the browser-reported center by `0.001` and assert `ALL_VIEWS_REJECTED`.

- [ ] **Step 2: Run RED**

```powershell
node --test --test-name-pattern="transformed indexed GLB bounds" test/elevation3d-unified-flow.test.ts --experimental-strip-types
```

Expected: FAIL because Node `getBounds(scene)` and browser non-precise `Box3.setFromObject(root)` disagree.

- [ ] **Step 3: Implement one canonical point-bounds algorithm**

Replace the Node aggregate bounds source with bounds over the already transformed points:

```js
function boundsFromPoints(points) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const point of points) for (let axis = 0; axis < 3; axis += 1) {
    min[axis] = Math.min(min[axis], point[axis]);
    max[axis] = Math.max(max[axis], point[axis]);
  }
  if (![...min, ...max].every(Number.isFinite)) {
    throw new Error("selected GLB has no finite geometry bounds for camera authority");
  }
  return { min, max };
}
```

Remove the `getBounds` import. Collect transformed points once, require at least one point, and return `boundsFromPoints(points)`.

In `viewer-app.mjs`, use a focused helper for every authoritative loaded-object bound:

```js
function preciseObjectBounds(root) {
  return new THREE.Box3().setFromObject(root, true);
}
```

Use it in the GLB fallback of `contentCenter()` (`scene`), `renderInteractiveAllViews()` (`root`), and the existing axon bounds path. Do not change the explicit legacy `config.mesh.vertices` branch.

- [ ] **Step 4: Run GREEN and existing camera suites**

```powershell
node --test test/elevation3d-unified-flow.test.ts test/elevation3d-facade-agent-presentation.test.ts test/elevation3d-texturing-render.test.ts --experimental-strip-types --test-concurrency=1
```

Expected: all pass; coherent camera/bounds mutations remain rejected.

- [ ] **Step 5: Commit Task 1**

```powershell
git add plugins/elevation-3d/lib/camera-authority.mjs plugins/elevation-3d/web/viewer-app.mjs test/elevation3d-unified-flow.test.ts
git commit -m "fix(elevation3d): unify camera geometry bounds"
```

---

### Task 2: Single-read content-addressed JSON

**Files:**
- Modify: `plugins/elevation-3d/lib/facade-agent/artifact-closure.mjs`
- Modify: `test/elevation3d-facade-agent-presentation.test.ts`

**Interfaces:**
- Add `readContentAddressedJson({ runDir, value, label, expectedSha256, readBytes })`.
- It returns `{ ref: { path, sha256 }, value }` and calls `readBytes` exactly once.
- Production defaults `readBytes` to `safeRead`; `closeJson` delegates to this function.

- [ ] **Step 1: Write the one-read RED**

Export the wished-for API in the test import, then use an injected reader whose first call returns valid content-addressed JSON and whose second call would return a semantic mutation:

```ts
let reads = 0;
const original = Buffer.from(JSON.stringify({ accepted: true, selected_glb: "a".repeat(64) }));
const mutated = Buffer.from(JSON.stringify({ accepted: false, selected_glb: "b".repeat(64) }));
const result = await readContentAddressedJson({
  runDir,
  value: { path: "authority.json", sha256: sha256(original) },
  label: "authority",
  readBytes: async () => (++reads === 1 ? original : mutated),
});
assert.equal(reads, 1);
assert.equal(result.value.accepted, true);
```

Add separate cases for wrong claimed hash and invalid JSON; each must call the reader once and reject with `FACADE_PRESENTATION_ARTIFACT_CLOSURE_INVALID`.

- [ ] **Step 2: Run RED**

```powershell
node --test --test-name-pattern="content-addressed JSON" test/elevation3d-facade-agent-presentation.test.ts --experimental-strip-types
```

Expected: FAIL because the API is absent or the existing `closeJson` needs two reads.

- [ ] **Step 3: Implement a single immutable read**

Implement:

```js
export async function readContentAddressedJson({
  runDir, value, label, expectedSha256, readBytes = safeRead,
}) {
  const claimed = claimedRef(value, label);
  const path = portable(runDir, claimed.path, label);
  let bytes;
  try { bytes = await readBytes(runDir, join(runDir, path), label); }
  catch (error) { fail(`${label} is unavailable or unsafe`, error); }
  const digest = sha256(bytes);
  if (claimed.sha256 && claimed.sha256.toLowerCase() !== digest) {
    fail(`${label} SHA-256 does not match its bytes`);
  }
  if (expectedSha256 && expectedSha256.toLowerCase() !== digest) {
    fail(`${label} is not bound to the selected GLB`);
  }
  let parsed;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch (error) { fail(`${label} is not valid JSON`, error); }
  return { ref: { path, sha256: digest }, value: parsed };
}
```

Make `closeJson` call it directly. Keep binary `closeRef` unchanged. Ensure closure verification never reparses a JSON file through a second read.

- [ ] **Step 4: Run GREEN and closure suites**

```powershell
node --test test/elevation3d-facade-agent-presentation.test.ts test/elevation3d-facade-agent-harness.test.ts --experimental-strip-types --test-concurrency=1
```

Expected: all pass; existing leaf deletion, semantic tamper, and hash mismatch tests remain fail-closed.

- [ ] **Step 5: Commit Task 2**

```powershell
git add plugins/elevation-3d/lib/facade-agent/artifact-closure.mjs test/elevation3d-facade-agent-presentation.test.ts
git commit -m "fix(elevation3d): parse closed JSON from hashed bytes"
```

---

### Task 3: Recover a deterministic orphan presentation receipt

**Files:**
- Modify: `plugins/elevation-3d/lib/facade-agent/harness.mjs`
- Modify: `test/elevation3d-facade-agent-harness.test.ts`

**Interfaces:**
- Deterministic path: `final-presentation/presentation-receipt.json`.
- New internal `discoverOrphanPresentationReceipt(runDir, run)` returns an adopted run only for exact `returned` authority, or `null` when no receipt exists.
- A present but invalid/mismatched orphan receipt throws `FACADE_PRESENTATION_RECOVERY_UNSAFE`.

- [ ] **Step 1: Write the post-receipt crash RED**

Add lifecycle support for the exact durable boundary and simulate a crash after the receipt file exists but before `run.presentation_receipt` / `presentation_execution.status = "succeeded"` is persisted:

```ts
let crash = true;
const first = await fixture({
  runId: "presentation-orphan-receipt",
  lifecycle: { onTransition(event: any) {
    if (crash && event.stage === "presentation" && event.status === "receipt-persisted") {
      crash = false;
      throw new Error("crash after presentation receipt persisted");
    }
  } },
});
await assert.rejects(() => runFacadeAgent(first.config, first.deps), /crash after presentation receipt persisted/);
const persisted = JSON.parse(await readFile(join(first.runDir, "run.json"), "utf8"));
assert.equal(persisted.presentation_execution.status, "returned");
assert.equal(persisted.presentation_receipt, undefined);
assert.equal(await exists(join(first.runDir, "final-presentation/presentation-receipt.json")), true);
```

Resume with counters and assert:

```ts
assert.equal(resumed.final.status, "winner");
assert.equal(recoveryCalls.presentation, 0);
assert.deepEqual(recoveryCalls.paid, { image: 0, grammar: 0 });
assert.deepEqual(recoveryCalls.pipeline, { build: 0, validate: 0, score: 0, delivery: 0 });
```

- [ ] **Step 2: Add wrong-authority/checkpoint RED cases**

Mutate one field at a time in the orphan receipt: provider, candidate ID/SHA, selected version, selected GLB SHA, technical manifest, artifact closure, provider calls, or credits. Also test persisted execution states `prepared`, `rendering`, `failed`, `uncertain`, and `succeeded-without-reference`.

Use explicit tables so every authority and checkpoint is independently exercised:

```ts
const receiptMutations = [
  ["provider", (receipt: any) => { receipt.provider = "other-provider"; }],
  ["candidate id", (receipt: any) => { receipt.candidate_id = "other-candidate"; }],
  ["candidate sha", (receipt: any) => { receipt.candidate_sha256 = "0".repeat(64); }],
  ["version", (receipt: any) => { receipt.selected_version = "v999"; }],
  ["GLB", (receipt: any) => { receipt.selected_glb_sha256 = "1".repeat(64); }],
  ["technical manifest", (receipt: any) => { receipt.technical_manifest.sha256 = "2".repeat(64); }],
  ["closure", (receipt: any) => { receipt.artifact_closure.sha256 = "3".repeat(64); }],
  ["provider calls", (receipt: any) => { receipt.provider_calls = 1; }],
  ["credits", (receipt: any) => { receipt.credits_consumed = 1; }],
] as const;
const wrongCheckpoints = ["prepared", "rendering", "failed", "uncertain", "succeeded"] as const;
```

Every case must reject with `FACADE_PRESENTATION_RECOVERY_UNSAFE`, make zero dependency calls, and leave the orphan file untouched.

- [ ] **Step 3: Run RED**

```powershell
node --test --test-name-pattern="orphan presentation receipt" test/elevation3d-facade-agent-harness.test.ts --experimental-strip-types
```

Expected: valid orphan cannot finalize because initialization rejects persisted `returned` state.

- [ ] **Step 4: Implement narrow orphan discovery and adoption**

Track receipt publication separately inside `executePresentationStage`:

```js
let receiptPersisted = false;
const receipt = await writeReceipt(...);
receiptPersisted = true;
await callLifecycle(deps, {
  stage: "presentation", status: "receipt-persisted", provider,
  selected_glb_sha256: artifact.sha256, receipt_sha256: receipt.receipt_sha256,
});
```

In the catch block, when `receiptPersisted` is true but the public run has not recorded the receipt, rethrow the lifecycle/crash error without rewriting the persisted `returned` checkpoint.

Implement discovery:

```js
const ORPHAN_PRESENTATION_RECEIPT_PATH = "final-presentation/presentation-receipt.json";

async function discoverOrphanPresentationReceipt(runDir, run) {
  const execution = run.presentation_execution;
  if (run.presentation_receipt) return null;
  const absolute = containedPath(runDir, join(runDir, ORPHAN_PRESENTATION_RECEIPT_PATH), "orphan presentation receipt");
  if (!await exists(absolute)) return null;
  if (execution?.status !== "returned" || !exactReturnedAuthority(run, execution)) {
    throw codedError("FACADE_PRESENTATION_RECOVERY_UNSAFE", "Orphan presentation receipt checkpoint or authority is invalid");
  }
  const bytes = await safeRead(runDir, absolute, "orphan presentation receipt");
  const receipt = JSON.parse(bytes.toString("utf8"));
  const ref = {
    path: ORPHAN_PRESENTATION_RECEIPT_PATH,
    sha256: sha256(bytes),
    receipt_sha256: sha256(stableJson(receipt)),
  };
  const adopted = structuredClone(run);
  adopted.presentation_receipt = ref;
  adopted.presentation_execution = {
    ...execution,
    status: "succeeded",
    artifact_closure: receipt.artifact_closure,
    receipt_sha256: ref.receipt_sha256,
  };
  await verifyPresentationReceipt(runDir, adopted, true);
  return adopted;
}
```

Wrap JSON/path/hash/binding failures as `FACADE_PRESENTATION_RECOVERY_UNSAFE`. During initialization, attempt discovery before rejecting `returned`; if adopted, persist the succeeded run and route through the existing committed-receipt zero-call finalizer. Do not broaden `presentationRecoveryAttemptAllowed`.

- [ ] **Step 5: Run GREEN and full recovery suites**

```powershell
node --test test/elevation3d-facade-agent-harness.test.ts test/elevation3d-facade-agent-presentation.test.ts --experimental-strip-types --test-concurrency=1
```

Expected: valid orphan zero-call finalizes; every wrong state/authority case fails closed; existing returned uncertainty and retry tests remain green.

- [ ] **Step 6: Commit Task 3**

```powershell
git add plugins/elevation-3d/lib/facade-agent/harness.mjs test/elevation3d-facade-agent-harness.test.ts
git commit -m "fix(elevation3d): recover orphan presentation receipt"
```

---

### Task 4: Integration evidence, documentation, and completion review

**Files:**
- Modify: `memory/elevation-3d/README.md`
- Append ignored reports under `.superpowers/sdd/2026-08-10-final-facade-durability-hardening/`

**Interfaces:**
- Produces a fresh retained offline run under `D:\Data\50_ELE\facade-agent-verification\unified-facade-render-elevation-20260810`.
- Documents selected, contained technical, and presentation-loaded GLB hashes plus closure/receipt/view/elevation/browser hashes and zero-live-call counts.

- [ ] **Step 1: Run amended focused suites**

```powershell
node --test test/elevation3d-unified-flow.test.ts test/elevation3d-facade-agent-presentation.test.ts test/elevation3d-facade-agent-harness.test.ts test/elevation3d-facade-agent-e2e.test.ts test/elevation3d-all-views-e2e.test.ts test/elevation3d-texturing-render.test.ts test/elevation3d-plugin.test.ts --experimental-strip-types --test-concurrency=1
```

Expected: zero failures/cancellations/skips; transformed bounds, one-read closure, and orphan recovery regressions pass.

- [ ] **Step 2: Refresh offline retained evidence**

```powershell
$env:FACADE_AGENT_E2E_OUTPUT_ROOT='D:\Data\50_ELE\facade-agent-verification\unified-facade-render-elevation-20260810'
node --test test/elevation3d-facade-agent-e2e.test.ts --experimental-strip-types
Remove-Item Env:FACADE_AGENT_E2E_OUTPUT_ROOT
```

Expected: one winner run; fixture counts `{ image: 1, grammar: 1, unexpected: 0 }`; presentation provider calls/credits 0; selected/enriched/textured GLB SHA-256 values identical.

- [ ] **Step 3: Run full completion verification**

```powershell
npm test -- --test-concurrency=1
npm run build
npm audit --audit-level=high
git diff --check
git status --short --branch
```

Expected: full suite green, build exit 0, 0 vulnerabilities, diff check exit 0, only intended tracked documentation modified before its commit.

- [ ] **Step 4: Document exact evidence and commit**

Record the follow-up commit range, retained root/run, selected/enriched/textured GLB hashes, artifact-closure and presentation-receipt hashes, front/back/left/right technical hashes, presentation contact sheet, browser report, exact test totals, and no-live-call statement.

```powershell
git add memory/elevation-3d/README.md
git commit -m "docs(elevation3d): record final durability verification"
```

- [ ] **Step 5: Independent final review**

Review the complete follow-up range for:

- transformed/indexed/unreferenced-position bounds parity;
- single-read hash/parse identity;
- exact orphan receipt authority and zero-call recovery;
- no regression to paid-call, facade geometry, PBR, elevation, path containment, or full artifact closure.

Fix every Critical/Important finding through a new RED/GREEN cycle, rerun Steps 1-3, and use `superpowers:finishing-a-development-branch` only after the review is clean.
