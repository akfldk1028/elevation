# LLM Facade Design Agent Design

## Objective

Turn the geometry-locked facade pipeline into a creative but controllable architectural co-designer. The LLM proposes a structured facade program containing an entrance, lobby glazing, window families, bay hierarchy, material zones, and termination details. Deterministic code resolves that program onto authoritative facade segments, builds a new candidate GLB, and rejects geometric or dimensional violations before promotion.

The generated hero image is a visual target, not a source from which geometry is silently inferred.

## Problem and authority boundary

The current workflow locked every opening before presentation generation. That protected geometry, but left only material and lighting variables, so the result became a repeated window grid without a legible entrance or base-middle-top hierarchy.

The corrected boundary is:

- immutable: MASS, footprint, five floor guides, facade planes, roof, camera source contract, safety and path constraints;
- designable proposal: doors, window families, local opening positions, bay rhythm, bounded articulation, material zoning, and entrance emphasis;
- authoritative only after compilation: resolved segment IDs and local bounds, collision results, candidate GLB bytes, technical elevations, and validation receipts.

## Research basis

- CGA shape grammar supplies the split-and-replace model for hierarchical shells and facade detail: [Procedural Modeling of Buildings](https://doi.org/10.1145/1179352.1141931).
- Facade layouts can be represented as compact split grammars rather than unrelated pixels: [Inverse Procedural Modeling of Facade Layouts](https://arxiv.org/abs/1308.0419).
- Empirical studies support controlled articulation and intermediate complexity instead of blank repetition or visual noise: [TU Delft facade complexity study](https://repository.tudelft.nl/record/uuid%3A9b5d8b11-119a-4e5f-a2ee-b525dd23defc) and [Complexity and Order](https://link.springer.com/article/10.5659/AIKAR.2011.13.4.19).
- Recent multimodal CAD work supports structured parametric intent, while deterministic geometry and constraints remain necessary: [CadVLM](https://arxiv.org/abs/2409.17457) and [Text2CAD](https://github.com/SadilKhan/Text2CAD).
- The applicable architecture is image inspiration plus an LLM-authored grammar plus algorithmic validation, not image-only authorship: [AI-Driven Methods in Facade Design](https://www.mdpi.com/2075-5309/16/4/782).

## System architecture

### 1. Verified context builder

`context.mjs` reads only verified candidate, facade-segment, floor-guide, selected-GLB, technical-elevation, and presentation authorities. It emits a bounded `FacadeDesignContext` with:

- source hashes and candidate identity;
- floor elevations and storey intervals;
- each facade segment's ID, local horizontal and vertical intervals, outward normal, length, and visibility score;
- existing openings as editable proposal inputs;
- structural exclusion margins and accepted recess/projection allowances;
- compact thumbnails and evidence hashes for a multimodal model.

It never gives the LLM filesystem access or geometry-write authority.

### 2. LLM design director

`design-agent.mjs` requests exactly one closed `FacadeProgramV2` object. It rejects prose, executable code, mesh bytes, arbitrary paths, and provider-specific fields. The model must establish:

- exactly one legible primary entrance on an eligible ground-floor segment;
- a distinct base, middle, and top;
- two or three reusable window families;
- a bay rhythm with controlled variation;
- a fold/corner treatment compatible with the faceted mass;
- a bounded material palette;
- a rationale used for critique only, never as geometry.

### 3. Closed facade-program contract

`contract.mjs` validates a closed schema. Source authority is injected from verified context after parsing; the LLM cannot choose or rewrite it.

```js
{
  schema_version: "arr.elevation3d.facade-program.v2",
  concept_id: "creative-020-corner-entry-v1",
  source: verifiedSourceAuthority,
  entrance: {
    segment_selector: "primary_visible_ground_segment",
    preferred_bay: "central_or_corner_focus",
    door_family: "recessed_glazed_portal",
    width_m: 1.8,
    height_m: 2.4,
    recess_m: 0.15
  },
  zones: [
    { id: "base", storeys: [1], treatment: "lobby_and_entrance" },
    { id: "middle", storeys: [2, 3, 4], treatment: "a_b_a_window_rhythm" },
    { id: "top", storeys: [5], treatment: "paired_openings_and_cornice" }
  ],
  window_families: [
    { id: "narrow", width_m: 0.9, height_m: 1.8, sill_m: 0.8 },
    { id: "wide", width_m: 1.5, height_m: 1.8, sill_m: 0.8 },
    { id: "lobby", width_m: 1.8, height_m: 2.4, sill_m: 0.0 }
  ],
  bay_rules: [],
  articulation: [],
  materials: [],
  design_rationale: []
}
```

Unknown keys, accessors, unsafe values, excessive arrays, non-finite numbers, invalid hashes, and unrecognized selectors fail closed.

### 4. Deterministic resolver and compiler

`resolver.mjs` converts semantic selectors into exact `segment_id` and segment-local bounds. Eligible segments are ranked by stable visibility, width, and ground-access rules, with stable segment ID as the tie-breaker. It emits typed primitives:

```js
{
  kind: "door",
  segment_id: "facade-segment-003",
  local_bounds: { u_min: 3.1, u_max: 4.9, z_min: 0, z_max: 2.4 },
  depth_m: 0.15,
  family_id: "recessed_glazed_portal"
}
```

`compiler.mjs` extends the existing punched-facade and enrichment modules. It can generate only typed door, window, reveal, lintel, sill, pilaster, band, and cornice primitives. MASS vertices, footprint, floor guides, roof geometry, and source cameras remain immutable.

### 5. Deterministic validation

`validator.mjs` rejects a program before rendering when:

- there is not exactly one primary entrance;
- the entrance is not on storey 1 or has no ground connection;
- openings overlap, cross a fold, enter a floor exclusion band, or leave their segment;
- openings violate edge, mullion, sill, head, or inter-opening clearances;
- a recess or projection exceeds the accepted envelope;
- a family or material palette is unbounded;
- base-middle-top hierarchy is absent;
- MASS, floor count, floor heights, roof, or camera authority changes.

Failures have stable codes and bounded measurements. The LLM gets at most two local correction attempts and can never relax validators.

### 6. Technical render and multimodal critic

An accepted candidate produces the same eight technical views plus a PBR contact sheet and perspective hero. A multimodal critic returns structured scores for entrance legibility, base-middle-top hierarchy, repetition/variation balance, cross-view coherence, material hierarchy, and technical-to-perspective consistency. It may reject or request a grammar correction; it cannot edit geometry or pixels.

### 7. Authority promotion and recovery

Every compiled program becomes a new immutable candidate version; the original GLB remains recoverable. Promotion requires valid program/source hashes, deterministic geometry acceptance, accepted technical elevations, an accepted presentation receipt, and explicit selected-version promotion. Paid calls use the existing integer-micros ledger and crash-safe prepared/returned/succeeded checkpoints.

## Initial architectural concept for creative-020

The first design brief is a contemporary warm-brick building with:

- a strong recessed glazed portal at the most visible ground-level faceted bay;
- adjacent lobby glazing that identifies the base without becoming a curtain wall;
- three window families in an `A-B-A` middle-storey rhythm;
- deeper brick reveals and pale precast lintels/sills;
- vertical brick pilasters reinforcing folds in the star-like mass;
- a restrained band or cornice terminating storey 5;
- no balconies and no change to the five-storey MASS or roof outline.

This is a starting brief, not hard-coded geometry. The LLM may propose alternatives within the schema and deterministic constraints.

## Repository module boundaries

Create `plugins/elevation-3d/lib/facade-agent/design/` with:

- `context.mjs` - verified, bounded model context;
- `contract.mjs` - `FacadeProgramV2` parsing and authority capabilities;
- `prompt.mjs` - versioned research-derived prompts;
- `design-agent.mjs` - provider-neutral LLM orchestration;
- `resolver.mjs` - semantic selectors to exact local coordinates;
- `compiler.mjs` - typed facade primitives and scene integration;
- `validator.mjs` - deterministic architectural/geometric rules;
- `critic.mjs` - structured multimodal review contract;
- `state-store.mjs` - atomic crash-safe proposal state;
- `index.mjs` - narrow public interface.

Expose a standalone opt-in `elevation_3d_facade_design_agent` with `prepare`, `design`, `compile`, `review`, `status`, and `resume`. It defaults to offline preflight. Live LLM/image work requires exact confirmation and uses the existing paid-operation ledger.

## Research-code intake

External repositories go into an ignored research cache, never directly into production. Each intake record stores repository URL, exact commit, license file hash, useful concepts, prohibited dependencies, and an adoption decision.

- `Text2CAD`: CC BY-NC-SA 4.0 and research-oriented; reference its schema and command-sequence concepts, but copy no code into this repository.
- `ifc-bonsai-mcp`: MIT; door/window tool schemas may inform an independent contract, but Blender/IFC runtime dependencies are excluded.
- `Nova3D`: MIT client code may inform prompt-to-procedure separation and named-part hierarchy; its hosted proprietary backend is excluded.
- `CADAM`: GPL-3.0 architecture reference only; copy no code into this repository.
- CGA/CityEngine and inverse-facade supplemental materials: research references only unless an explicit compatible license permits reuse.

Every adopted snippet requires provenance and a compatible license. The default decision is "ideas only, independent implementation."

## Testing strategy

- Contract: malicious objects, unknown keys, invalid hashes, non-finite bounds, and excessive arrays.
- Resolver: deterministic segment selection and exact local bounds.
- Compiler: door/window/reveal output while source MASS and floor guides remain byte/semantic equivalent.
- Validator: overlap, fold crossing, floor intrusion, missing entrance, excessive projection, and missing hierarchy.
- Agent: structured fixture, two-attempt correction cap, and no validator relaxation.
- Ledger/recovery: pre-submit persistence, uncertain submission without replay, and succeeded resume with zero paid calls.
- E2E: one LLM program creates an entrance and varied grammar; one compiled GLB produces accepted technical elevations, axons, contact sheet, and perspective hero.
- Visual review: a readable entrance and reduced monotony without changing MASS or the five-storey authority.

## Success criteria

- The output reads as a designed building, not a repeated-window wrapper.
- A door and entrance hierarchy exist in both 3D and technical elevations.
- Window variation follows a reusable grammar rather than random per-opening edits.
- The LLM controls architectural intent; deterministic code controls coordinates and authority.
- The workflow remains modular, testable, resumable, provider-neutral, and maintainable in `D:/Data/50_ELE/gitagent`.
