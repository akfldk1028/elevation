# Facade Provider Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build independent image and grammar provider routers, defaulting to Seedream 5.0 Pro plus BytePlus Seed 2.0 Mini while preserving exact local 3D authority and all existing public interfaces.

**Architecture:** Canonical schema-v2 configuration selects `imageProviders` and one `grammarProvider`; pure compatibility normalization maps existing `providers` and `grammarModel` inputs. Existing image adapters remain behind a compatibility router, while OpenAI grammar transport is extracted from the monolithic grammar agent and BytePlus grammar is added behind a common registry. The harness invokes only selected adapters through common contracts, persists hash-bound provider metadata, and never retries or falls back between paid providers.

**Tech Stack:** Node.js 20+ ESM, TypeScript tests through Node's test runner and `--experimental-strip-types`, `sharp`, existing GLTF/Three.js local builder and renderer, built-in `fetch`/`AbortController`, JSON Schema structured outputs.

## Global Constraints

- Authoritative footprint, mass, floor guides, facade segments, matrices, cameras, and 3D construction remain local and deterministic.
- Initial image IDs are exactly `seedream-5-pro`, `gpt-image-2`, `qwen-image-2`, and `nano-banana-pro`.
- Initial grammar IDs are exactly `byteplus-seed-mini` and `openai-gpt-5.6`.
- Canonical defaults are `imageProviders: ["seedream-5-pro"]` and `grammarProvider: "byteplus-seed-mini"`.
- A live adapter is called only when explicitly selected; there is no automatic paid retry, fallback, or budget transfer.
- The default safety ceilings are `$0.06` for Seedream image generation and `$0.01` for BytePlus grammar extraction; exact confirmation is `$0.07`.
- Budgets and confirmations are compared as integer micro-dollars.
- Every generated image count is one; every selected image proposal is processed by the one selected grammar provider.
- Existing `submit`, `status`, COS, CLI, schema-v1 stored runs, and compatibility imports remain supported.
- Fixture outputs always record `transport: "fixture"` and never support model-quality claims.
- No API key, authorization header, signed URL, provider response body, or reusable remote ID enters logs, manifests, errors, fixtures, or memory.
- Each accepted result must use the exact local builder and produce eight distinct 2400 x 2400 PNG delivery views.
- No live API request is part of this implementation plan; prepare the command and stop before execution.

---

## File Map

**Create**

- `plugins/elevation-3d/lib/facade-agent/routers/image-provider-registry.mjs` — canonical image-router entry point with compatibility re-export.
- `plugins/elevation-3d/lib/facade-agent/routers/grammar-provider-registry.mjs` — allowlisted grammar selection, credential scoping, and adapter construction.
- `plugins/elevation-3d/lib/facade-agent/providers/grammar/contract.mjs` — immutable provider-neutral grammar request/result boundary and stable error codes.
- `plugins/elevation-3d/lib/facade-agent/providers/grammar/prompt.mjs` — versioned hash-bound facade grammar prompt.
- `plugins/elevation-3d/lib/facade-agent/providers/grammar/openai/adapter.mjs` — existing GPT-5.6 structured-output transport behind the common grammar interface.
- `plugins/elevation-3d/lib/facade-agent/providers/grammar/byteplus/request.mjs` — pure BytePlus request mapping.
- `plugins/elevation-3d/lib/facade-agent/providers/grammar/byteplus/response.mjs` — bounded BytePlus response decoding and normalized result mapping.
- `plugins/elevation-3d/lib/facade-agent/providers/grammar/byteplus/adapter.mjs` — endpoint/model policy, credential handling, timeout, and one-shot extraction.
- `test/elevation3d-facade-agent-grammar-router.test.ts` — grammar registry and cross-adapter conformance.
- `test/elevation3d-facade-agent-byteplus-grammar.test.ts` — exact BytePlus request/response/security fixtures.
- `test/fixtures/facade-agent/grammar/byteplus/success.json` — sanitized structured-output success fixture.
- `test/fixtures/facade-agent/grammar/byteplus/error.json` — sanitized provider-error fixture.

**Modify**

- `plugins/elevation-3d/lib/facade-agent/contract.mjs` — schema-v2 fields, legacy normalization, defaults, and exact budgets.
- `plugins/elevation-3d/lib/facade-agent/grammar-agent.mjs` — retain authority/schema validation while delegating transport through adapters.
- `plugins/elevation-3d/lib/facade-agent/image-providers/registry.mjs` — accept canonical `imageProviders` in addition to internal compatibility input.
- `plugins/elevation-3d/lib/facade-agent/production-dependencies.mjs` — construct both registries and remove the OpenAI grammar closure.
- `plugins/elevation-3d/lib/facade-agent/harness.mjs` — route grammar calls, persist provider metadata, resume by provider/model hash, and remove `openai-grammar` labels.
- `plugins/elevation-3d/lib/facade-agent/cli.mjs` — canonical router flags and legacy aliases.
- `plugins/elevation-3d/lib/facade-agent/fixture-transport.mjs` — common fixture transport labeling for both provider families.
- `test/elevation3d-facade-agent-contract.test.ts` — schema-v2/default/compatibility/budget tests.
- `test/elevation3d-facade-agent-provider-registry.test.ts` — canonical image-router compatibility tests.
- `test/elevation3d-facade-agent-grammar.test.ts` — OpenAI compatibility and common contract tests.
- `test/elevation3d-facade-agent-harness.test.ts` — selected grammar provider, no fallback, receipts, and resume tests.
- `test/elevation3d-facade-agent-cli.test.ts` — new flags, aliases, and exact confirmation tests.
- `test/elevation3d-facade-agent-e2e.test.ts` — Seedream/BytePlus fixture route, non-curtain-wall GLB, and PNG delivery checks.
- `test/fixtures/facade-agent/README.md` — state that fixture PNGs validate plumbing rather than model quality.
- `docs/elevation-3d-facade-agent-local-runbook.md` — offline verification and prepared live command using environment variables.

---

### Task 1: Canonical Schema-v2 Router Configuration

**Files:**

- Modify: `plugins/elevation-3d/lib/facade-agent/contract.mjs`
- Modify: `test/elevation3d-facade-agent-contract.test.ts`

**Interfaces:**

- Consumes: existing `normalizeFacadeAgentConfig(input)` and `FacadeAgentContractError`.
- Produces: `FACADE_GRAMMAR_PROVIDER_IDS`, `DEFAULT_IMAGE_PROVIDERS`, `DEFAULT_GRAMMAR_PROVIDER`, and a deeply frozen normalized config containing both canonical camelCase fields and compatibility `providers`/`grammarModel` views.

- [ ] **Step 1: Write failing schema-v2 default and compatibility tests**

Add tests with these exact assertions:

```ts
const canonical = normalizeFacadeAgentConfig({
  candidateId: "creative-020", datasetRoot: "D:/dataset", outputRoot: "D:/results",
  runId: "router-v2-001", briefId: "brick-punched-window-v1",
  imageProviders: ["seedream-5-pro"], grammarProvider: "byteplus-seed-mini",
  imageBudgetUsd: { "seedream-5-pro": 0.06 }, grammarBudgetUsd: 0.01,
  confirmLive: true, confirmedTotalUsd: 0.07,
});
assert.equal(canonical.schemaVersion, 2);
assert.deepEqual(canonical.imageProviders, ["seedream-5-pro"]);
assert.equal(canonical.grammarProvider, "byteplus-seed-mini");
assert.deepEqual(canonical.providers, canonical.imageProviders);
assert.equal(canonical.runBudgetUsd, 0.07);

const legacy = normalizeFacadeAgentConfig({
  candidateId: "creative-020", datasetRoot: "D:/dataset", outputRoot: "D:/results",
  runId: "router-v1-001", briefId: "brick-punched-window-v1",
  providers: ["gpt-image-2"], grammarModel: "gpt-5.6",
  imageBudgetUsd: { "gpt-image-2": 0.5 }, grammarBudgetUsd: 0.35,
  confirmLive: false,
});
assert.deepEqual(legacy.imageProviders, ["gpt-image-2"]);
assert.equal(legacy.grammarProvider, "openai-gpt-5.6");
```

Also assert `CONFIG_FIELD_CONFLICT` for simultaneous unequal `providers`/`imageProviders` or `grammarModel`/`grammarProvider`, `GRAMMAR_PROVIDER_INVALID` for unknown grammar IDs, and `LIVE_COST_CONFIRMATION_INVALID` for `0.070001`.

- [ ] **Step 2: Run the focused contract test and verify failure**

Run:

```powershell
node --test test/elevation3d-facade-agent-contract.test.ts --experimental-strip-types
```

Expected: FAIL because schema-v2 fields and grammar provider IDs do not exist.

- [ ] **Step 3: Implement canonical normalization and pure legacy mapping**

Add these exported constants and normalization rules:

```js
export const FACADE_GRAMMAR_PROVIDER_IDS = Object.freeze(["byteplus-seed-mini", "openai-gpt-5.6"]);
export const DEFAULT_IMAGE_PROVIDERS = Object.freeze(["seedream-5-pro"]);
export const DEFAULT_GRAMMAR_PROVIDER = "byteplus-seed-mini";

const imageProviders = input.imageProviders ?? input.providers ?? DEFAULT_IMAGE_PROVIDERS;
const grammarProvider = input.grammarProvider
  ?? (input.grammarModel === "gpt-5.6" ? "openai-gpt-5.6" : DEFAULT_GRAMMAR_PROVIDER);
```

Reject conflicting dual representations before normalization. Preserve `providers: imageProviders` and map `grammarModel` only for the OpenAI compatibility route; harness code must stop relying on `grammarModel`. Keep the existing candidate, brief, path, local-attempt, selected-budget, deep-freeze, and secret-redaction gates. Compute `runBudgetMicros` from selected image ceilings plus the one grammar ceiling.

- [ ] **Step 4: Run focused tests and verify passing behavior**

Run the command from Step 2. Expected: all contract tests PASS, including legacy tests.

- [ ] **Step 5: Commit the configuration unit**

```powershell
git add plugins/elevation-3d/lib/facade-agent/contract.mjs test/elevation3d-facade-agent-contract.test.ts
git commit -m "feat(elevation3d): normalize facade router configuration"
```

---

### Task 2: Common Grammar Boundary and OpenAI Compatibility Adapter

**Files:**

- Create: `plugins/elevation-3d/lib/facade-agent/providers/grammar/contract.mjs`
- Create: `plugins/elevation-3d/lib/facade-agent/providers/grammar/prompt.mjs`
- Create: `plugins/elevation-3d/lib/facade-agent/providers/grammar/openai/adapter.mjs`
- Modify: `plugins/elevation-3d/lib/facade-agent/grammar-agent.mjs`
- Modify: `test/elevation3d-facade-agent-grammar.test.ts`

**Interfaces:**

- Consumes: verified proposal authority, verified evidence authority, existing facade grammar schema/validator, and facade grammar one-shot capability.
- Produces: `createFacadeGrammarRequest(input)`, `normalizeFacadeGrammarResult(input)`, `buildFacadeGrammarPrompt(input)`, and `createProvider(env, options)` returning `{ transport, preflight, extract }`.

- [ ] **Step 1: Add failing common-boundary and OpenAI compatibility tests**

Assert that the common request is deeply frozen, includes `provider`, `model`, `proposalSha256`, `evidenceManifestSha256`, `promptRevision`, `promptSha256`, `ceilingUsd`, and `estimateUsd`, and rejects non-64-character hashes, mutable exotic objects, non-PNG/JPEG media, oversized prompt/image input, and estimates above ceilings. Add an OpenAI adapter test that retains:

```ts
assert.equal(call.url, "https://api.openai.com/v1/responses");
assert.equal(call.body.model, "gpt-5.6");
assert.equal(call.body.text.format.type, "json_schema");
assert.equal(call.body.text.format.strict, true);
assert.match(call.body.input[0].content[1].image_url, /^data:image\/png;base64,/);
assert.equal(result.provider, "openai-gpt-5.6");
assert.equal(result.transport, "live");
```

Keep the existing tests for proposal/evidence authority, duplicate keys, geometry-changing output, timeout, abort, response bounds, cost bounds, and secret redaction.

- [ ] **Step 2: Run the grammar test and verify failure**

```powershell
node --test test/elevation3d-facade-agent-grammar.test.ts --experimental-strip-types
```

Expected: FAIL because the common modules and OpenAI adapter do not exist.

- [ ] **Step 3: Extract provider-neutral request/prompt code and wrap OpenAI transport**

Use this stable adapter surface and keep both functions private to the adapter module:

```js
export function createProvider(env = {}, options = {}) {
  return Object.freeze({
    transport: "live",
    preflight,
    extract,
  });
}
```

Move only provider serialization, bounded response reading, timeout/abort transport, HTTP error mapping, and usage decoding into the adapter. Keep unforgeable proposal/evidence/grammar authorities and `validatePunchedFacadeGrammar` in `grammar-agent.mjs`. Make the prompt version `facade-grammar-v2` and bind both hashes in its text. The compatibility exports `preflightFacadeGrammar` and `extractFacadeGrammar` delegate to the OpenAI adapter and retain their existing observable behavior.

- [ ] **Step 4: Run grammar and provider-security tests**

```powershell
node --test test/elevation3d-facade-agent-grammar.test.ts test/elevation3d-facade-agent-providers.test.ts --experimental-strip-types
```

Expected: PASS with one fetch per authorized extraction and zero fetches on every preflight/boundary failure.

- [ ] **Step 5: Commit the OpenAI extraction unit**

```powershell
git add plugins/elevation-3d/lib/facade-agent/providers/grammar plugins/elevation-3d/lib/facade-agent/grammar-agent.mjs test/elevation3d-facade-agent-grammar.test.ts
git commit -m "refactor(elevation3d): isolate facade grammar provider boundary"
```

---

### Task 3: Independent Image and Grammar Registries

**Files:**

- Create: `plugins/elevation-3d/lib/facade-agent/routers/image-provider-registry.mjs`
- Create: `plugins/elevation-3d/lib/facade-agent/routers/grammar-provider-registry.mjs`
- Modify: `plugins/elevation-3d/lib/facade-agent/image-providers/registry.mjs`
- Modify: `plugins/elevation-3d/lib/facade-agent/production-dependencies.mjs`
- Create: `test/elevation3d-facade-agent-grammar-router.test.ts`
- Modify: `test/elevation3d-facade-agent-provider-registry.test.ts`

**Interfaces:**

- Consumes: normalized `config.imageProviders`, `config.grammarProvider`, adapter factories, explicitly injected `fetchImpl`, environment record, DNS lookup, and timeout.
- Produces: `createFacadeImageProviderRegistry(config, options)` and `createFacadeGrammarProviderRegistry(config, options)`; production dependencies expose `providers` as the compatibility image map and `grammarProvider` as one adapter.

- [ ] **Step 1: Write failing independent-selection and credential-isolation tests**

Construct factory spies and assert:

```ts
const grammar = createFacadeGrammarProviderRegistry(
  { grammarProvider: "byteplus-seed-mini" },
  { env: ALL_ENV, fetchImpl, providerFactories },
);
assert.equal(grammar.id, "byteplus-seed-mini");
assert.deepEqual(calls, [{
  provider: "byteplus-seed-mini",
  env: { ARK_API_KEY: "byteplus-only" },
}]);
assert.equal(typeof grammar.preflight, "function");
assert.equal(typeof grammar.extract, "function");
```

Also prove that selecting Seedream image plus OpenAI grammar constructs only BytePlus image and OpenAI grammar factories, unknown/duplicate image IDs construct nothing, unknown grammar constructs nothing, and neither router reads the other provider's credential.

- [ ] **Step 2: Run router tests and verify failure**

```powershell
node --test test/elevation3d-facade-agent-provider-registry.test.ts test/elevation3d-facade-agent-grammar-router.test.ts --experimental-strip-types
```

Expected: FAIL because canonical router entry points and grammar registry do not exist.

- [ ] **Step 3: Implement allowlisted routers and production construction**

The grammar registry must have fixed factories and scoped credentials:

```js
const DEFAULT_FACTORIES = Object.freeze({
  "openai-gpt-5.6": createOpenAIProvider,
  "byteplus-seed-mini": createBytePlusProvider,
});

const scopedEnvironment = (id, env) => id === "openai-gpt-5.6"
  ? { OPENAI_API_KEY: env.OPENAI_API_KEY }
  : { ARK_API_KEY: env.ARK_API_KEY };
```

The image router file re-exports the established image registry; update the established registry to read `config.imageProviders ?? config.providers`. In `production-dependencies.mjs`, replace the hard-coded OpenAI closure with the grammar registry. Keep `providers` in the returned dependencies for harness compatibility and add `grammarProvider`.

- [ ] **Step 4: Run registry and production dependency tests**

```powershell
node --test test/elevation3d-facade-agent-provider-registry.test.ts test/elevation3d-facade-agent-grammar-router.test.ts test/elevation3d-facade-agent-providers.test.ts --experimental-strip-types
```

Expected: PASS; spies show only explicitly selected factories and scoped credentials.

- [ ] **Step 5: Commit the router unit**

```powershell
git add plugins/elevation-3d/lib/facade-agent/routers plugins/elevation-3d/lib/facade-agent/image-providers/registry.mjs plugins/elevation-3d/lib/facade-agent/production-dependencies.mjs test/elevation3d-facade-agent-provider-registry.test.ts test/elevation3d-facade-agent-grammar-router.test.ts
git commit -m "feat(elevation3d): route facade image and grammar providers independently"
```

---

### Task 4: BytePlus Seed Mini Grammar Adapter

**Files:**

- Create: `plugins/elevation-3d/lib/facade-agent/providers/grammar/byteplus/request.mjs`
- Create: `plugins/elevation-3d/lib/facade-agent/providers/grammar/byteplus/response.mjs`
- Create: `plugins/elevation-3d/lib/facade-agent/providers/grammar/byteplus/adapter.mjs`
- Create: `test/elevation3d-facade-agent-byteplus-grammar.test.ts`
- Create: `test/fixtures/facade-agent/grammar/byteplus/success.json`
- Create: `test/fixtures/facade-agent/grammar/byteplus/error.json`

**Interfaces:**

- Consumes: common frozen grammar request, `ARK_API_KEY`, injected `fetchImpl`, one-shot submission capability, signal, and timeout.
- Produces: BytePlus adapter `{ transport: "live", preflight, extract }` returning the common grammar result with provider `byteplus-seed-mini` and pinned model `seed-2-0-mini-260428`.

- [ ] **Step 1: Write exact request-vector and response-boundary tests**

Test the fixed endpoint and request fields:

```ts
assert.equal(call.url, "https://ark.ap-southeast.bytepluses.com/api/v3/responses");
assert.equal(call.body.model, "seed-2-0-mini-260428");
assert.equal(call.body.text.format.type, "json_schema");
assert.equal(call.body.text.format.strict, true);
assert.equal(call.body.input[0].content[0].type, "input_text");
assert.match(call.body.input[0].content[1].image_url, /^data:image\/png;base64,/);
assert.equal(call.init.headers.Authorization, "Bearer byteplus-fixture-key");
```

Add cases for missing/invalid credentials, wrong model or endpoint override, authentication, 429, moderation rejection, 5xx, timeout, caller abort, invalid JSON, duplicate keys, invalid grammar, content-length overflow, streamed overflow, reported cost above `$0.01`, signed URL/secret redaction, and a second use of the same submission capability. Every local rejection must assert `fetchCalls === 0`; authorized extraction must assert `fetchCalls === 1`.

- [ ] **Step 2: Run the BytePlus grammar test and verify failure**

```powershell
node --test test/elevation3d-facade-agent-byteplus-grammar.test.ts --experimental-strip-types
```

Expected: FAIL because the BytePlus grammar modules do not exist.

- [ ] **Step 3: Implement pure request/response modules and one-shot adapter**

`request.mjs` must be a pure mapping from the common request. `response.mjs` must accept only bounded plain JSON and return `{ grammarCandidate, remoteId, actualUsd, usage }` after stripping all provider-specific data. `adapter.mjs` owns the fixed endpoint/model, credential validation, timeout/abort, one fetch, status mapping, one-shot capability consumption, and final common result normalization.

Map failures to the stable categories declared in the design: `AUTHENTICATION_FAILED`, `RATE_LIMITED`, `CONTENT_REJECTED`, `REQUEST_TIMEOUT`, `PROVIDER_UNAVAILABLE`, `INVALID_PROVIDER_RESPONSE`, `INVALID_GRAMMAR`, `RESPONSE_TOO_LARGE`, and `SUBMISSION_UNCERTAIN`. Preserve a `definitiveNonSubmission` boolean without exposing response bodies.

- [ ] **Step 4: Run BytePlus and cross-adapter conformance tests**

```powershell
node --test test/elevation3d-facade-agent-byteplus-grammar.test.ts test/elevation3d-facade-agent-grammar-router.test.ts test/elevation3d-facade-agent-grammar.test.ts --experimental-strip-types
```

Expected: PASS with identical normalized grammar schema from OpenAI and BytePlus fixtures.

- [ ] **Step 5: Commit the BytePlus adapter unit**

```powershell
git add plugins/elevation-3d/lib/facade-agent/providers/grammar/byteplus test/elevation3d-facade-agent-byteplus-grammar.test.ts test/fixtures/facade-agent/grammar/byteplus
git commit -m "feat(elevation3d): add BytePlus facade grammar adapter"
```

---

### Task 5: Harness Routing, Receipts, and Safe Resume

**Files:**

- Modify: `plugins/elevation-3d/lib/facade-agent/harness.mjs`
- Modify: `plugins/elevation-3d/lib/facade-agent/fixture-transport.mjs`
- Modify: `test/elevation3d-facade-agent-harness.test.ts`

**Interfaces:**

- Consumes: dependency maps `{ providers, grammarProvider, ledger, ... }`, canonical router config, image results, and verified evidence/proposal authorities.
- Produces: one grammar extraction per successful proposal, provider/model/hash-bound stage receipts, `transport` metadata, and safe status/resume behavior.

- [ ] **Step 1: Add failing selected-provider, no-fallback, and resume tests**

Update the fixture dependency to expose:

```ts
grammarProvider: createFacadeFixtureTransport({
  id: "byteplus-seed-mini",
  model: "seed-2-0-mini-260428",
  preflight() { return { provider: "byteplus-seed-mini", transport: "fixture" }; },
  async extract(input) { calls.grammar.push(input.provider); return fixtureGrammarResult(input); },
})
```

Assert the capability key is `grammar:byteplus-seed-mini`, grammar stage input includes grammar provider/model plus proposal/evidence hashes, every successful image proposal calls the same grammar adapter once, an adapter error does not call OpenAI or retry BytePlus, and a `submitting` stage without a receipt resumes as `SUBMISSION_UNCERTAIN` with zero calls. Assert fixture run manifests and result reports contain `transport: "fixture"`.

- [ ] **Step 2: Run harness tests and verify failure**

```powershell
node --test test/elevation3d-facade-agent-harness.test.ts --experimental-strip-types
```

Expected: FAIL at the old `extractGrammar` dependency and `openai-grammar` capability assumptions.

- [ ] **Step 3: Route harness grammar stages through the selected adapter**

Replace `deps.extractGrammar` with `deps.grammarProvider.extract`, and bind submissions with:

```js
const grammarIdentity = Object.freeze({
  provider: config.grammarProvider,
  model: deps.grammarProvider.model,
  proposalProvider: provider,
  proposalSha256: proposal.sha256,
  evidenceSha256: evidence.manifestSha256,
});
```

Persist identity before network access, then persist redacted receipt and normalized result immediately. Treat `submitting` without definitive non-submission evidence as uncertain and never replay it. A completed stage is reusable only when all identity fields and artifact hashes match. Keep per-image grammar budget allocation deterministic but charge against the single grammar-provider ceiling.

- [ ] **Step 4: Run harness, ledger, and evaluation tests**

```powershell
node --test test/elevation3d-facade-agent-harness.test.ts test/elevation3d-facade-agent-ledger.test.ts test/elevation3d-facade-agent-evaluation.test.ts --experimental-strip-types
```

Expected: PASS; failure fixtures show one attempt, no fallback, and stable resumable state.

- [ ] **Step 5: Commit the harness unit**

```powershell
git add plugins/elevation-3d/lib/facade-agent/harness.mjs plugins/elevation-3d/lib/facade-agent/fixture-transport.mjs test/elevation3d-facade-agent-harness.test.ts
git commit -m "feat(elevation3d): run grammar through selected facade provider"
```

---

### Task 6: CLI, Public Compatibility, and Exact Confirmation

**Files:**

- Modify: `plugins/elevation-3d/lib/facade-agent/cli.mjs`
- Modify: `test/elevation3d-facade-agent-cli.test.ts`
- Regression test without modification: `test/elevation3d-plugin.test.ts`
- Regression test without modification: `test/elevation3d-providers.test.ts`

**Interfaces:**

- Consumes: `normalizeFacadeAgentConfig`, existing CLI/TinyHuman tool inputs, and run/status APIs.
- Produces: repeatable `--image-provider`, `--grammar-provider`, keyed `--image-budget`, `--grammar-budget`, exact `--confirm-total-usd`, plus existing `--providers` and JSON tool fields as aliases.

- [ ] **Step 1: Add failing canonical CLI and alias tests**

Parse and assert this command configuration:

```text
run --candidate creative-020 --brief brick-punched-window-v1
--dataset-root D:/dataset --output-root D:/results --run-id router-cli-001
--image-provider seedream-5-pro --image-budget seedream-5-pro=0.06
--grammar-provider byteplus-seed-mini --grammar-budget 0.01
--confirm-live --confirm-total-usd 0.07
```

Assert repeated `--image-provider` preserves order, legacy `--providers gpt-image-2,nano-banana-pro` maps to canonical selection, conflicting canonical/legacy flags fail locally, missing selected budgets fail locally, unselected positive budgets fail locally, `0.070001` fails exact confirmation, and CLI output never includes supplied environment secrets.

- [ ] **Step 2: Run CLI tests and verify failure**

```powershell
node --test test/elevation3d-facade-agent-cli.test.ts --experimental-strip-types
```

Expected: FAIL because canonical router flags are not accepted.

- [ ] **Step 3: Implement router flags and backward-compatible tool schema**

Parse repeatable flags without splitting values outside their defined syntax. Normalize CLI snake-case fields to the contract's camelCase fields. Keep old JSON tool properties `providers` and `grammar_model` accepted, add `image_providers` and `grammar_provider`, and reject conflicts. Update status summaries to include optional:

```js
router: {
  image_providers: [...config.imageProviders],
  grammar_provider: config.grammarProvider,
}
```

Do not remove or rename existing public result fields.

- [ ] **Step 4: Run CLI, contract, and harness tests**

```powershell
node --test test/elevation3d-facade-agent-cli.test.ts test/elevation3d-facade-agent-contract.test.ts test/elevation3d-facade-agent-harness.test.ts test/elevation3d-plugin.test.ts test/elevation3d-providers.test.ts --experimental-strip-types
```

Expected: PASS for canonical commands, legacy compatibility cases, plugin `submit`/`status`, and the unchanged Hunyuan/COS provider contract.

- [ ] **Step 5: Commit the CLI unit**

```powershell
git add plugins/elevation-3d/lib/facade-agent/cli.mjs test/elevation3d-facade-agent-cli.test.ts
git commit -m "feat(elevation3d): expose facade provider router CLI"
```

---

### Task 7: Offline Seedream/BytePlus Non-Curtain-Wall PNG E2E

**Files:**

- Modify: `test/elevation3d-facade-agent-e2e.test.ts`
- Modify: `test/fixtures/facade-agent/README.md`
- Modify: `test/fixtures/facade-agent/providers/generate-proposals.mjs`

**Interfaces:**

- Consumes: fixture Seedream image adapter, fixture BytePlus grammar adapter, local facade builder/validator, browser delivery renderer, and run manifest.
- Produces: offline E2E evidence containing an opaque masonry punched-window/door facade GLB and eight verified 2400 x 2400 PNGs marked as fixture-derived.

- [ ] **Step 1: Add a failing router E2E with explicit architectural assertions**

Use a grammar fixture that includes opaque masonry, punched windows, frames/glass, and an entrance door zone while asserting:

```ts
assert.equal(result.router.grammar_provider, "byteplus-seed-mini");
assert.deepEqual(result.router.image_providers, ["seedream-5-pro"]);
assert.equal(result.transport.image, "fixture");
assert.equal(result.transport.grammar, "fixture");
assert.equal(validation.accepted, true);
assert.equal(validation.curtain_wall_allowed, false);
assert.match(delivery.manifest.facade_system, /punched-window|masonry/);
assert.equal(Object.keys(delivery.manifest.views).length, 8);
```

For every view, decode with `sharp`, assert PNG format and `2400 x 2400`, verify the file hash equals its manifest hash, and assert the eight hashes/visual signatures are not all identical. Inspect the GLB with `NodeIO` and assert non-empty meshes/materials plus the existing geometry identity gates.

- [ ] **Step 2: Run E2E and verify failure**

```powershell
node --test test/elevation3d-facade-agent-e2e.test.ts --experimental-strip-types
```

Expected: FAIL because the E2E fixture still assumes the OpenAI grammar path or lacks router/transport metadata.

- [ ] **Step 3: Wire the fixture route and document fixture limitations**

Generate deterministic fixture proposal bytes locally, return deterministic BytePlus grammar JSON, and pass both through the same contracts, receipts, local builder, validation, and delivery code used by live adapters. Update the fixture README with this exact meaning: fixture PNGs validate request binding, persistence, local 3D construction, and rendering; they do not measure Seedream or BytePlus visual quality.

- [ ] **Step 4: Run E2E plus validation/rendering regressions**

```powershell
node --test test/elevation3d-facade-agent-e2e.test.ts test/elevation3d-facade-agent-validation.test.ts test/elevation3d-punched-facade.test.ts test/elevation3d-all-views-e2e.test.ts --experimental-strip-types
```

Expected: PASS with one GLB and eight valid, distinct 2400-square PNG delivery views for the Seedream/BytePlus fixture route.

- [ ] **Step 5: Commit the offline E2E unit**

```powershell
git add test/elevation3d-facade-agent-e2e.test.ts test/fixtures/facade-agent/README.md test/fixtures/facade-agent/providers/generate-proposals.mjs
git commit -m "test(elevation3d): verify routed facade PNG delivery"
```

---

### Task 8: Full Verification and Live-Run Handoff

**Files:**

- Modify: `docs/elevation-3d-facade-agent-local-runbook.md`
- Modify only if verification exposes a scoped defect: files already listed in Tasks 1–7 and their focused tests.

**Interfaces:**

- Consumes: completed router implementation and all offline tests.
- Produces: green focused/full verification, clean security audit, documented credential variables, and a prepared but unexecuted live command.

- [ ] **Step 1: Document offline verification and the non-executed live command**

Add environment variable names only (`ARK_API_KEY`; never a value) and this PowerShell command. State that `seedream-byteplus-live-20260806-150000` is an example and execution must use a newly generated safe run ID:

```powershell
npm run facade:agent -- run --candidate creative-020 --brief brick-punched-window-v1 `
  --dataset-root D:/Data/50_ELE/elevation-3d-dataset `
  --output-root D:/Data/50_ELE/elevation-3d-e2e-results `
  --run-id seedream-byteplus-live-20260806-150000 `
  --image-provider seedream-5-pro --image-budget seedream-5-pro=0.06 `
  --grammar-provider byteplus-seed-mini --grammar-budget 0.01 `
  --confirm-live --confirm-total-usd 0.07
```

State immediately above it: do not execute until offline gates pass, a credential is supplied out of band, and the user gives a fresh exact `$0.07` approval.

- [ ] **Step 2: Run focused router verification**

```powershell
node --test test/elevation3d-facade-agent-contract.test.ts test/elevation3d-facade-agent-provider-registry.test.ts test/elevation3d-facade-agent-grammar-router.test.ts test/elevation3d-facade-agent-grammar.test.ts test/elevation3d-facade-agent-byteplus-grammar.test.ts test/elevation3d-facade-agent-harness.test.ts test/elevation3d-facade-agent-cli.test.ts test/elevation3d-facade-agent-e2e.test.ts test/elevation3d-plugin.test.ts test/elevation3d-providers.test.ts --experimental-strip-types
```

Expected: PASS with zero network calls outside injected fixtures.

- [ ] **Step 3: Run full repository verification**

```powershell
npm test
npm run build
npm audit --audit-level=high
```

Expected: all tests PASS, TypeScript build exits 0, and audit reports zero high/critical vulnerabilities. If a command fails, use `superpowers:systematic-debugging`, add a focused regression test, fix only the root cause, and rerun the focused command before repeating this step.

- [ ] **Step 4: Scan tracked output for secrets and unfinished markers**

```powershell
$unfinished = @(("TO" + "DO"), ("T" + "BD"), ("PLACE" + "HOLDER")) -join "|"
rg -n "Bearer [A-Za-z0-9]|sk-[A-Za-z0-9]|ARK_API_KEY=" plugins/elevation-3d/lib/facade-agent test/fixtures/facade-agent docs/elevation-3d-facade-agent-local-runbook.md
rg -n $unfinished plugins/elevation-3d/lib/facade-agent test/fixtures/facade-agent docs/elevation-3d-facade-agent-local-runbook.md
git diff --check
git status --short
```

Expected: no credential values or unfinished markers; `git diff --check` exits 0; status contains only the intended runbook or scoped verification fixes.

- [ ] **Step 5: Commit the verified handoff**

```powershell
git add docs/elevation-3d-facade-agent-local-runbook.md
git commit -m "docs(elevation3d): document routed facade live run"
```

- [ ] **Step 6: Stop before live execution and report artifacts**

Report the focused/full test counts, build result, audit result, commits, offline GLB path, eight PNG paths, and the exact missing credential/approval requirements. Do not run the live command in Step 1 during implementation-plan execution.
