# Facade Router Final Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the final facade-router review with fail-closed billed transports, exact micro-dollar accounting, Seedream/BytePlus defaults, provider-neutral grammar execution, and evidence-backed entrance geometry only if the existing authority can safely express it.

**Architecture:** Money is canonicalized once to integer micro-dollars and remains integer through config allocation, ledger aggregation, and persistence; USD numbers are derived only at adapter/public compatibility boundaries. Every billed POST disables redirects and maps 3xx responses to the existing uncertain-submission category. Canonical defaults are supplied at the CLI/tool boundary, while explicitly supplied legacy routes remain compatible. Production dependencies expose only the selected common grammar adapter, and the harness submits both grammar providers through the same capability-bearing interface.

**Tech Stack:** Node.js 20+ ESM, Node test runner with TypeScript stripping, existing deterministic GLB builder/validator/render pipeline.

## Global Constraints

- No live provider calls.
- Canonical no-selection defaults are one `seedream-5-pro` image at `$0.06`, one `byteplus-seed-mini` grammar extraction at `$0.01`, and exact `$0.07` confirmation.
- Redirects from billed POSTs are never followed.
- Config and ledger arithmetic/persistence use integer micro-dollars; legacy persisted USD records remain readable without unsafe reinterpretation.
- No unselected grammar credential is captured by production dependencies.
- Grammar provider failure remains fail-closed with no fallback.
- A door may ship only when represented by authoritative schema, deterministic geometry, validation receipt, and routed E2E evidence.

---

### Task 1: Redirect-safe billed transports

**Files:**
- Modify: image transport and both grammar adapters.
- Test: image-provider, OpenAI grammar, and BytePlus grammar transport suites.

- [ ] Add regressions whose injected fetch emulates normal redirect following unless `redirect: "error"` is present; assert one request, no second-hop body/authorization exposure, and stable non-definitive submission errors.
- [ ] Run the focused tests and observe the redirect regressions fail.
- [ ] Add redirect rejection to every billed POST and preserve uncertain submission semantics.
- [ ] Run the focused tests green.

### Task 2: Exact micro-dollar configuration and ledger accounting

**Files:**
- Modify: `contract.mjs`, `paid-operation-ledger.mjs`, and their focused tests.

- [ ] Add literal regressions for `$0.35 / 3`, quotient/remainder distribution, repeated operations, exact aggregate ceilings/actuals, confirmations, and legacy ledger/config reads.
- [ ] Run focused tests and observe float-backed fields/allocation fail.
- [ ] Canonicalize budget, estimate, actual, aggregate, and persisted values as safe integer micros; deterministically allocate quotient/remainder; derive USD compatibility views only at boundaries.
- [ ] Run contract, ledger, harness-resume, CLI, and plugin focused tests green.

### Task 3: Canonical CLI and tool defaults

**Files:**
- Modify: CLI/tool input normalization as required.
- Test: CLI script, plugin programmatic tool, and schema/default tests.

- [ ] Add no-selection regressions proving exact Seedream/BytePlus routes, ceilings, and `$0.07` confirmation; retain explicit legacy OpenAI/three-provider cases.
- [ ] Run focused tests and observe current legacy defaults fail.
- [ ] Supply only the canonical defaults when the caller omits selection/budgets.
- [ ] Run focused tests green.

### Task 4: Provider-neutral production grammar execution

**Files:**
- Modify: `production-dependencies.mjs`, `harness.mjs`, `grammar-agent.mjs` only where compatibility boundaries require it.
- Test: production dependency shape/credential isolation and harness common-interface tests.

- [ ] Add regressions proving no `extractGrammar` dependency property/closure, no `OPENAI_API_KEY` access for selected BytePlus, and identical capability-bearing extraction for OpenAI/BytePlus without hardcoded model verification.
- [ ] Run focused tests and observe obsolete closure/provider branch failures.
- [ ] Remove the obsolete production closure/import and route all selected grammar adapters through the common submission interface; keep explicit public OpenAI compatibility exports outside production dependency construction.
- [ ] Run focused tests green.

### Task 5: BytePlus response cleanup and door feasibility

**Files:**
- Modify: BytePlus adapter test/implementation.
- Conditionally modify: facade grammar schema, deterministic builder, validation, fixtures, and routed E2E.

- [ ] Add a response-body cancellation regression for declared length overflow; observe failure, implement cancellation, and verify green.
- [ ] Trace door intent through schema, segment authority, builder, validation receipt, and GLB evidence.
- [ ] If the primitive can be bounded without weakening authority, add failing schema/build/validation/E2E tests and implement it; otherwise document the exact structural conflict and retain intent-only labeling.
- [ ] Retain one fresh offline E2E artifact if routed geometry changes.

### Task 6: Full verification and handoff

**Files:**
- Append: `.superpowers/sdd/2026-08-06-facade-provider-router/task-7-report.md` or create the requested hardening report.

- [ ] Run all amended focused suites.
- [ ] Run `npm test`, `npm run build`, `npm audit --audit-level=high`, and `git diff --check`.
- [ ] Self-review persisted compatibility, secret isolation, redirect behavior, integer arithmetic, and artifact evidence.
- [ ] Commit all intended changes and report commits/tests/artifacts/concerns.
