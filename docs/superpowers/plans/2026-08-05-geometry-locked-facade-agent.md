# Geometry-Locked Facade Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a CLI-driven agent harness that compares one GPT Image 2 proposal with one Nano Banana Pro proposal, converts each into a typed red-brick punched-window facade on the exact `creative-020` MASS, validates two bounded local builds, and selects only a geometry-safe multi-view winner.

**Architecture:** Add a focused `facade-agent/` package beside the existing enrichment pipeline. The package locks candidate evidence, performs crash-safe provider calls, extracts an allowlisted grammar, delegates geometry construction to a new punched-facade builder, runs existing and new hard gates, and scores accepted results. The CLI and plugin tool call the same harness; the existing procedural `elevation_3d_run` and optional Tripo path remain available but are not invoked by this agent.

**Tech Stack:** Node.js ESM, TypeScript node:test files, native `fetch`, `sharp`, `three`, Puppeteer/Chromium through the existing viewer stack, `@gltf-transform/core`, deterministic JSON/SHA-256 utilities, OpenAI Images and Responses HTTP APIs, Gemini `generateContent` HTTP API.

## Global Constraints

- First candidate is exactly `creative-020`.
- Facade brief is exactly `brick-punched-window-v1`: opaque red brick, repeated deep punched windows, restrained precast lintels and sills, no curtain wall.
- The indexed mesh, canonical MASS primitive, transforms, bounds, dimensions, component count, placement, floor guides, and camera contract are immutable.
- GPT Image 2 and Nano Banana Pro receive the same semantic evidence and at most one image-generation submission each.
- Grammar extraction uses `gpt-5.6` with one common OpenAI multimodal structured-output contract per downloaded proposal; it is separately budgeted and never substitutes an image provider.
- Provider generation is never automatically retried. Status polling and artifact download may retry only when they cannot create another billable generation.
- Each provider gets at most `v001` and one allowlisted local `v002` grammar/build correction.
- The harness, not model output, owns state, cost ceilings, retries, validation, scoring, artifact publication, and winner selection.
- Every CLI stage verifies upstream hashes, refuses overwrite, writes atomically, emits redacted JSON on stdout, and uses distinct nonzero exit codes for rejection, configuration, transport, security, and internal failures.
- Unit, integration, CLI, and browser fixture tests make no external API calls.
- No live call occurs until the full suite, build, audit, CLI dry-run, credential preflight, and explicit per-provider cost approval pass.

---

## File Structure

Create these focused modules:

- `plugins/elevation-3d/lib/facade-agent/contract.mjs` — constants, schemas, normalization, path and budget checks.
- `plugins/elevation-3d/lib/facade-agent/evidence.mjs` — immutable color/depth/normal/edge/floor-guide evidence pack.
- `plugins/elevation-3d/lib/facade-agent/evidence-renderer.mjs` — deterministic software rasterizer for geometry evidence passes.
- `plugins/elevation-3d/lib/facade-agent/paid-operation-ledger.mjs` — atomic one-submit records for synchronous and asynchronous image/model calls.
- `plugins/elevation-3d/lib/facade-agent/provider.mjs` — narrow adapter contract and normalized failure types.
- `plugins/elevation-3d/lib/facade-agent/providers/openai-image.mjs` — GPT Image 2 request and response adapter.
- `plugins/elevation-3d/lib/facade-agent/providers/gemini-image.mjs` — Nano Banana Pro request and response adapter.
- `plugins/elevation-3d/lib/facade-agent/grammar-agent.mjs` — common OpenAI multimodal structured grammar extraction.
- `plugins/elevation-3d/lib/facade-agent/punched-facade.mjs` — deterministic cladding shell, openings, reveals, glazing, frames, lintels, sills, and corner anchors.
- `plugins/elevation-3d/lib/facade-agent/procedural-materials.mjs` — deterministic brick/precast PBR maps and UV helpers.
- `plugins/elevation-3d/lib/facade-agent/score.mjs` — hard-gate eligibility and weighted provider comparison.
- `plugins/elevation-3d/lib/facade-agent/harness.mjs` — persisted state machine and bounded local repair loop.
- `plugins/elevation-3d/lib/facade-agent/cli.mjs` — stage subcommands, stdout/stderr and exit-code contract.
- `scripts/elevation-3d-facade.mjs` — executable CLI entry.

Modify only the existing shared files that own the affected boundary:

- `plugins/elevation-3d/lib/facade-grammar.mjs` — accept and correct the typed punched-facade grammar.
- `plugins/elevation-3d/lib/enrichment.mjs` — delegate facade-detail creation and add brick/precast materials without changing canonical MASS emission.
- `plugins/elevation-3d/lib/enrichment-validation.mjs` — add geometry-lock, reveal-depth, opaque-wall, corner, and floor gates.
- `plugins/elevation-3d/lib/final-delivery.mjs` — export the already-tested paired delivery-camera derivation for evidence rendering.
- `plugins/elevation-3d/lib/run-memory.mjs` — persist redacted facade-agent comparison evidence.
- `plugins/elevation-3d/index.mjs` — register `elevation_3d_facade_agent_run` without changing the existing tool order.
- `package.json` — add the CLI script.
- `memory/elevation-3d/README.md` — record the superseding production path after fixture verification.

Tests mirror responsibilities instead of collecting everything in one file.

---

### Task 1: Lock the Facade-Agent Contract

**Files:**
- Create: `plugins/elevation-3d/lib/facade-agent/contract.mjs`
- Create: `test/elevation3d-facade-agent-contract.test.ts`

**Interfaces:**
- Produces: `FACADE_AGENT_PROVIDERS`, `FACADE_AGENT_STAGES`, `normalizeFacadeAgentConfig(input)`, `facadeRequestFingerprint(input)`, `FacadeAgentContractError`.
- Consumes: `stableJson`, `sha256`, and `redactSecrets` from `plugins/elevation-3d/lib/core.mjs`; `assertSafePathSegment` from `plugins/elevation-3d/lib/run-memory.mjs`.

- [ ] **Step 1: Write failing contract tests**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	FacadeAgentContractError,
	facadeRequestFingerprint,
	normalizeFacadeAgentConfig,
} from "../plugins/elevation-3d/lib/facade-agent/contract.mjs";

test("locks the first comparison and rejects unsafe expansion", () => {
	const value = normalizeFacadeAgentConfig({
		candidateId: "creative-020",
		datasetRoot: "D:/dataset",
		outputRoot: "D:/results",
		runId: "brick-ab-001",
		providers: ["gpt-image-2", "nano-banana-pro"],
		briefId: "brick-punched-window-v1",
		confirmLive: false,
		imageBudgetUsd: { "gpt-image-2": 1, "nano-banana-pro": 1 },
		grammarBudgetUsd: 1,
		grammarModel: "gpt-5.6",
	});
	assert.equal(value.maxLocalAttempts, 2);
	assert.equal(value.maxImageSubmissionsPerProvider, 1);
	assert.deepEqual(value.providers, ["gpt-image-2", "nano-banana-pro"]);
	assert.throws(() => normalizeFacadeAgentConfig({ ...value, candidateId: "../escape" }), FacadeAgentContractError);
	assert.throws(() => normalizeFacadeAgentConfig({ ...value, maxLocalAttempts: 3 }), /two local attempts/i);
});

test("fingerprint is stable and excludes consent-free defaults", () => {
	const left = facadeRequestFingerprint({ provider: "gpt-image-2", evidenceSha256: "a".repeat(64), briefId: "brick-punched-window-v1", parameters: { quality: "high", size: "auto" } });
	const right = facadeRequestFingerprint({ parameters: { size: "auto", quality: "high" }, briefId: "brick-punched-window-v1", evidenceSha256: "a".repeat(64), provider: "gpt-image-2" });
	assert.equal(left, right);
});
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `node --test test/elevation3d-facade-agent-contract.test.ts --experimental-strip-types`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `facade-agent/contract.mjs`.

- [ ] **Step 3: Implement the immutable contract**

```js
export const FACADE_AGENT_PROVIDERS = Object.freeze(["gpt-image-2", "nano-banana-pro"]);
export const FACADE_AGENT_STAGES = Object.freeze(["preflight", "evidence", "generate", "grammar", "build", "validate", "compare"]);

export class FacadeAgentContractError extends Error {
	constructor(code, message) { super(message); this.name = "FacadeAgentContractError"; this.code = code; }
}

export function normalizeFacadeAgentConfig(input) {
	const candidateId = assertSafePathSegment(input.candidateId, "candidate_id");
	const runId = assertSafePathSegment(input.runId, "run_id");
	if (candidateId !== "creative-020") throw new FacadeAgentContractError("CANDIDATE_NOT_APPROVED", "First comparison requires creative-020");
	if (input.briefId !== "brick-punched-window-v1") throw new FacadeAgentContractError("BRIEF_NOT_APPROVED", "First comparison requires brick-punched-window-v1");
	if (input.grammarModel !== "gpt-5.6") throw new FacadeAgentContractError("GRAMMAR_MODEL_INVALID", "First comparison requires gpt-5.6 grammar extraction");
	if (input.maxLocalAttempts !== undefined && input.maxLocalAttempts !== 2) throw new FacadeAgentContractError("LOCAL_ATTEMPT_LIMIT_INVALID", "Exactly two local attempts are allowed");
	const providers = [...(input.providers ?? FACADE_AGENT_PROVIDERS)];
	if (providers.join("|") !== FACADE_AGENT_PROVIDERS.join("|")) throw new FacadeAgentContractError("PROVIDER_SET_INVALID", "Controlled comparison requires both providers in fixed order");
	return Object.freeze({ ...input, candidateId, runId, providers, maxLocalAttempts: 2, maxImageSubmissionsPerProvider: 1, confirmLive: input.confirmLive === true });
}

export function facadeRequestFingerprint(input) {
	return sha256(stableJson(input));
}
```

Import the named shared functions, resolve dataset/output roots to absolute paths, require finite nonnegative provider ceilings, and return only redacted data from any exported summary helper.

- [ ] **Step 4: Run the contract test and verify GREEN**

Run: `node --test test/elevation3d-facade-agent-contract.test.ts --experimental-strip-types`

Expected: 2 tests pass.

- [ ] **Step 5: Commit the contract**

```bash
git add plugins/elevation-3d/lib/facade-agent/contract.mjs test/elevation3d-facade-agent-contract.test.ts
git commit -m "feat(elevation-3d): lock facade agent contract"
```

---

### Task 2: Build an Immutable Geometry Evidence Pack

**Files:**
- Create: `plugins/elevation-3d/lib/facade-agent/evidence.mjs`
- Create: `plugins/elevation-3d/lib/facade-agent/evidence-renderer.mjs`
- Create: `test/elevation3d-facade-agent-evidence.test.ts`
- Modify: `plugins/elevation-3d/lib/final-delivery.mjs`
- Modify: `test/elevation3d-all-views-e2e.test.ts`
- Reuse: `plugins/elevation-3d/lib/core.mjs`
- Reuse: `plugins/elevation-3d/lib/enrichment.mjs`

**Interfaces:**
- Consumes: `loadCandidatePackage(datasetRoot, candidateId)` and `writeEnrichedGlb(scene, outputPath)`.
- Produces: `buildFacadeEvidencePack({ input, runDir, renderPasses, signal }) -> { manifestPath, manifestSha256, contactSheetPath, artifacts }` and `renderFacadeEvidencePasses({ mesh, cameras, outputDir, modes, signal })`.
- `renderPasses` receives `{ mesh, cameras, outputDir, modes, signal }` and returns paths for `color`, `depth`, `normal`, `edge`, and `surface-id` passes; production uses the deterministic software rasterizer and tests may inject fixed PNGs.
- Consumes: exported `deriveDeliveryCameras(input)` from `final-delivery.mjs` so the evidence pack uses the same axon/opposite-axon pair as final delivery.

- [ ] **Step 1: Write failing evidence tests**

Test that the function:

```ts
const pack = await buildFacadeEvidencePack({
	input,
	runDir,
	renderPasses: async ({ modes }: any) => Object.fromEntries(modes.flatMap((mode: string) =>
		["front", "right", "back", "left", "top", "axon", "opposite-axon"].map((view) => [`${mode}:${view}`, fixturePng])))),
});
assert.equal(pack.manifest.candidate_id, "creative-020");
assert.equal(pack.manifest.geometry_hash, input.identity.geometry_hash);
assert.deepEqual(pack.manifest.floor_guides_m, input.floor_guides.floor_guides_m);
assert.equal(Object.keys(pack.manifest.artifacts).length, 35);
assert.equal(pack.manifest.contact_sheet.sha256.length, 64);
```

Also mutate one upstream artifact hash after pack creation and assert `verifyFacadeEvidencePack()` throws `EVIDENCE_INPUT_HASH_MISMATCH`.

- [ ] **Step 2: Run evidence tests and verify RED**

Run: `node --test test/elevation3d-facade-agent-evidence.test.ts --experimental-strip-types`

Expected: FAIL because `buildFacadeEvidencePack` is absent.

- [ ] **Step 3: Implement evidence creation and verification**

Export the current private `deliveryCameras(input)` implementation as `deriveDeliveryCameras(input)` without changing its calculations, and update its existing callers. Add a regression assertion that the derived axon depth vectors have dot product below `-0.8`.

Implement a triangle z-buffer rasterizer at 1024 x 1024. Orthographic views use the stored `view_matrix4` and `projected_bounds_m`; derived axons construct right/up/depth camera basis vectors from `position`, `target`, `up`, and `fov_degrees`. For each covered pixel, retain the nearest depth and emit neutral Lambert color, normalized depth, world-normal RGB, stable triangle-ID color, and a one-pixel edge mask derived from triangle/depth discontinuities. Encode raw RGB buffers with `sharp`; never infer geometry from a source PNG.

Require seven named cameras and five pass modes. Hash every PNG byte, then compose a labelled contact sheet with `sharp` in fixed view order.

```js
const VIEW_NAMES = ["front", "right", "back", "left", "top", "axon", "opposite-axon"];
const PASS_NAMES = ["color", "depth", "normal", "edge", "surface-id"];
const manifest = {
	schema_version: "arr.elevation3d.facade-evidence.v1",
	candidate_id: input.candidate.candidate_id,
	geometry_hash: input.identity.geometry_hash,
	floor_guides_m: [...input.floor_guides.floor_guides_m],
	facade_planes_sha256: sha256(stableJson(input.facade_planes)),
	cameras_sha256: sha256(stableJson(input.cameras)),
	artifacts,
	contact_sheet: hashedContactSheet,
};
```

Write PNGs and `evidence-manifest.json` beneath `runDir/evidence/` using temporary files plus rename. Refuse an existing final manifest. Implement `verifyFacadeEvidencePack({ manifestPath, input })` by rehashing every file and every authority field.

- [ ] **Step 4: Run evidence tests and relevant existing rendering tests**

Run: `node --test test/elevation3d-facade-agent-evidence.test.ts test/elevation3d-assets.test.ts test/elevation3d-geometry.test.ts --experimental-strip-types`

Expected: all pass.

- [ ] **Step 5: Commit the evidence pack**

```bash
git add plugins/elevation-3d/lib/facade-agent/evidence.mjs plugins/elevation-3d/lib/facade-agent/evidence-renderer.mjs plugins/elevation-3d/lib/final-delivery.mjs test/elevation3d-facade-agent-evidence.test.ts test/elevation3d-all-views-e2e.test.ts
git commit -m "feat(elevation-3d): build facade evidence pack"
```

---

### Task 3: Enforce Crash-Safe Paid Image Operations

**Files:**
- Create: `plugins/elevation-3d/lib/facade-agent/paid-operation-ledger.mjs`
- Create: `plugins/elevation-3d/lib/facade-agent/provider.mjs`
- Create: `test/elevation3d-facade-agent-ledger.test.ts`

**Interfaces:**
- Produces: `createPaidOperationLedger(path)`, `normalizeProviderFailure(error, provider, stage)`, `FacadeProviderError`.
- `ledger.executeOnce({ requestKey, provider, kind, ceilingUsd, estimateUsd, operation, signal })` returns the one persisted result or refuses uncertain/resubmitted work.
- Allowed kinds are exactly `image-generation` and `grammar-extraction`.

- [ ] **Step 1: Write failing one-submit and crash tests**

```ts
let calls = 0;
const ledger = createPaidOperationLedger(join(root, "paid-operations.json"));
const first = await ledger.executeOnce({
	requestKey: "a".repeat(64), provider: "gpt-image-2", kind: "image-generation",
	ceilingUsd: 1, estimateUsd: 0.2,
	operation: async () => { calls++; return { remoteId: "secret-id", artifactSha256: "b".repeat(64), actualUsd: 0.18 }; },
});
const second = await ledger.executeOnce({
	requestKey: "a".repeat(64), provider: "gpt-image-2", kind: "image-generation",
	ceilingUsd: 1, estimateUsd: 0.2, operation: async () => { calls++; throw new Error("must not run"); },
});
assert.equal(calls, 1);
assert.equal(first.artifactSha256, second.artifactSha256);
assert.equal((await ledger.summary()).operations[0].remoteIdHash.length, 64);
```

Persist a fixture with `status: "submitting"` and assert the next call fails with `PAID_OPERATION_SUBMISSION_UNCERTAIN`. Test parallel instances against the same path and assert only one callback runs.

- [ ] **Step 2: Run ledger tests and verify RED**

Run: `node --test test/elevation3d-facade-agent-ledger.test.ts --experimental-strip-types`

Expected: FAIL with missing ledger module.

- [ ] **Step 3: Implement the ledger and failure normalization**

Port the atomic `flag: "wx"` reservation, PID-owner check, temp-file rename, and serialized queue pattern from `texturing/paid-task-ledger.mjs`. Before `operation`, persist:

```js
record.operations[key] = {
	provider, kind, status: "submitting", estimateUsd,
	ceilingUsd, remoteId: null, artifactSha256: null, actualUsd: null,
};
```

After success persist `status: "succeeded"`. Store raw `remoteId` only in the ignored local ledger; `summary()` returns `remoteIdHash`. If the callback throws before a remote ID or definitive non-submission error is proven, retain `submitting` and return `PAID_OPERATION_SUBMISSION_UNCERTAIN`. Reject estimates above ceilings before acquiring a reservation.

- [ ] **Step 4: Run ledger tests and the existing texturing ledger tests**

Run: `node --test test/elevation3d-facade-agent-ledger.test.ts test/elevation3d-texturing-delivery.test.ts --experimental-strip-types`

Expected: all pass with one-operation concurrency proof.

- [ ] **Step 5: Commit the paid boundary**

```bash
git add plugins/elevation-3d/lib/facade-agent/paid-operation-ledger.mjs plugins/elevation-3d/lib/facade-agent/provider.mjs test/elevation3d-facade-agent-ledger.test.ts
git commit -m "feat(elevation-3d): guard facade agent paid operations"
```

---

### Task 4: Add GPT Image 2 and Nano Banana Pro Adapters

**Files:**
- Create: `plugins/elevation-3d/lib/facade-agent/providers/openai-image.mjs`
- Create: `plugins/elevation-3d/lib/facade-agent/providers/gemini-image.mjs`
- Create: `test/elevation3d-facade-agent-providers.test.ts`

**Interfaces:**
- Produces from each module: `buildRequest({ evidence, brief, output })`, `createProvider(env, { fetchImpl, timeoutMs })`.
- Provider methods: `preflight(config)` and `generate({ request, signal }) -> { bytes, mimeType, remoteId, usage, rawMeta }`.
- Consumes: the normalized failure and redaction helpers from Tasks 1 and 3.

- [ ] **Step 1: Write failing fixed-vector adapter tests**

For OpenAI, assert `POST /v1/images/edits` with multipart form data, model `gpt-image-2`, one output, high quality, a deterministic prompt containing `creative-020`, `brick-punched-window-v1`, `NO CURTAIN WALL`, and the evidence contact sheet as the image part. Return fixture `b64_json` and assert decoded PNG bytes.

For Gemini, assert `POST /v1beta/models/gemini-3-pro-image:generateContent`, exactly the same semantic prompt and evidence bytes, response modalities containing image, and one decoded inline image part.

```ts
assert.deepEqual(calls.map((call) => call.method), ["POST"]);
assert.doesNotMatch(JSON.stringify(result.rawMeta), /sk-openai-secret|gemini-secret/);
assert.equal(result.mimeType, "image/png");
assert.equal(result.bytes.equals(expectedPng), true);
```

Test 401, 429, timeout, moderation block, malformed base64, missing image, oversized response, and two-image response normalization to stable codes.

- [ ] **Step 2: Run provider tests and verify RED**

Run: `node --test test/elevation3d-facade-agent-providers.test.ts --experimental-strip-types`

Expected: FAIL for missing provider modules.

- [ ] **Step 3: Implement both native-fetch adapters**

Do not add SDK dependencies. Construct headers inside `generate` so they never enter request manifests. Merge the caller signal with a timeout signal. Limit decoded output to 32 MiB and require PNG, JPEG, or WebP signatures.

```js
const form = new FormData();
form.set("model", "gpt-image-2");
form.set("prompt", request.prompt);
form.set("quality", "high");
form.set("n", "1");
form.set("image", new Blob([request.evidenceBytes], { type: "image/png" }), "evidence.png");
const response = await fetchImpl("https://api.openai.com/v1/images/edits", {
	method: "POST",
	headers: { Authorization: `Bearer ${apiKey}` },
	body: form, signal: combinedSignal,
});
```

For Gemini use `x-goog-api-key` and never place the key in the URL. Provider preflight checks credentials, request size, configured ceiling, and model allowlist without sending a request.

- [ ] **Step 4: Run provider and security-focused tests**

Run: `node --test test/elevation3d-facade-agent-providers.test.ts test/elevation3d-providers.test.ts --experimental-strip-types`

Expected: all pass; captured requests contain no secret in body or URL.

- [ ] **Step 5: Commit provider adapters**

```bash
git add plugins/elevation-3d/lib/facade-agent/providers test/elevation3d-facade-agent-providers.test.ts
git commit -m "feat(elevation-3d): add facade image providers"
```

---

### Task 5: Extract and Correct a Typed Punched-Facade Grammar

**Files:**
- Create: `plugins/elevation-3d/lib/facade-agent/grammar-agent.mjs`
- Modify: `plugins/elevation-3d/lib/facade-grammar.mjs`
- Create: `test/elevation3d-facade-agent-grammar.test.ts`
- Modify: `test/elevation3d-facade-grammar.test.ts`

**Interfaces:**
- Produces: `extractFacadeGrammar({ proposalPath, evidence, config, fetchImpl, ledger, signal })`.
- Extends: `normalizeFacadeGrammar()` and `correctGrammar()`.
- Typed grammar fields: `system`, `surfaces`, `materials`, `corner_datum_m`, `bay_width_m`, `window_width_m`, `window_height_m`, `sill_height_m`, `reveal_depth_m`, `frame_width_m`, `lintel_height_m`, `sill_depth_m`, `cladding_depth_m`, `brick_module_m`, `confidence`, `unresolved_surfaces`.

- [ ] **Step 1: Write failing schema and correction tests**

```ts
const grammar = normalizeFacadeGrammar({ approvedDesign: { facade_grammar: {
	 system: "brick-punched-window-v1", bay_width_m: 2.4,
	 window_width_m: 1.2, window_height_m: 1.65, sill_height_m: 0.85,
	 reveal_depth_m: 0.22, frame_width_m: 0.06, lintel_height_m: 0.18,
	 sill_depth_m: 0.08, cladding_depth_m: 0.12, brick_module_m: [0.215, 0.065],
	 corner_datum_m: 0, confidence: 0.92, unresolved_surfaces: [], surfaces: ["front", "right", "back", "left"],
} }, floorGuides, facadePlanes });
assert.equal(grammar.system, "brick-punched-window-v1");
assert.equal(grammar.wall_opacity, "opaque");
assert.equal(grammar.curtain_wall_allowed, false);
assert.throws(() => normalizeFacadeGrammar({ approvedDesign: { facade_grammar: { ...grammar, unresolved_surfaces: ["back"] } }, floorGuides, facadePlanes }), /unresolved facade/i);
assert.equal(correctGrammar(grammar, ["WINDOW_CROSSES_FLOOR_BAND"]).window_height_m < grammar.window_height_m, true);
```

Test structured-output parsing with a fixed OpenAI Responses fixture and verify unknown fields, free-form code, URLs, raw vertices, missing surfaces, low confidence, and curtain-wall materials fail closed.

- [ ] **Step 2: Run grammar tests and verify RED**

Run: `node --test test/elevation3d-facade-agent-grammar.test.ts test/elevation3d-facade-grammar.test.ts --experimental-strip-types`

Expected: new tests fail because punched-facade fields and extractor do not exist.

- [ ] **Step 3: Implement the common grammar extractor and allowlisted corrections**

Call the OpenAI Responses endpoint with `model: "gpt-5.6"`, the proposal image, evidence manifest, and a strict JSON Schema. Set `additionalProperties: false`; require every field. Persist the redacted request hash and parsed JSON, not chain-of-thought or raw authorization data.

Extend `LIMITS` with candidate-safe numeric ranges and make corrections explicit:

```js
const CORRECTIONS = {
	WINDOW_CROSSES_FLOOR_BAND: (g) => ({ ...g, window_height_m: clamp(g.window_height_m * 0.85, LIMITS.window_height_m) }),
	DETAIL_BOUNDS_EXCEEDED: (g) => ({ ...g, cladding_depth_m: clamp(g.cladding_depth_m * 0.75, LIMITS.cladding_depth_m), reveal_depth_m: clamp(g.reveal_depth_m * 0.75, LIMITS.reveal_depth_m) }),
	CORNER_DATUM_MISMATCH: (g) => ({ ...g, corner_datum_m: 0 }),
	PRIMITIVE_BUDGET_EXCEEDED: (g) => ({ ...g, bay_width_m: clamp(g.bay_width_m * 1.25, LIMITS.bay_width_m) }),
};
```

Reject unrecognized failure codes instead of returning an unchanged grammar. Preserve existing curtain-wall grammar behavior for `elevation_3d_run` by branching on `grammar.system`.

- [ ] **Step 4: Run old and new grammar tests**

Run: `node --test test/elevation3d-facade-agent-grammar.test.ts test/elevation3d-facade-grammar.test.ts --experimental-strip-types`

Expected: all pass.

- [ ] **Step 5: Commit typed grammar support**

```bash
git add plugins/elevation-3d/lib/facade-agent/grammar-agent.mjs plugins/elevation-3d/lib/facade-grammar.mjs test/elevation3d-facade-agent-grammar.test.ts test/elevation3d-facade-grammar.test.ts
git commit -m "feat(elevation-3d): define punched facade grammar"
```

---

### Task 6: Construct Real Brick Cladding and Punched-Window Depth

**Files:**
- Create: `plugins/elevation-3d/lib/facade-agent/punched-facade.mjs`
- Create: `plugins/elevation-3d/lib/facade-agent/procedural-materials.mjs`
- Modify: `plugins/elevation-3d/lib/enrichment.mjs`
- Create: `test/elevation3d-punched-facade.test.ts`
- Modify: `test/elevation3d-enrichment.test.ts`

**Interfaces:**
- Produces: `buildPunchedFacadeDetails({ mesh, floorGuides, facadePlanes, grammar }) -> DetailRecord[]` and `createFacadePbrMaps({ grammar, resolution }) -> { brick, precast }`.
- Detail kinds: `brick-cladding`, `window-reveal`, `window-frame`, `glazing`, `precast-lintel`, `precast-sill`, `corner-return`.
- `DetailRecord` retains existing `positions`, `indices`, `view`, `material`, `component_id`, and adds `floor_m`, `bay`, `depth_m`, `corner_anchor_id` where applicable.
- Every cladding/reveal record includes facade-local `uvs`; `enrichment.mjs` writes them as `TEXCOORD_0` and embeds the generated PNG maps.

- [ ] **Step 1: Write failing geometric builder tests**

Use a two-storey rectangular fixture and assert:

```ts
const details = buildPunchedFacadeDetails({ mesh, floorGuides, facadePlanes, grammar });
assert.ok(details.some((item) => item.kind === "brick-cladding"));
assert.ok(details.some((item) => item.kind === "window-reveal" && item.depth_m >= 0.18));
assert.ok(details.some((item) => item.kind === "precast-lintel"));
assert.equal(details.some((item) => item.kind === "mullion" || item.material === "curtain-wall"), false);
assert.deepEqual(scene.base.positions, mesh.vertices);
assert.deepEqual(scene.base.indices, mesh.triangles);
assert.ok(details.filter((item) => item.material === "brick").every((item) => item.uvs.length === item.positions.length));
```

For two adjacent facade planes, assert matching `corner_anchor_id`, identical band elevation, and endpoint distance below `1e-5`. Assert no detail vertex exceeds `cladding_depth_m + 1e-5` from its source facade plane. Assert repeated bay primitives share one deterministic geometry signature even if GLB instancing is deferred.

- [ ] **Step 2: Run builder tests and verify RED**

Run: `node --test test/elevation3d-punched-facade.test.ts test/elevation3d-enrichment.test.ts --experimental-strip-types`

Expected: FAIL for missing punched-facade builder.

- [ ] **Step 3: Implement facade-local shell construction**

Derive `tangent = [-normal[1], normal[0], 0]`, vertical `[0,0,1]`, and a facade-local rectangle per plane. For every storey interval, calculate bay centers from the shared `corner_datum_m`. Emit cladding rectangles around each opening rather than boolean-cutting the MASS; place glazing behind the cladding face and connect it with four reveal prisms.

```js
const opening = {
	u0: center - grammar.window_width_m / 2,
	u1: center + grammar.window_width_m / 2,
	v0: floor + grammar.sill_height_m,
	v1: floor + grammar.sill_height_m + grammar.window_height_m,
};
```

Use shallow prisms for cladding, reveals, frames, lintels, sills, and corner returns. Calculate UVs from facade-local horizontal distance and elevation divided by `brick_module_m`; do not emit one primitive per brick.

Generate deterministic 2048 x 2048 brick base-color, tangent-space normal, and metallic/roughness PNGs plus a precast base-color/normal/metallic-roughness set. Use the grammar's allowlisted palette values, running-bond half-course offset, and mortar ratio. In `writeEnrichedGlb`, create `Texture` objects from these buffers, attach them to `brick` and `precast` materials, and emit `TEXCOORD_0` when `detail.uvs` is present. Add a NodeIO test that reloads the GLB and measures all required maps as 2048 x 2048.

Add `brick`, `precast`, `window-frame`, and `glass` material factors in `enrichment.mjs`. Preserve the existing detail builder for grammars without `system: "brick-punched-window-v1"`.

- [ ] **Step 4: Run builder, GLB, and legacy enrichment tests**

Run: `node --test test/elevation3d-punched-facade.test.ts test/elevation3d-enrichment.test.ts test/elevation3d-geometry.test.ts --experimental-strip-types`

Expected: all pass and a NodeIO round-trip preserves the exact base primitive.

- [ ] **Step 5: Commit the deterministic builder**

```bash
git add plugins/elevation-3d/lib/facade-agent/punched-facade.mjs plugins/elevation-3d/lib/facade-agent/procedural-materials.mjs plugins/elevation-3d/lib/enrichment.mjs test/elevation3d-punched-facade.test.ts test/elevation3d-enrichment.test.ts
git commit -m "feat(elevation-3d): build punched brick facade"
```

---

### Task 7: Add Hard Gates and Provider-Neutral Scoring

**Files:**
- Modify: `plugins/elevation-3d/lib/enrichment-validation.mjs`
- Create: `plugins/elevation-3d/lib/facade-agent/score.mjs`
- Create: `test/elevation3d-facade-agent-validation.test.ts`
- Create: `test/elevation3d-facade-agent-score.test.ts`
- Modify: `test/elevation3d-enrichment-validation.test.ts`

**Interfaces:**
- Extends `validateEnrichment()` metrics with `canonical_surface_match`, `opaque_wall_coverage`, `minimum_reveal_depth_m`, `corner_max_gap_m`, `floor_alignment_max_error_m`, `facade_orientation_coverage`.
- Produces: `scoreFacadeCandidate({ provider, validation, grammar, visualMetrics })` and `selectFacadeWinner(candidates, tolerance = 0.5)`.

- [ ] **Step 1: Write failing hard-gate tests**

Create GLB fixtures for: changed base index, missing back facade, curtain-wall material, shallow reveal, corner gap, window crossing a floor band, detached detail, excessive outward bounds, and valid brick facade. Assert stable codes:

```ts
assert.deepEqual(report.codes, ["CANONICAL_SURFACE_MISMATCH"]);
assert.ok(shallow.codes.includes("PUNCHED_REVEAL_DEPTH_MISSING"));
assert.ok(corner.codes.includes("CORNER_DATUM_MISMATCH"));
assert.equal(valid.accepted, true);
```

- [ ] **Step 2: Write failing score tests**

```ts
const selected = selectFacadeWinner([
	{ provider: "gpt-image-2", accepted: true, metrics: { implementability: 90, multiview: 88, grammar: 85, visual: 75 } },
	{ provider: "nano-banana-pro", accepted: true, metrics: { implementability: 86, multiview: 84, grammar: 92, visual: 96 } },
]);
assert.equal(selected.provider, "gpt-image-2");
assert.equal(selected.score, 86.8);
assert.equal(selectFacadeWinner([{ provider: "gpt-image-2", accepted: false, metrics: {} }]).status, "no-winner");
```

Add a tie test within `0.5` points that returns `human-review` without provider preference.

- [ ] **Step 3: Run validation and score tests and verify RED**

Run: `node --test test/elevation3d-facade-agent-validation.test.ts test/elevation3d-facade-agent-score.test.ts --experimental-strip-types`

Expected: missing score module and missing validation codes.

- [ ] **Step 4: Implement the gates and exact weights**

Keep existing validation behavior for legacy grammars. For punched facades, inspect primitive extras and world bounds, compare the exact-MASS primitive positions/indices to `sourceMesh`, measure detail-to-source distances, and verify each facade/floor/corner key.

```js
const score = 0.35 * metrics.implementability
	+ 0.35 * metrics.multiview
	+ 0.20 * metrics.grammar
	+ 0.10 * metrics.visual;
```

Reject before scoring if `validation.accepted !== true`. Store component scores and formula version `arr.elevation3d.facade-score.v1`.

- [ ] **Step 5: Run new and existing validation tests**

Run: `node --test test/elevation3d-facade-agent-validation.test.ts test/elevation3d-facade-agent-score.test.ts test/elevation3d-enrichment-validation.test.ts --experimental-strip-types`

Expected: all pass.

- [ ] **Step 6: Commit validation and scoring**

```bash
git add plugins/elevation-3d/lib/enrichment-validation.mjs plugins/elevation-3d/lib/facade-agent/score.mjs test/elevation3d-facade-agent-validation.test.ts test/elevation3d-facade-agent-score.test.ts test/elevation3d-enrichment-validation.test.ts
git commit -m "feat(elevation-3d): validate and score facade proposals"
```

---

### Task 8: Implement the Persisted Agent Harness and Two-Attempt Loop

**Files:**
- Create: `plugins/elevation-3d/lib/facade-agent/harness.mjs`
- Create: `test/elevation3d-facade-agent-harness.test.ts`
- Reuse: `plugins/elevation-3d/lib/final-delivery.mjs`
- Reuse: `plugins/elevation-3d/lib/facade-grammar.mjs`
- Reuse: `plugins/elevation-3d/lib/enrichment.mjs`
- Reuse: `plugins/elevation-3d/lib/enrichment-validation.mjs`

**Interfaces:**
- Produces: `runFacadeAgent(config, deps)`, `runFacadeStage(stage, config, deps)`, `readFacadeAgentStatus(runDir)`.
- `deps` contains `loadCandidate`, `buildEvidence`, `providers`, `extractGrammar`, `build`, `validate`, `renderDelivery`, `score`, `ledger`, and lifecycle hooks.

- [ ] **Step 1: Write failing harness state-machine tests**

Use fixture providers and injected local stages. Assert:

- exactly one `generate` call per provider;
- the same evidence SHA and brief ID reach both providers;
- `v001` failure with `WINDOW_CROSSES_FLOOR_BAND` creates exactly one corrected `v002`;
- `v002` failure ends that provider as rejected;
- transport, uncertain submission, geometry mismatch, unknown validation code, and cancellation produce no local retry where prohibited;
- one accepted provider wins; two rejected providers yield `no-winner`; a tie yields `human-review`;
- final delivery is invoked once from the selected GLB only;
- resume never resubmits a generation recorded as `submitting` or `succeeded`.

```ts
assert.deepEqual(calls.generate, ["gpt-image-2", "nano-banana-pro"]);
assert.deepEqual(result.providers["gpt-image-2"].versions.map((v: any) => v.id), ["v001", "v002"]);
assert.equal(result.image_submissions.total, 2);
assert.equal(result.final.selected_provider, "nano-banana-pro");
```

- [ ] **Step 2: Run harness tests and verify RED**

Run: `node --test test/elevation3d-facade-agent-harness.test.ts --experimental-strip-types`

Expected: missing harness module.

- [ ] **Step 3: Implement atomic state transitions**

Persist `run.json`, provider state, stage manifests, and final decision beneath the run directory. Each transition requires the previous stage status and input hash.

```js
for (const providerName of config.providers) {
	const proposal = await generateOnce(providerName);
	let grammar = await extractOnce(providerName, proposal);
	for (let attempt = 1; attempt <= config.maxLocalAttempts; attempt++) {
		const version = await buildAndValidate(providerName, attempt, grammar);
		if (version.validation.accepted) break;
		if (attempt === config.maxLocalAttempts || !version.validation.retryable) break;
		grammar = correctGrammar(grammar, version.validation.codes);
	}
}
```

Do not use `Promise.all` for paid submissions; submit sequentially so the ledger and cancellation state are unambiguous. Local post-processing may run in parallel only after both proposal artifacts are durable. Use temp-file plus rename for every manifest. The final state references content hashes, not mutable provider URLs.

- [ ] **Step 4: Run harness and existing unified-flow tests**

Run: `node --test test/elevation3d-facade-agent-harness.test.ts test/elevation3d-unified-flow.test.ts --experimental-strip-types`

Expected: all pass; existing `elevation_3d_run` behavior is unchanged.

- [ ] **Step 5: Commit the harness**

```bash
git add plugins/elevation-3d/lib/facade-agent/harness.mjs test/elevation3d-facade-agent-harness.test.ts
git commit -m "feat(elevation-3d): orchestrate facade agent harness"
```

---

### Task 9: Expose One CLI and One Narrow Agent Tool

**Files:**
- Create: `plugins/elevation-3d/lib/facade-agent/cli.mjs`
- Create: `scripts/elevation-3d-facade.mjs`
- Create: `test/elevation3d-facade-agent-cli.test.ts`
- Modify: `plugins/elevation-3d/index.mjs`
- Modify: `test/elevation3d-plugin.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces CLI subcommands `preflight`, `evidence`, `generate`, `grammar`, `build`, `validate`, `compare`, `run`, `status`, and `resume`.
- Registers `elevation_3d_facade_agent_run` after `elevation_3d_run` and before legacy experimental tools.
- Both call `runFacadeAgent()` or `runFacadeStage()` from Task 8.

- [ ] **Step 1: Write failing CLI tests**

Spawn `node scripts/elevation-3d-facade.mjs` with fixture dependencies selected through an injected test entry. Assert stdout is one JSON document, stderr contains progress, and codes are stable:

```ts
assert.equal(success.status, 0);
assert.equal(JSON.parse(success.stdout).state, "accepted");
assert.equal(rejected.status, 20);
assert.equal(JSON.parse(rejected.stdout).state, "rejected");
assert.equal(configError.status, 30);
assert.equal(transportError.status, 40);
assert.equal(securityError.status, 50);
assert.equal(internalError.status, 70);
```

Run each stage independently, mutate its upstream hash, and assert the next stage fails before doing work. Assert a second invocation refuses overwrite. Assert `--dry-run` cannot set `confirmLive` and makes zero provider calls.

- [ ] **Step 2: Extend the plugin test before implementation**

Change expected production tool order to:

```ts
assert.deepEqual(tools.slice(0, 2).map((tool) => tool.name), [
	"elevation_3d_run",
	"elevation_3d_facade_agent_run",
]);
```

Assert the new input schema exposes only candidate/dataset/output/run IDs, providers, brief ID, dry run, live confirmation, and cost ceilings. Test unsafe identifiers and an already-aborted signal.

- [ ] **Step 3: Run CLI and plugin tests and verify RED**

Run: `node --test test/elevation3d-facade-agent-cli.test.ts test/elevation3d-plugin.test.ts --experimental-strip-types`

Expected: CLI file missing and plugin order assertion fails.

- [ ] **Step 4: Implement CLI parsing and plugin registration**

Add package script:

```json
"facade:agent": "node scripts/elevation-3d-facade.mjs"
```

Keep argument parsing dependency-free. Require `--candidate creative-020`, `--brief brick-punched-window-v1`, explicit roots, provider ceilings, and `--confirm-live` for network stages. `status` is read-only. `resume` accepts only the run directory and continues from persisted config.

The plugin handler normalizes snake_case tool fields, forwards `AbortSignal`, calls the same harness, and returns `redactSecrets(result)`.

- [ ] **Step 5: Run CLI and plugin tests**

Run: `node --test test/elevation3d-facade-agent-cli.test.ts test/elevation3d-plugin.test.ts --experimental-strip-types`

Expected: all pass.

- [ ] **Step 6: Commit CLI and agent surface**

```bash
git add plugins/elevation-3d/lib/facade-agent/cli.mjs scripts/elevation-3d-facade.mjs plugins/elevation-3d/index.mjs test/elevation3d-facade-agent-cli.test.ts test/elevation3d-plugin.test.ts package.json
git commit -m "feat(elevation-3d): expose facade agent CLI"
```

---

### Task 10: Persist Comparison Memory and Prove the Full Fixture Story

**Files:**
- Modify: `plugins/elevation-3d/lib/run-memory.mjs`
- Create: `test/elevation3d-facade-agent-e2e.test.ts`
- Modify: `test/elevation3d-run-memory.test.ts`
- Modify: `memory/elevation-3d/README.md`

**Interfaces:**
- Produces: `appendFacadeAgentMemory(result, memoryRoot)` with schema `arr.elevation3d.facade-agent-memory.v1`.
- Consumes the final redacted harness result, selected delivery, provider ledgers, validation reports, and scorecard.

- [ ] **Step 1: Write failing memory tests**

Assert memory records:

```ts
assert.equal(event.candidate_id, "creative-020");
assert.equal(event.brief_id, "brick-punched-window-v1");
assert.equal(event.image_submissions["gpt-image-2"], 1);
assert.equal(event.image_submissions["nano-banana-pro"], 1);
assert.equal(event.geometry_authority, "canonical-local-mass");
assert.equal(event.retry_policy, "two-local-attempts-no-image-resubmit");
assert.equal(JSON.stringify(event).includes("sk-"), false);
assert.equal(JSON.stringify(event).includes("signedUrl"), false);
```

Assert duplicate `run_id` append is idempotent and artifact paths remain relative to the run base.

- [ ] **Step 2: Write the fixture E2E test**

Use the real `creative-020` package, fixed local provider images, fixed grammar Responses fixtures, the real punched-facade builder, real GLB validation, and the real eight-view browser delivery. Assert:

- exact base geometry signature;
- nonzero brick, reveal, glazing, lintel, sill, and corner-return counts;
- minimum reveal depth gate;
- all eight views from one selected GLB;
- zero console errors and stable settled frames;
- exactly two fixture image submissions and no network access;
- deterministic scorecard and selected provider;
- successful second `status` read without artifact mutation.

- [ ] **Step 3: Run memory and E2E tests and verify RED**

Run: `node --test test/elevation3d-run-memory.test.ts test/elevation3d-facade-agent-e2e.test.ts --experimental-strip-types`

Expected: missing facade-agent memory writer and E2E result.

- [ ] **Step 4: Implement memory normalization and README correction**

Write only redacted hashes, relative paths, status, costs, attempts, codes, component metrics, score breakdown, winner, and fallback reference. Add a README section stating that the older single-image-to-3D instruction is historical, Tripo is optional research only, and the production facade agent uses exact local geometry plus image-model design evidence.

- [ ] **Step 5: Run focused fixture verification**

Run: `npm test`

Expected: all focused tests pass with zero network calls.

- [ ] **Step 6: Run build, full suite, and dependency audit**

Run:

```bash
npm run build
npm test
npm audit --audit-level=high
```

Expected: TypeScript build passes, the complete test suite passes, and audit reports zero high/critical vulnerabilities.

- [ ] **Step 7: Run the real CLI in preflight and dry-run mode only**

```powershell
npm run facade:agent -- preflight --candidate creative-020 --brief brick-punched-window-v1 --dataset-root D:\Data\50_ELE\MAAS_ELEVATION_TEST_SET_20260730 --output-root D:\Data\50_ELE\elevation-3d-e2e-results\facade-agent --run-id creative-020-brick-ab-v1 --providers gpt-image-2,nano-banana-pro --gpt-image-max-usd 1 --nano-banana-max-usd 1 --grammar-max-usd 1 --dry-run
```

Expected: exit `0`; JSON reports locked input/evidence hashes, provider capability status, maximum two image submissions total, estimated ceilings, no provider task, and no paid ledger entry.

- [ ] **Step 8: Record the live approval gate without crossing it**

Print the dry-run request fingerprints, exact current provider estimates, credential presence without values, and total ceiling. Stop and ask the user to approve those exact ceilings. Do not add `--confirm-live` in this task.

- [ ] **Step 9: Commit verified memory and E2E coverage**

```bash
git add plugins/elevation-3d/lib/run-memory.mjs test/elevation3d-facade-agent-e2e.test.ts test/elevation3d-run-memory.test.ts memory/elevation-3d/README.md
git commit -m "test(elevation-3d): verify facade agent workflow"
```

---

## Final Review Checklist

- [ ] `git status --short` shows only intended worktree changes.
- [ ] Every new module has one responsibility and no provider secrets in fixtures or snapshots.
- [ ] `rg -n "T[B]D|T[O]DO|F[I]XME|sk-|AIza|Bearer " plugins/elevation-3d/lib/facade-agent test` returns no secret or unfinished implementation.
- [ ] Exactly one image-generation ledger record exists per provider in the live-ready dry-run schema, and dry-run itself created none.
- [ ] Grammar calls are separately identified and budgeted; they are not counted as image-provider retries.
- [ ] The exact MASS primitive and all camera/floor contracts pass unchanged.
- [ ] Rejected and tie outcomes cannot produce a selected provider.
- [ ] Existing `elevation_3d_run` and Tripo tests remain green.
- [ ] No live image or grammar request has been sent without the final explicit cost approval.
