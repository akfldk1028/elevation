# Multi-Provider Facade Image Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add modular GPT Image 2, Seedream 5 Pro, Qwen Image 2, and retained Nano Banana adapters, then compare the first three through the same geometry-locked local 3D and eight-view PNG pipeline without permitting an unapproved paid call.

**Architecture:** A provider-neutral immutable request/result boundary feeds small provider request, response, and adapter modules selected by one allowlisted registry. The existing harness remains authoritative for paid-operation receipts, grammar extraction, exact local geometry, GLB validation, and delivery rendering; a separate evaluation layer adds normalized cost and practical-equivalence reporting. Existing provider import paths remain compatibility re-exports.

**Tech Stack:** Node.js ESM, TypeScript tests through Node's type stripping, built-in `fetch`, `AbortController`, `crypto`, `dns/promises`, Sharp, Playwright, Three.js, npm, PyCharm project XML.

## Global Constraints

- Follow test-driven development: add one focused failing test, run it and observe the expected failure, implement only that behavior, then rerun the focused test.
- Do not make GPT Image 2, BytePlus, Alibaba, Gemini, or grammar network calls while implementing or running offline verification.
- Do not add an SDK or a new npm dependency. Provider HTTP contracts remain small, explicit, and testable with injected `fetch` implementations.
- Keep exact MASS geometry, facade segment authority, floor guides, cameras, matrices, local builder, GLB validator, and eight-view renderer unchanged.
- A selected image provider can consume exactly one `image-generation` submission capability per run. A local correction reuses the original proposal and cannot resubmit it.
- Production endpoints, model IDs, output count, prompt revision, and output format are code allowlists, not CLI-controlled values.
- Never persist or print API keys, authorization headers, signed download URLs, raw remote IDs, or unsanitized provider response bodies.
- Preserve raw provider PNG bytes and their verified media type, dimensions, size, hash, usage, and redacted receipt metadata before any comparison normalization.
- Live evaluation remains gated on all tests passing, all three credentials being present in the process environment, and a new exact user approval of the computed final ceiling.
- Use small commits at the end of each task. Do not combine unrelated cleanup with these changes.

## File Responsibility Map

- `image-providers/contract.mjs`: common immutable request/result authorities and canonical fingerprints only.
- `image-providers/prompt.mjs`: the single provider-neutral prompt revision, positive prompt, negative prompt, and prohibited-change vocabulary.
- `image-providers/image-codec.mjs`: bounded PNG signature, decode, dimension, and pixel validation only.
- `image-providers/response-boundary.mjs`: hostile-object-safe plain-data cloning, response limits, and redaction only.
- `image-providers/transport.mjs`: abort/timeout composition and one-attempt HTTP transport only.
- `image-providers/download.mjs`: public-HTTPS validation and bounded temporary-artifact download only.
- `image-providers/providers/<vendor>/request.mjs`: pure common-request-to-vendor-payload mapping.
- `image-providers/providers/<vendor>/response.mjs`: vendor-response-to-common-result mapping.
- `image-providers/providers/<vendor>/adapter.mjs`: credentials, allowlisted endpoint/model, submission capability, and transport orchestration.
- `image-providers/registry.mjs`: the only production provider-ID-to-adapter map.
- `evaluation/cost.mjs`: receipt-derived cost normalization only.
- `evaluation/scorecard.mjs`: hard-gate-aware technical/cost selection only.
- `evaluation/report.mjs`: deterministic redacted machine and human report construction only.
- Existing `contract.mjs`, `cli.mjs`, `harness.mjs`, and `production-dependencies.mjs`: configuration, orchestration, and migration wiring; no vendor payload construction.

---

### Task 1: Freeze the shared image boundary in focused tests

**Files:**

- Create: `plugins/elevation-3d/lib/facade-agent/image-providers/contract.mjs`
- Create: `plugins/elevation-3d/lib/facade-agent/image-providers/image-codec.mjs`
- Create: `plugins/elevation-3d/lib/facade-agent/image-providers/response-boundary.mjs`
- Create: `plugins/elevation-3d/lib/facade-agent/image-providers/transport.mjs`
- Create: `test/elevation3d-facade-agent-image-boundary.test.ts`

**Interfaces:**

- `createFacadeImageEditRequest(input)` returns a deeply frozen request containing candidate, brief, evidence and prompt hashes, one PNG input, exact output controls, provider pin, estimate, and ceiling.
- `verifyFacadeImageEditResult(input)` returns a deeply frozen normalized authority containing verified bytes, media type, dimensions, hash, redacted usage, cost, request fingerprint, and remote-ID hash.
- `decodeBoundedProviderImage(input)` accepts only PNG bytes/base64 within fixed encoded, decoded, dimension, and pixel limits and fully decodes pixels before returning metadata.
- `cloneBoundedPlainData(value)` rejects accessors, proxies that throw, excessive depth, excessive properties, cycles, and dangerous keys while copying only plain data.
- `fetchWithProviderDeadline(input)` composes caller abort and timeout signals, performs one injected fetch, and never retries.

Target exports:

```ts
export declare function createFacadeImageEditRequest(input: unknown): Readonly<Record<string, unknown>>;
export declare function verifyFacadeImageEditResult(input: unknown): Readonly<Record<string, unknown>>;
export declare function decodeBoundedProviderImage(input: { bytes: Buffer; expectedMimeType?: "image/png" }): Promise<Readonly<Record<string, unknown>>>;
export declare function cloneBoundedPlainData(value: unknown): null | boolean | number | string | readonly unknown[] | Readonly<Record<string, unknown>>;
export declare function fetchWithProviderDeadline(input: Readonly<Record<string, unknown>>): Promise<Response>;
```

- [ ] Write failing tests for mutable input, accessor/proxy input, invalid candidate/evidence hashes, non-PNG bytes, truncated PNG, decompression/pixel overflow, count other than one, estimate above ceiling, oversized JSON, caller abort, timeout, and secret-shaped response fields.

- [ ] Run the focused test and confirm failure because the four modules do not exist:

  `node --test --experimental-strip-types test/elevation3d-facade-agent-image-boundary.test.ts`

- [ ] Implement fixed limits, canonical hashing, deep freezing, bounded plain-data cloning, PNG signature/decode verification, and one-shot timeout transport using built-in APIs and the existing Sharp dependency.

- [ ] Rerun the focused test and confirm all boundary cases pass.

- [ ] Commit:

  `git add plugins/elevation-3d/lib/facade-agent/image-providers test/elevation3d-facade-agent-image-boundary.test.ts && git commit -m "refactor(elevation3d): add facade image provider boundary"`

### Task 2: Add one versioned architectural prompt and adapter request snapshots

**Files:**

- Create: `plugins/elevation-3d/lib/facade-agent/image-providers/prompt.mjs`
- Create: `test/elevation3d-facade-agent-image-prompt.test.ts`
- Modify: `test/elevation3d-facade-agent-image-boundary.test.ts`

**Interfaces:**

- `FACADE_IMAGE_PROMPT_REVISION` is a fixed revision identifier.
- `buildFacadeArchitecturalPrompt(input)` returns the provider-neutral English prompt and its SHA-256.
- `FACADE_PROHIBITED_CHANGES` is an immutable ordered list reused by the main and negative prompts.
- The request fingerprint binds prompt revision/hash, evidence manifest/hash, candidate and brief identities, model pin, output controls, estimate, and ceiling; it excludes credentials and paths.

Target exports:

```js
export const FACADE_IMAGE_PROMPT_REVISION = "facade-architectural-edit-v1";
export const FACADE_PROHIBITED_CHANGES = Object.freeze([
	"curtain wall", "extra floors", "balconies", "setbacks", "projections",
	"roof changes", "landscaping", "people", "text", "labels", "logos", "camera changes",
]);
export declare function buildFacadeArchitecturalPrompt(input: {
	candidateId: string;
	briefId: string;
	evidenceManifestSha256: string;
}): Readonly<{ revision: "facade-architectural-edit-v1"; prompt: string; negativePrompt: string; sha256: string }>;
```

- [ ] Add a failing prompt snapshot test asserting the labeled Goal, Authority, Material direction, Composition, Constraints, and Output use sections; the repeated preserve rule; and explicit prohibitions on curtain walls, extra floors, balconies, setbacks, projections, roof changes, landscaping, people, text, logos, and camera changes.

- [ ] Add tests proving a single-character prompt/evidence/model/output change changes the fingerprint, while a credential-like extra field is rejected rather than fingerprinted.

- [ ] Run:

  `node --test --experimental-strip-types test/elevation3d-facade-agent-image-prompt.test.ts test/elevation3d-facade-agent-image-boundary.test.ts`

- [ ] Implement the frozen prompt constants and canonical prompt builder, then connect the prompt revision and hash to `createFacadeImageEditRequest`.

- [ ] Rerun both focused tests and confirm exact snapshot and hash binding.

- [ ] Commit:

  `git add plugins/elevation-3d/lib/facade-agent/image-providers test/elevation3d-facade-agent-image-prompt.test.ts test/elevation3d-facade-agent-image-boundary.test.ts && git commit -m "feat(elevation3d): bind shared facade image prompt"`

### Task 3: Move GPT Image 2 and Nano Banana behind modular adapters

**Files:**

- Create: `plugins/elevation-3d/lib/facade-agent/image-providers/providers/openai/adapter.mjs`
- Create: `plugins/elevation-3d/lib/facade-agent/image-providers/providers/openai/request.mjs`
- Create: `plugins/elevation-3d/lib/facade-agent/image-providers/providers/openai/response.mjs`
- Create: `plugins/elevation-3d/lib/facade-agent/image-providers/providers/google/adapter.mjs`
- Create: `plugins/elevation-3d/lib/facade-agent/image-providers/providers/google/request.mjs`
- Create: `plugins/elevation-3d/lib/facade-agent/image-providers/providers/google/response.mjs`
- Modify: `plugins/elevation-3d/lib/facade-agent/providers/openai-image.mjs`
- Modify: `plugins/elevation-3d/lib/facade-agent/providers/gemini-image.mjs`
- Modify: `plugins/elevation-3d/lib/facade-agent/grammar-agent.mjs`
- Modify: `test/elevation3d-facade-agent-providers.test.ts`

**Interfaces:**

- Each `request.mjs` exports a pure serializer that accepts only a verified common request and emits its provider's exact HTTP payload.
- Each `response.mjs` exports a bounded decoder into `verifyFacadeImageEditResult`.
- Each `adapter.mjs` exports `createProvider(options)`, `buildRequest(input)`, and the existing verified-result reader required by grammar extraction.
- The old `providers/openai-image.mjs` and `providers/gemini-image.mjs` files become compatibility re-exports with no provider logic.

Compatibility shape:

```js
export {
	buildRequest,
	createProvider,
	readVerifiedProposalResultAuthority,
} from "../image-providers/providers/openai/adapter.mjs";
```

- [ ] Extend existing tests to import old and new paths and assert identical request fingerprints, exact OpenAI multipart fields, exact Gemini JSON fields, normalized results, error codes, timeouts, one-shot capability consumption, and authority rehydration.

- [ ] Run the existing provider suite and confirm it fails on missing modular exports:

  `node --test --experimental-strip-types test/elevation3d-facade-agent-providers.test.ts`

- [ ] Extract shared validation/transport/decoding into the new boundary modules, split OpenAI and Google request/response/adapter responsibilities, and leave compatibility exports at the old paths.

- [ ] Update grammar proposal verification to use the common verified-result authority without branching on provider-specific readers.

- [ ] Rerun provider, grammar, score, and harness tests:

  `node --test --experimental-strip-types test/elevation3d-facade-agent-providers.test.ts test/elevation3d-facade-agent-grammar.test.ts test/elevation3d-facade-agent-score.test.ts test/elevation3d-facade-agent-harness.test.ts`

- [ ] Commit:

  `git add plugins/elevation-3d/lib/facade-agent test/elevation3d-facade-agent-providers.test.ts test/elevation3d-facade-agent-grammar.test.ts && git commit -m "refactor(elevation3d): modularize existing image adapters"`

### Task 4: Implement the BytePlus Seedream 5 Pro adapter

**Files:**

- Create: `plugins/elevation-3d/lib/facade-agent/image-providers/providers/byteplus/adapter.mjs`
- Create: `plugins/elevation-3d/lib/facade-agent/image-providers/providers/byteplus/request.mjs`
- Create: `plugins/elevation-3d/lib/facade-agent/image-providers/providers/byteplus/response.mjs`
- Create: `test/fixtures/facade-agent/providers/byteplus/success.json`
- Create: `test/fixtures/facade-agent/providers/byteplus/error.json`
- Create: `test/elevation3d-facade-agent-byteplus.test.ts`

**Interfaces:**

- Provider ID: `seedream-5-pro`.
- Model allowlist: exactly `dola-seedream-5-0-pro-260628`.
- Endpoint allowlist: exactly `https://ark.ap-southeast.bytepluses.com/api/v3/images/generations`.
- Credential lookup: `ARK_API_KEY`, read only inside adapter construction/preflight.
- Request fields: `model`, shared `prompt`, one PNG data URL in `image`, `size: "1536x1536"`, `output_format: "png"`, `response_format: "b64_json"`, and `watermark: false`.
- Response accepts exactly one inline `b64_json` PNG and normalizes request ID, resolved model, usage, latency, and derived/actual cost without exposing raw identifiers.

Target exports and fixed policy:

```js
export const BYTEPLUS_SEEDREAM_POLICY = Object.freeze({
	provider: "seedream-5-pro",
	model: "dola-seedream-5-0-pro-260628",
	endpoint: "https://ark.ap-southeast.bytepluses.com/api/v3/images/generations",
	size: "1536x1536",
});
export declare function serializeBytePlusRequest(request: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
export declare function decodeBytePlusResponse(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
export declare function createProvider(options: Readonly<Record<string, unknown>>): Readonly<Record<string, Function>>;
```

- [ ] Write failing tests for the exact JSON body and headers, missing credential, wrong endpoint/model, output count drift, prompt rewrite fields, estimate above ceiling, timeout/abort, authentication/rate-limit/moderation/server errors, malformed JSON/base64/PNG, oversized response, duplicate images, hostile response objects, and secret redaction.

- [ ] Run and confirm failure on the absent adapter:

  `node --test --experimental-strip-types test/elevation3d-facade-agent-byteplus.test.ts`

- [ ] Implement pure serialization, bounded inline response decoding, fixed endpoint/model preflight, one-shot submission, and stable `FacadeProviderError` normalization without retry.

- [ ] Rerun the BytePlus and common boundary suites.

- [ ] Commit:

  `git add plugins/elevation-3d/lib/facade-agent/image-providers/providers/byteplus test/fixtures/facade-agent/providers/byteplus test/elevation3d-facade-agent-byteplus.test.ts && git commit -m "feat(elevation3d): add Seedream facade adapter"`

### Task 5: Implement the Alibaba Qwen Image 2 adapter and safe download boundary

**Files:**

- Create: `plugins/elevation-3d/lib/facade-agent/image-providers/providers/alibaba/adapter.mjs`
- Create: `plugins/elevation-3d/lib/facade-agent/image-providers/providers/alibaba/request.mjs`
- Create: `plugins/elevation-3d/lib/facade-agent/image-providers/providers/alibaba/response.mjs`
- Create: `plugins/elevation-3d/lib/facade-agent/image-providers/download.mjs`
- Create: `test/fixtures/facade-agent/providers/alibaba/success.json`
- Create: `test/fixtures/facade-agent/providers/alibaba/error.json`
- Create: `test/elevation3d-facade-agent-alibaba.test.ts`

**Interfaces:**

- Provider ID: `qwen-image-2`.
- Model allowlist: exactly `qwen-image-2.0`; Pro is not an automatic fallback.
- Endpoint is constructed from a validated workspace ID as `https://{workspaceId}.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`.
- Credentials: `DASHSCOPE_API_KEY` and the non-secret workspace ID, read only by the adapter.
- Request `input.messages[0].content` contains one image data URL and the shared text prompt; parameters fix `n: 1`, the common negative prompt, `prompt_extend: false`, `watermark: false`, and `size: "1536*1536"`.
- `downloadVerifiedProviderImage(input)` permits only a provider-returned HTTPS URL with no userinfo or fragment, resolves every hostname, rejects loopback/private/link-local/multicast/unspecified addresses, sends no authorization header, disables automatic redirects, revalidates each bounded redirect, limits bytes/time, and validates the downloaded PNG.

Target exports and fixed policy:

```js
export const ALIBABA_QWEN_POLICY = Object.freeze({
	provider: "qwen-image-2",
	model: "qwen-image-2.0",
	region: "ap-southeast-1",
	size: "1536*1536",
});
export declare function serializeAlibabaRequest(request: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
export declare function decodeAlibabaResponse(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
export declare function downloadVerifiedProviderImage(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
export declare function createProvider(options: Readonly<Record<string, unknown>>): Readonly<Record<string, Function>>;
```

- [ ] Write failing payload tests plus download tests for signed-query redaction, literal private IPv4/IPv6, DNS-resolved private addresses, mixed public/private DNS answers, redirect to private address, redirect overflow, missing/invalid location, non-HTTPS URL, userinfo, fragments, timeout, oversized stream, malformed PNG, duplicate images, and no authorization header on downloads.

- [ ] Run and confirm failure on missing Alibaba modules:

  `node --test --experimental-strip-types test/elevation3d-facade-agent-alibaba.test.ts`

- [ ] Implement the pure request serializer, response URL extraction, DNS-aware download guard using `dns/promises.lookup({ all: true })`, manual bounded redirects, byte/decode validation, immediate local persistence, hashed remote authority, and normalized cost/usage.

- [ ] Rerun Alibaba, boundary, and provider tests.

- [ ] Commit:

  `git add plugins/elevation-3d/lib/facade-agent/image-providers test/fixtures/facade-agent/providers/alibaba test/elevation3d-facade-agent-alibaba.test.ts && git commit -m "feat(elevation3d): add Qwen facade adapter"`

### Task 6: Centralize provider construction in an allowlisted registry

**Files:**

- Create: `plugins/elevation-3d/lib/facade-agent/image-providers/registry.mjs`
- Modify: `plugins/elevation-3d/lib/facade-agent/production-dependencies.mjs`
- Create: `test/elevation3d-facade-agent-provider-registry.test.ts`
- Modify: `test/elevation3d-facade-agent-providers.test.ts`

**Interfaces:**

- `FACADE_IMAGE_PROVIDER_IDS` is `Object.freeze(["gpt-image-2", "seedream-5-pro", "qwen-image-2", "nano-banana-pro"])`.
- `createFacadeImageProviderRegistry(config, options)` constructs only `config.providers`, returns a frozen provider map, and injects only each adapter's credential and transport dependencies.
- `production-dependencies.mjs` consumes the registry and no longer imports provider implementations directly.

Target registry surface:

```js
export const FACADE_IMAGE_PROVIDER_IDS = Object.freeze([
	"gpt-image-2", "seedream-5-pro", "qwen-image-2", "nano-banana-pro",
]);
export declare function createFacadeImageProviderRegistry(
	config: Readonly<Record<string, unknown>>,
	options?: Readonly<Record<string, unknown>>,
): Readonly<Record<"gpt-image-2" | "seedream-5-pro" | "qwen-image-2" | "nano-banana-pro", Readonly<Record<string, Function>>>>;
```

- [ ] Add failing tests proving unknown/duplicate providers are rejected, selection order is preserved, unselected adapters are not constructed, Nano remains selectable, and OpenAI/BytePlus/Alibaba/Google credentials never cross adapter boundaries.

- [ ] Run:

  `node --test --experimental-strip-types test/elevation3d-facade-agent-provider-registry.test.ts test/elevation3d-facade-agent-providers.test.ts`

- [ ] Implement the registry and replace hard-coded provider construction in production dependencies.

- [ ] Rerun registry, provider, contract, CLI, and harness suites.

- [ ] Commit:

  `git add plugins/elevation-3d/lib/facade-agent/image-providers/registry.mjs plugins/elevation-3d/lib/facade-agent/production-dependencies.mjs test/elevation3d-facade-agent-provider-registry.test.ts test/elevation3d-facade-agent-providers.test.ts && git commit -m "refactor(elevation3d): centralize facade provider registry"`

### Task 7: Generalize configuration and CLI budgets without breaking aliases

**Files:**

- Modify: `plugins/elevation-3d/lib/facade-agent/contract.mjs`
- Modify: `plugins/elevation-3d/lib/facade-agent/cli.mjs`
- Modify: `test/elevation3d-facade-agent-contract.test.ts`
- Modify: `test/elevation3d-facade-agent-cli.test.ts`
- Modify: `README.md`

**Interfaces:**

- `--providers` accepts an ordered, unique, non-empty subset of the four allowlisted IDs; the first paid evaluation uses `gpt-image-2,seedream-5-pro,qwen-image-2`.
- Repeatable `--image-budget <provider>=<usd>` is the canonical budget input.
- Existing `--image-budget-gpt-image-2`, `--image-budget-nano-banana-pro`, `--gpt-image-max-usd`, and `--nano-banana-max-usd` remain compatibility aliases and cannot be mixed with the canonical entry for the same provider.
- Every selected provider requires one positive ceiling; every unselected provider must be absent or zero.
- `--confirm-total-usd` must exactly equal the decimal sum of selected image ceilings and the grammar ceiling; floating-point tolerance is not used for authorization.
- `--dry-run` and `preflight` reject `--confirm-live` and perform zero network calls.

Canonical CLI shape:

```text
--providers gpt-image-2,seedream-5-pro,qwen-image-2
--image-budget gpt-image-2=0.50
--image-budget seedream-5-pro=0.10
--image-budget qwen-image-2=0.05
--grammar-budget 0.35
--confirm-total-usd 1.00
```

- [ ] Replace the fixed two-provider assertions with failing tests for all valid subsets, three-provider order, duplicate/unknown providers, missing/extra budgets, alias conflicts, decimal exactness, immutable returned maps, dry-run, status, resume, and secret-free CLI output.

- [ ] Run:

  `node --test --experimental-strip-types test/elevation3d-facade-agent-contract.test.ts test/elevation3d-facade-agent-cli.test.ts`

- [ ] Implement provider-keyed parsing with integer decimal units, normalize aliases into the same frozen map, and derive exact run ceiling before writing any state.

- [ ] Document the offline three-provider preflight command with design ceilings `$0.50`, `$0.10`, `$0.05`, grammar `$0.35`, and exact total `$1.00`; label those values as ceilings rather than quoted prices.

- [ ] Rerun contract and CLI tests, then the existing E2E test to detect compatibility regressions.

- [ ] Commit:

  `git add plugins/elevation-3d/lib/facade-agent/contract.mjs plugins/elevation-3d/lib/facade-agent/cli.mjs test/elevation3d-facade-agent-contract.test.ts test/elevation3d-facade-agent-cli.test.ts README.md && git commit -m "feat(elevation3d): support provider-keyed facade budgets"`

### Task 8: Add normalized cost and practical-equivalence reporting

**Files:**

- Create: `plugins/elevation-3d/lib/facade-agent/evaluation/cost.mjs`
- Create: `plugins/elevation-3d/lib/facade-agent/evaluation/scorecard.mjs`
- Create: `plugins/elevation-3d/lib/facade-agent/evaluation/report.mjs`
- Modify: `plugins/elevation-3d/lib/facade-agent/score.mjs`
- Create: `test/elevation3d-facade-agent-evaluation.test.ts`
- Modify: `test/elevation3d-facade-agent-score.test.ts`

**Interfaces:**

- `normalizeFacadeEvaluationCost(input)` produces image, grammar, correction, total, and cost-per-accepted-result values from verified receipts; absent actual cost remains explicitly `null`, never zero.
- `selectFacadeRecommendation(candidates, { scoreMargin: 3, minimumSavingsRatio: 0.40 })` first chooses the highest accepted technical score, then marks a cheaper accepted candidate within 3.0 points and at least 40% cheaper as `recommended_default`, retaining the highest scorer as `quality_fallback`.
- `buildFacadeEvaluationReport(input)` emits deterministic JSON-safe data with technical winner, recommended default, quality fallback, diagnostics, artifact hashes/paths, and no raw identifiers or signed URLs.
- Existing `selectFacadeWinner` remains exported with its current behavior for compatibility.

Target selection surface:

```js
export declare function normalizeFacadeEvaluationCost(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
export declare function selectFacadeRecommendation(
	candidates: readonly Readonly<Record<string, unknown>>[],
	policy?: { scoreMargin?: 3; minimumSavingsRatio?: 0.40 },
): Readonly<Record<string, unknown>>;
export declare function buildFacadeEvaluationReport(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
```

- [ ] Write failing table tests covering no accepted candidates, ties, exactly/just outside the 3.0 margin, exactly/just below 40% savings, missing actual costs, failed hard gates, zero costs, shuffled input order, and stable redacted report serialization.

- [ ] Run:

  `node --test --experimental-strip-types test/elevation3d-facade-agent-evaluation.test.ts test/elevation3d-facade-agent-score.test.ts`

- [ ] Implement cost normalization and the two-step decision with integer micro-dollar arithmetic and deterministic provider-ID tie-breaking.

- [ ] Make `score.mjs` re-export or delegate only the new comparison behavior needed by the harness while preserving the legacy function contract.

- [ ] Rerun evaluation and score tests.

- [ ] Commit:

  `git add plugins/elevation-3d/lib/facade-agent/evaluation plugins/elevation-3d/lib/facade-agent/score.mjs test/elevation3d-facade-agent-evaluation.test.ts test/elevation3d-facade-agent-score.test.ts && git commit -m "feat(elevation3d): report facade quality and cost tradeoffs"`

### Task 9: Generalize the harness, receipts, resume, and memory to selected providers

**Files:**

- Modify: `plugins/elevation-3d/lib/facade-agent/harness.mjs`
- Modify: `plugins/elevation-3d/lib/facade-agent/fixture-transport.mjs`
- Modify: `test/elevation3d-facade-agent-harness.test.ts`
- Modify: `test/elevation3d-facade-agent-ledger.test.ts`

**Interfaces:**

- All stage loops derive from the immutable selected-provider list and provider-keyed ceilings.
- Preflight creates request manifests for selected providers only and validates all non-network capabilities before ledger mutation.
- Generate consumes one image capability per selected provider, persists `submitting` before fetch, records receipt authority immediately, and never auto-falls back or retries.
- Grammar/build/correct/validate/deliver reuses one persisted proposal per provider; at most one local correction remains allowed.
- Resume verifies provider list, budgets, request hashes, receipts, artifact hashes, and stage authorities before continuing.
- Memory stores selected provider state, normalized cost, and recommendation labels but no secrets, URLs, or raw remote IDs.

Required persisted comparison fields:

```js
{
	technical_winner: "gpt-image-2",
	recommended_default: "qwen-image-2",
	quality_fallback: "gpt-image-2",
	providers: {
		"gpt-image-2": { status: "accepted" },
		"seedream-5-pro": { status: "accepted" },
		"qwen-image-2": { status: "accepted" },
	},
	cost: { currency: "USD", actual_total_usd: 0.18 },
}
```

- [ ] Convert fixture construction to provider-agnostic test helpers and add failing three-provider tests for call order, one submission each, isolated provider failure, ambiguous submission blocking, no fallback, local correction without image resubmission, resume from every stage, tampered provider state, and redacted memory/report output.

- [ ] Run:

  `node --test --experimental-strip-types test/elevation3d-facade-agent-harness.test.ts test/elevation3d-facade-agent-ledger.test.ts`

- [ ] Replace fixed provider branches with registry-backed loops while preserving current stage authority and atomic persistence behavior.

- [ ] Connect accepted candidates to `buildFacadeEvaluationReport` and persist both machine-readable JSON and concise text summaries.

- [ ] Rerun harness, ledger, CLI, score, grammar, and validation tests.

- [ ] Commit:

  `git add plugins/elevation-3d/lib/facade-agent/harness.mjs plugins/elevation-3d/lib/facade-agent/fixture-transport.mjs test/elevation3d-facade-agent-harness.test.ts test/elevation3d-facade-agent-ledger.test.ts && git commit -m "feat(elevation3d): run selected facade providers through one harness"`

### Task 10: Prove the complete three-provider local 3D and PNG flow offline

**Files:**

- Modify: `test/elevation3d-facade-agent-e2e.test.ts`
- Create: `test/fixtures/facade-agent/providers/byteplus/proposal.png`
- Create: `test/fixtures/facade-agent/providers/alibaba/proposal.png`
- Modify: `test/fixtures/facade-agent/README.md`
- Modify: `plugins/elevation-3d/lib/facade-agent/fixture-transport.mjs`

**Interfaces:**

- The retained fixture run selects `gpt-image-2`, `seedream-5-pro`, and `qwen-image-2`; all injected transports are explicitly fixture-authorized and make zero network calls.
- Each provider yields one raw proposal, one grammar lineage, one accepted GLB after no more than one local correction, and eight distinct final views.
- Every delivery PNG is 2400×2400, fully decodable, hash-matched to its manifest, visually non-blank by entropy/variance thresholds, and associated with stable browser frames and zero browser errors.
- The final report distinguishes technical winner, recommended default, and quality fallback according to fixture scores and costs.

Required delivery assertion shape:

```js
for (const provider of ["gpt-image-2", "seedream-5-pro", "qwen-image-2"]) {
	const accepted = result.providers[provider].versions.find((version) => version.status === "accepted");
	assert.equal(accepted.delivery.views.length, 8);
	assert.ok(accepted.delivery.views.every((view) => view.width === 2400 && view.height === 2400));
}
```

- [ ] Add red E2E assertions for three one-shot submissions, three raw proposal hashes, accepted GLB validation authorities, 24 unique view manifests, 24 decoded 2400-square PNGs, per-provider view distinctness, recommendation fields, retained artifact paths, and an empty network-call log.

- [ ] Run:

  `node --test --experimental-strip-types test/elevation3d-facade-agent-e2e.test.ts`

- [ ] Add deterministic, non-curtain-wall fixture proposals with materially different facade grammars and connect them to the fixture transport without bypassing common response verification.

- [ ] Rerun E2E and open the retained contact sheets plus all eight views for each provider with the existing browser/image inspection path. Record inspection assertions in the fixture report instead of relying only on file existence.

- [ ] Run related local pipeline tests:

  `node --test --experimental-strip-types test/elevation3d-facade-agent-e2e.test.ts test/elevation3d-facade-agent-evidence.test.ts test/elevation3d-facade-agent-grammar.test.ts test/elevation3d-facade-agent-validation.test.ts`

- [ ] Commit:

  `git add test/elevation3d-facade-agent-e2e.test.ts test/fixtures/facade-agent plugins/elevation-3d/lib/facade-agent/fixture-transport.mjs && git commit -m "test(elevation3d): verify three-provider facade delivery"`

### Task 11: Reduce PyCharm indexing load without hiding active source

**Files:**

- Modify locally, outside Git: `D:/Data/50_ELE/.idea/50_ELE.iml`
- Create: `docs/superpowers/runbooks/facade-agent-local-environment.md`

**Interfaces:**

- Exclude the root output directories `elevation-3d-e2e-results`, `facade-agent-verification`, and `facade-agent-live-evaluation`.
- Exclude `gitagent/node_modules`, `gitagent/dist`, the inactive `gitagent/.worktrees/tripo-extreme-8k-validation`, and `node_modules`, `dist`, result, and verification directories under the active worktree.
- Do not exclude the active worktree root, `plugins`, `test`, `docs`, or fixture source.
- The runbook lists process-environment variable names only; it contains no credential values.

- [ ] Read the current XML and record the existing `<content>` element before editing:

  `Select-String -Path 'D:/Data/50_ELE/.idea/50_ELE.iml' -Pattern '<content|excludeFolder'`

- [ ] Patch the existing `<content>` element with explicit `excludeFolder` entries, preserving all unrelated user IDE settings.

  ```xml
  <excludeFolder url="file://$MODULE_DIR$/elevation-3d-e2e-results" />
  <excludeFolder url="file://$MODULE_DIR$/facade-agent-verification" />
  <excludeFolder url="file://$MODULE_DIR$/facade-agent-live-evaluation" />
  <excludeFolder url="file://$MODULE_DIR$/gitagent/node_modules" />
  <excludeFolder url="file://$MODULE_DIR$/gitagent/dist" />
  <excludeFolder url="file://$MODULE_DIR$/gitagent/.worktrees/tripo-extreme-8k-validation" />
  <excludeFolder url="file://$MODULE_DIR$/gitagent/.worktrees/geometry-locked-facade-agent/node_modules" />
  <excludeFolder url="file://$MODULE_DIR$/gitagent/.worktrees/geometry-locked-facade-agent/dist" />
  ```

- [ ] Add the local-environment runbook with credential names, offline preflight, retained-output location, and instructions to reindex only after exclusions are saved.

- [ ] Parse the XML, assert every required exclusion is present, and assert no exclusion ends at the active worktree, `plugins`, `test`, `docs`, or `test/fixtures`:

  ```powershell
  [xml]$project = Get-Content -Raw 'D:/Data/50_ELE/.idea/50_ELE.iml'
  $excluded = @($project.module.component.content.excludeFolder | ForEach-Object { $_.url })
  if ($excluded -contains 'file://$MODULE_DIR$/gitagent/.worktrees/geometry-locked-facade-agent') { throw 'Active worktree source is excluded' }
  git -C 'D:/Data/50_ELE/gitagent/.worktrees/geometry-locked-facade-agent' status --short
  ```

- [ ] Commit only repository files:

  `git add docs/superpowers/runbooks/facade-agent-local-environment.md && git commit -m "docs(elevation3d): document facade agent local setup"`

### Task 12: Run offline release verification and prepare the exact live command

**Files:**

- No planned repository modifications; any discovered defect returns to its owning task and focused test before this gate is rerun.
- Create outside Git when executed: `D:/Data/50_ELE/facade-agent-live-evaluation/<run-id>/`

**Interfaces:**

- Offline verification must pass without `OPENAI_API_KEY`, `ARK_API_KEY`, or `DASHSCOPE_API_KEY` and without provider network access.
- Live preflight verifies credential presence but makes zero network calls.
- The live command selects only GPT Image 2, Seedream 5 Pro, and Qwen Image 2 and contains exact provider ceilings, grammar ceiling, computed total, a unique run ID, and `--confirm-live` only after fresh user approval.

- [ ] Confirm no unresolved implementation markers or accidental secrets exist:

  `rg -n "T[O]DO|T[B]D|PLACEH[O]LDER|sk-[A-Za-z0-9]|Authorization: Bearer|X-DashScope-SSE" plugins/elevation-3d/lib/facade-agent test docs/superpowers`

- [ ] Run formatting/diff safety checks:

  `git diff --check`

- [ ] Run TypeScript build:

  `npm run build`

- [ ] Run all tests:

  `npm test`

- [ ] Run the dependency audit without changing the lockfile:

  `npm audit --omit=dev --offline`

- [ ] Run the documented three-provider CLI dry run and preflight with injected fixture transports; assert zero network calls and print the exact authorized total.

- [ ] Inspect the retained offline output: decode and hash every raw proposal and every 2400×2400 delivery PNG, verify all GLBs and manifests, and visually inspect each provider's eight views.

- [ ] Request `OPENAI_API_KEY`, `ARK_API_KEY`, `DASHSCOPE_API_KEY`, and Alibaba workspace ID through process environment only after all preceding checks pass. Report which names are missing without printing values.

- [ ] Recompute the exact ceiling from the final CLI configuration and ask the user to approve that amount. The prior design approval does not authorize a billed request.

- [ ] After explicit cost approval, run exactly one live image request per selected provider into `D:/Data/50_ELE/facade-agent-live-evaluation/<run-id>/`, complete grammar/local 3D/GLB/eight-view validation, inspect all outputs, and report technical winner, recommended default, quality fallback, total actual cost, and any blocked provider.

- [ ] If no implementation changes were needed during verification, do not create an empty commit. If a focused fix was required, rerun the failing focused test plus the full suite and commit it with a scope-specific message.

## Completion Evidence

Before declaring implementation complete, capture and report:

- commit list for Tasks 1–11 and any verification fix;
- `npm run build`, `npm test`, audit, and `git diff --check` results;
- the three-provider dry-run/preflight command and proof of zero network calls;
- counts and hashes for raw proposals, accepted GLBs, and all eight-view PNG sets;
- visual inspection result for each provider across all eight views;
- the redacted evaluation report and recommendation reasoning;
- PyCharm exclusion verification and confirmation that active source remains indexed;
- whether live execution is complete or is waiting for credentials and exact cost approval.
