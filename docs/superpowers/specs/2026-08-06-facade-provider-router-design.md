# Facade Provider Router Design

Date: 2026-08-06

Status: approved design; awaiting written-spec review

Supersedes: the fixed GPT-5.6 grammar path in `2026-08-06-multi-provider-facade-image-evaluation-design.md`. The image-provider comparison, exact local geometry authority, and delivery gates in that document remain valid unless this document changes them explicitly.

## Purpose

Turn the facade agent into a provider-neutral, geometry-locked pipeline with two independent routers:

1. an image router that selects one or more facade-proposal providers; and
2. a grammar router that selects exactly one structured facade-grammar provider for the run.

The default economical path is Seedream 5.0 Pro for the proposal and BytePlus Seed 2.0 Mini for grammar extraction. GPT Image 2, Nano Banana, Qwen Image, and later allowlisted image adapters remain selectable through the same image contract. OpenAI, BytePlus, and later allowlisted structured-output adapters remain selectable through the same grammar contract.

No model generates authoritative 3D geometry. Models propose facade appearance and structured facade grammar; the existing local coordinates, matrices, facade segments, builder, GLB validation, and fixed cameras remain the sole geometry authority.

## Decisions

1. Use independent `ImageProviderRegistry` and `GrammarProviderRegistry` components rather than provider bundles or a general workflow graph.
2. Run only explicitly selected paid providers. Never retry a paid submission or fall back to another paid provider automatically.
3. Select one grammar provider per run and apply it independently to every successfully downloaded image proposal. This keeps comparisons fair and makes grammar cost predictable.
4. Preserve the existing `submit`, `status`, COS artifact, CLI, and harness boundaries through compatibility aliases and re-exports.
5. Keep raw model proposals immutable. Local correction may revise structured grammar and local 3D, but it may not resubmit the image request.
6. Persist provider identity, resolved model, request hash, artifact hash, transport type, cost, and receipts in the run manifest.
7. Label deterministic fixtures as fixtures everywhere. Fixture PNGs demonstrate transport and pipeline behavior, never model quality.
8. Require a fresh run ID and exact budget confirmation for every new live provider selection.

## Architecture

```text
verified local candidate package
  -> evidence/contact-sheet builder
  -> ImageProviderRegistry
       -> selected image adapter A (one shot)
       -> selected image adapter B (one shot, only when explicitly selected)
  -> immutable raw proposal artifacts
  -> GrammarProviderRegistry
       -> selected grammar adapter, once per successful proposal
  -> normalized facade grammar
  -> exact local coordinate/matrix-based 3D builder
  -> geometry, GLB, and browser delivery gates
  -> eight 2400 x 2400 PNG views per accepted proposal
  -> provider-neutral quality/cost report
```

The routers perform selection and construction only. They do not contain provider payload branches, network policy, prompt text, scoring, or geometry logic. Each adapter owns provider-specific serialization and response decoding behind a common contract.

## Module Layout

```text
plugins/elevation-3d/lib/facade-agent/
  routers/
    image-provider-registry.mjs
    grammar-provider-registry.mjs
  providers/
    image/
      contract.mjs
      prompt.mjs
      openai/
      byteplus/
      alibaba/
      google/
      wan/                    # added only with an implemented adapter
      flux/                   # added only with an implemented adapter
    grammar/
      contract.mjs
      prompt.mjs
      openai/
      byteplus/
      alibaba/                # added only with an implemented adapter
  contracts/
    run-config.mjs
    provider-result.mjs
  harness/
    provider-ledger.mjs
    run-orchestrator.mjs
  evaluation/
    scorecard.mjs
    cost.mjs
    report.mjs
```

This is the target ownership model, not a flag-day directory move. Existing imports under `image-providers/`, `providers/openai-image.mjs`, `providers/gemini-image.mjs`, `contract.mjs`, and `harness.mjs` remain compatibility entry points while implementation is extracted in small tested steps. Unrelated facade-agent code is not moved.

Boundary rules:

- A registry maps an allowlisted public provider ID to one adapter constructor.
- A provider adapter receives only normalized, frozen input plus explicit transport dependencies.
- Shared modules never branch on a provider name.
- Endpoint, region, credential name, and model allowlists remain inside the relevant adapter policy.
- Prompts are versioned independently for image proposal and grammar extraction.
- Grammar adapters return the same validated facade grammar schema regardless of model-native response format.
- The harness depends only on the two router contracts.

## Provider IDs and Initial Scope

Initial image IDs:

```text
seedream-5-pro
gpt-image-2
qwen-image-2
nano-banana-pro
```

The registry may later add `wan-image` and `flux-2-klein` without changing run orchestration. Mentioning a future ID in documentation does not make it selectable; an ID enters the allowlist only with a complete adapter, fixtures, conformance tests, and cost policy.

Initial grammar IDs:

```text
byteplus-seed-mini
openai-gpt-5.6
```

`byteplus-seed-mini` uses the pinned BytePlus Seed 2.0 Mini model that supports image understanding and structured output. `openai-gpt-5.6` wraps the current grammar implementation without changing its schema or validation rules. An Alibaba grammar adapter may be added later through the same conformance suite.

Default selection:

```json
{
  "image_providers": ["seedream-5-pro"],
  "grammar_provider": "byteplus-seed-mini"
}
```

Defaults choose a route; they do not authorize a live call.

## Configuration and Compatibility

The canonical run configuration uses explicit router fields:

```json
{
  "schema_version": 2,
  "image_providers": ["seedream-5-pro"],
  "grammar_provider": "byteplus-seed-mini",
  "image_budget_usd": { "seedream-5-pro": 0.06 },
  "grammar_budget_usd": 0.01,
  "confirm_live": true,
  "confirm_total_usd": 0.07
}
```

Compatibility behavior:

- legacy `providers` is normalized to `image_providers`;
- legacy `grammarModel: "gpt-5.6"` is normalized to `grammar_provider: "openai-gpt-5.6"`;
- conflicting legacy and canonical fields are rejected rather than silently prioritized;
- persisted schema-v1 runs remain readable and resumable through a pure migration view;
- their stored bytes are never rewritten in place;
- current `submit`, `status`, and COS-facing response shapes retain their public fields, with new router metadata added only in backward-compatible optional fields.

CLI examples:

```text
facade-agent run \
  --image-provider seedream-5-pro \
  --image-budget seedream-5-pro=0.06 \
  --grammar-provider byteplus-seed-mini \
  --grammar-budget 0.01 \
  --confirm-live \
  --confirm-total-usd 0.07
```

`--image-provider` may be repeated for an explicitly approved comparison. The existing comma-separated `--providers` option remains a compatibility alias. Duplicate or unknown IDs are rejected before dependency construction.

## Common Provider Contracts

Every image adapter exposes:

```text
preflight(request) -> capability
submitOnce(request, submissionCapability) -> image result
```

Every grammar adapter exposes:

```text
preflight(request) -> capability
submitOnce(request, submissionCapability) -> validated grammar result
```

`preflight` is network-free. It verifies credential presence, endpoint/model/region allowlists, input sizes, media signatures, prompt revision, estimates, and ceilings. It returns a single-use in-memory submission capability that is bound to the normalized request fingerprint. Credentials are capabilities, not spending authorization.

Normalized results contain only bounded plain data:

```text
provider ID and resolved model
transport: live | fixture
request and input SHA-256 fingerprints
artifact path, media type, dimensions, byte size, and SHA-256
sanitized usage and cost
durable receipt authority or its non-reusable hash
normalized error code when unsuccessful
```

Provider bodies, authorization headers, signed URLs, API keys, and reusable remote identifiers cannot cross the adapter boundary.

## Paid-Call and Budget Policy

The run follows this order:

```text
normalize configuration
  -> local preflight for every selected adapter
  -> compute exact micro-dollar ceiling
  -> verify exact user confirmation
  -> persist submitting state
  -> consume one-shot capability
  -> persist receipt/result immediately
```

Rules:

- No automatic paid retry.
- No automatic paid fallback.
- No transfer of unused budget from one provider to another.
- A timeout or uncertain submission state blocks replay until manually reconciled.
- Another provider requires a new run ID and its own exact confirmation unless it was already selected and included in the original confirmation.
- Estimates and ceilings use integer micro-dollars internally; floating-point equality never authorizes spending.
- The recommended one-provider Seedream route starts with a `$0.06` image ceiling and `$0.01` grammar ceiling, for an exact `$0.07` confirmation. These are safety ceilings, not price claims.
- Fixture transports require no live confirmation and cannot consume a paid-call capability.

## Failure and Security Handling

Both adapter families normalize provider-specific failures into stable categories:

```text
AUTHENTICATION_FAILED
RATE_LIMITED
CONTENT_REJECTED
REQUEST_TIMEOUT
PROVIDER_UNAVAILABLE
INVALID_PROVIDER_RESPONSE
INVALID_IMAGE
INVALID_GRAMMAR
RESPONSE_TOO_LARGE
SUBMISSION_UNCERTAIN
```

Each error records whether non-submission is definitive. Only a definitive pre-submission error leaves the paid capability unused; the harness still does not retry automatically.

All transports enforce bounded request/response bodies, decoded-image size, JSON depth/property count, redirect policy, timeout, and abort. Redaction runs before logging or persistence and covers keys, bearer values, signed query strings, provider bodies, and reusable IDs. Production endpoints and models are fixed allowlists, not arbitrary CLI values.

Resume is receipt-driven and idempotent. A completed, hash-bound stage is reused. A `submitting` stage without definitive receipt is marked uncertain and cannot be replayed. A configuration, prompt, evidence, provider, or model hash mismatch requires a new run.

## Grammar and Local 3D Authority

Grammar extraction remains constrained by the existing validated facade schema. The router changes who produces that schema, not its meaning. The grammar must bind every facade operation to verified local segments, storey guides, opening zones, depth limits, material slots, and evidence hashes.

The local builder alone converts the grammar into meshes, transforms, PBR material assignments, and GLB output. Generated images cannot alter footprint, silhouette, floor count, authoritative matrices, cameras, or facade-plane identity. Designs with punched windows, doors, masonry bays, fins, balconies only where allowed by source geometry, and non-curtain-wall articulation must be testable; the evaluation cannot rely solely on curtain-wall examples.

## Test Strategy

Implementation is test-driven and proceeds in small router/adapter increments.

### Contract conformance

Run the same conformance suite against every image adapter and every grammar adapter:

- preflight performs no network access;
- exact endpoint/model/region allowlists are enforced;
- request capabilities are fingerprint-bound and single-use;
- timeout and abort are wired through the transport;
- oversized or malformed responses are rejected before persistence;
- errors normalize to stable codes with correct submission certainty;
- secrets and signed URLs never appear in thrown errors, stdout, manifests, or fixtures;
- fixtures report `transport: fixture` and live adapters report `transport: live`.

### Router matrix

Router tests prove:

- every registered provider is selectable through the common interface;
- image and grammar selections are independent;
- only selected adapters are constructed or called;
- duplicates, unknown IDs, and conflicting legacy fields fail locally;
- no error triggers retry, fallback, or budget reallocation;
- old `providers` and `grammarModel` configurations normalize deterministically;
- schema-v1 persisted runs remain readable without mutation.

### Harness and end-to-end verification

Offline fixture E2E must cover at least:

1. Seedream image plus BytePlus grammar;
2. Seedream image plus OpenAI grammar;
3. multiple explicitly selected image providers plus one common grammar provider;
4. a punched-window/door masonry facade that is not a curtain wall;
5. interrupted and uncertain submission states;
6. `submit`, `status`, COS artifacts, resume, CLI, and machine-readable output.

Every accepted route must build its GLB locally and render eight distinct 2400 x 2400 PNG views. Tests decode each PNG, verify dimensions and signatures, bind hashes to the delivery manifest, check browser errors and frame stability, and retain artifacts when requested. Synthetic fixture images prove orchestration only and are excluded from quality conclusions.

### Live evaluation

A live test occurs only after focused tests, the complete suite, build, dependency audit, fixture E2E, dry-run preflight, credential checks, and exact cost confirmation pass. The first recommended live test is one Seedream 5.0 Pro image call followed by one BytePlus Seed Mini grammar call. Its proposal PNG and all eight final facade PNGs require visual inspection in addition to automated validation.

The report separates:

- geometry and delivery hard-gate results;
- grammar validity and local correction count;
- visual facade character and material credibility;
- latency and actual/derived cost;
- technical winner and economical recommended default.

Quality is never inferred from fixture output, model price, or a successful HTTP response.

## Migration Sequence

1. Add failing tests for schema-v2 configuration, compatibility normalization, and independent registry selection.
2. Extract the current OpenAI grammar implementation behind the common grammar adapter without behavioral changes.
3. Route the harness through `GrammarProviderRegistry`; remove the hard-coded `openai-grammar` capability label.
4. Add BytePlus Seed Mini grammar request/response fixtures and adapter conformance tests.
5. Generalize CLI fields, budgets, manifests, status output, and resume validation while retaining legacy aliases.
6. Extract or re-export the existing image registry into the target router ownership model without changing current provider behavior.
7. Add router-matrix, security, uncertainty, and compatibility tests.
8. Run offline Seedream/BytePlus and multi-provider E2E through local GLB and eight-view PNG delivery.
9. Run the full suite, build, and dependency audit.
10. Prepare but do not execute the exact live command. Request API credentials and a fresh `$0.07` approval only when all offline gates are green.

## Acceptance Criteria

- Image proposal and grammar extraction are independently selectable through allowlisted registries.
- Seedream 5.0 Pro plus BytePlus Seed Mini is the default route but has no implicit spending authority.
- Existing GPT Image 2, Nano Banana, Qwen Image, and OpenAI grammar behavior remains accessible.
- The current fixed `grammarModel === "gpt-5.6"` and `openai-grammar` harness assumptions are removed from canonical schema-v2 execution.
- No selected provider can be retried or replaced by another paid provider automatically.
- Exact micro-dollar ceilings cover every selected live call and match explicit confirmation.
- Existing `submit`, `status`, COS, CLI, stored run, and compatibility import contracts continue to pass.
- Fixture and live artifacts are unmistakably labeled and cannot be confused in quality reports.
- At least one non-curtain-wall facade fixture completes grammar extraction, exact local GLB construction, and eight 2400-square PNG views.
- Adapter conformance proves timeout, abort, response bounds, stable errors, and secret redaction.
- Full tests, build, dependency audit, and offline E2E pass before any credential is requested or live request is made.
- A live call is performed only with credentials supplied at that time and a newly approved exact total.

## Official References

- BytePlus image generation API: <https://docs.byteplus.com/api/docs/ModelArk/1541523>
- BytePlus model pricing: <https://docs.byteplus.com/docs/ModelArk/1099320>
- BytePlus structured output: <https://docs.byteplus.com/en/docs/ModelArk/1958523>
- BytePlus image understanding: <https://docs.byteplus.com/en/docs/ModelArk/1362931>
- OpenAI image generation and editing: <https://developers.openai.com/api/docs/guides/image-generation>
- Alibaba image model selection: <https://www.alibabacloud.com/help/en/model-studio/image-model>
