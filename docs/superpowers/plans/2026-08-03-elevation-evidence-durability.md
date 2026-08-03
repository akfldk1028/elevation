# Elevation Evidence Durability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make future and retained elevation-3d memory events independently resolve stable, provenance-bound artifacts.

**Architecture:** Persist a machine-local file URI once per event and keep version artifact references relative to it. Use a narrow, validated backfill script for the retained event and a recursively hashed external copy plus committed manifest for durability.

**Tech Stack:** Node.js ESM, `node:fs/promises`, `node:url`, JSONL, SHA-256, Node test runner, PowerShell copy verification.

## Global Constraints

- Never call a provider or rerun elevation generation.
- Copy the retained source; never move or delete it.
- Reject an existing destination unless its recursive manifest is byte-identical.
- Keep exactly one matching event in each memory file.
- Commit metadata only, not result binaries.

---

### Task 1: Future event artifact contract

**Files:**
- Modify: `test/elevation3d-run-memory.test.ts`
- Modify: `plugins/elevation-3d/lib/run-memory.mjs`

**Interfaces:**
- Produces: top-level `artifact_base: string`; version and candidate-top `drawing_provenance: { path: string, sha256: string }`.

- [ ] Add a real append test whose validation includes a provenance file and literal SHA-256 expectation.
- [ ] Run the focused test and confirm the global base and `drawing_provenance` assertions fail.
- [ ] Build the base with `pathToFileURL(resolve(run.dir)).href`, normalize provenance through `artifactEntry`, and add selected candidate provenance.
- [ ] Run `node --test test/elevation3d-run-memory.test.ts --experimental-strip-types` and confirm it passes.

### Task 2: Idempotent retained-event backfill

**Files:**
- Create: `scripts/backfill-elevation3d-evidence-base.mjs`
- Create: `test/elevation3d-evidence-backfill.test.ts`

**Interfaces:**
- Consumes: `ELEVATION3D_MEMORY_ROOT`, `ELEVATION3D_EVIDENCE_RUN_DIR`, `ELEVATION3D_EVIDENCE_RUN_ID`, and `ELEVATION3D_EVIDENCE_CANDIDATE_ID`.
- Produces: atomically updated global and candidate JSONL with stable base and verified provenance.

- [ ] Add a subprocess fixture with one matching event per side and a real provenance file.
- [ ] Assert first run supplies resolvable base/provenance and second run leaves both files byte-identical.
- [ ] Run the test and confirm it fails because the script is absent.
- [ ] Implement identifier/path validation, exact association checks, hash verification, same-directory temp writes, and atomic replacement.
- [ ] Run the focused backfill test and confirm it passes.

### Task 3: Stable copy, retained backfill, and evidence manifest

**Files:**
- Modify: `memory/elevation-3d/unified-runs.jsonl`
- Modify: `memory/elevation-3d/runs/creative-013.jsonl`
- Create: `evidence/elevation-3d/final-fix-b-round1-20260803-190000.manifest.json`

**Interfaces:**
- Stable base: `file:///D:/Data/50_ELE/elevation-3d-e2e-results/creative-013/final-fix-b-round1-20260803-190000/`.

- [ ] Resolve source/destination and compute the sorted source manifest.
- [ ] Copy only when destination is absent; otherwise compare manifests and abort on mismatch.
- [ ] Recompute destination manifest and require exact equality.
- [ ] Run the backfill script twice and require byte identity after the first run.
- [ ] Resolve every retained artifact path and verify every stored SHA-256.

### Task 4: Documentation, report, and final verification

**Files:**
- Modify: `README.md`
- Create: `.superpowers/sdd/2026-08-03-unified-mass-enrichment-agent/final-fix-e-report.md`

**Interfaces:**
- Documents: machine-local evidence location, portability limitation, provenance path/SHA, and manifest.

- [ ] Repair the malformed FAQ heading and add the stable evidence section.
- [ ] Record source/destination manifests, backfill counts, artifact verification, and commands in the report.
- [ ] Run focused tests, `npm test`, `npm run build`, and `git diff --check`.
- [ ] Review the final diff for binaries, source preservation, one event per run, and exact path/hash references.
- [ ] Commit the complete Fix E change set.
