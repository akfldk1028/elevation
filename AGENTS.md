# Elevation agent — entry point

Read this before touching anything. `CLAUDE.md` beside it is a 1400-line running log
of how the system got here; it is evidence, not an introduction. This file is the
introduction.

## What this is

Given a **mass** (a GLB of a building volume, authored elsewhere), produce **verified
architectural drawings** of a facade on it: four elevations, plan, roof plan, two axons,
a PBR pass and a perspective hero.

The design step is an LLM writing a **split grammar** — a CGA-lineage rule language.
Everything after it is deterministic local code that refuses what it cannot verify.

    MASS (fixed, authority)  ->  PERSPECTIVE (an image model dresses that exact mass)
                             ->  DRAWING (an author transcribes the picture into grammar)
                             ->  gates -> compile -> render

## 🏛️ Core Principles & Architectural Law (10 절대 원칙)

1. **대지 안착 및 매스 배치 절대 원칙 (The Mass is the Authority)**:
   - 건물의 3D 매스(Mass)는 대지 조건, 용적률, 건폐율, 사선 제한에 의해 사전 확정된 **절대 기준(Authority)**입니다.
   - 에이전트는 매스의 형태를 임의로 변경하거나 제멋대로 생성할 수 없으며, 주어진 매스 표면에 오차 없이 파사드를 입히는(Dressing) 역할만 수행합니다.
2. **도로 소요너비 미달 후퇴 및 모퉁이 가각전제**:
   - **건축법 제46조**: 일반도로 4m 미달 시 중심선 후퇴, 막다른 도로(10m/35m 기준) 폭원 확보, 반대편 경사지/하천 시 반대편 경계선 기준 전폭 후퇴.
   - **시행령 제31조 (가각전제)**: 2~4m 코너 절단.
   - 후퇴 면적은 공부상 대지면적에서 공제한 **'유효 대지면적'**을 기준으로 건폐율(BCR)과 용적률(FAR)을 계산.
3. **최신 정북방향 일조사선 (시행령 제86조)**:
   - 높이 10m 이하 1.5m 이격, 10m 초과 시 건축물 높이의 1/2 이상 이격 ($H \le 2D$).
   - 북측이 도로/공원/하천에 접할 경우 반대편 경계선으로 기산선 이동 완화 반영.
4. **용적률 산정용 연면적 및 지자체 조례 우선**:
   - 지하층 면적과 지상 주차장 면적은 용적률 산정용 연면적에서 엄격히 제외(시행령 제119조 제1항 제4호).
   - 전국 17개 광역시도 조례 상한을 국토계획법령 상한보다 최우선 적용.
5. **층별 건축한계선 (Buildable Envelope)**:
   - 대지경계선 이격 및 층별 일조사선을 슬라이스한 층별 건축한계선을 정확한 수치/좌표로 산출하여 3D 매스 배치에 직접 연동.
6. **공동주택 채광창 및 동간 인동거리**:
   - 채광창 대지경계선 이격거리 $D \ge 0.5H$ (다세대 $0.25H$), 동간 인동거리(남측동 $0.5H$, 측벽 대면 4m/8m) 확보.
7. **토지이용계획확인원(토지이음) 중첩 규제 전수 검토**:
   - 지목 전용, 지구단위계획 지침 최우선, 고도지구 절대높이 캡핑, 방화지구, 경관지구 후퇴, 교육환경 50m 절대보호구역, 공개공지(5~10% 확보 시 1.2배 완화).
8. **LawAgent 24/7 오프라인 무중단 Fallback**:
   - 외부 서비스(8001)나 Neo4j 유무와 무관하게 `src/legal/` 내장 엔진으로 즉시 자동 전환되어 100% 무중단 건축검토 보고서와 3D Envelope 산출.
9. **크로스 AI 공통 동기화 (Single Source of Truth)**:
   - 모든 AI 에이전트(Codex, Claude, Gemini)는 `CLAUDE.md`, `CODEX.md`, `GEMINI.md`, `AGENTS.md`를 단일 진실 원천으로 공유.
10. **형상 일치성 게이트 (Source Fidelity)**:
    - 원본 컨셉과 도면 간 일치성 검증 통과 필수 (`SOURCE_COLOUR_INVENTED`, `SOURCE_VARIATION_LOST` 방지).

---

## 🔄 The 3-Stage Pipeline (Mass ➡️ Concept ➡️ Elevation Dressing)

```
[Step 1: Authority Mass]
  - Fixed 3D Mass: mass.obj / selected.glb
  - Chained Facet Run: 16+ facets unfolded into a 2D coordinate space [0..W, 0..H]
         │
         ▼
[Step 2: Vision Concept Analysis]
  - Concept Image: User idea (--idea) or architectural photo (e.g. The Broad)
  - 4-Point Homography Perspective Rectification: H maps perspective -> ortho plane
  - Neural Foundation Segmentation: SAM 3 (concept prompt) or Grounded-SAM-2 (DINO + SAM 2.1)
  - Lossless Vectorization: VTracer / Douglas-Peucker -> normalized [0..1] curve outlines
         │
         ▼
[Step 3: Parametric Lattice Fitting & Elevation Dressing]
  - Fit: Curve inventory -> ModelSpec (basis_a, basis_b, field attractors, scoop/depth)
  - Apply: Lay ModelSpec onto Mass Facet Run
    * split_by_facets: Boundary clipping clamped via fit_points (strictly 3..33 points)
    * Backing: Wall backing & polygon glass generation
  - Grammar Synthesis: Emits arr.elevation3d.facade-grammar.v3
  - Verification & Render:
    * Deterministic Three.js/WebGL compilation -> enriched.glb
    * 8 Orthographic & Axonometric Technical Views (Front, Back, Left, Right, Plan, Top, Axon, Opposite-Axon)
    * PBR Perspective Hero Render
```

---

## What we are actually trying to do

One sentence: **a picture of a facade, and any mass, come in; a drawing of that facade on that
mass comes out, and a person agrees it is the same building.**

Four things follow from that sentence, and every argument in this repo has been settled by one
of them:

- **The mass is not ours.** It is authored by the mass agent and it is the authority. This
  agent designs the elevation on whatever arrives. It never edits a mass, and the
  `synthetic-*` candidates exist only so the engine can be tested without a design.
- **The picture is the brief, and it must not be closed.** A prompt names the constraint and
  the question — never the style, the palette, the material or a list of elements.
- **A green gate is not the acceptance test.** The gates stop what is unbuildable or
  unreadable; they have passed drawings that no one would hand in, five times. A run is done
  when a person looks at the drawing beside the picture and says it is the same building.
- **Nothing is tuned per building.** Every constant carries the derivation that produced it.
  If a rule only works on one mass, it is not a rule yet.

Since 2026-09-16 the parametric half of this is a **lattice**, not a grammar of splits: a
family (one unit curve + shape modes), a lattice basis, fields over the surface, and
exceptions. `fit` reads that spec off an observed facade; `apply` lays it onto a mass as a
facet run; the cells compile to 3D funnel MODULES standing on a glass box. Spec and plan:
`docs/superpowers/plans/2026-09-16-parametric-lattice.md`.

## How to work here

`memory/elevation-agent/working-rules.md` carries what this file does not: how a round is run.
Choose the mass deliberately (nine authors in a row got the same one, and every elevation came
out stepped); crop a drawing to its own bounds and look at the four edges before reporting it;
one round per sheet; `npm test` alone and one draw at a time, because a killed draw is not a
failed gate; ask the population, never `instances[0]`; and when a gate refuses work you believe
in, check its units before its threshold. Each rule is written with what it cost.

## With this folder alone

Measured on 2026-09-26 by copying exactly what a clone carries (548 files, 19 MB) into an
unrelated directory and running it there. Nothing below is an expectation; each line was run.

**Runs with nothing but this repository** — the three candidate masses are in
`data/datasets/candidates/`, their four run seeds in `output/<candidate>/…` (`prepare` rebuilds
the 37-file evidence pack from them), the sample grammar in `data/sample_grammar.json`:

    cli.mjs roots | prepare <candidate> | brief <candidate>
    cli.mjs check creative-020 data/sample_grammar.json     # accepted, 273 primitives
    cli.mjs draw  creative-020 data/sample_grammar.json x   # eight views + PBR + hero
    cli.mjs fit | apply | lattice                           # python evaluator, in-repo

**Needs one environment variable** — the full test suite. The five finished e2e runs it reads
weigh ~420 MB and are deliberately not here: `ELEVATION_AGENT_FIXTURE_ROOT=/path/to/
elevation-3d-e2e-results`. With it, 951/951. Without it, 890 pass, 15 fail and eleven files stop
at load, each naming what is missing — a clone with no fixture root is red on purpose.

**Needs a download** — only the two neural steps:

| step | what | size | gated |
|---|---|---|---|
| `trace --engine sam3` | the sam3 PACKAGE (`SAM3_PATH`, `vendor/sam3`, …) | 71 MB | no |
| | its weights (`SAM3_CHECKPOINT`) | 3.3 GB | **yes** — request access, `hf auth login` |
| `concept --engine sdxl` | RealVisXL + ControlNet union, fetched automatically | 9 GB | no |

`trace --engine classical` needs neither and is refused on a real photograph at `mask_iou 0.802`
against a floor of 0.90 (tiled SAM 3 scores 0.924) — the gate working, not a broken install.
`checkpoints/README.md` carries the source, size and sha256 of every weight file this project's
drawings were made with.

**Is NOT here, on purpose**: source photographs (this repository is public, so the pictures a
design was read from are supplied locally — their ROI files are tracked and record each image's
sha256); the design corpus of 173 authored grammars and specs (3 MB) and 25 concept images
(53 MB); and ~25 GB of retained renders, which are output and regenerable.

## Where this stands, and what to pick up next (2026-09-26)

The lane runs end to end from a picture, in a copy of this repo, with no closed account in it:

    concept --engine sdxl   local SDXL + ControlNet over the mass's own depth raster
    trace --engine sam3 --tile-size 512
    fit -> apply -> draw    eight views + PBR + hero

Proven twice this week. From a **photograph** (The Broad): 581 apertures at IoU 0.924, fit 536
cells at RMS 0.089 m, 1,969 cells applied with zero faults, drawn. From a **generated concept**:
264 apertures at IoU 0.966, 251 cells at 0.070 m, 2,681 cells, drawn. The photograph is still
the better input — fit inliers 0.821 against 0.315, because a generated field is less regular
than it looks — so the generator's job is to PROPOSE, and proposing is now free.

The open item, and the next task for whoever picks this up:
**`docs/superpowers/plans/2026-09-20-cell-budget-on-a-pleated-mass.md`.** On a mass pleated
finer than the design's own cell (creative-004, 113 facets at 1.76 m), the self-sizing veil
passes every gate and the drawing reads as confetti — 60.4% of it is solid panel — because the
cell cap counts fold PARTS and is spent over all four faces at once. That file carries every
measurement already taken, the acceptance numbers, and the rules. Do not re-derive its table.

Also open, smaller: the crest lines in the 2D export; the parapet sawtooth; the homography
before the fit (the fit has no perspective correction, so a concept must be near-frontal or
assigned a frame); a second real photograph; and the star prism's roof seam, which needs a PALE
veil to clear the seam detector on that mass.

Handing a task to Codex is one line:

    codex exec --cd D:\Data\50_ELE\ElevationAgent --sandbox workspace-write \
      "Read AGENTS.md, then docs/superpowers/plans/2026-09-20-cell-budget-on-a-pleated-mass.md, and do it."

As of 2026-09-24 that account is refused — `codex login status` says logged in and every model
comes back `not supported when using Codex with a ChatGPT account`, which is an entitlement, not
a model name. Re-authenticate with `codex login` before commissioning. Every task here hands to
a Claude subagent unchanged, and image generation is no longer a reason to wait for it.

## What has to be on the machine, and what is in the repo

The repository is self-contained for **running**: the code, the three candidate masses
(`data/datasets/candidates/`), their run seeds (`output/<candidate>/…`), the small grammar
fixtures and the source photograph the fitted Broad spec was read from
(`data/sources/the_broad.jpg`, sha `a0242053856315e2…`, the name its specs record). `roots`
prints where it resolved them; all three land inside the repo.

Three things live outside it on purpose:

- **The finished e2e fixtures** — enriched GLBs and rendered views, ~420 MB across the five
  runs the suite names (one is 302 MB). Point `ELEVATION_AGENT_FIXTURE_ROOT` at the tree
  (here: `D:/Data/50_ELE/elevation-3d-e2e-results`). Measured on a clean copy of what a clone
  carries: **951/951 with it; 890 pass and 15 fail without, and eleven files stop at load**
  because they ask for a fixture path while being imported. Each one says what is missing and
  which variable to set. A clone with no fixture root is red on purpose.
- **The neural stack** — two separate things, and only the first is usually remembered. The
  CHECKPOINTS: SAM 3 (3.3 GB), SAM 2.1, GroundingDINO, under `D:/Data/50_ELE/clone/…`, named by
  `SAM3_CHECKPOINT` / `SAM2_CHECKPOINT` / `GDINO_CHECKPOINT`, also found in a repo-local
  `checkpoints/`. And the PACKAGE: `import sam3` is not a PyPI install, it is Meta's repository
  (71 MB of source), found through `SAM3_PATH`, `<repo>/vendor/sam3`, `<repo>/clone/sam3` or
  `<repo>/../clone/sam3` — on this machine an editable install points at the last of those, which
  is why a copy of this repo anywhere still traced. `trace --engine classical` needs neither, and
  on a real photograph is refused at `mask_iou 0.802` where tiled SAM 3 scores 0.924.
- **The retained runs** — every drawing this project has made, ~25 GB. Output, regenerable;
  the design corpus inside it (173 grammars and specs, 3 MB, plus 25 concept images, 53 MB)
  is the part worth carrying if this repo moves.

## Run it

    npm run facade:perspective -- <candidate> <run-name> --idea "..."  # mass -> generated perspective -> SAM -> grammar -> drawings -> visual correction
    node tools/facade-pipeline/cli.mjs roots                       # where the data lives
    node tools/facade-pipeline/cli.mjs prepare  <candidate>        # mass -> verified context
    node tools/facade-pipeline/cli.mjs brief    <candidate>        # the brief + schema an author answers
    node tools/facade-pipeline/cli.mjs check    <candidate> <grammar.json>
    node tools/facade-pipeline/cli.mjs render   <candidate> <grammar.json> <run-name> --palette competition-material
    node tools/facade-pipeline/cli.mjs concept  <candidate> <name> --idea "..."   # mass -> perspective (codex image lane)
    node tools/facade-pipeline/cli.mjs trace    <candidate> <concept.png> <name> --roi <roi.json> --engine sam3 --tile-size 512  # observed curves -> SVG/DXF
    node tools/facade-pipeline/cli.mjs lattice  <spec.json> <out-dir>   # ModelSpec (family + lattice + fields) -> instances.json + SVG + DXF, one model hash
    node tools/facade-pipeline/cli.mjs fit      <curves.json> <spec.json> # observed cells (a `trace` facade_model.json) -> a fitted ModelSpec + recovery numbers
    node tools/facade-pipeline/cli.mjs apply    <candidate> <base-spec.json> <name> [--scale --pitch --thickness --web --rotate --faces]  # a BASE MODEL onto a mass: facet run, spec, grammar, gates
    node tools/facade-pipeline/cli.mjs prepare  synthetic-box-12x8x6.6  # a box candidate built on the fly, for engine tests that need a mass and not a design
    node tools/facade-pipeline/cli.mjs edit     <facade_model.json> <output-directory> --edits <edits.json>
    node tools/facade-pipeline/cli.mjs cad      <facade_model.json> <output-directory>
    node tools/facade-pipeline/cli.mjs draw     <candidate> <grammar.json> <run-name>   # check + render, one verdict
    node tools/facade-pipeline/cli.mjs photo    <in.png> <out.png> --subject "..."

`concept` reads the storey count, height, facet count and ground contact from the prepared
context and states them as facts to the image model; the `--idea` is the open brief and is
passed through verbatim. It writes `concept-<name>.png` into the run directory. The lane is
the user's Codex CLI; on a quota refusal the error names the limit and the date it lifts.

## The roles

Three roles do the work an engineer cannot do by reading code, and each is a file under
`.claude/agents/` that any agent - Claude Code, Codex, a person - plays by reading it:

| file | plays | reads | must not read |
|---|---|---|---|
| `facade-author.md` | designs a facade from the brief alone (programme-led briefs, and the cheapest test of whether the brief works) | brief, schema, context, mass pictures | `plugins/`, `tools/`, `.superpowers/` |
| `facade-transcriber.md` | turns a concept photograph into a grammar with `source_photograph` set; the standard lane | the photograph, brief, schema, context, mass pictures | the engine |
| `facade-reviewer.md` | says YES / ROUGHLY / NO to "same building?" from a manifest of concept / elevation / hero paths | images only | code, grammars, reports, notes |

The standard automatic perspective-to-drawing lane is `agent` (`facade:perspective`). Its harness and prompts live in
`tools/facade-pipeline/perspective-workflow.mjs` and `workflow-prompts.mjs`. It binds the generated image by hash,
passes the image plus measured SAM observations into v3 transcription, renders all eight technical views and the hero,
and feeds an independent visual review back into transcription. Technical acceptance alone does not finish this lane.
See `tools/facade-pipeline/README.md` for commands, receipts and limitations.

The older `scripts/elevation-3d-facade.mjs` paid harness is a specialized brick/punched-window workflow;
its fixed brick prompts are not the general curved-facade authoring route. The design-only director receives
a mass thumbnail; it is not a perspective transcriber. Do not present either as equivalent to `agent`.

The auxiliary 2D lane is `concept` -> `trace` (explicit ROI, SAM3 or Grounding DINO + SAM2) -> editable curve CAD -> visual review.

**The parametric lane is a LATTICE, not a split** (2026-09-16, spec `docs/superpowers/specs/2026-09-16-parametric-facade-lattice-design.md`,
plan `docs/superpowers/plans/2026-09-16-parametric-lattice.md`). A ModelSpec - a family (piecewise cubic Bezier unit + shape modes),
a lattice (two basis vectors, origin, stagger, edge policy) and fields (constant / linear / grid / point over the host) - is evaluated ONCE,
in Python (`tools/facade-parametric/`), to instances with a model hash. The same instances write the 2D CAD (through `tools/facade-vision`)
and drive the 3D: a grammar terminal carries `lattice: {model_hash, family, instances: "<file>"}` and is drawn once per cell inside its
scope with host (0,0) at the FACET origin (the same origin the SVG/DXF use - the review of 2026-09-16 found it pinned to the
fold-inset scope origin, 0.3 m off the DXF under the same hash), cells clipped at the scope edge, standing aside only from the
floor-band gate and from overlap within one evaluation; the fold and opening-clearance rules hold for a cell as for any hole.
Every command reads a grammar file through `readAuthoredGrammar` (tools/facade-pipeline/lattice.mjs), which inlines the cells.
Node never evaluates a spec, so the hash cannot fork. First proof: `synthetic-box-12x8x6.6/render-lattice-001`,
72 lens cells per 12 m face, eight views + PBR + hero accepted, GLB / instances / DXF on one hash.
Trace does not emit a heuristic 3D grammar; see `tools/facade-vision/README.md` for its schema, parameters and limits.
The authored 3D lane is `prepare` -> `brief` -> `concept` -> `transcriber` -> `draw` -> `reviewer`,
and it loops: the reviewer's list of what a person could still point at goes back to the
transcriber (a defect or an honest limit) or to the engineer (a missing capability). The
reviewer's manifest is a JSON file of relative paths per building - `concept`, `elevation`,
optional `elevation_second_face`, `hero`, and `photographed_faces` in words; the role file
says why that last field exists.

Candidates: `creative-020` (16-facet star prism, 5 storeys), `creative-004` (cleft block,
113 facets, 5 storeys), `creative-013` (bent bar, 37 facets, 3 storeys, a bridge - most of
it does not touch the ground).

Every subcommand prints one JSON object and **exits non-zero on failure**. Do not pipe it
through `tail`; that once masked two failed renders as successes.

Code lives here. Data does not: `elevation-agent.json` declares all three roots -
`dataset_root` (the masses), `output_root` (authored schemes and their drawings) and
`fixture_root` (finished e2e runs the TESTS read fixtures from). Nothing depends on cwd and
**nothing outside that file may name a drive**: nine test files used to have the absolute
path typed into them, which is the eleven-copies problem the config module exists to end.
Tests reach their data through `test/helpers/roots.ts` and name a candidate and a file, never
a path. Override any root with `ELEVATION_AGENT_{DATASET,OUTPUT,FIXTURE}_ROOT`.

    npm test        # 878 tests. Two are load-flaky (a file-lock race, a 287 s e2e);
                    # if one fails, re-run that file alone before believing it.

## The four rules that are not negotiable

1. **The mass is the authority.** Polygons, planes, cameras come from `selected.glb` and
   are byte-canonical. A facade is drawn on it, never edits it.
2. **The LLM authors intent only.** Geometry and views are approved by verifiable code.
3. **The gates stay green.** `test/elevation3d-facade-*`.
4. **The drawing must reflect the perspective.** A run is finished when a person shown the
   photograph and the drawing agrees they are the same building — not when the checks pass.
   Every serious failure here passed every gate. See "How this goes wrong" below.

## The language

    terminals  wall glass door reveal lintel sill band cornice
               pilaster mullion transom spandrel arch louvre
    axes       u  z  storey  layer
    grade      on a terminal: depth_m | inset_m from..to along the run
               on a repeat PART: tile size from..to metres along the run (spacing gradient)
    predicates index/storey == n, % n == m, == last; index/storey < <= > >= n;
               face_offset < <= > >= metres; band ==; face_view ==; param ==
    rise_to    building_top  building_underside  storey_line
               (solids; storey_line also for glass/door, only into a coplanar course
               above - the facet's `continues_above_m` - never across a crease)
    reach      facet_edge
    diagonal   rising  rising_upper  falling  falling_upper
    outline    the member's own shape, [u,v] points in its 0..1 square - a hexagon, a
               rhombus, a circle as a ring of points, a concave slot. One closed loop,
               may not cross itself. Refused on wall and arch and with diagonal.
    outline_far the member's FAR end, when it differs: a funnel, a hood, a scoop. Same
               point count and same winding, because vertex i travels to vertex i.
    standoff_m how far IN FRONT of the wall the member sits, 0..2 - a veil, a brise-
               soleil with air behind it. Refused on an opening and on wall.
    mix        on an alternative, instead of `when`: take it for NONE of the members
               within range_m[0] of a field, ALL past range_m[1], an ordered halftone
               between. How a facade changes CONSTRUCTION across an elevation, since a
               field varies a number and cannot turn a wall into a screen.
    depth_m    SIGNED - positive stands out (bounded per terminal), negative sets in
               (bounded by the wall)
    source_photograph  the file a grammar TRANSCRIBES; then HIERARCHY_MISSING,
               OPENING_RATIO_LOW, PBR_PRESENTATION_RANGE_INVALID, LINE_DENSITY_EXCEEDED (+ its plan twin)
               are recorded as waived, not refused (TRANSCRIPTION_WAIVERS). Null = intent.
    materials  DECLARED, not chosen: substance / lightness / hue / finish / joint_m,
               under a name the author invents. The engine derives colour, roughness,
               metalness, joint family. Nobody writes a hex code.

A rule symbol with a `param` is a named composite - that is the library, and authors grow
their own elements out of it. When something cannot be said, ask whether the PRIMITIVE is
too narrow before adding a word. Four separate author requests turned out to be one missing
sign on `depth_m`.

A parameter may vary with WHERE a member sits, not only with how far along a run it fell.
Declare a place in SPACE - `"fields": [{ "id": "sun", "at": [0.0, -24.0, 8.25] }]`, in the
metres the mass is written in, read off `origin_m` in the context summary -
and a terminal's `grade` names it: `{ "attr": "inset_m", "from": 0.02, "to": 0.30, "field":
"sun", "range_m": [4, 26] }`. That is the parametric operator the literature converged on:
one unit repeated, one parameter driven by distance to a fixed place, so it means the same
thing on every facet and around every corner instead of restarting at each. `field` and
`range_m` come together or not at all. **The coordinate was face metres first and that was
wrong** - `face_offset_m` restarts on every FACE, so one place made four identical ramps on a
four-faced mass; the first outside author proved it and it is a place in space now. Two
shapes to know: a point makes CIRCULAR level sets, so a u-only field wants the point twenty
or thirty metres off the building; and a field varies a NUMBER, not a construction, because a
face is classified punched or skin as a whole. It cannot drive a repeat's TILE SIZE yet and
is refused there rather than dropped; there is one kind of field, a point.

**The pipeline reads the photograph now, and until 2026-09-08 it never did.**
`source_photograph` had eleven uses in this engine and every one spent it turning a gate OFF;
nothing opened the file. So rule 4 above was enforced by nobody but a person, while eight
gates checked a drawing against itself. `source-fidelity.mjs` measures the two pictures on the
same axes and `draw` reports `source_fidelity`: SOURCE_COLOUR_INVENTED (the drawing's boldest
surface is far more saturated than anything in the photograph) and SOURCE_VARIATION_LOST (the
photograph changes markedly along its length and the drawing does not). Checked against three
runs a person had already judged: the one called the same building is clean, the one called
not the same trips both, the one called roughly trips one. Missing/failed source comparisons now reject a claimed transcription; passing these coarse measurements still does not prove geometric fidelity.

## How this goes wrong, every time

**What the lane can be ASKED for is narrower than what an image model can draw.** Measured
2026-09-24, each costing a run, and none of them is about the model:

- The open brief handed to a diffusion model verbatim — *"what facade does a building of this
  shape want?"* — returns a **blank massing model**. It renders a description; it does not
  answer a question. Name the programme; style, palette and material still must not be named.
  (The rule was written for a model that INTERPRETS a commission, and it still holds there.)
- A **front** depth raster of a prism is nearly featureless, so a ControlNet holds nothing and
  the model returns a wall texture with no building in it. Condition on the three-quarter axon.
- The trace reads **cells, not glass**: SAM 3 finds zero apertures in a continuous glazed skin,
  and the lattice fit refuses a sparse punched grid outright — *the inlier cells lie on one
  line; a lattice needs two directions.* What this lane reads back is a dense, doubly periodic
  field. And untiled SAM 3 found 4 apertures where `--tile-size 512` found 581, while the
  fidelity gate scored BOTH well: it measures whether the curves were drawn accurately, never
  whether they were all found.

**A path can be the bug.** A copy of this repo at a 272-character path (Windows stops at 260)
failed every draw with `DIMENSION_SOURCE_MISSING` while the mass, the context and the compiled
GLB matched to the byte. The validator now records `dimension_source_error` beside the code, so
the next one costs a minute rather than an afternoon.

**A green gate is not evidence the drawing is right.** Measured examples from one day:

- 799 primitives "accepted", zero faults, and not one triangle drawn - a new field passed
  the parser, the deriver and the geometry, and a **whitelist** in `punched-facade.mjs`
  dropped it one step before the mesh.
- Every declared window rendered as a flat grey tile for a day - glTF multiplies
  baseColorFactor by baseColorTexture and both carried the tint.
- Five buildings with five declared shells all rendered the same cream, because `wall`
  emits no geometry and a material on it was inert prose.
- An entrance reported missing five times. It was on the back face; only the front
  elevation was ever opened.

So: **query the compiled GLB, and open all four elevations.** `check` validates the design
and never reaches the compiler; only a render exercises the geometry path.

The elevation sheet is a flat fill plus a LINE PASS (`elevation-ink.mjs`), three kinds of
line: a declared material's `joint_m` drawn as its module over its own fill; member edges
wherever the depth raster steps 30 mm or more; and CREASES, where the surface turns 2 degrees
or more with the depth continuous through the turn - a folded panel, a pleat, the arris
between two facets of the mass. The ink footprint persists as `<view>-ink.png` and the seam
detector skips it. A material with `joint_m: null` draws no joint - that is what monolithic
means - so a wall that should show panels needs its module declared.

The crease pass reads its OWN raster, `<view>-normal-flat.png`, flat-shaded. The compiled GLB
carries positions and indices and no normals, so three computes them per vertex and averages
across every triangle sharing one; on a faceted mass that smooths its own folds into ramps
fifteen pixels wide, and a reviewer called the resulting flat grey wall the disqualifying
difference on a building whose every panel is a folded diamond. Two degrees is low because
flat shading has no quantisation floor: one triangle, one normal, one encoded value. It is a
second raster because `<view>-normal.png` has two readers calibrated against its smoothing -
the ink pass's facing cull, and the seam detector's 2-degree coplanarity test - and flat
shading moved both, the second into a false TRIANGULATION_VISIBLE on a drawing that had not
changed by a pixel. **Do not merge the two rasters without re-measuring both readers.**

A RECESSED opening (negative `depth_m`) is a hole. The mass mesh is never cut, so the hole is
cut at render time: the builder emits the pane at the bottom of the recess plus four jamb
faces in the shell material, and the viewer (`holeCut`) subtracts the hole volume from every
mass material per pixel before every render. The PLACED entrance takes the same hole: its
`entrance.recess_m` is a magnitude and `depth_m` is signed, so the resolver negates it. Passed
through unnegated it stood every entrance proud of the wall by its own recess, which two
reviewers named on three buildings before anyone read the sign. Query the compiled GLB and you will find the
pane and the jambs; the hole itself exists only in the rasters.

## Adding a field to the grammar

Five links. The third drops silently what it does not name, and the fourth is the one
`outline` stopped at after clearing the other four:

1. `design/grammar/contract.mjs` - parse, validate, and RETURN it; refuse it where it would
   be ignored (on a split, on `wall`, on `arch`) and where its precondition fails (`scoop_deg`
   needs a recess, `rotate_deg` an outline). If the field is `grade`-able, the grade must
   inherit both the bound AND the refusals, or it becomes the way round them.
2. `design/grammar/derive.mjs` - copy it onto the primitive, conditionally, so older
   grammars stay byte-identical. Through `graded(attr, literal)` if a field may drive it.
3. `punched-facade.mjs`, the `pushDetail` call in the design path - **the whitelist**.
4. **The RENDERER, wherever it rebuilds geometry of its own from a primitive.** Only fields
   it re-derives something from - so far `outline`, `recess_m` and `recess_axis` - and easy to
   miss, because links 1 to 3 make the member itself draw correctly. `holeCut` in
   `web/viewer-app.mjs` built every hole from a fixed list of BOX indices over the four
   deepest vertices of the pane: a lens pane has sixteen, four were picked by depth order, and
   the scoops came out square on a drawing whose own geometry was perfect and whose every gate
   was green.
5. `design/grammar/prompt.mjs` - the emitted schema (and its `required` list, or a strict
   provider 400s) AND the brief prose. A field no author can read about does not exist.

Then check the GLB, not the gate - and regenerate the three briefs, because `brief` writes a
file per candidate and nothing regenerates it when the prompt changes. `check` and `draw`
report `brief_stale` when they differ.

## What a field can drive, and what it can be measured from

Both were one-line answers and both are now sets. Five attributes take a `grade`: `inset_m`,
`depth_m`, `standoff_m`, `scoop_deg`, `rotate_deg` - which is the list the panelization
practice varies (size, depth, rotation, the angle of a cut) with `mix` covering the fifth,
which module appears. Five field KINDS, each a formula:

    point   d = |p - a|
    line    d = |p - (a + s(b-a))|,  s = clamp(((p-a).(b-a))/|b-a|^2, 0, 1)   a segment
    plane   d = (p - a) . n          SIGNED, so one side clamps out and it reads as a horizon
    sun     t = (1 - n_face . s)/2   Lambert, on the facet's own outward normal
    mix     product | min | max | mean of two fields declared above it
    falloff t -> t^k, k in 0.25..4   applied after normalising; k = 2 is inverse-square

A field either carries its own `range_m` and answers 0..1, or takes one from the grade naming
it. Only the first may go inside a `mix`: combining raw metres with a cosine is a category
error, and a point field inside a product saturated one metre from its attractor before the
rule existed.

**To tell a field from a gradient, sample the attribute per FACE.** A gradient ramps along one
run and restarts in the next, so every face comes out identical; a field disagrees with itself
because one term is a property of the face and the other of the place.

## Crossing a fold is a formula, not a tolerance

A member is planar and the mass is not, so carried `d` metres past a seam creased by `theta`
it stands off that course's surface by `e = d sin(theta)`. The admissible reach is therefore
`d_max = 0.03 / sin(theta)`, unbounded when the courses are truly coplanar, and the hard angle
cap falls out rather than being chosen: under 0.15 m of reach, at 11.5 degrees, no continuation
is offered at all. The rule this replaced fixed `theta` at 0.5 degrees, which is the same
formula solved backwards for a FULL STOREY of rise - and fixing the height made it wrong in
both directions at once.

**The pattern to look for:** a bare constant whose comment explains where it came from. Both of
today's were that. Still standing: `fold_clearance_m: 0.3`, `edge_clearance_m: 0.3`,
`SEAM_TOLERANCE_M: 0.02`, the 2048-primitive and 16 MB budgets, `P05 >= 10`, `colorDistance >= 5`.
