# Multi-Provider Facade Image Evaluation Design

Date: 2026-08-06

Status: approved direction; awaiting written-spec review

Supersedes: the two-provider selection in `2026-08-05-geometry-locked-facade-agent-design.md`

## Purpose

Evaluate GPT Image 2, BytePlus Seedream 5.0 Pro, and Alibaba Cloud Qwen Image 2.0 against the same geometry-locked architectural evidence. Each provider may make exactly one paid image-edit submission. Every proposal then passes through the same GPT-5.6 grammar extractor, exact local 3D builder, hard validation gates, eight-view renderer, and scorecard.

The goal is not to select the most attractive isolated image. The goal is to find the least expensive provider whose proposal can be converted into a coherent, geometry-preserving facade across the complete building. GPT Image 2 is the quality reference. Seedream is the precision-editing challenger. Qwen is the cost challenger.

## Decisions

1. Keep the exact local MASS, facade segment authority, floor guides, cameras, matrices, builder, GLB validator, and eight-view delivery as the production authority.
2. Add Seedream and Qwen as image-proposal providers only. Neither may generate or replace authoritative 3D geometry.
3. Keep the existing GPT Image 2 and Nano Banana implementations compatible. Nano Banana is not part of the first three-way paid evaluation and is not called automatically.
4. Use a common provider-neutral request and result contract. Provider-specific serialization stays inside small adapters.
5. Use one common English architectural prompt because all three providers document English support and it avoids translation-induced prompt drift.
6. Generate one image per provider. Disable batch or sequential generation explicitly.
7. Normalize only derived comparison copies. Preserve raw provider bytes, media type, dimensions, hash, usage, and redacted response metadata.
8. Prefer a cheaper provider when its accepted score is within the configured practical-equivalence margin of the best accepted result. Cost cannot rescue a result that fails a hard geometry or delivery gate.

## Provider Set

### GPT Image 2

- Model: `gpt-image-2`, with the returned model snapshot recorded.
- Endpoint: `POST /v1/images/edits`.
- Input: verified contact-sheet PNG as multipart image input.
- Output request: PNG, one image, high quality, explicit supported size.
- Role: quality and instruction-following reference.
- Credential: `OPENAI_API_KEY`.

### Seedream 5.0 Pro

- Model: `dola-seedream-5-0-pro-260628`.
- Endpoint: BytePlus ModelArk `POST /api/v3/images/generations` in `ap-southeast-1`.
- Input: verified contact sheet as a base64 data URL.
- Output request: one image, PNG, watermark disabled, explicit pixel dimensions.
- Role: precise reference-image editing challenger. Its coordinate and bounding-box editing capability is structurally useful for later facade-local edits, but the first comparison uses the same unmarked evidence as the other providers.
- Credential: `ARK_API_KEY`.

### Qwen Image 2.0

- Model: `qwen-image-2.0` for the cost trial. The exact resolved model version is recorded. `qwen-image-2.0-pro` remains an explicit later upgrade, not an automatic retry.
- Endpoint: Alibaba Cloud Model Studio international service in Singapore.
- Input: verified contact-sheet image using the official image-edit request contract.
- Output request: one image, 1536-square comparison target where supported, watermark disabled, negative prompt containing the same prohibited geometry drift rules.
- Role: lowest-cost full editing challenger.
- Credential: `DASHSCOPE_API_KEY`.

## Common Comparison Contract

The provider-neutral request is immutable and hash-bound:

```text
FacadeImageEditRequest
  candidate identity
  brief identity and revision
  evidence manifest SHA-256
  evidence PNG bytes and SHA-256
  architectural prompt revision and SHA-256
  output width, height, format, and count
  prohibited changes
  provider model pin
  estimated cost and hard ceiling
```

The normalized result contains only plain, redacted data and verified bytes:

```text
FacadeImageEditResult
  provider and resolved model
  raw artifact path, media type, dimensions, byte size, SHA-256
  provider request fingerprint
  durable remote-ID hash, never the reusable raw identifier
  sanitized usage and actual/derived cost
  submission receipt authority
```

Adapters may not receive arbitrary endpoints, headers, model IDs, output counts, or prompts from CLI input. Endpoint and supported model allowlists live in code. Credentials never enter the request fingerprint, run manifest, logs, memory, or committed fixtures.

## Architectural Prompt

The shared prompt follows the same labeled order for every provider:

1. **Goal:** competition-quality architectural facade concept that will be rebuilt as exact local 3D.
2. **Authority:** the supplied contact sheet fixes silhouette, footprint, height, storey count, facade planes, opening zones, and every camera.
3. **Material direction:** warm red or red-brown masonry, deep punched windows, mineral mortar, restrained precast lintels and sills, dark durable metal frames, realistic glazing.
4. **Composition:** preserve every panel and view in the supplied sheet; design one coherent facade system across all visible sides.
5. **Constraints:** change facade articulation and material appearance only; no curtain wall, extra floors, balconies, setbacks, projections, roof changes, landscaping, people, text, labels, logos, or camera changes.
6. **Output use:** reference board for deterministic architectural grammar extraction, not a free-form marketing rendering.

Critical preserve rules are repeated once at the end because both OpenAI and BytePlus prompt guidance recommend explicit edit invariants. Provider-specific prompt rewriting is disabled where it could weaken those invariants.

## Modular Code Layout

The current large provider modules mix boundary validation, request construction, transport, response decoding, and provider policy. This change introduces narrowly owned folders without moving unrelated facade code.

```text
plugins/elevation-3d/lib/facade-agent/
  image-providers/
    contract.mjs              # provider-neutral immutable request/result schema
    registry.mjs              # allowlisted IDs and dependency construction
    prompt.mjs                # one shared versioned architectural prompt
    image-codec.mjs           # bounded signature/decode/dimension checks
    response-boundary.mjs     # plain-data cloning, bounded JSON, redaction
    transport.mjs             # timeout/abort primitives, no provider policy
    providers/
      openai/
        adapter.mjs
        request.mjs
        response.mjs
      byteplus/
        adapter.mjs
        request.mjs
        response.mjs
      alibaba/
        adapter.mjs
        request.mjs
        response.mjs
      google/
        adapter.mjs           # compatibility wrapper for existing Nano path
        request.mjs
        response.mjs
  evaluation/
    scorecard.mjs             # accepted-result comparison and equivalence margin
    cost.mjs                  # provider-specific estimate/actual normalization
    report.mjs                # redacted human- and machine-readable comparison
```

Rules for module boundaries:

- `contract.mjs` knows no endpoint or environment variable.
- `prompt.mjs` knows no provider serialization.
- provider `request.mjs` modules are pure mappings from authorized common requests.
- provider `response.mjs` modules decode provider payloads into the common result.
- `adapter.mjs` owns credentials, endpoint, paid submission capability, and transport orchestration.
- shared helpers contain no provider branching by name.
- `registry.mjs` is the only production location that maps a provider ID to an adapter.
- the harness depends on the common interface, never on provider modules directly.

The existing public provider imports remain as compatibility re-exports during migration. This prevents a large flag-day change and keeps existing tests and plugin consumers stable.

## CLI and Budget Contract

Provider IDs become:

```text
gpt-image-2
seedream-5-pro
qwen-image-2
nano-banana-pro
```

The first live evaluation explicitly selects only the first three. CLI budget input becomes provider-keyed rather than adding another dedicated flag for every model. Existing dedicated GPT/Nano flags remain accepted compatibility aliases.

The live command must include:

- `--confirm-live`;
- a unique run ID;
- an exact total confirmation equal to all selected provider ceilings plus the grammar ceiling;
- one positive ceiling for every selected provider;
- zero or absent ceilings for unselected providers.

No provider network call occurs during `preflight`. Local adapter preflight verifies credential presence, endpoint/model allowlists, evidence size, prompt size, output constraints, and estimated ceilings. A credential is capability, not spending authorization.

Initial ceilings are intentionally conservative:

- GPT Image 2: `$0.50`;
- Seedream 5.0 Pro: `$0.10`;
- Qwen Image 2.0: `$0.05`;
- GPT-5.6 grammar extraction: `$0.35` total;
- complete first live evaluation: `$1.00` maximum.

The exact confirmed amount is recomputed from the final configuration. These are design ceilings, not claimed prices.

## Data Flow

```text
exact candidate package
  -> verified evidence/contact sheet
  -> common request + prompt hash
  -> three one-shot provider adapters
  -> three raw proposal artifacts
  -> common proposal validation
  -> GPT-5.6 typed grammar per proposal
  -> exact local 3D build and at most one local correction
  -> GLB hard gates
  -> eight-view PNG delivery per accepted proposal
  -> provider-neutral scorecard
  -> practical-equivalence cost decision
```

Image-provider submission is never repeated by the local repair loop. A grammar correction reuses the already downloaded proposal. An ambiguous paid submission blocks that provider and requires manual reconciliation.

## Evaluation and Winner Policy

Hard gates remain unchanged: exact-MASS identity, facade-segment binding, bounded depth, storey and camera preservation, valid GLB/PBR, eight distinct 2400-square views, stable browser frames, and zero browser errors.

Accepted proposals receive the existing implementability, multi-view, grammar, and visual components. The comparison report adds non-scoring diagnostics:

- raw proposal dimensions and entropy;
- prompt/evidence binding;
- local correction count;
- actual image and grammar cost;
- cost per accepted local 3D result;
- provider latency;
- human-review notes for facade character and material credibility.

Selection is two-step:

1. Select the highest accepted technical score.
2. If another accepted provider is within 3.0 score points and costs at least 40% less for the completed accepted result, mark the cheaper provider `recommended_default` and retain the highest scorer as `quality_fallback`.

The report records both labels. The harness never treats price as evidence of geometry quality. If scores are outside the equivalence margin, the best technical score wins regardless of price.

## PyCharm Indexing Scope

The project module remains rooted at `D:/Data/50_ELE`, but generated and dependency-heavy paths are excluded in `.idea/50_ELE.iml`:

- `elevation-3d-e2e-results`;
- `facade-agent-verification`;
- `gitagent/node_modules`;
- `gitagent/dist`;
- `gitagent/.worktrees/tripo-extreme-8k-validation`;
- `node_modules`, `dist`, result, and verification directories inside the active geometry worktree.

The active `geometry-locked-facade-agent` source, tests, documentation, fixtures, and plugin files remain indexed. `.git`, caches, and IDE-standard ignored paths retain IDE defaults. The local `.idea` change is machine configuration outside the Git repository and is not committed with product code.

## Error and Security Handling

- Reject non-allowlisted production endpoints before constructing authorization headers.
- Use one-shot paid-operation submission capabilities already enforced by the harness ledger.
- Record `submitting` durably before network access and returned receipt authority immediately afterward.
- Bound request, response, decoded image, nesting depth, property count, and download size.
- Normalize authentication, rate-limit, moderation, timeout, server, invalid JSON, invalid image, and ambiguous submission errors.
- Download temporary URLs immediately into the run directory, then validate bytes independently of the URL.
- Never log or persist API keys, authorization headers, signed output URLs, raw remote IDs, or unsanitized provider bodies.
- Do not fall back from one paid provider to another automatically.

## Test Strategy

Implementation follows test-driven development in small module-sized steps:

1. Common contract rejects mutable, oversized, unauthoritative, or non-one-image requests.
2. Prompt snapshot tests prove identical semantic instructions and preserve rules across adapters.
3. Pure request tests lock exact GPT, BytePlus, and Alibaba API payloads.
4. Response tests cover inline base64, temporary URL download, malformed data, oversized bodies, secret redaction, and usage normalization.
5. Adapter tests prove endpoint/model allowlists, timeouts, one-shot submission authority, no retry, and stable error codes.
6. Registry tests prove selected providers only are constructed and no credential crosses provider boundaries.
7. CLI tests cover provider-keyed budgets, compatibility flags, exact live confirmation, dry run, status, and resume.
8. Harness fixture comparison runs all three providers with zero network and verifies one image submission each.
9. Full local E2E builds accepted GLBs, renders eight PNGs per accepted proposal, opens them in the browser, and retains artifacts on demand.
10. One explicitly authorized live evaluation runs only after build, audit, focused tests, full tests, dry-run preflight, credential checks, and exact cost confirmation pass.

Live output is not accepted merely because the API returned an image. Every raw proposal is opened for visual inspection, and every final PNG is decoded, hashed, checked against its manifest, and inspected across all eight views.

## Migration Sequence

1. Extract provider-neutral helpers behind compatibility re-exports without changing behavior.
2. Move GPT and Google implementations into the modular layout and prove existing tests unchanged.
3. Add BytePlus fixtures and adapter.
4. Add Alibaba fixtures and adapter.
5. Generalize provider registry, budgets, CLI, harness, and reporting.
6. Run complete offline verification.
7. Apply local PyCharm exclusions and confirm active source remains indexed.
8. Request credentials only after the live preflight command and exact ceilings are ready.
9. Run one live request per selected provider and complete the local 3D/eight-view comparison.

## Acceptance Criteria

- Provider code follows the documented folder ownership and contains no new monolithic multi-provider module.
- Existing GPT Image 2 and Nano Banana behavior and tests remain compatible.
- Seedream 5.0 Pro and Qwen Image 2.0 use official global API endpoints with fixed allowlisted models.
- All selected providers receive one semantically identical, hash-bound architectural edit request.
- Exactly one billed image submission is possible per selected provider and run.
- Three raw proposals and all derived grammar, GLB, validation, cost, and eight-view artifacts are retained.
- Geometry and delivery hard gates remain provider-neutral and unchanged.
- The scorecard distinguishes technical winner, recommended cost default, and quality fallback.
- No credential or reusable provider identifier appears in repository files, stdout, reports, memory, or fixtures.
- PyCharm excludes large outputs and dependencies while retaining the active worktree source.
- No live call occurs before the user supplies credentials and approves the exact final cost confirmation.

## References

- OpenAI GPT Image 2 model: <https://developers.openai.com/api/docs/models/gpt-image-2>
- OpenAI image generation and editing: <https://developers.openai.com/api/docs/guides/image-generation>
- BytePlus image generation API: <https://docs.byteplus.com/api/docs/ModelArk/1541523>
- BytePlus Seedream tutorial: <https://docs.byteplus.com/en/docs/ModelArk/1824121>
- BytePlus pricing: <https://docs.byteplus.com/docs/ModelArk/1099320>
- Alibaba image model selection: <https://www.alibabacloud.com/help/en/model-studio/image-model>
- Alibaba Qwen image editing: <https://www.alibabacloud.com/help/en/model-studio/qwen-image-edit-guide>
- Alibaba pricing: <https://www.alibabacloud.com/help/en/model-studio/model-pricing>
- Qwen Image Bench: <https://github.com/QwenLM/Qwen-Image-Bench>
