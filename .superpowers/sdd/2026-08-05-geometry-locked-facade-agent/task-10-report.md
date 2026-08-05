# Task 10 Report: Facade-Agent Memory and Full Fixture Story

## Result

Implemented and verified the complete local `creative-020` comparison workflow: two fixture image proposals, two fixture GPT-5.6 grammar extractions, exact-MASS facade construction, real GLB validation, deterministic scoring, one selected GLB, real eight-view browser delivery, immutable status reread, and redacted idempotent memory persistence.

**LIVE CALLS=0 / COST=0.** All provider HTTP responses were fixed local fixtures. The browser verifier allowed only loopback HTTP(S), `data:`, and `blob:` requests and observed zero blocked external requests. No paid provider operation or network-dependent audit was run.

The fixture ledger intentionally exercises accounting with synthetic costs (`$1.28`: GPT image `$0.20`, Nano image `$1.00`, two grammar fixtures `$0.08`). These are test values only; actual external spend was `$0`.

## Exact geometry authority

The real `creative-020` MASS is a 66-triangle closed shell. Its perimeter derives to **16** deterministic facade segments (8 cardinal and 8 oblique), not 12. The original four authored cardinal planes remain the delivery dimension authority; the separate `arr.elevation3d.facade-segments.v1` authority controls facade construction, evidence binding, and validation.

- MASS geometry signature: `86bb271ffc8e951ff75d813c98fdf4742bc5938970ecc30f4d49c291923dabe1`
- Exact base accessor: 35 vertices, 66 triangles
- Segment topology: one outward, MASS-backed closed cycle; reversed, open, disconnected, ambiguous, or missing-ID topology is rejected
- Selected GLB segment count: 16
- Selected GLB detail primitives: 2,560
- Detail counts: brick cladding 640; window reveals 640; glazing 160; precast lintels 160; precast sills 160; corner returns 160

Validation reconstructs every typed primitive from the authoritative segment origin, tangent, normal, and local bounds. When a segment authority is supplied, every detail primitive must carry a known segment ID and the actual ID set must exactly equal the authoritative set. A negative regression proves that omitting all segment metadata is rejected.

## End-to-end fixture evidence

- Test: `test/elevation3d-facade-agent-e2e.test.ts`
- Result: 1/1 passed in 98.2 seconds on the final run
- Image fixture fetches: `gpt-image-2=1`, `nano-banana-pro=1`
- Grammar fixture fetches: 2
- Unexpected fetches: 0
- GPT versions: `v001=rejected`, `v002=accepted`
- Nano versions: `v001=accepted`
- Deterministic winner: `gpt-image-2/v002`
- Selected GLB SHA-256: `d473d4e90cef52d310949512a14c7a0d31f2aa18360d4196ed712ac90f4a2b2e`
- Selected GLB size: 4,513,604 bytes
- Delivery views: 8, all bound to the same selected GLB
- Browser console errors: 0
- Blocked external requests: 0
- Settled frame hashes: identical
- Second CLI `status` read: succeeded with byte/size/mtime/hash tree unchanged

The delivery memory record now comes from the persisted production `run.json`; the E2E test does not inject it as a test-only side channel. Memory artifact paths are run-relative, costs are read through the verified paid-operation ledger, repeated provider operations are summed, and duplicate `run_id` appends are idempotent.

## RED/GREEN evidence

The required initial command was run before implementation:

```text
node --test test/elevation3d-run-memory.test.ts test/elevation3d-facade-agent-e2e.test.ts --experimental-strip-types
15 passed, 2 failed
```

The failures were the missing facade-agent memory writer and the absent final E2E winner. After implementation, the final combined memory/E2E run passed 17/17. The final authority/validation/memory focused set passed 50/50.

## CLI dry preflight and approval gate

The documented canonical-alias dry preflight ran against the real dataset and exited 0:

```text
run_id: creative-020-brick-ab-v1
stage: preflight
status: succeeded
input_sha256: 63cde6b708534b4479228305a9a7b74e8c04202691c3fa5373650865d16a1d78
candidate_sha256: 9f5d7738037caf471c28ec90959c84e65ea9d970b42d8dbcb083ee8b9878e237
image_submissions: gpt-image-2=0, nano-banana-pro=0
```

Only `facade-agent-config.json`, `run.json`, and `stages/preflight.json` were created. No ledger and no provider task were created. Therefore no provider request fingerprint exists at the preflight stop point; fingerprints are created only after evidence and request construction.

Configured estimate/ceiling values were GPT image `$1`, Nano image `$1`, and grammar `$1`, total `$3`. In the absence of separate estimate flags, each estimate equals its ceiling. Credential presence was checked without reading or printing values: `OPENAI_API_KEY=false`, `GEMINI_API_KEY=false`.

A negative approval-gate check supplied live intent but deliberately omitted the exact `$3` cost confirmation. It exited 1 with `BUDGET_INVALID`, created no run directory, and reached no dependency factory or transport. No approval gate was crossed.

## Verification

```text
npm run build
PASS

node --test test/elevation3d-enrichment-validation.test.ts test/elevation3d-run-memory.test.ts test/elevation3d-punched-facade.test.ts --experimental-strip-types
50/50 PASS

node --test test/elevation3d-facade-agent-e2e.test.ts --experimental-strip-types
1/1 PASS

npm test
536/537 PASS; 1 known baseline timing flake

node --test --experimental-strip-types --test-name-pattern="deadline and caller abort remain active while the response body is being consumed" test/elevation3d-facade-agent-providers.test.ts
1/1 PASS

npm audit --offline --audit-level=high
0 vulnerabilities
```

The full-suite failure is the pre-existing response-body deadline/caller-abort timing test. Baseline was already 530/531 with that same failure; the isolated final rerun passed. Offline audit was used instead of the networked command to honor the explicit no-network requirement.

The requested broad secret/TODO scan is not zero-match on the baseline repository because existing provider tests intentionally contain fake `sk-`/Bearer fixtures and provider production code constructs authorization headers. A new-diff scan found only deliberate redaction-test keys (`api_key` and `signedUrl`); no real credential, unfinished marker, or secret value was added.

## Independent review

Independent review initially found five issues: selected-GLB segment binding, delivery persistence, presentation-gate spoofing, browser network isolation, and ledger normalization. All were fixed. The reviewer then found and prompted closure of a zero-segment-ID bypass. Final rereview verdict: **no remaining Critical or Important issues**.

No branch was pushed or merged.
