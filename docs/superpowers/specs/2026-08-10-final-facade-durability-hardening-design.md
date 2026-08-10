# Final Facade Durability Hardening Design

## Goal

Close the three load-bearing residuals from the scoped final re-review without changing facade geometry, presentation style, validation thresholds, provider behavior, or paid-call semantics.

## Scope

This pass covers only:

1. deterministic server/browser geometry-bounds parity for exact camera authority;
2. single-read content-addressed JSON verification;
3. zero-call recovery from a crash after durable presentation-receipt publication but before run-state success publication.

The untouched legacy `results.mjs` drawing/finalization junction paths remain a separate hardening scope.

## Architecture

### Geometry-bounds parity

Define one canonical bounds contract over the selected GLB's rendered geometry. It must account for node transforms, indexed primitives, and every rendered `POSITION` accessor exactly once. Node-side authority derivation and the browser viewer must produce the same finite min/max/center/radius values from those semantics.

Technical and presentation camera verification continues to derive deterministic fitted cameras from candidate authority plus canonical selected-GLB bounds. A valid transformed/indexed GLB must not fail because one runtime uses local accessor bounds while the other uses transformed vertices. A coherent camera or bounds mutation must still fail closed.

### Single-read JSON closure

Every content-addressed JSON leaf is read once into immutable bytes. The verifier computes SHA-256 and parses JSON from that same byte buffer. It must never hash one read and parse a second read.

Containment and reparse checks remain before the read. Invalid JSON, hash mismatch, or semantic mismatch fails closed. Tests use a controlled replacement hook to prove that a second filesystem read cannot influence parsed authority.

### Post-receipt crash recovery

The presentation receipt path is deterministic and authority-bound. Resume logic may discover an orphan receipt only when persisted execution is exactly the matching `returned` checkpoint and the normal receipt reference/succeeded state is absent.

Recovery revalidates provider, candidate, selected version, selected GLB, technical delivery, artifact closure, and receipt bytes. A valid orphan receipt is attached and finalized with zero provider, renderer, build, validation, score, or delivery calls. Missing, mismatched, tampered, `prepared`, `rendering`, failed, or uncertain state never adopts an orphan receipt.

Lifecycle notification failures after receipt publication cannot downgrade durable success or trigger replay.

## Data flow

1. Derive canonical selected-GLB bounds in Node and browser using identical geometry semantics.
2. Derive and verify fitted camera authority from candidate input plus canonical bounds.
3. Publish all presentation artifacts and the content-addressed closure.
4. Write the deterministic presentation receipt.
5. Persist the receipt reference and succeeded execution state, then finalize the winner.
6. On resume from the narrow returned checkpoint, discover and fully verify the deterministic receipt before zero-call finalization.

## Failure handling

- Bounds disagreement rejects delivery before winner publication.
- JSON bytes are authoritative for both hash and parse; concurrent replacement cannot self-bless semantics.
- An invalid orphan receipt fails closed and is never deleted, overwritten, or replayed automatically.
- A valid orphan receipt is adopted only for the exact provider/candidate/version/GLB authority.
- Paid image and grammar operations remain one-shot and are never involved in this recovery path.

## Testing

- A transformed indexed GLB with unused and referenced `POSITION` accessors produces identical Node/browser bounds and accepted cameras.
- A coherent wrong camera or transformed-bounds mutation is rejected.
- A JSON verifier test proves one physical read supplies both SHA-256 and parsing.
- Hash mismatch, invalid JSON, and semantic tamper remain rejected.
- A crash immediately after receipt persistence resumes to `winner` with all upstream/local-render counters at zero.
- Wrong provider, candidate, version, GLB, closure, receipt hash, or execution checkpoint rejects orphan adoption.
- Focused presentation/harness/unified-flow suites, retained offline E2E, full serial tests, build, audit, and diff check pass.

## Acceptance criteria

- The three scoped re-review blockers are independently reproduced RED and verified GREEN.
- Exact camera authority accepts valid transformed/indexed geometry and rejects coherent mutations.
- Content-addressed JSON is hashed and parsed from one immutable read.
- The post-receipt/pre-state crash is zero-call recoverable without broadening any other retry state.
- Selected GLB bytes, PBR style, facade geometry, four orthographic elevations, no-door policy, and zero-live-call evidence remain unchanged.
