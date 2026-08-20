# LLM Facade Design Agent v1 handoff

다음 세션은 아래 위치와 흐름만 그대로 이어가면 됩니다.

작업트리:

- `D:\Data\50_ELE\gitagent\.worktrees\geometry-locked-facade-agent`
- 브랜치: `llm-facade-design-agent-v1`

현재 상태 요약:

- `llm-facade-design-agent-v1`는 현재 수정 중인 작업 상태입니다.
- 변경된 핵심 코어는 `plugins/elevation-3d/lib/facade-agent/design/` (compiler/director/resolver/validator/state/context/index 등)와 `plugins/elevation-3d/lib/punched-facade.mjs`.
- E2E 기준 성공 산출물은 `D:\Data\50_ELE\facade-agent-verification\llm-facade-design-agent-20260810\creative-020\llm-facade-v5` 입니다.
- 현재 v5는 `succeeded`, 재실행 재개(resume) 시 모델 호출/실서비스 호출이 0회입니다.
- 입면/투시 일관성은 `llm-facade-v5`의 `technical-render`, `pbr-render`, `perspective-hero.png`를 기준으로 유지해야 합니다.

다음 시작 명령:

1. `Set-Location D:\Data\50_ELE\gitagent\.worktrees\geometry-locked-facade-agent`
2. `git checkout llm-facade-design-agent-v1`
3. `git status --short`
4. 필요한 경우 상태별 테스트:
   - 디자인 E2E: `npm test -- --test-concurrency=1 test/elevation3d-facade-design-e2e.test.ts --experimental-strip-types`
   - 컴파일러/플러그인: `npm test -- --test-concurrency=1 test/elevation3d-facade-design-compiler.test.ts test/elevation3d-plugin.test.ts --experimental-strip-types`

핵심 제약(변경 전 확인):

- 핵심 폴리곤과 평면/카메라/아티팩트 권한은 `selected.glb` 기반에서 고정됩니다.
- LLM은 설계 의도만 생성하며, 최종 기하/뷰는 검증 가능한 코드 경로로만 승인되어야 합니다.
- 문/창문/입면 변화는 `facade-agent/design` 모듈들(`contract`, `resolver`, `validator`, `punched-facade`)로 반영하고, 렌더/검증 게이트(`test/elevation3d-facade-design-*`)는 항상 통과 상태 유지해야 합니다.

참조 대상:

- 스펙: `docs/superpowers/specs/2026-08-10-llm-facade-design-agent-design.md`
- 플랜: `docs/superpowers/plans/2026-08-10-llm-facade-design-agent.md`
- 결과 메모: `memory/elevation-3d/README.md`의 `LLM facade design agent v1 retained result` 섹션
- 오프라인 실제 실행 스크립트(참고): `.superpowers/sdd/2026-08-10-llm-facade-design-agent/run-real-e2e.mjs` (ignored)

## 2026-08-14 live grammar status

The model now authors an accepted facade grammar. Run
`llm-facade-live-v6` (creative-020), attempt-01: parse, derive and
validate all clean, no warnings - 368 primitives, 46 windows, 32
pilasters, 290 bands, openings on 5 of 5 storeys, and all four
elevations different (front 162, back 102, left/right 52 each).

The run then dies in `renderAllViews`: the **plan** view at the 1.2 m cut
fails `TRIANGULATION_VISIBLE`
(`technical-render/views/plan/plan-validation.json`). The gate is
same-material seam detection in `elevation-presentation-validation.mjs:385`
- 290 bands abutting the wall in the same material read as coplanar
seams. Elevations and PBR never render, so there is still no elevation
PNG from a live grammar.

The grammar is already in the ledger, so re-running v6 after fixing the
plan costs nothing and makes no model call. That is the next step.

Six live runs, eighteen grammars. Five faults were mine (model pin,
strict schema shape, reasoning multi-output, null-vs-absent twice, a
32-symbol cap below what the grammar needed, first-hole-only reporting)
and one was the correction loop reauthoring instead of repairing.

## 2026-08-14 the elevations render, and they still read as an apartment

All four elevations of v6 rendered and passed presentation validation.
Only the plan is rejected. They are at
`llm-facade-live-v6/technical-render/views/<view>/competition-elevation/<view>/<view>.png`.

The user's read was right: byte-different from v5/v24, architecturally the
same. Reference reading named the device - alternating opening sizes
storey by storey is *pseudo-random windows*, what critics call fake
difference. It raises a variety score and still reads as a housing block.
The whole diversity effort had been aimed at the wrong target.

Root cause was the terminal vocabulary, in four hand-synced lists that
had drifted: `lintel`, `sill` and `cornice` were plumbed through the
renderer, the material table and the presentation validator while the
grammar had no word for them. The model wrote a correct tripartite
rationale and could not draw a top to the building. Also, the start
symbol derives once per *facet*, so the model's root rule
`'0.05 pilaster | '0.90 core | '0.05 pilaster` put a pier on all 16
folds - that is the 32 black stripes.

Changed:

- new leaf module `facade-agent/facade-vocabulary.mjs` is the single
  source for word / primitive kind / material / purpose. `contract.mjs`,
  `derive.mjs`, `punched-facade.mjs` and the prompt all derive from it.
  `test/elevation3d-facade-vocabulary.test.ts` holds the four in
  agreement so they cannot drift again.
- new `design/composition.mjs` measures the three things the elevation
  actually lacked: opening-to-wall ratio per elevation (worst one counts),
  a top termination, and largest-to-median opening ratio. Thresholds are
  slack on purpose - they catch a warehouse, not taste.
- composition runs in the design agent's correction loop, NOT in
  `validateResolvedFacadeProgram`. Putting it in the validator broke 22
  unrelated plumbing tests, because the validator answers "is this
  buildable" and everything depends on it. It is gated on the authored
  program being v3 grammar, tested on `schema_version` rather than the
  requested language, because the offline fixture asks for grammar and
  returns v2.
- a structurally sound but flat answer is returned as a fallback with
  `composition_faults` rather than failing the run.
- the prompt's GUIDANCE no longer says "change opening proportion between
  base, middle and top" (that is the fake-difference generator). It asks
  for tripartite with material change, a cornice, one dominant element,
  and a fifth to two fifths opening ratio. It also states that the start
  symbol is per facet.

Note: composition faults cost extra paid attempts. A flat-but-valid
answer now spends up to 3 calls instead of 1, within the existing
`ceilingUsd * (MAX_CORRECTIONS + 1)` run envelope.

Next: re-run live. The prompt changed, so the request fingerprint changes
and this is a fresh paid call, not a free ledger replay.

## 2026-08-14 the pipeline completes; best result is v11

`llm-facade-live-v11` is the result to keep. It runs the whole pipeline
for the first time - four elevations, plan, axon, PBR and
`pbr-render/perspective-hero.png` - with 371 details and scores 100 on
every axis except `repetition_variation_balance` at 70, which is the
known-flawed metric. It is v9's accepted grammar replayed from a copied
ledger, so it cost nothing beyond v9's own $0.12.

What made the pipeline complete, in order:

- `61d457f` the competition views kept their own palette role lookup and
  it had drifted from the PBR one. It matched on the glTF material name
  (the facade material) instead of the primitive kind (the role the
  palette paints), so brick matched the near-black `opaque` and the
  pilasters were the black stripes, while precast matched `concrete`,
  the same role as the mass, and every band was painted wall-tone and
  vanished. Measured on the v6 geometry: plan seam segments 6 -> 0.
  The earlier guess in this file - that bands abutting the wall caused
  the plan failure - was wrong; no band crosses the 1.2 m cut at all.
- `authorsOwnTrim` switched the generated window frame off whenever the
  grammar drew a reveal, a lintel OR a sill. The frame is the two
  vertical edges of an opening, so only a reveal contests it. Once the
  vocabulary made lintel and sill sayable the model used them, frames
  switched off, `window-frame` lost its only source and the front and
  right elevations failed MATERIAL_ROLE_MISSING on the missing bronze
  role while back and left passed on the entrance door's frame alone.
- the elevation base pass is a raw ShaderMaterial and got none of
  three's output encoding, so linear light landed in an sRGB buffer and
  every fill was a transfer function too dark. This affects the
  elevation/plan/axon path only - the perspective hero renders through
  embedded-pbr-presentation and was byte-identical before and after.

Open, and worth doing in this order:

1. The `giant order` attempt (v12) made things worse and is discarded.
   Asking for an element carried through two or three storeys, without
   relaxing anything else, made the model strip openings rather than
   enlarge them: windows went 78 -> 8 and the elevation became a blank
   wall. All three attempts failed composition and the fallback shipped
   it. The STOREY_LOCKSTEP metric itself looks sound - the diagnosis
   that a facade confining every opening to one storey is one floor
   drawn five times still holds, and the validator has always allowed an
   opening to cross a slab. It is the prompt that needs to ask for it
   without trading away the opening ratio.
2. The fallback now keeps the least-faulty attempt rather than the first;
   that landed after v12 and has not been exercised live.
3. Plan `TRIANGULATION_VISIBLE` has a zero-tolerance clause: any single
   connected seam segment of 12px fails it even when the seam fraction is
   185x under its own limit. v9 passed, v10 failed on 2 segments, v12 on
   16. Decide whether that clause is right before tuning grammars around
   it.
4. The perspective hero crops the bottom of the building, so the base and
   the entrance cannot be checked in it. Framing lives in the PBR
   presentation path, not in the runners.
5. `repetition_variation_balance` still scores variety down (70).

## 2026-08-15 the five open items, closed

All five are done, plus a sixth that fell out of the third. Everything here is
tested offline. Nothing has been through a live run: the next live grammar call
is the first thing that exercises items 1 and 2, and it is a fresh paid call
because the prompt changed and so does its fingerprint.

1. The giant-order wording now names what it must not spend. Asking for an
   element carried through three floors, on its own, made the model buy it by
   deleting windows - 78 down to 8, and a blank wall. The bullet says the order
   is one or two bays against the ordinary ones and that every other bay keeps
   its storey split and its windows, and it says outright that emptying the
   facade fails the opening ratio instead. The STOREY_LOCKSTEP fault carries the
   same guard with the count it must keep, because the model reads the fault and
   not the prompt when it is correcting.
2. The fallback no longer ranks by fault count alone. Counting faults makes a
   blank wall one fault, so it beats an elevation that kept its openings and
   only wants a cornice and a subject - which is how a blank wall shipped. An
   answer with no openings now sorts behind every answer that has them, and
   fewest faults breaks the tie among the rest. `isBetterFallbackComposition` is
   exported and tested rather than inlined, since driving the whole agent to
   reach three composition failures is not a test anyone will keep.
3. TRIANGULATION_VISIBLE measures the length a seam runs, not how many samples
   fell in it. Measured on four persisted plan views: v10's two failures were
   compact specks 13 px and 11 px across, and v12's real seams - roof-quad
   diagonals and four coplanar band lines - ran 111 to 185 px. An order of
   magnitude apart with nothing between them, so the gate is zero tolerance at
   48 px on a 2400 px sheet. v9 and v11 still pass, v10 now passes, v12 still
   fails on nine segments. `competition-elevation.mjs` had a second copy of this
   metric under the same name measuring pixel counts at full resolution; both
   now import one constant and report `{ visible, longest_px }`.
4. `composePerspectiveHero` reframes with `contain` instead of `cover`, so the
   parapet and the ground storey survive and the margin is filled with the
   plate's own paper. **The runners still crop.** The `fit: "cover"` line is in
   `.superpowers/sdd/2026-08-10-llm-facade-design-agent/run-live-grammar-*.mjs`,
   which are untracked and one per run; the completed ones were left alone
   rather than rewriting how a finished run was produced. The next runner must
   call `composePerspectiveHero` instead of that line, or item 4 is only fixed
   in the library.
5. `repetition_variation_balance` no longer scores difference down. Its third
   term was one minus the share of segments carrying a distinct rhythm, so a
   street face and a service face that differ in kind - the thing the guidance
   asks for - drove it to zero and held the axis at 70. It now measures the
   share of a segment's openings that belong to a repeat, averaged over
   segments: repetition belongs inside a face, difference between them.

And the sixth. The creative-013 front e2e had been failing since `339880c`, the
sRGB fix, and the handoff did not know it. Encoding the base pass correctly
brightened every fill, so the same lines cross the strong-edge threshold that
used to fall just under it: strong went 0.014953 -> 0.015667 while total went
0.016074 -> 0.015743. The drawing has no more lines in it - it has the contrast
it was always supposed to have - and the untyped limit of 0.015 had 0.3% of
headroom, so it failed the first correctly encoded render. It is 0.020 now,
still under the typed 0.025 because a plain mass has less to draw than a facade.
The same commit moved which pixels fall under the dark-luminance test, so the
two component bounding boxes that test pinned no longer exist; it asserts the
property those two were sampling instead - every dark component is classified as
authored, and every depth silhouette is fully covered by the depth buffer.

## 2026-08-15 open: `61d457f` broke the typed-facade e2e, and the fix is a real choice

`test/elevation3d-facade-agent-e2e.test.ts` - the offline Seedream/BytePlus
`brick-punched-window-v1` fixture - fails, and has since `61d457f`. Bisected:
its parent `4cda591` passes, `61d457f` fails. This is the only remaining red
test; everything else in the suite passes.

That commit moved the competition views onto `resolveSemanticRole`, which keys
the palette role off the primitive kind. `KIND_ROLES` carries the procedural and
the design grammar vocabularies and not the typed one, so `brick-cladding`,
`corner-return`, `window-reveal`, `precast-lintel` and `precast-sill` fall
through to the `concrete` fallback. Nothing is left on `opaque` and the front
elevation fails `MATERIAL_ROLE_MISSING`. `multi-elevation.mjs` now names the
codes in that rejection - it used to say only "front validation was not
accepted", which is why this looked like a render fault rather than a role one.

Adding the five kinds is the fix, but the role for `brick-cladding` is squeezed
from three sides and both obvious answers were measured and rejected:

- `opaque`, which is what the old material-name lookup gave it, puts 83% of the
  building on the darkest tint. The elevation passes; the PBR presentation then
  fails `PBR_PRESENTATION_RANGE_INVALID` with a building luminance P50 of 9.9 on
  the back view. `KIND_ROLES` is shared with the PBR path, so it cannot answer
  the two renderers differently.
- `concrete`, matching the design vocabulary where the wall pier is wall, gives
  the cladding the same role as the exact mass. The plan then fails on its own
  validation, which is the seam this commit's own message describes: two
  surfaces on one role make their depth edge a same-material seam.

`concrete` is the only bright role in the palette - bronze measures a mean
luminance of 3 to 32 across the views - so no single assignment satisfies a
bright 83% field, a role that is not the mass's, and a non-empty `opaque`.
Something has to give: a fifth role, a per-renderer override on the shared
table, or accepting one of the two failures as the lesser. That is a call about
what the drawings should look like, not a lookup to be patched, so it is left
here rather than guessed at.

## 2026-08-17 v11 is superseded; the grammar can be authored without paying

**Do not treat `llm-facade-live-v11` as the result to keep.** It reads as an
apartment block and now there are numbers for why: front 3.7% opening ratio,
back 4.8%, **left and right at literally 0%** - two blank flanks - and
`max_storey_span` 1, which is the whole building being one floor drawn five
times. It scored 100 on five of six axes while looking like that, which is
the clearest statement available of what those axes miss.

Eight schemes now clear every gate, at
`facade-agent-verification/llm-facade-design-agent-20260810/creative-020/llm-facade-subagent-v1/`.
Open `elevations.html` there to see them together. Worst-case opening ratio
across the set is 21-34% on every face, `max_storey_span` 2 to 5,
`scale_ratio` 2.3 to 11.7, composition faults zero.

They were authored by subagents, not by a paid provider, through
`design/authoring-kit.mjs`. The one paid operation in this pipeline is asking
for the grammar; everything after it is local deterministic code, so the
answers are held to the identical gates. Cost for the eight: nothing.

**What that does not prove.** Every one of those subagents read
`composition.mjs`, `validator.mjs`, `resolver.mjs` and `derive.mjs` and
hand-computed its coordinates before writing any JSON, and every one passed on
its first attempt, predicting the metrics to three decimals. The paid provider
sees a prompt and a thumbnail. So the STOREY_LOCKSTEP rewording and the
fallback ranking from the previous session are still **unexercised against a
real provider run** - these eight say the gates and the renderer work, not that
the prompt does.

Open, in the order worth doing:

1. Nothing measures whether two faces differ in *kind*. The guidance asks the
   street face and the service face to differ in kind rather than in window
   width, and `measureComposition` only reads each view's ratio independently.
   Scheme A passed with a front and a back identical apart from the
   deterministic entrance. Naming it in the prompt was enough for schemes D
   through H, but that is a request, not a gate.
2. Scheme D fails to render: its back elevation trips LINE_DENSITY_EXCEEDED at
   strong 0.02520 against a typed limit of 0.025, by 0.8%. Its
   `total_edge_density` is 0.0253 against a limit of 0.035, so the drawing is
   within the line budget and only the strong sub-limit fires. After the sRGB
   fix strong is 99.5% of total on these drawings, which makes the strong limit
   the de facto line budget at a number nobody chose - the same collapse that
   was already re-derived for the untyped case. It was left alone here because
   the design that fails it is one of ours, and moving a gate to admit your own
   work needs someone else's eyes.
3. `61d457f` still breaks the typed-facade e2e; the diagnosis and the two
   measured dead ends are in the previous section. Unchanged.
4. The presentation ambient lives in `REVEAL_FACADE_PRESENTATION_STYLE` as an
   override. The preset default is still calibrated for facades without
   reveals, so anyone writing a new runner hits the same wall unless they use
   the constant.

## 2026-08-17 subsymmetry was tried and does not work; and the pipeline runs on one mass

Two findings, one negative and one larger than everything above it.

### Bay subsymmetry: implemented, measured, discarded

The reading was that the remaining fault is horizontal - the faces are
stratified into bands and each band is a uniform run of near-identical bays,
"one bay drawn six times in three flavours" - and that Alexander's local
symmetries would catch it. It does not. The measure was built (bays grouped by
u-overlap, labelled by their openings quantised to 0.05 m, scored as
non-trivial palindromic runs per bay), measured across all ten grammars, and
reverted. The numbers, front/back:

    a ABCCBA .333 / ABCCBD .167      f AAAAAA .000 / AAAAAB .000
    b ABCBCA .333 / ABCBCD .333      g ABBBBA .167 / AAAAAB .000
    c ABCCBA .333 / ABCCBD .167      h ABCBBA .167 / AABAAC .333
    d ABBBBA .167 / 12 bays .000     p ABCCDA .000 / ABBBBC .000
    e ABBBBB .000 / ABAAAC .167    v11 AAABAA .333 / AAABAC .167

v11 - the known-bad scheme - ties for the top of the set, on a front of
`AAABAA`, five identical bays and one odd one. G, which reads best by eye,
scores zero. There is no gap to derive a threshold from: the only values are
0, 1/6 and 2/6, which is quantisation from six bays rather than two
populations. `a-b-a-b-a-b` scores 1.000, three times the best real scheme, and
is exactly the fault the measure was built to catch.

Three things worth keeping from the attempt:

- **A and C emit identical bay sequences on both faces.** No measure over bay
  order can separate them, so whatever makes C read worse is *inside* a bay.
  The horizontal-sequence hypothesis is not merely unsupported, it is refuted
  for this pair.
- **The site polygon nearly ate the measure.** Both long faces fold
  0.707, 1, 0.707, 0.707, 1, 0.707 - itself `a-b-a-a-b-a`, scoring 0.667,
  identical in all ten schemes because it is the plan and not the design.
  Labelling bays by drawn width put scheme F top of the sheet for placing one
  identical rule on all six facets and letting the folds do the work. Labelling
  by unforeshortened width removes it. Any future face-sequence measure has to
  handle this or it measures the site.
- 48-90% of every scheme's windows sit in a vertical repeat of two or more
  identical openings, and the flanks carry two bays each and cannot be measured
  at all. The near-identity is in both axes and neither sorts these schemes.

### The pipeline has only ever run on creative-020

`MAAS_ELEVATION_TEST_SET_20260730` holds three candidates. creative-020 has 35
vertices and **two** distinct z levels - a plain extruded prism, every vertical
face a full rectangle. creative-004 has 86 vertices and 13 levels; creative-013
has 184 and 15. The set is three candidates because it is meant to test
generalisation.

creative-013 throws in `deriveFacadeSegmentsFromMass`, before the LLM, the
gates or the renderer see anything. The rejection now carries its measurement,
and it says `covered 0.000000000 of 3.101669840 m2` on the 2.3575 x 1.3157 m
plane at (9.269, 0.334, 4.476) - **zero**, not a rounding shortfall.

The obvious reading, that the code assumes rectangular faces, is wrong:
`usableFaceRectangle` already takes the face boundary polygon and inscribes the
largest rectangle in it. A plane the function derived from a coplanar triangle
group finds none of that group coplanar with it, which is self-contradictory.
This is a bug in that path, not a limitation to design around. Not yet
eliminated: `massSupportTriangles` requires all three points within 1e-5 of the
plane; `deriveFacadeSegmentsFromMass` passes one global
`closedShellOrientation` for every triangle, which is fine for a single closed
prism; and the plane origin is chosen by matching a vertex on (u, z) alone.

**Everything tuned in this session came from that one prism** - seam length
48 px, untyped strong-edge 0.020, ambient 1.7/2.2/0.86, the opening-ratio
target, the face-kind profile. None has been shown to be a property of the
pipeline rather than of creative-020. Preparing another candidate does not need
a retained delivery: `.superpowers/sdd/2026-08-10-llm-facade-design-agent/prepare-any-candidate.mjs`
builds the evidence pack from the candidate and takes the GLB and thumbnails
from the e2e results tree.

### And the vocabulary cannot say curtain wall

The grammar's entire terminal set is `wall glass door reveal lintel sill band
cornice pilaster`. Nine punched-masonry words. There is no mullion, transom,
spandrel, louvre, balcony, canopy, projecting bay or arch. The nine schemes all
read as one architectural language because the language has no other words - no
prompt work will produce a curtain wall. Adding one is not a one-file change
(`facade-vocabulary.mjs` feeds contract, derive, punched-facade and the prompt,
held in agreement by a test) and it breaks the premises of the composition
measures, which assume openings are a minority of the wall.

## 2026-08-18 the curtain wall renders, and the fold clearance is what you see

`grammar-cw3.json` is the first facade in this project that reads as an office
rather than an apartment: glass running five storeys, mullions unbroken from
grade to cornice, a spandrel at every slab, a cornice closing the top. It clears
every gate with zero faults and reaches `skin_transparency_by_view` **0.618**
against cw2's 0.562. Rendered at
`.../creative-020/llm-facade-subagent-v1/cw3/`; all eight views pass
presentation validation. All twelve grammars (a-h, p, cw, cw2, cw3) pass, and
the five gate suites are 51/51 green.

**The elevation's loudest element is a clearance constant, not a design
decision.** `design/context.mjs:227` sets `fold_clearance_m: 0.3` for every
candidate, and `resolver.mjs` insets the derivation scope by it at both edges.
creative-020's facets are 2.206 m wide, so the two strips are 27% of every
facet. Decomposed on cw3's front face: the fold strip costs **0.246** of skin
transparency, every mullion and transom together costs **0.041**. Six to one.
The ceiling for this facet is 0.660 and cw3 is at 94% of it. Do not tune a
skin-transparency threshold here - it would be a threshold on the fold constant.
0.3 m is a fair corner-column dimension; 2.2 m facets are what make it dominate,
and the mass is another agent's work.

**`FOLD_CLEARANCE_INVALID` cannot fire on a grammar-derived window.** The scope
is already inset by exactly the clearance, `derive.mjs` only narrows from the
scope, and the carry-to-facet-edge at `derive.mjs:118` fires only for
`SKIN_KINDS` (mullion / transom / spandrel) - `window` is not in it. A probe
with the corner mullions stripped out entirely and *nothing* framing the fold
still passes validation. Relaxing the fault to admit framed glass at the fold
was implemented, measured, and **reverted as dead code**: the predicate is never
evaluated. Opening the root scope to the full facet was tried in the previous
session and broke all ten grammars, because every size fraction is a fraction of
that scope. Both dead ends are now measured; do not re-walk them.

What is still open and is a real choice: cw3 puts a `mullion` in the forced
strip, `mullion` maps to `window-frame` / the `bronze` role, and two adjacent
facets each contribute 0.35 m, so every fold renders as a **0.70 m near-black
band** against 1.506 m of glass. That is concrete-frame proportion; a real
curtain wall mullion is 50-150 mm. The strip is forced but its material is not,
and whether a bright `spandrel` there reads better is being authored as cw4.

## 2026-08-18 cw4 is the scheme to keep, and the strong-edge limit is now the binding one

`grammar-cw4.json` supersedes cw3 and is the best facade this project has
produced. Same skin as cw3 with one substitution: the forced 0.3 m fold strip
carries a bright `spandrel` pier instead of a dark `mullion`, and only a 40 mm
mullion stands at the glass edge. `dark_pixel_fraction` 0.114931 -> **0.031661**,
3.6x less dark ink, and the facade stops reading as a concrete frame with infill
panels. `skin_transparency_by_view` 0.618289 -> **0.62123**, zero faults, all
eight views render and pass.

Two things worth knowing about that number. The pier-for-mullion swap is
**exactly free** to six decimals - cw3 spent 0.05 m of scope per edge on the
corner mullion, cw4 spends 0.01 on the pier plus 0.04 on the mullion, and both
leave a 1.5060696 m pane. The +0.0029 is vertical: slab clearance 0.16 -> 0.155
and the skin cornice 0.60 -> 0.45. And the 50-150 mm mullion a real curtain wall
would use is not reachable - the budget is `pier_scope + mullion <= 0.05` for
glass parity, so 40 mm is what parity buys. **The proportion did not change,
only the tone.** cw4 reads as a light frame, not as a glazed skin, and that is
the ceiling for a 2.2 m facet.

`spandrel` is the only terminal that is both bright (`concrete`, the one bright
role) and in `SKIN_KINDS`, so it is the only word that can occupy the strip at
all. `lintel` and `cornice` are bright but not carryable. That single fact is
the whole scheme.

**The KIND_ROLES seam warning is confirmed with a number.** A full-height
precast pier crossing the 1.2 m plan cut failed `TRIANGULATION_VISIBLE` at 7
visible segments, longest 95 px, because `spandrel` and `exact-mass` share
`concrete`. Fixed in the grammar, not the code, by springing the pier at 1.5 m -
which leaves a visible notch in the base silhouette and is a compromise, not a
design decision.

**`total_edge_density > 0.035` is unreachable and the note claiming otherwise is
now corrected in the source.** Across thirteen rendered schemes x four
elevations, strong is 95.6% to 99.9% of total, never below; the 0.035 clause
would need strong under 71% of total to fire first. So the strong limit is the
entire line budget, at a number chosen when it was a strict subset - the same
collapse already re-derived for the untyped case (0.015 -> 0.020) and never
re-derived for the typed one. It is deliberately **not** retuned: nothing that
should pass is failing (highest of the thirteen is cw4 front at 0.024224, 3.1%
of headroom; scheme D's back at 0.02520 is the only failure). Picking a
replacement is a judgement about how busy a drawing may look, and that is the
judgement class with measured evidence against it. The next scheme to fail it is
the trigger to re-derive 0.025 and 0.035 together.

## 2026-08-18 correction: none of these are curtain walls

Two sections above call cw3 and cw4 curtain walls. They are not, and the user
said so on sight: it is glass set into a thick wall. The claim was made from the
*terminals* the grammar used - mullion, transom, spandrel - and not from the
drawing. This repo had already written the same sentence about scheme C: a
'deeply glazed frame' that is still punched openings which happen to be large.

Three reasons, and they share one root:

- **The glass cannot cross a fold.** A curtain wall is a continuous skin hung in
  front of the structure and it turns corners. Here each 2.206 m facet gets its
  own isolated glass strip with 0.6 m of solid between. That is punched, by
  definition, however tall the strip is.
- **The vertical solid beats the horizontal.** Pier 0.70 m against spandrel
  0.20 m reads as a pier rhythm, not a mullion grid.
- **The glass sits in the wall, not in front of it.** Primitives are placed on
  the face; nothing is hung off it.

Root: derivation is per *facet* and its scope is inset by `fold_clearance_m`, so
a continuous skin is not expressible. **The pipeline models one construction -
holes in a solid mass.** A curtain wall is a different construction, not a
different pattern of holes, which is why going from nine terminals to twelve did
not produce one. See [[facade-grammar-vocabulary-is-punched-masonry]], which was
right that the vocabulary was the blocker and wrong that vocabulary was enough.

`fold_clearance_m: 0.3` is a bare literal in `context.mjs:227` with no derivation
anywhere. Its stated rationale, in `derive.mjs`, is that *a hole cut through a
turn breaks the mass* - which is an argument about punching a solid wall. In a
glazed skin the corner glass does not pierce the mass, it replaces it, and the
corner mullion is the return. The clearance should therefore be a property of
the construction (punched: 0.3; skin: the mullion width), not a global constant.
That is the one change that would move the fold band from 0.70 m to about
0.10 m, which is the difference between a pier rhythm and a mullion grid.

## 2026-08-19 the typed-facade e2e is green, and the suite is 867/867

`4ac7bfa`. The `61d457f` break is closed with the pair both halves of which were
already on the table: `brick-cladding` takes `opaque` (the pre-61d457f state,
what the typed 0.60 dark-fraction limit was calibrated for - the plan's 8 seam
segments clear because the cladding's cut face stops sharing the mass's role),
and `deliverFacadeFinalPresentation` takes `renderStyleOverrides`, defaulting to
`REVEAL_FACADE_PRESENTATION_STYLE`, so the typed delivery renders under the
reveal ambient instead of the preset that measured its back view at P50 9.85.
Measured after both: P05 27.6-41.4 / P50 36.4-76.6 / P95 <= 243.1. The constant
now lives in `final-presentation.mjs`; the authoring kit re-exports it.

Two things this settles from the earlier open lists: the fifth role stays
rejected (nothing needed it), and item 4 of 2026-08-17 - "anyone writing a new
runner hits the same wall unless they use the constant" - no longer applies to
the delivery path, which defaults to it.

Retained verification run: `D:\Data\50_ELE\facade-agent-verification\typed-e2e-debug-20260819`.

## 2026-08-19 third blind run: the entrance was deleting the grammar's members

`f5da9a9`. A repo-blind author given "a masonry building that opens into glass where it
meets the street" produced the first mixed-construction design (back face skin, three
punched faces, worst opening ratio 0.174, skin transparency 0.527) and passed on attempt 2.
Attempt 1 exposed that the entrance carve-out dropped any primitive grazing the door plus
its 0.3 m gap - a full-height corner mullion lost its whole 16.5 m to a 2.6 m overlap, and
with it the fold framing and mullion-as-separation exemptions the brief promises. Fifteen
of the eighteen retained grammars were quietly losing one to three members each; verdicts
all unchanged under the fix. Solids now yield only where they cover the door, cut at the
door head. FLOOR_BAND_INTRUSION's boundary epsilons are symmetric now (exactly 0.15 clears,
both sides of both lines) and it reports distance-to-slab, not a coordinate. The brief
states the rules the authors had to guess (door discarded, wall emits nothing, repeat
rounding, one-skin-word classification, exact boundaries).

The reconstructed attempt-1 geometry lives as `grammar-fold-probe.json` and
`grammar-grid-probe.json` beside the other subagent grammars, both accepted. The prompt
changed again, so the next live provider call is still a fresh fingerprint. `run-live-grammar-v13.mjs`
is ready in the sdd directory: composePerspectiveHero for the hero and the reveal ambient
for the PBR, the two defects every earlier runner carried.

## 2026-08-19 the first live-provider facade ships: llm-facade-live-v14

The result to keep. gpt-5.5, brief unmodified, three attempts, $0.20 all
told across v13+v14 ($0.12 wasted measuring the blind-correction defect,
$0.08 for the two corrections that landed). Attempt 1 (replayed free from
v13's ledger) died on the fixed-parts overrun; attempt 2 - the first
correction ever delivered WITH the resolver's cause - fixed the
arithmetic and left one real fault (FLOOR_BAND_INTRUSION, head 0.12 m
from a slab line, correctly reported as a distance by the new message);
attempt 3 accepted: mixed construction (back skin 0.589 transparency,
three punched faces, worst opening ratio 0.242), 852 details, all eight
views + PBR + hero rendered and accepted, critic 100/100/99/100/94/100.
The back elevation reads as a curtain wall - continuous glass, mullion
grid, spandrels at slabs, storefront base - which no live run had ever
produced.

Replay mechanics, learned the hard way: a free replay needs the SAME
ledger file AND the attempt's persisted prepared.json/response.json
copied into the new run dir, the ledger trimmed to only the ops being
replayed (the aggregate budget counts dead reservations), and no stale
failed state.json. Run dir:
`facade-agent-verification/llm-facade-design-agent-20260810/creative-020/llm-facade-live-v14`.

## 2026-08-19 the stepped mass teaches the loop four lessons ($0.24 of live runs, one blind pass)

Two live runs on creative-013 failed in opposite directions and a blind author then
passed attempt 3 with a design that reads the terracing as one composition (three skin
faces tracing the steps, punched front, worst opening 0.231). What all three runs taught,
each fixed and committed:

- `9e8385f` the brief now carries a dynamic facet advisory (widths/heights computed per
  candidate, silent on a prism) ending with the guard that names where the design must
  still live - the advisory without the guard made the live model empty the building to
  seven primitives, the giant-order trade again.
- `9e8385f` the OpenAI adapter timeout cap is 600 s; the stepped brief blew the 300 s cap
  and stranded an uncertain paid operation.
- `b50570c` two rules only the error messages knew are now stated: the punched u scope is
  pre-inset by the fold clearance (both the live model and the blind author budgeted it
  twice), and a repeat never draws zero tiles (an author built bare-wall-for-free on the
  contrary reading).
- `ea2f148` MATERIAL_ROLE_MISSING's certain half runs in composition now, inside the
  correction loop - a live fallback and the blind author's accepted design both died in
  the renderer on a rule ("a pure skin needs its transom") the loop never relayed.

Still open for 013: a fresh live run on the hardened brief (fingerprint moved again), and
the blind design needs its transoms before it can render. Total live spend today $0.44
across v13/v14/013-a/013-b, plus one uncertain $0.04 from the timeout.

## 2026-08-20 two more stepped-mass runs, two more loop repairs

013-c ($0.12): the advisory's guard held - the model kept a rich design through all three
attempts - and the run exhausted on whack-a-mole: the correction relayed one worst
measurement per code, the model fixed that window, a sibling surfaced next attempt, and
attempt 3 repeated attempt 2's unfixed 6 cm sliver verbatim. `14c14ad` relays up to three
instances per code with the count of the rest.

013-d ($0.12): the composition role check fired live exactly as designed - attempt 2 was
told which roles its front face could not produce - and the fallback shipped that attempt
into the renderer anyway, dying at MATERIAL_ROLE_MISSING after the paid calls were spent;
attempt 3 was told only a bare HIERARCHY_MISSING and corrected blind. `af980f1` makes a
MATERIAL_ROLE_MISSING design fallback-ineligible and gives the two measurement-less codes
their explanations in words.

Live spend to date: $0.68 across six runs plus one uncertain $0.04 timeout. Every run has
converted into at least one committed loop repair; creative-013 itself is still unshipped
by a live provider (the blind author ships it fine). The full-suite tripo ledger race test
flaked once on a Windows lock-file EPERM, 3/3 green in isolation - not related.

## 2026-08-20 013-e closes the live campaign; the blind design ships transomed

013-e ($0.12, cumulative $0.80 + one uncertain $0.04): every known feedback repair applied,
and the run still exhausted - attempt 1 referenced undefined symbols, attempts 2 and 3 died
on new instances of FLOOR_BAND_INTRUSION and FOLD_CLEARANCE_INVALID with the ends of
fraction-sized windows landing millimetres from slab lines. Five live runs failed five
different ways on the same underlying task: per-facet slab-relative arithmetic on 37
irregular facets, the thing the blind author solved by hand-computing absolute margins per
facet. Verdict recorded as model convergence under the 3-attempt budget, not a feedback gap.

The blind design ships: `grammar-blind-013-t.json` is the blind grammar with one
substitution (the 0.4 m skin plinth spandrel -> sill, giving every skin face its opaque
role; concept "-transomed", geometry otherwise untouched), accepted and rendered end to end
at `creative-013/llm-facade-subagent-creative-013/render-blind-013-t/` - all eight views,
PBR, hero. The stepped mass now has two shipped designs: 013-a (punched-led) and this
(skin-led, the terracing read as one composition).

If 013 live is attempted again, the options on the table are: raise MAX_CORRECTIONS for
irregular candidates (cost scales linearly), give the grammar a slab-snapped z size so the
model stops doing slab arithmetic (engine feature, breaks no existing grammar if additive),
or accept that non-prism masses route through the subagent path, which costs nothing and
has now shipped twice.

## 2026-08-20 the variety round: seven designs on the stepped mass, and an arch

The user's critique - one glassy language on every shipped design - is the recorded one,
and the answer was the free path: four more blind authors on creative-013 with opposed
intents. All seven schemes now render end to end (llm-facade-subagent-creative-013/render-*):
skin-led T, punched A, closed vessel (three near-blank faces vs a 64% street skin), stone
(no skin words, worst 10.6%), horizontal ribbon (poorest 11.4%, span-3 pilasters), inverted
plinth (glass base under closed body, span-2 hero slot), and the arch demo. The sheet is
`elevations-20260820.html` at the verification root.

`0b33119` gave the grammar its arch - archGeometry, the one non-box terminal, dark role so
it reads - and closed the recess schema/gate mismatch, named TOP_TERMINATION as gated, and
stated index scoping. `745f3ef` raised the derivation depth to 12 and warned the brief file
can go stale against prompt.mjs (four authors read a stale one; regenerate before every
protocol run). The last commit names the 35% storey-span bar and the storey-predicate
semantics the plinth author paid five attempts to reverse-engineer. Two author designs were
revived by one-number fixes applied as -fx copies (stone recess 0.6->0.5, plinth hero slot
'0.16->'0.14); the originals stand as protocol artifacts.

Still open from the round: per-facet routing capacity (index dead below the start rule and
8 alternatives cap the routes - the plinth author called a 14-way discrimination unroutable
and worked around it; an engine answer would be index inheritance through single-part
splits or a higher start-rule alternative cap).
