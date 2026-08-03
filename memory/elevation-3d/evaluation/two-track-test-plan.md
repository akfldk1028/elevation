# Two-Track Test Plan

## Candidate

Start with `creative-004` because its asymmetric enclosure makes directional errors visible. Do not batch all three candidates.

## Phase 0: shared dry run

- verify candidate and artifact hashes;
- convert OBJ to GLB only if conversion preserves coordinates and topology;
- label and size every source image;
- prepare floor-guide overlays;
- produce provider request JSON without secrets;
- estimate calls and cost;
- make zero provider calls.

## Phase 1A: direct texture test

- one Hunyuan3D 3.1 texture request;
- zero automatic retries;
- 2048 texture;
- PBR recorded as an explicit parameter;
- returned model immediately downloaded and quarantined pending verification.

## Phase 1B: view generation test

- one Wan or Qwen request that returns the required view set, or a documented fixed request count if the provider cannot return the set in one response;
- zero automatic retries;
- project results on the original mesh;
- retain per-view coverage and disagreement masks.

## Gates

| Gate | Required |
| --- | --- |
| source manifest integrity | pass |
| vertex coordinate identity | pass for any returned provider mesh |
| topology identity | pass for any returned provider mesh |
| silhouette preservation | pass |
| storey count | pass |
| corner/material continuity | reviewed jointly |
| roof and ground coverage | no critical gaps |
| drawing reproducibility | same inputs produce same camera framing |

## Comparison record

Record latency, actual cost, API errors, geometry status, texture coverage, visual review, result portability, and required manual intervention. The recommended implementation is selected only after both tracks are evaluated under comparable constraints.
