# Generative Facade Hero Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce one geometry-faithful, warm-daylight architectural perspective hero PNG from the verified axon render and leave a complete durable handoff for a context-free future AI session.

**Architecture:** The retained axon PNG is the edit target; the contact sheet and front orthographic PNG are supporting identity references. GPT image generation may change only photographic presentation. The result is stored in a sibling generative root, visually checked against locked geometry, hash-manifested, and documented in repository memory without modifying the retained evidence tree.

**Tech Stack:** Built-in `image_gen` editing, local `view_image`, PowerShell SHA-256/file verification, Markdown handoff, JSON provenance manifest.

## Global Constraints

- The selected GLB and technical elevations remain the only geometry and dimension authority.
- Preserve the existing axon camera side, perspective direction, silhouette, mass, floor count, roof outline, facade bays, window count, window positions, and opening proportions.
- Do not add balconies, doors, windows, canopies, signs, rooftop equipment, adjacent buildings, or invented architecture.
- Generation may improve only materials, glazing, daylight, shadows, landscaping, atmosphere, and photographic presentation.
- No text, logo, watermark, border, or annotation appears in the hero image.
- The immutable retained root `D:/Data/50_ELE/facade-agent-verification/unified-facade-render-elevation-20260810` remains byte-untouched and at 212 files.
- Save output only under `D:/Data/50_ELE/facade-agent-verification/generative-facade-presentation-20260810`.
- Generated imagery is proposal intent, never geometry authority.

---

### Task 1: Durable context-free AI handoff

**Files:**
- Create: `memory/elevation-3d/generative-facade-handoff.md`
- Read: `docs/superpowers/specs/2026-08-10-generative-facade-hero-design.md`

**Interfaces:**
- Consumes the approved design and the three retained reference PNGs.
- Produces one self-contained entrypoint that a new AI session can follow without conversation history.

- [ ] **Step 1: Verify immutable reference files and hashes**

Use these exact inputs:

```text
Primary edit target:
D:/Data/50_ELE/facade-agent-verification/unified-facade-render-elevation-20260810/output/creative-020/seedream-byteplus-offline-fixture-v1/final-presentation/views/axon/axon.png
SHA-256 3883ead16dafdd23919c03de63ec81d64cbafed0be382c6ba290d7263a53e72a

Supporting contact sheet:
D:/Data/50_ELE/facade-agent-verification/unified-facade-render-elevation-20260810/output/creative-020/seedream-byteplus-offline-fixture-v1/final-presentation/contact-sheet.png
SHA-256 f5c18b785446913161a9622a3f8d345f5e600209a079f111b3c5d9ad119eedfe

Supporting front reference:
D:/Data/50_ELE/facade-agent-verification/unified-facade-render-elevation-20260810/output/creative-020/seedream-byteplus-offline-fixture-v1/final-presentation/views/front/front.png
SHA-256 c006ce57366e4413018537db32d39d9f1bbf9fd13369c426179987dbe4ace482
```

Run `Get-FileHash -Algorithm SHA256` for all three and stop if any value differs.

- [ ] **Step 2: Write the handoff**

The handoff must include:

- project goal: beautiful photoreal facade render first, technical elevations remain downstream authority;
- the three absolute input paths and hashes above, with roles `edit target`, `identity grid`, and `orthographic identity`;
- the exact generation prompt copied verbatim from `docs/superpowers/specs/2026-08-10-generative-facade-hero-design.md` section `Exact image-generation prompt`;
- every Global Constraint verbatim;
- output root, filename, manifest path, and validation checklist;
- continuation rule: inspect existing manifest/output first; never regenerate or overwrite an accepted image automatically;
- failure rule: reject invented geometry even when visually attractive.

- [ ] **Step 3: Check the handoff for completeness**

Run:

```powershell
$handoff='memory/elevation-3d/generative-facade-handoff.md'
Select-String -Path $handoff -Pattern 'TBD|TODO|PLACEHOLDER'
```

Expected: no matches. Confirm all three hashes, the output root, the exact prompt, and the geometry rejection rule occur in the file.

- [ ] **Step 4: Commit**

```powershell
git add memory/elevation-3d/generative-facade-handoff.md
git commit -m "docs(elevation3d): add generative facade handoff"
```

---

### Task 2: Generate the warm-daylight perspective hero

**Files:**
- Read: the three retained PNGs from Task 1.
- Create outside Git: `D:/Data/50_ELE/facade-agent-verification/generative-facade-presentation-20260810/hero-perspective-v1.png`

**Interfaces:**
- Consumes the exact hashed references from Task 1.
- Produces one non-authoritative PNG candidate for Task 3 review.

- [ ] **Step 1: Inspect the primary edit target**

Open `axon.png` with `view_image` at original detail. Count five storeys, confirm the star-like roof/plan outline, repeated vertical bays, and the visible left/right facade faces before generation.

- [ ] **Step 2: Run built-in image generation/editing**

Call `image_gen` with `referenced_image_paths` containing the three absolute paths in Task 1, in that order, and this exact prompt:

```text
Use case: sketch-to-render
Asset type: high-end architectural competition hero perspective
Input images: Image 1 is the authoritative edit target and fixes the camera, silhouette, mass, storey count, roof outline, facade bays, and every window/opening; Image 2 is the eight-view identity grid; Image 3 is the orthographic front identity reference.
Primary request: transform Image 1 into a polished photoreal architectural visualization of exactly the same building. Preserve its existing three-quarter perspective and corrected architectural verticals.
Scene/backdrop: restrained premium urban forecourt with light stone paving, sparse low planting, a clean bright sky, and only a few small people for scale; do not obscure the facade.
Subject: the exact five-storey faceted building from Image 1, unchanged in geometry and opening layout.
Style/medium: competition-winning professional architectural photography, realistic rather than illustrative.
Lighting/mood: warm natural daytime sunlight, soft directional shadows, realistic global illumination, inviting and calm.
Color palette: retain the existing deep warm red facade identity with refined brick and masonry tonal variation; pale stone accents; neutral glazing.
Materials/textures: tactile premium brick or masonry, crisp restrained frames and lintels, physically plausible glass reflections and interior depth, subtle weathering only.
Composition/framing: keep the same camera side and perspective direction as Image 1, show the complete building and its grounding with comfortable margins, no crop.
Constraints: preserve exactly the silhouette, mass, five storeys, roof outline, facade divisions, window count, window positions, opening sizes and proportions. Change only material realism, glazing, light, shadows, landscaping, atmosphere, and photographic finish.
Avoid: added or removed windows, doors, balconies, canopies, signs, rooftop equipment, adjacent buildings, changed roof or mass, warped verticals, fantasy styling, dramatic dusk, excessive vegetation, cars blocking the building, text, logo, watermark, border, annotations.
```

- [ ] **Step 3: Save non-destructively**

Create the exact sibling output directory with `New-Item -ItemType Directory -Force`. Copy the generated output reported by the built-in tool to `hero-perspective-v1.png`. If that file already exists, stop and inspect its manifest; never overwrite it.

- [ ] **Step 4: Verify the bitmap exists**

Run `Get-Item` and `Get-FileHash -Algorithm SHA256`. Require a nonzero file size and record the lowercase SHA-256 for Task 4.

---

### Task 3: Geometry-faithful visual acceptance

**Files:**
- Read: primary `axon.png` and generated `hero-perspective-v1.png`.
- Optionally create outside Git: `hero-perspective-v2.png` only if one targeted correction is necessary.

**Interfaces:**
- Consumes the first generated candidate.
- Produces one accepted version path or a fail-closed rejection report.

- [ ] **Step 1: Inspect source and candidate at original detail**

Open both with `view_image`. Compare:

- complete silhouette and star-like roof outline;
- five storeys;
- visible facade-face count and perspective direction;
- vertical bay divisions;
- window count, row count, placement, size, and proportions;
- no invented doors, balconies, canopies, signs, or roof equipment;
- building fully visible with grounding and margins;
- no text, logo, watermark, or annotations.

- [ ] **Step 2: Judge presentation improvement**

Require materially improved brick/masonry texture, glazing depth/reflection, warm daylight, contact shadows, believable paving/planting, and professional architectural-photography finish.

- [ ] **Step 3: Apply at most one targeted correction if needed**

If and only if the candidate fails one localized presentation or geometry item, invoke `image_gen` once more using the candidate and all original references, repeat every invariant, and request only that correction. Save it as `hero-perspective-v2.png`; never overwrite v1. If geometry still drifts, reject and stop rather than iterating into a different building.

- [ ] **Step 4: Select the accepted version**

Record `hero-perspective-v1.png` or `hero-perspective-v2.png`. If neither passes, record `status: rejected` and do not claim completion.

---

### Task 4: Provenance manifest, memory, and handoff verification

**Files:**
- Create outside Git: `D:/Data/50_ELE/facade-agent-verification/generative-facade-presentation-20260810/generation-manifest.json`
- Modify: `memory/elevation-3d/generative-facade-handoff.md`
- Modify: `memory/elevation-3d/README.md`

**Interfaces:**
- Consumes the accepted output, its SHA-256, the exact prompt, and source hashes.
- Produces durable provenance and a next-session resume point.

- [ ] **Step 1: Write the manifest**

Write valid JSON with schema `generative-facade-presentation.v1`, status `accepted` or `rejected`, generation mode `built-in-image-gen`, the three source `{ role, path, sha256 }` objects, exact prompt text, selected output `{ path, sha256 }` when accepted, the full geometry-lock checklist as booleans, and `authoritative_geometry: false`.

- [ ] **Step 2: Verify manifest and output**

Parse the manifest with `ConvertFrom-Json`. Rehash every source and the selected output and require exact equality. Recount the immutable retained root and require exactly 212 files; confirm the new sibling output root is not beneath it.

- [ ] **Step 3: Update memory and handoff**

Record the generation status, selected version/path/hash, source hashes, prompt identity, visual acceptance result, retained-root 212-file preservation, and non-authoritative rule. Put the next action at the top of the handoff: either use the accepted hero as presentation reference for the front orthographic generative pass, or fix the named rejection without changing geometry.

- [ ] **Step 4: Verify repository and commit**

```powershell
git diff --check
git status --short --branch
git add memory/elevation-3d/README.md memory/elevation-3d/generative-facade-handoff.md
git commit -m "docs(elevation3d): record generative facade hero"
```

- [ ] **Step 5: Independent visual/code review**

Review the manifest, handoff, memory diff, input/output hashes, and both images. Reject any mismatch between documented and actual files, any overwrite of retained evidence, or any invented architecture. The final report must state the exact saved PNG path and whether the candidate is visually accepted.
