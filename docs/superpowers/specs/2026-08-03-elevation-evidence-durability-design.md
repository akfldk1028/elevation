# Elevation Evidence Durability Design

## Goal

Make the latest retained elevation-3d result independently resolvable after the working tree disappears, without rerunning a provider or moving/deleting the original evidence.

## Durable event contract

Both `arr.elevation3d.run-memory.v2` and `arr.elevation3d.candidate-run-memory.v2` events carry a top-level `artifact_base` machine-local `file:` URI for the run directory. Artifact paths remain slash-normalized and relative to that base. Each version's artifacts carry `drawing_provenance: { path, sha256 }` whenever render checkpoint or validation evidence supplies provenance. Candidate top-level selected artifacts carry the same `drawing_provenance` reference.

The URI is explicitly machine-local rather than portable. It is useful because every event can resolve its own retained artifacts without relying on the repository checkout location.

## Stable copy and manifest

The retained source directory is copied, never moved, to `D:\Data\50_ELE\elevation-3d-e2e-results\creative-013\final-fix-b-round1-20260803-190000`. Before copying, source and destination are resolved to exact absolute paths. A recursive manifest of relative path, byte length, and SHA-256 is computed for the source. If the destination exists, it is accepted only when its manifest is byte-identical; otherwise copying aborts. After copying, the destination manifest must equal the source manifest.

A compact JSON manifest is committed under `evidence/elevation-3d/`; binaries remain external.

## Backfill

A dedicated script receives the memory root, run ID, candidate ID, and stable run directory. It validates safe identifiers, a stable directory containing the referenced files, exactly one matching global event, exactly one matching candidate event, and matching identities. It updates only those rows with the stable `artifact_base`, candidate `run_dir`, and verified `drawing_provenance` path/SHA. Writes use validated same-directory temporary files and atomic rename. A second invocation produces identical bytes.

## Documentation and verification

README documents the stable machine-local evidence path, its non-portable nature, provenance, and committed manifest, and repairs the malformed FAQ heading. Tests exercise real future event persistence and a subprocess backfill rerun. Final verification resolves every retained reference against `artifact_base`, recomputes every SHA-256, runs focused and full tests, builds TypeScript, and checks the diff.

## Safety constraints

- No provider calls or result reruns.
- Do not delete or move the source run.
- Do not overwrite a non-identical destination.
- Keep one global and one candidate event for the retained run.
- Commit no generated binaries.
