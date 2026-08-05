# Final Hardening Report

## Scope and safety

Base commit: `4b4dfd507b409b8c76b25b042e802e8870f2fc40`.

This pass addressed the five blocking durability and budget findings without changing the approved `creative-020` geometry pipeline. All provider behavior was exercised with local fixtures or non-network preflight capability checks. **Live calls: 0. Actual external cost: USD 0.** The ledger's USD 1.28 E2E total is synthetic fixture accounting only.

## Findings closed

1. **Run-wide budget enforcement.** The grammar ceiling is deterministically divided across both providers. Image and grammar work must use the same ledger, which reserves against per-call, per-kind, and whole-run ceilings before invoking a callback and verifies actual cost afterward. Run manifests, preflight receipts, status verification, and memory preserve the exact ceiling allocation and aggregate totals.
2. **Canonical grammar recovery.** A persisted grammar is accepted on resume only after canonical bytes and all provider, proposal, evidence, candidate, geometry-content, winding, segment, camera, floor-guide, and facade-length bindings are reverified. Only then is its in-memory authority restored.
3. **Durable validation and scoring recovery.** Completed validation and score receipts can resume without replaying expensive local work. Their artifact, grammar/correction, validation-authority, provider/candidate, and scoring-formula bindings are reverified before capability rehydration. A returned operation without a durable receipt remains uncertain and fail-closed; ambiguous delivery is never replayed.
4. **Auditable v002 repair.** Each local retry writes canonical `grammar-v002.json` and `correction-v002.json` records with exact input/output hashes, allowed changed fields, correction codes, and geometry/evidence authority bindings. Missing or modified records reject before a v002 build.
5. **Real zero-network preflight.** Dry preflight builds the actual evidence bundle and canonical provider requests, computes their fingerprints, performs explicit non-network capability/credential checks, redacts capability results, and writes a hash-bound receipt. It does not invoke fetch, a provider callback, or the paid ledger.

An additional fail-closed guard requires a single shared aggregate ledger before the first paid operation, and configured image estimates are now validated as finite, nonnegative, and no greater than their provider ceilings.

## Strict RED/GREEN evidence

- Aggregate grammar test first demonstrated that two individually valid grammar calls could exceed the run ceiling; the implementation then blocked the second callback and preserved exact per-kind/run totals.
- Grammar authority tests first showed that parsed canonical JSON lacked trusted runtime authority; rehydration now succeeds only for exact bound bytes and rejects tampering.
- Crash tests first showed completed validation/score work could not resume; durable receipts now skip those callbacks, while returned-before-receipt cases remain blocked.
- v002 tests first showed the correction was not independently auditable; canonical grammar/correction files are now required and tamper checked.
- Preflight tests first showed it did not exercise production request construction or capabilities; it now does both without network access.
- The final shared-ledger regression first reached the pipeline without an aggregate grammar ledger; it now rejects with `FACADE_LEDGER_AGGREGATE_UNAVAILABLE` before any paid callback.
- The image-estimate regression first accepted an over-ceiling/NaN estimate; normalization now rejects both.

## Production-shaped E2E evidence

- Exact MASS facade segments: 16 (8 cardinal, 8 oblique)
- Typed detail primitives: 2,560 (brick 640, reveals 640, glazing 160, lintels 160, sills 160, corner returns 160)
- Provider requests: GPT image 1, Nano image 1, grammar 2, unexpected 0
- Selected artifact: `gpt-image-2/v002`
- Selected GLB: `5d593b4b69e7d1409bae8a6b3ca9223de2252a772556d19890314dd59f2d7463`, 4,400,084 bytes
- Delivery: 8 views, 0 blocked external requests
- Synthetic accounting: USD 1.28 total (images USD 1.20, grammar USD 0.08)

## Final verification

- `npm run build`: PASS.
- `npm audit --offline --audit-level=high`: PASS, 0 vulnerabilities.
- Final focused facade-agent contract/ledger/grammar/harness/CLI/score/validation/memory/plugin set: 136/136 PASS; the contract and harness suites include the final narrow hardening regressions.
- Production-shaped E2E: 1/1 PASS; it also passed inside both subsequent full-suite runs.
- `npm test`, run twice: 546/547 and 545/547. Both runs reproduced the pre-existing response-body deadline timing flake under parallel load; the second also exposed an unrelated cross-process texturing-ledger scheduling race. The exact deadline test passed 1/1 in isolation, and the exact texturing-ledger test passed 1/1 in isolation. Neither failing file is part of this diff.
- `git diff --check`: PASS. The changed-diff scan contains only deliberate fake/redaction-test credential strings; no real credential or unfinished marker was added.
- Independent rereview: APPROVED, with no remaining Critical/Important issue in the five blocking areas.
- Integration: one scoped local commit; no push, merge, squash, or worktree cleanup.
