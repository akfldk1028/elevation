# Elevation 3D Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give this GitAgent a cost-gated two-provider workflow that produces geometry-locked architectural 3D previews and drawings from the MAAS test set.

**Architecture:** A local programmatic plugin validates the immutable input package, freezes an agent-authored facade brief into an approval hash, submits Hunyuan and Wan jobs once, resumes them by saved IDs, verifies returned geometry, and builds a static Three.js result bundle. Provider clients are isolated behind request builders and injectable adapters so automated tests never make paid calls.

**Tech Stack:** Node.js 22, GitAgent plugin SDK, Tencent AI3D/COS SDKs, Alibaba Model Studio HTTP API, Sharp, glTF Transform, Three.js, esbuild, Puppeteer Core, node:test.

## Global Constraints

- Source geometry, topology, storey count, camera matrices, and artifact hashes are immutable.
- Live generation requires exact approval ID, `confirm_live=true`, and a CNY cap of at least 6.10.
- Exactly one Hunyuan and one Wan submission; zero automatic retries.
- Secrets, Base64 inputs, signed queries, and expiring result URLs are never persisted.
- Strategy B is labelled `view-dependent-projection`, not portable GLB.

---

### Task 1: Input and approval contract

- [x] Test the real creative-004 manifest, tamper rejection, stable plan hash, cost gate, and secret redaction.
- [x] Implement candidate loading, SHA-256 verification, prompt derivation, immutable plan files, and approval checks.

### Task 2: Provider contracts and resumable execution

- [x] Test Hunyuan/Wan request and status normalization without network calls.
- [x] Implement Tencent COS/AI3D and Alibaba async clients.
- [x] Test and implement submit-once state with polling-only resume.

### Task 3: Geometry and web results

- [x] Test canonical geometry equivalence with UV-seam duplicates and mutation failures.
- [x] Implement OBJ/GLB parsing, geometry quarantine, result download, Three.js bundling, and Chrome drawing capture.

### Task 4: GitAgent integration and acceptance

- [x] Register prepare, generate, resume, and preview tools with agent prompt guidance.
- [x] Run the real creative-004 dry-run, all unit tests, TypeScript build, and plugin loading smoke test.
- [x] Review diffs for secrets, placeholders, generated binaries, and out-of-scope changes; commit the verified feature.
