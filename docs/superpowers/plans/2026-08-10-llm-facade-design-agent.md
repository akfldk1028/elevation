# LLM Facade Design Agent Implementation Plan

> Design authority: `docs/superpowers/specs/2026-08-10-llm-facade-design-agent-design.md`
>
> Research provenance: `docs/superpowers/research/2026-08-10-facade-design-code-intake.md`

## Goal

Add a standalone, opt-in `elevation_3d_facade_design_agent` that lets an LLM propose architectural facade intent while deterministic modules own segment-local coordinates, geometry, validation, GLB compilation, technical elevations, and authority promotion.

## Guardrails

- Use test-driven development for every task: focused RED, minimal GREEN, regression run, commit.
- Do not call a live provider until the offline fixture E2E is green and the user explicitly confirms the exact provider and maximum cost.
- Preserve MASS, footprint, five floor guides, roof, and source-camera authority.
- Do not copy external research code; implement against this repository's contracts.
- Keep every task independently revertible with its own commit.

## Task 1: FacadeProgramV2 contract

Files:

- create `plugins/elevation-3d/lib/facade-agent/design/contract.mjs`;
- create `test/elevation3d-facade-design-contract.test.ts`.

Implement a closed parser for source authority, entrance, zones, window families, bay rules, articulation, materials, and rationale. Reject accessors, prototypes, unknown keys, invalid hashes, non-finite values, duplicate IDs, oversized arrays, and unsupported selectors. Inject verified source authority after parsing rather than trusting model output.

Verify:

`node --test test/elevation3d-facade-design-contract.test.ts --experimental-strip-types`

Commit: `feat(elevation3d): add facade design program contract`

## Task 2: Verified design context

Files:

- create `plugins/elevation-3d/lib/facade-agent/design/context.mjs`;
- create `test/elevation3d-facade-design-context.test.ts`.

Derive bounded segment, floor, exclusion, source-hash, and thumbnail evidence from already verified authorities. Use `path-safety.mjs` and artifact hashes. Prove that escaped paths, stale hashes, missing segment authority, and unbounded evidence fail before any model callback.

Verify both new tests and `test/elevation3d-facade-agent-presentation.test.ts`.

Commit: `feat(elevation3d): bind facade design context`

## Task 3: Deterministic resolver

Files:

- create `plugins/elevation-3d/lib/facade-agent/design/resolver.mjs`;
- create `test/elevation3d-facade-design-resolver.test.ts`.

Resolve semantic entrance and bay selectors to exact `segment_id` and local `u/z` bounds. Rank eligible segments by stable visibility, width, and ground access, with segment ID as final tie-breaker. Emit only typed door, window, reveal, lintel, sill, pilaster, band, and cornice primitives.

Verify repeatability, fold avoidance, ground-floor entrance placement, and stable ties.

Commit: `feat(elevation3d): resolve facade programs deterministically`

## Task 4: Geometry validator

Files:

- create `plugins/elevation-3d/lib/facade-agent/design/validator.mjs`;
- create `test/elevation3d-facade-design-validator.test.ts`.

Add stable failure codes for entrance count/access, overlap, fold crossing, floor-band intrusion, edge/mullion/sill/head clearance, projection/recess limits, palette/family limits, hierarchy, and immutable-authority changes. Return bounded measurements suitable for at most two model correction attempts.

Commit: `feat(elevation3d): validate facade design geometry`

## Task 5: Compiler integration

Files:

- create `plugins/elevation-3d/lib/facade-agent/design/compiler.mjs`;
- modify `plugins/elevation-3d/lib/facade-agent/punched-facade.mjs` only through a narrow typed-primitive input boundary;
- modify the existing enrichment integration only where required;
- create `test/elevation3d-facade-design-compiler.test.ts`.

Compile the accepted primitives into a new immutable candidate GLB. Record source/program/output hashes and prove source MASS vertices, footprint, floor guides, roof, and camera authority remain unchanged. The original candidate stays recoverable.

Verify the new suite plus `test/elevation3d-punched-facade.test.ts`, `test/elevation3d-enrichment.test.ts`, and `test/elevation3d-texturing-geometry.test.ts`.

Commit: `feat(elevation3d): compile typed facade designs`

## Task 6: Provider-neutral LLM director

Files:

- create `plugins/elevation-3d/lib/facade-agent/design/prompt.mjs`;
- create `plugins/elevation-3d/lib/facade-agent/design/design-agent.mjs`;
- create `test/elevation3d-facade-design-agent.test.ts`;
- reuse the existing grammar provider registry and paid-operation ledger.

Request only `FacadeProgramV2`. Persist prepared authority before submission, bind returned bytes before parsing, never replay an uncertain paid submission, and cap correction at two attempts without validator relaxation.

Commit: `feat(elevation3d): orchestrate llm facade design`

## Task 7: Critic and state machine

Files:

- create `plugins/elevation-3d/lib/facade-agent/design/critic.mjs`;
- create `plugins/elevation-3d/lib/facade-agent/design/state-store.mjs`;
- create `test/elevation3d-facade-design-recovery.test.ts`.

Persist proposal, compiled, rendered, reviewed, succeeded, and failed checkpoints atomically. Bind technical views, PBR contact sheet, perspective hero, source/program/candidate hashes, and structured critic scores. Successful resume performs zero paid calls.

Commit: `feat(elevation3d): persist facade design review state`

## Task 8: Plugin tool and offline E2E

Files:

- create `plugins/elevation-3d/lib/facade-agent/design/index.mjs`;
- modify `plugins/elevation-3d/index.mjs`;
- create `test/elevation3d-facade-design-e2e.test.ts`;
- update `README.md` and the local environment runbook.

Register `elevation_3d_facade_design_agent` with `prepare`, `design`, `compile`, `review`, `status`, and `resume`. Run an offline fixture from verified `creative-020` evidence through one compiled GLB, eight technical views, contact sheet, and perspective hero. Require a visible entrance, base-middle-top hierarchy, and at least two reusable window families.

Verify:

1. all facade-design focused tests serially;
2. existing facade-agent, punched-facade, enrichment, technical-delivery, and presentation suites;
3. `npm test -- --test-concurrency=1`;
4. `npm run build`;
5. `npm audit --audit-level=high`;
6. `git diff --check`;
7. retained output audit with one selected candidate, artifact hashes, zero reparse points, and zero unapproved live calls.

Commit: `feat(elevation3d): expose facade design agent`

## Final review and experiment checkpoint

Perform a read-only code review across authority boundaries, recovery, licensing provenance, and render evidence. Fix confirmed defects with separate RED/GREEN commits. When clean, create an annotated experimental tag without deleting earlier checkpoints.
