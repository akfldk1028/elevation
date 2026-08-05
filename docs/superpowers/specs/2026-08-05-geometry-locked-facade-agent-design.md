# Geometry-Locked Facade Agent Design

Date: 2026-08-05

Status: approved for implementation planning

First comparison candidate: `creative-020`

Facade direction: red brick, deep punched windows, precast lintels
Image providers: GPT Image 2 and Nano Banana Pro, one controlled generation each

## Purpose

Replace the Tripo-first presentation path with an agentized facade-design pipeline that uses the exact local MASS as geometry authority. Image models propose coherent architectural appearance; they do not generate, replace, normalize, or remesh the building. A deterministic local builder converts a validated facade grammar into real shallow facade geometry and portable materials on the source coordinate system. One GLB remains the source of every elevation, plan, top, axonometric view, and interactive inspection result.

The first controlled comparison applies the same evidence and architectural brief to GPT Image 2 and Nano Banana Pro. Each provider receives one generation request. The harness builds and validates both proposals locally, then selects a winner primarily by 3D implementability and multi-view consistency rather than by the attractiveness of one perspective image.

## Context and Corrected Direction

The repository memory contains an older instruction that treats a cropped isometric image as the sole production input to an image-to-3D provider. That direction was superseded by `memory/elevation-3d/decisions/ADR-004-exact-mass-architectural-enrichment.md` and the current `memory/elevation-3d/README.md`. The accepted production direction is exact-MASS enrichment using the complete candidate package.

The completed Tripo experiments reinforce that correction. Tripo normalized the source scale and changed the mesh from 24,296 to 23,900 triangles. The provider geometry was rejected, and only safely matched UV/PBR evidence was transferred to 92.5224527% of the canonical non-glass area. Extreme produced measured 8K maps for 30 credits but no material presentation improvement over Standard in the fixed eight-view comparison. Tripo therefore remains an optional research adapter, not the default facade agent or geometry authority.

The current local pipeline already proves the necessary base capabilities: it reads the indexed mesh, transform trace, facade planes, surface normals, floor guides, and camera poses; produces enriched GLBs; validates geometry and storey constraints; and renders eight deterministic views. The new design extends those boundaries instead of replacing them.

## Goals

1. Preserve the exact source MASS coordinates, indices, component count, bounds, transforms, placement, and camera contract.
2. Generate a credible non-curtainwall facade as actual local GLB components and portable materials.
3. Compare GPT Image 2 and Nano Banana Pro under the same candidate, evidence, brief, request count, and validation rules.
4. Make every stage directly runnable and inspectable from a CLI.
5. Put the agent inside a deterministic harness whose validation, budget, retry, and artifact policies cannot be bypassed by model output.
6. Permit at most two local grammar/build attempts per provider without automatically repeating an image-provider request.
7. Produce one selected GLB and eight validated views, while retaining both raw proposals and all rejection evidence.

## Non-Goals

- Reconstructing or replacing MASS geometry from an image.
- Asking an image model to emit GLB, OBJ, vertices, or authoritative coordinates.
- Using Tripo, Hunyuan, SPAR3D, or another 3D generator in the first comparison.
- Treating a generated contact sheet as measured architectural evidence.
- Automatically buying another provider attempt after a timeout, ambiguous response, invalid output, or validation failure.
- Cutting structural openings into the canonical MASS in the first implementation.
- Creating a general BIM authoring system, planning approval system, or unrestricted autonomous design agent.

## Considered Approaches

### A. Geometry-locked facade agent with local construction — selected

Generate provider-specific visual proposals from deterministic geometry evidence, extract a typed facade grammar, and construct facade shells, openings, reveals, frames, lintels, and materials locally. This best uses the available coordinates and matrices, preserves technical authority, and makes failures measurable. It requires more local builder and validation work, but that work is reusable across providers and facade styles.

### B. Direct multi-view projection and texture baking

Generate front/right/back/left/top images and project them directly onto the exact mesh. This is faster for a first visual result and reuses the camera matrices well, but seams, occlusion, unseen surfaces, baked lighting, and portable UV generation remain difficult. It also does not produce the real punched-window depth requested for this facade. Projection can remain a diagnostic preview, not the selected production path.

### C. Image-to-3D or provider-mesh donation

Generate a new model and register it back to the MASS, or transfer provider geometry details. This duplicates known geometry, reintroduces hidden-surface hallucination and scale/topology changes, and already failed held-out-view authority tests. It is excluded from the production design.

## Authority Model

Authority is explicit and non-transitive:

| Artifact | Authority |
| --- | --- |
| Indexed mesh, OBJ, geometry program, transform trace | geometry and coordinate authority |
| Camera poses and projected bounds | view and drawing authority |
| Floor guides | storey and vertical-alignment authority |
| Facade planes and surface normals | facade placement and orientation authority |
| Provider images | visual proposal only |
| Typed facade grammar | build instruction after validation |
| Locally built detail meshes and PBR materials | presentation detail, subordinate to the MASS |

No provider image or model response may override the authoritative chain. The final GLB contains the canonical MASS unchanged plus separately identifiable facade-detail nodes.

## System Architecture

```text
CLI / elevation_3d_facade_agent_run
  -> Run Harness
     -> Candidate Loader and Authority Lock
     -> Evidence Pack Renderer
     -> Provider Comparison Controller
        -> GPT Image 2 Adapter
        -> Nano Banana Pro Adapter
     -> Facade Grammar Agent
     -> Deterministic Facade Builder
     -> Validation and Local Repair Loop
     -> Fixed Eight-View Renderer
     -> Scorer and Winner Selector
     -> Artifact Ledger and Run Memory
```

The harness owns state transitions, immutable inputs, paid-call permission, request counts, timeouts, validation gates, retry limits, artifact publication, and exit codes. The agent controller may choose a typed correction supported by the harness, but cannot skip a stage, relax a threshold, mutate locked evidence, resubmit a provider request, or mark a rejected result as accepted.

The current `unified-flow.mjs` structure is retained as the execution foundation. Its `v001 -> corrected v002 -> fallback` behavior becomes a provider-scoped facade build loop. The generic exact-MASS fallback remains available for delivery continuity but cannot win the facade comparison or masquerade as a detailed result.

## CLI Contract

The first implementation adds a single CLI with stage subcommands and one composed command:

```text
elevation-3d-facade preflight
elevation-3d-facade evidence
elevation-3d-facade generate
elevation-3d-facade grammar
elevation-3d-facade build
elevation-3d-facade validate
elevation-3d-facade compare
elevation-3d-facade run
elevation-3d-facade status
elevation-3d-facade resume
```

Every subcommand reads a persisted stage manifest, verifies upstream hashes, refuses implicit overwrite, writes its output atomically, and emits one redacted JSON object to stdout. Human-readable diagnostics go to stderr. Success is exit code `0`; rejected design evidence is a distinct nonzero exit code from configuration, transport, security, and internal failures.

`run` composes the same public stage functions used by the subcommands; it does not contain an alternate hidden path. `resume` may continue polling a durably recorded request or continue local processing, but it may never infer permission to submit a missing or ambiguous paid request.

The first controlled invocation locks:

- candidate `creative-020`;
- providers `gpt-image-2` and `nano-banana-pro`;
- facade brief `brick-punched-window-v1`;
- priority `implementability-and-multiview`;
- one image-generation request per provider;
- two local grammar/build attempts per provider;
- the same evidence hashes and scoring configuration.

## Evidence Pack

The evidence renderer derives all inputs from the candidate package without provider creativity. The pack includes:

- canonical axon and opposite-axon color-neutral renders;
- orthographic front, right, back, left, and top renders;
- depth, world-normal, silhouette, and edge passes;
- floor-guide overlays;
- stable facade-surface IDs and orientation labels;
- candidate dimensions, storey count, and prohibited envelope changes;
- one compact labelled contact sheet plus machine-readable camera and surface manifests.

The provider-facing images must not include people, landscaping, text labels inside the architectural panels, or decorative backgrounds. The request tells each model to keep the supplied silhouette, height, storey divisions, viewpoint, and component arrangement. The desired facade is an opaque red-brick cladding system with repeated punched windows, deep reveals, restrained precast lintels/sills, coherent corners, and no curtain wall.

Both providers receive equivalent semantic evidence. Provider-specific serialization is allowed only where APIs differ. Raw request fingerprints record all meaningful parameters. Raw output is retained before cropping, normalization, or panel extraction.

## Provider Boundary

Both image adapters implement the same narrow interface:

```text
preflight(config) -> capability and estimated-cost evidence
submit(immutableRequest) -> durable submission record
status(durableRequest) -> normalized pending/succeeded/failed state
download(result) -> raw image artifact
```

Adapters expose no arbitrary provider action surface. They normalize authentication, timeout, response, moderation, and download failures into stable local codes. Credentials, bearer headers, signed URLs, raw provider identifiers, and provider response bodies that may contain secrets are excluded from committed memory and normal CLI output.

Each provider gets one generation submission. Polling and download retries that cannot create another billed generation are permitted within explicit limits. An ambiguous submission is recorded as uncertain and blocks resubmission until manually reconciled. No provider is silently substituted for the other.

The comparison asks each provider for one multi-view facade board at the highest common supported presentation size established during preflight. Raw provider pixels remain authoritative for provider-output evidence; normalized comparison rasters are derived artifacts and never overwrite the originals.

## Facade Grammar Agent

The grammar agent consumes the provider board together with the locked evidence manifest. It emits schema-validated JSON only. The schema describes:

- facade surface groups and adjacency;
- floor-aligned horizontal zones;
- bay origins, spacing, repetition, and allowed residual bays;
- window width, height, sill, head, reveal depth, frame profile, and glazing material;
- brick module, bond direction, mortar appearance, and corner continuation;
- precast lintel, sill, band, parapet, and entrance rules;
- material palette and portable PBR parameters;
- explicit confidence and unresolved regions per surface.

The grammar contains no raw vertex edits, arbitrary scripts, material URLs, file paths, or executable expressions. Numeric fields are clamped by the harness to candidate-derived ranges. Unknown fields fail validation. Low-confidence or contradictory surfaces are rejected rather than filled with an unconstrained guess.

## Deterministic Facade Builder

The builder keeps the canonical MASS node byte- and surface-equivalent and adds a separate `facade-details` hierarchy. It constructs a thin cladding shell outside eligible facade faces. Punched windows are openings in that shell, with inset glazing planes, real reveal side faces, frames, sills, and lintels. This produces visible depth without boolean-cutting or remeshing the canonical MASS.

Brick scale is represented primarily through UV/PBR maps and normal detail rather than one mesh per brick. Major openings, reveals, frames, lintels, sills, parapets, entrances, and corner returns are geometry. Repeated components use shared meshes or GPU-friendly instancing where compatible with GLB delivery.

All placement is computed from facade-local coordinates derived from source positions, surface normals, floor guides, and facade-plane frames. Adjacent surfaces share deterministic corner anchors so the brick datum and precast bands continue around corners. Detail thickness and outward offset are bounded and recorded; no detail may create a new storey, detached building volume, or material component outside the approved shallow-envelope tolerance.

## Harness State Machine and Repair Loop

Each provider follows the same states:

```text
prepared -> submitted -> downloaded -> grammar_v001 -> built_v001
-> validated_v001
   -> accepted
   -> grammar_v002 -> built_v002 -> validated_v002 -> accepted|rejected
```

Only a successful, hash-bound download can enter grammar extraction. Validation failures are mapped to an allowlisted correction vocabulary such as bay-spacing adjustment, floor alignment, opening-size reduction, corner-datum reconciliation, detail-thickness reduction, or material reassignment. `correctGrammar()` is extended to apply only those typed changes.

There is no model-driven free-form code repair. There is no third local attempt. There is no automatic image regeneration. Transport, ambiguous payment, missing evidence, canonical-geometry mismatch, camera mismatch, new-storey detection, invalid GLB, or unrecognized validation failures stop that provider immediately.

## Validation

Hard gates run before any score:

1. All candidate identity, mesh, matrix, camera, floor-guide, facade-plane, evidence, request, grammar, and build hashes form one unbroken chain.
2. The canonical MASS surface signature, indices, bounds, dimensions, component count, transforms, and placement remain unchanged.
3. Added details stay within the shallow facade envelope and remain attached to eligible facade surfaces.
4. Storey count and floor elevations remain unchanged; windows cannot cross protected slab bands.
5. Every required facade orientation receives valid opaque-wall and punched-window treatment.
6. Adjacent faces agree on corner datum, material continuation, and band elevations.
7. GLB structure, materials, textures, color spaces, and resource binding are valid and portable.
8. All eight fixed views render from the same GLB with the required orthographic/perspective policies, stable frames, and zero browser console errors.
9. Front/back/left/right projected silhouettes and extents remain within existing geometry-locked tolerances.
10. The result is visibly non-curtainwall and contains measurable window-reveal depth.

An accepted result is scored only after passing every hard gate:

- 35% deterministic 3D implementability;
- 35% cross-view and corner consistency;
- 20% facade-grammar completeness and coverage;
- 10% visual presentation quality.

The higher score wins. A tie within the configured tolerance remains `human_review`; the harness does not choose by provider name or cost. If only one provider passes, it wins and the other remains a retained rejection. If neither passes, no winner is declared and the current procedural delivery remains untouched.

## Agent Interface

The plugin exposes one production tool, `elevation_3d_facade_agent_run`, over the same harness used by the CLI. Its input is deliberately narrow: candidate and dataset roots, output root, provider selection, facade brief ID, explicit live confirmation, and per-provider spend ceiling. It does not accept arbitrary prompts, shell commands, validation thresholds, retry counts, output paths outside the configured result root, or instructions to replace geometry.

The tool returns redacted run identity, current state, artifact paths, provider request counts, actual or estimated spend, validation summaries, score breakdown, selected provider when one exists, and the exact next authorized action when blocked. A credential means capability only; it never means consent to make a paid call.

## Artifacts and Memory

Every run receives an immutable directory containing:

- locked input and evidence manifests;
- provider-specific redacted request manifests and raw output hashes;
- raw and normalized proposal images;
- grammar v001/v002 and correction records;
- built GLBs and geometry signatures;
- validation reports and fixed eight-view renders;
- comparison scorecard and winner decision;
- durable paid-operation ledger;
- final redacted run summary.

Run memory records that older single-image-to-3D instructions are historical and superseded for production. It also records that Tripo Standard and Extreme were valid technical experiments but did not justify provider geometry or further default spending.

## Error Handling and Safety

- Validate all paths against the configured dataset, memory, and output roots before reading or writing.
- Write state and artifacts atomically; never publish a successful stage before its files and hashes exist.
- Persist `submitting` before a paid request and the provider identifier immediately after receipt.
- Treat process death between those writes as an uncertain paid submission requiring manual reconciliation.
- Enforce independent provider ceilings and a total run ceiling before network access.
- Do not log API keys, authorization headers, signed URLs, raw task IDs, or reusable upload tokens.
- Reject symlink/path traversal and oversized or malformed provider downloads.
- Preserve the last accepted procedural package on every failure.
- Never delete or overwrite prior provider evidence during resume or comparison.

## Test Strategy

Implementation follows test-driven development and adds tests in layers:

1. Schema and contract tests for facade briefs, evidence manifests, provider normalization, grammar output, correction vocabulary, scoring, and CLI exit codes.
2. Fixed provider fixtures for GPT Image 2 and Nano Banana Pro. Unit and integration suites make no external requests.
3. Builder tests proving canonical surface-signature preservation, floor alignment, bounded offsets, attached details, corner continuity, shared repetition geometry, and non-curtainwall openings.
4. Harness tests for state transitions, atomic publication, one-submit enforcement, ambiguous submission recovery, no automatic provider retry, maximum two local attempts, resume, cancellation, and redaction.
5. CLI end-to-end tests executing every subcommand and the composed `run` against local fixtures.
6. Real browser validation of eight views from one GLB, stable frame hashes, camera policy, visible reveal depth, and zero console errors.
7. One explicitly approved live comparison: exactly one GPT Image 2 generation and one Nano Banana Pro generation, followed only by local processing and validation.

The live comparison occurs only after all fixture, build, full-suite, security, and dry-run gates pass and the user explicitly approves the recorded cost ceilings.

## Migration and Compatibility

The existing `elevation_3d_run` procedural path remains operational while the new agent is validated. Shared candidate loading, grammar normalization, enrichment, validation, rendering, delivery, memory, and lifecycle utilities are reused behind clearer interfaces. Legacy Hunyuan/Wan preparation tools and optional Tripo texturing are not removed in this change, but none is called by the new default facade agent.

After the controlled comparison passes, the selected image provider becomes the default visual-design adapter. The other remains an explicit comparison/fallback adapter; it is never invoked automatically after a default-provider failure unless a later approved policy authorizes that paid behavior.

## Acceptance Criteria

- `creative-020` is the sole first comparison candidate.
- The facade is visibly red brick with repeated deep punched windows and restrained precast lintels/sills; it is not a curtain wall.
- GPT Image 2 and Nano Banana Pro receive identical semantic evidence and exactly one generation submission each.
- Both proposals pass through the same grammar schema, local builder, two-attempt maximum, hard gates, renderer, and scoring code.
- The canonical MASS and camera contracts remain unchanged.
- The final detail geometry contains measurable window reveals and coherent corner continuation.
- Every CLI stage is independently executable, hash-bound, resumable where safe, and covered by fixture tests.
- The production agent calls the same harness used by the CLI and cannot bypass cost, retry, validation, or geometry-authority rules.
- Exactly one GLB produces the selected eight-view package with stable browser verification.
- No live request occurs until dry-run evidence and explicit cost approval exist.

## Official Capability References

- OpenAI GPT Image 2: <https://developers.openai.com/api/docs/models/gpt-image-2>
- OpenAI image generation and editing: <https://developers.openai.com/api/docs/guides/image-generation>
- Google Gemini image generation: <https://ai.google.dev/gemini-api/docs/image-generation>
- Google Gemini model catalog: <https://ai.google.dev/gemini-api/docs/models>
