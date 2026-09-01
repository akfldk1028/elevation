# Elevation agent handoff

이 저장소가 elevation agent입니다. `D:\Data\50_ELE\ElevationAgent`, GitHub은
`akfldk1028/elevation` (public). gitagent 제품 저장소에서 filter-repo로 추출했고,
elevation을 건드린 커밋 376개의 이력이 그대로 보존되어 있습니다.

## 실행

    node tools/facade-pipeline/cli.mjs roots                                   # 데이터 위치
    node tools/facade-pipeline/cli.mjs prepare  creative-013                   # 매스 -> 컨텍스트
    node tools/facade-pipeline/cli.mjs brief    creative-013                   # 저자가 답할 브리프
    node tools/facade-pipeline/cli.mjs check    creative-013 <grammar.json>    # 게이트
    node tools/facade-pipeline/cli.mjs render   creative-013 <grammar.json> <name> --palette competition-brick
    node tools/facade-pipeline/cli.mjs showcase creative-013 <name> <out.png> --wall precast --glass clear --mood morning
    node tools/facade-pipeline/cli.mjs photo    <in.png> <out.png> --subject "..."
    node tools/facade-presentation/catalog/build-sheet.mjs                     # 카탈로그

각 서브커맨드는 JSON 하나를 찍고 **실패하면 non-zero로 끝납니다**. 이걸 대체한 옛 러너들은
`| tail -1`로 출력해서 종료코드를 가렸고, 그 때문에 실패한 렌더 둘이 성공으로 보고된 적이
있습니다.

데이터 위치는 저장소 루트의 `elevation-agent.json`이 선언합니다 (`dataset_root`,
`output_root`). 해결 순서는 인자 → 환경변수 → 그 파일 → 역사적 기본값이고, 저장소 루트는
`import.meta.url`에서 찾으므로 어떤 명령도 특정 cwd를 요구하지 않습니다. 그 두 루트는 폴더
밖에 있는 게 맞습니다 — 컴파일러가 소스 파일을 품지 않는 것과 같습니다.

## 핵심 제약 (변경 전 확인)

- 매스가 권위입니다. `selected.glb` 기반의 폴리곤·평면·카메라·아티팩트 권한은 고정입니다.
- LLM은 설계 의도(문법)만 만들고, 최종 기하와 뷰는 검증 가능한 코드 경로로만 승인됩니다.
- geometry lock은 딱 한 군데 열려 있습니다: `rise_to: "building_top"`. 솔리드만, 데이텀까지만,
  한 층 이내만. 그 외 모든 부재는 자기 facet 안에 있습니다.
- 게이트(`test/elevation3d-facade-*`)는 항상 통과 상태를 유지해야 합니다.

## 다음 시작

1. `Set-Location D:\Data\50_ELE\ElevationAgent`
2. `git status --short`
3. `npm test`  (69개 파일, 796 테스트)

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

## 2026-08-20 the material axis, and a reference-conditioned scheme

The user's second critique - one palette, one glassy language - closed the same way as the
first: competition-brick is the fourth preset (the first where the wall reads as a fired
material; ribbon scheme rendered in it reads as a brick building), render-any takes a
palette argument, and the sheet's material section shows the same grammar in warm/stone/
neutral/brick. The ninth scheme, grammar-blind-013-sheer, is the first reference-conditioned
one: "SANAA-like sheer unitised glass, no plinth" produced four skin faces at 0.79-0.87
transparency with the glass standing on a 0.16 m shadow gap - the intent naming a real
precedent is the reference mechanism that costs nothing, since blind authors know famous
buildings even without the repo. z=0 is now named a slab line in the brief (an author lost
an attempt learning it). Known dishonest label deferred: the title block prints COMPETITION
WARM whatever palette rendered; generator and validator share the hardcode so nothing
mismatches, but the fix must thread the palette into the canonical-SVG recomputation on both
sides at once.

## 2026-08-20 the showcase renderer, and what its ground plane revealed

`render-showcase.mjs` (sdd dir, untracked) is a presentation-only renderer outside the
gated chain: same GLB, procedural brick/limestone materials, PMREM environment glass, warm
sun with soft shadows, sky and ground, auto-derived three-quarter camera. It answers the
"this doesn't feel AI-based" critique's code-addressable half; the diffusion half has its
conditioning ready (every render already emits depth/normal/material-id).

Its ground plane exposed something no pipeline render had: **creative-013 is a bridge
typology by design** - family morph-bridge-low, program bent_bar_terrace_bridge, the bar
touching z=0 only at one 5 m entrance pier (4 vertices), everything else with its underside
at z=1.861. The pipeline's own views have no ground, so nobody had seen it; a first
diagnosis of "the renderer dropped the mass" was instrumented and disproven (the mass is in
the scene, winding consistent). Do not "fix" the float - it is the authored mass.

## 2026-08-20 style presets close the image-level sameness

The user's third critique landed on the render, not the grammar: nine schemes were coming
out of the showcase as one beige building because materials were mapped by KIND alone. The
showcase now takes `--style brick|stone|sheer` - per-style material mapping (the WALL
itself becomes brick / mottled limestone / dark spandrel behind mirror glass) plus mood
(sun azimuth and warmth, sky, exposure, camera height). The three schemes now read as a
red-brick block at golden hour, a dark glass office on a grey day, and a white stone
building on a clear morning; the honest residual is that a sharp eye still sees the shared
massing and window rhythm underneath, which is the mass's and the rectangle-grammar's
signature, not the renderer's. No-style runs render byte-identically to before.

## 2026-08-20 materials become orthogonal axes

The user's architectural point - choosing brick must not drag the glass treatment along;
punched brick wants deep-set glass in frames, mirror skin belongs to curtain walls - is now
the showcase's structure: `--wall brick|limestone|precast|darkpanel`, `--glass
deep|clear|mirror`, `--frame bronze|iron|white`, `--mood golden|morning|overcast`, freely
combinable, with `--style` surviving as shorthand and the no-flag default verified
byte-identical. The proof pair on the sheet: the same running-bond brick wall wearing dark
deep-set panes at golden hour versus pale clear panes in white surrounds on a clear
morning. Caveats recorded by the builder: mirror under overcast reads as blue glazing (the
procedural env has little to reflect), iron on darkpanel is legible but low-contrast. The
next layer up is the design layer - a grammar naming its own materials via the schema's
existing materials/material_id fields - and the paid image path is currently locked
(no ARK_API_KEY in the env file).

## 2026-08-21 six material families, and the vocabulary measured against the literature

`--wall zinc` (0.43 m standing seams) and `--wall wood` (0.09 m boards, per-board jitter)
complete the six wall families - brick, limestone, precast, darkpanel, zinc, wood - all
procedural, all on the orthogonal axes. The sheet's matrix section now carries eight
perspective renders. Measured against the facade-taxonomy literature (UnderOneFacade/ZAHA/
MonuMAI class sets; CityGML/IFC/AAT): the grammar says ~12 of ~20 canonical element
classes - missing balcony/canopy (depth-budget decision), louvre/blinds, molding variety,
pediment - and the material families are 6 against libraries of thousands (Material
ConneXion 95k+). The gap splits by nature: projections need a depth-budget decision,
ornament classes are arch-shaped work (one geometry each, path proven in a day). Small
open item: the showcase camera auto-derives from the entrance face, so a scheme whose
subject is on another face (the arch demo's arched front) shows its back - a --face flag
is the fix.

## 2026-08-21 the fourth layer: photoreal, and the free lane for it

The pipeline's last layer is proven twice over. grammar -> gated drawings -> showcase ->
PHOTO: an img2img pass over the showcase render produces an architectural photograph with
the massing, window grid, stepped form and entrance block preserved. Lane one, the OpenAI
images API (gpt-image-1 edits, input_fidelity high): worked first try, $0.13/image,
retired at the user's direction after one proof (photo-brick-deep.png). Lane two, FREE:
`codex exec` (Codex CLI 0.147, the user's ChatGPT-Pro OAuth) has a built-in image
generation tool - prompt it to read the showcase PNG and generate; its sandbox cannot
write outside its home, so the output lands in ~/.codex/generated_images/<id>/ and must
be copied out (photo-sheer-codex.png). All future photoreal passes go through the codex
lane. The sheet's photo section carries both proofs.

## 2026-08-25 the master campaign, three engine defects, and the tools become modules

Four masters commissioned as repo-blind intents on creative-013, all four accepted:
Kuma's layered screen (`grammar-blind-013-screen-fx.json`, 153 louvres), Chipperfield's
colonnade (118 piers, worst opening 32.5%), Kahn's brick arcade (17 arches at the base,
the first blind use of the arch terminal), and Siza's white silence - which passed on
attempt ONE with zero faults, having predicted its own four opening ratios to two
decimals on paper before running anything. That is the clearest statement yet that the
brief is sufficient: the arithmetic in it is simulable.

`73312e7` gave the grammar `louvre`, the first terminal allowed to stand in front of
glass (it is deliberately not in the validator's collidable set), which is the
construction the vocabulary needed for Kuma-language facades. Nine of the thirteen master
languages in `master-intent-library.md` are sayable today.

**Three defects the campaign exposed, each found by an author failing:**

- `b5876c4` the root scope hardcoded `storey: storeys[0].storey`, so at the start rule
  every facet of a stepped mass answered `storey == 1` - including one spanning 7.26 to
  9.9 m. Routing the top facets to a cornice therefore produced nothing, silently. Two
  authors reached for that idiom; the plinth author diagnosed it precisely and the fix
  turned the colonnade's rejection into an acceptance with its author's file untouched.
  All eighteen retained grammars resolve byte-identically.
- `4503eb8` the recorded LINE_DENSITY trigger fired, and the re-derivation found the
  metric **inverted** in that regime: the legible louvre screen measured 0.025412 and was
  rejected while a deliberately mushed probe of the same grammar (tile pitch 0.30 -> 0.18 m,
  glazing gone) measured 0.024773 and passed. Past the point where a member is thinner
  than the antialiasing width the edge count falls, so no threshold there separates good
  from bad. Typed limit is 0.030 now, its job narrowed, and all seven presentation
  thresholds moved into `PRESENTATION_BOUNDS` with their derivations attached - the same
  discipline `COMPOSITION_BOUNDS` already had.
- `7880b32` / `6ac14b3` two feedback defects: the brief never said an oversized fixed
  split fails hard rather than shrinking away (the Kahn author paid an attempt for it),
  and `checkAuthoredGrammar` returned bare codes while the throwaway script beside it
  returned located ones - the library was handing authors the worse feedback. It also
  hardcoded `competition-warm`; both now fixed upstream with a regression test.

**The tools are modules.** `73acbcf` split the 881-line showcase renderer (CLI + axes +
an entire three.js app as a String.raw literal) into `tools/facade-presentation/` -
axes, moods, textures, sky-env, materials, geometry, camera, app, host, cli - by moving
the bundle from a stdin string to a real entry file, which killed the no-backtick
constraint. It gained `--face` and `photo/codex-photo.mjs`. `0c12b9a` added the catalogue:
`catalog/manifest.json` + `build-sheet.mjs` regenerate the whole page every run and
recompute every card's metrics through `checkAuthoredGrammar`, so a card cannot claim a
number its grammar does not have. First build: twelve schemes, 78 images, none missing.
Open `facade-agent-verification/llm-facade-design-agent-20260810/catalogue.html`.

**For the mass merge.** A read-only survey of the whole callable surface produced a
proposed `tools/facade-pipeline/` (normalizeMass, prepareFacadeContext, writeFacadeBrief,
checkFacadeGrammar, renderFacadeScheme, runFacadePipeline). The finding that matters: the
mass side needs to bring only a mass. The evidence pack renders from mesh + cameras, the
selected GLB can be synthesised with `buildEnrichedScene({safeFallback:true})`, and the
thumbnails come from the evidence pack's own colour pass. The one hard gate is that
`deriveFacadeSegmentsFromMass` must succeed and be byte-canonical - a hand-built authority
is refused by design. The one sharp friction for an in-memory mass is that
`verifyFacadeEvidencePack` demands a non-empty on-disk `artifacts` list (evidence.mjs:144),
relaxable in about five lines since `geometry_content_sha256` is already computed from the
mesh. The two upstream edits that survey called for are already done (`6ac14b3`).

## 2026-08-31 the live director ships on a stepped mass, and what the battered one showed

`aab1453`. Nine live runs on creative-013; the ninth succeeded - 455 details, scores
100/100/97/100/88/100, $0.12, run dir `creative-013/llm-facade-live-013-h`. The paid
director has now drawn a facade on a mass that is not a prism, which it had never done.

Four changes in order, each measured, the first three moving the failure and the fourth
ending it:

- `open_zones_m` per facet (`c72e0e9`): the z bands where an opening's ends already clear
  every slab line. The z-axis sin vanished; the failure moved to u.
- `punched_scope_m` per facet (`91393bd`): the u width after the fold inset, 0 meaning
  unpunchable, plus the mixed-facet trap - one skin word on a facet and its punched
  windows lose the automatic inset. The facet-level sin vanished; the failure moved to
  leaf scopes of a few centimetres.
- shrink-to-fit below the facet (`f0f49b2`): a split whose fixed parts overrun is scaled
  to fit instead of stopping the derivation, guarded three ways - the facet's own split
  still fails hard (the author was handed that number), a collapse under quarter-scale
  stays bare wall, and an inverted scope is never shrunk. All eighteen retained grammars
  resolve byte-identically. Every attempt now reached validation instead of resolve.
- repair-not-redesign in the correction (`aab1453`): the loop already returned the previous
  grammar, but the instruction above it only listed codes, so each attempt re-derived
  everything and traded one violation for another. It now names the member, the smallest
  move that clears the quoted number, and which hint answers which fault. The LLM-layout
  literature lands in the same place: constraint satisfaction is the bottleneck, not
  design, and the loops that converge ask for an adjustment to the violating element.

**creative-004's first live run failed differently, and the difference is the news.** It
cleared every design gate on its own - no correction exhaustion - and died in the renderer
on the plan view's TRIANGULATION_VISIBLE, 2 segments, longest 73 px. A composition-level
guard for it was written and reverted: 020's scheme-a has eight pilasters crossing the
1.2 m cut at exactly the same 0.22 m depth and renders clean, so the discriminator is not
the grammar but the mass - on a battered wall a constant-depth pier meets the mass surface
coplanar at the cut, on a vertical one it makes a depth step. Composition cannot decide it
without the mass. The real fix is the recorded architectural gap: render faults are never
relayed to the correction loop, so a run that authors well and renders badly dies with
nobody able to repair it.

## 2026-08-31 the agent becomes one module, and the grammar gets a datum

Two changes, and the second one is the first non-patch fix this project has made.

**`tools/facade-pipeline/` is the agent.** Its four steps - prepare a mass into a verified
design context, write the brief, hold an answer to the gates, render what clears them -
were four untracked scripts under `.superpowers/sdd/`, each with the two data locations
typed into it: eleven copies of the dataset root, fifteen of the output root. Tracked code
(`build-sheet.mjs`) reached into one of them for its context. The logic was already in
`design/authoring-kit.mjs`; what was missing was a tracked place that names the four
together and knows where the data is. `elevation-agent.json` now declares `dataset_root`
and `output_root`, resolved argument -> environment -> file -> historical default, with the
repo root found from `import.meta.url` so nothing depends on cwd. One CLI, one JSON object
per step, **non-zero exit on failure** - the runners this replaces printed through
`| tail -1`, which masked the exit code and reported two failed renders as successes on the
day it was found. Sheet rebuilds through the module: 15 cards, 90 images, none missing.

**`"axis": "storey"`** (`22f5daf`). The slab lines cut the scope and the rule is invoked
once per storey, so the split carries no sizes of its own and a member derived inside a band
cannot straddle a slab however its fractions land. Purely additive - all eighteen retained
grammars resolve byte-identically, full suite 873 passing.

The literature is the reason it is that and not another hint. Teboul et al. (CVPR 2010 2)
normalise a split's parameters to its scope so that "any set of parameters leads to a valid
split", and say outright that this property "allows us to deal with different facade
topologies using a single rule" - our 37-irregular-facet problem, stated in advance. CGA's
answer to slab alignment is stronger than a storey-relative coordinate: there is no world z
in a rule at all. `comp(f)` hands each facet a frame of its own, floors are addressed by
`split.index`, and an opening's clearance is a `~` remainder the engine computes. Muller et
al. (SIGGRAPH 2006 3.3) snap lines are the operator: "the snap lines divide the scope into
different parts and the repeat rule is invoked for each part separately."

**The literature also refuted the plan this file was about to follow.** Relaying render
faults into the correction loop is the wrong fix: render-closed loops went *backwards* in
two published systems (3D-Premise compile 96.0 -> 91.0, Seek-CAD compilability 77% -> 55%),
while a loop closed on geometry-kernel measurements converged in an average of 0.13
iterations. So the plan-cut seam must be measured as geometry, not as pixels. Also worth
knowing before more feedback work: repair loops saturate at round two across eight CAD
systems (+23-32 pp at round one, ~0 after), and located faults are already the best feedback
an oracle gives - that intervention is spent.

**Four blind authors, 4/4 accepted, and a perfect split at render.** Curtain wall (skin x4,
0.10 m mullions, 0.64-0.76 opening - the first facade here that actually is one), brise-soleil
(42 louvres), arcade (65 arches), soaring piers (span 3). The two glazed schemes rendered; all
three pier-bearing schemes died on the plan view's TRIANGULATION_VISIBLE, as did creative-004.
Every masonry scheme died, every glass scheme passed. That is the mechanism behind "they all
look alike", and it is recorded in [[plan-cut-seam-eliminates-masonry]].

Open, in the order the evidence supports: the plan-cut seam as a kernel measurement inside
the design loop; blind verification that the storey axis is actually reachable from the brief
(the author testing it was stopped mid-run for an unrelated reason); out-of-scope `index`
reading as 0 so an `index == 0` alternative below the start rule fires for everything (a
silent wrong answer, same class as the `storey` hardcode fixed in `b5876c4`); the start
rule's 8-alternative cap, which two authors reported as design-limiting on a mass with seven
degenerate facets; and the fact that a louvre cannot actually pass in front of glass, because
a split partitions its scope exactly once - the brief says it can.

## 2026-09-01 the catalogue was one building, and cw4 has never passed

**The sheet showed seventeen schemes and one candidate.** Every elevation on it therefore had
the same stepped silhouette, and no amount of looking at it could tell you whether a facade
was stepped by choice or by inheritance. The user said the elevations all looked alike for
hours before this was checked. `build-sheet.mjs` now prepares one context per candidate and a
section or card may name which one it belongs to; creative-020 joins with six already-rendered
schemes. 23 cards, 131 images, two masses.

**`grammar-cw4` does not clear the gates and there is no commit in this history where it
does.** It is recorded three sections above as "the best facade this project has produced",
"zero faults", "all eight views render and pass". That claim cannot be reproduced. Measured:
FOLD_CLEARANCE_INVALID, a window 0.05 m off a fold against 0.3 required, at HEAD and at every
testable commit back to 2026-08-18; on 2026-08-17 the file does not parse at all, because it
uses a terminal the vocabulary did not have yet. So either the file on disk was edited after
that note was written, or it passed only in an uncommitted working tree. Either way the note
is wrong and this is the correction.

Two process failures worth keeping, both mine:

- **The byte-identity snapshot quoted all session ran creative-013 and creative-004 only.**
  Nineteen prism grammars were never in it, which is why cw4's state went unnoticed through a
  dozen "all grammars byte-identical" claims. The snapshot covers all three candidates now.
- **The first bisect was invalid.** `git bisect start HEAD 2925748` asserted a good commit
  without testing it; the parent was broken too, so the answer it produced (`ea47906`) was
  meaningless. Sampling the history afterwards gave the real answer. Test the good end.

cw4 is deliberately left failing. The catalogue recomputes every card's metrics from its
grammar when the page is built, so the card prints "grammar no longer clears the gates" by
itself - the page contradicted a claim this file made about it, which is the whole reason the
sheet was built that way.

**Two operators landed, both asked for by authors rather than found in the code.** `band ==
full | cut` inside a storey split, because every member measures from the edges of its own
scope and on a stepped mass one of those edges is the step - seven windows on one face
measured seven distinct head heights. And `rise_to: "building_underside"`, the parapet
mirrored downward, after an author given no design intent read this mass as "a beam that
lands once" and named what was missing: a level bottom edge "so the beam reads as a beam and
not as a stack of shelves". The datum is the lowest facet bottom above grade, 1.8609 m here;
on a mass that sits on the ground it does not exist and the operator is inert, which is what
stops it filling in under a bridge. All pre-existing grammars byte-identical, suite 801 green.

## 2026-09-01 the plan seam cannot be predicted from the grammar, and that is now measured

Twelve schemes across both masses, whose render outcome is known, measured for what crosses
the 1.2 m plan cut. Four hypotheses, all refuted:

| | failing | passing |
|---|---|---|
| crossing count | cw2 **13** | 020-g **50** |
| total crossing width | cw2 **1.17 m** | 020-g **7.69 m** |
| max member depth | cw2 **0.14** | 020-g **0.45** |
| members sharing the mass's material | 0 on most failures | 0 on every pass |

The last one was the best hypothesis and it dies cleanest: `curtainwall` passes and `cw2`
fails with **identical material profiles at the cut** - window-frame only, no precast in
either. Same construction, same materials, opposite outcomes.

So the composition-level guard is not "reverted pending a better idea", it is **excluded**.
Nothing in the resolved primitive list separates the two populations. The seam is a property
of the compiled geometry meeting the mass, and the only place left to measure it is the GLB
before it is rendered - a kernel measurement, which is what the CAD literature said in the
first place: loops closed on geometry-kernel measurements converged in 0.13 iterations while
render-closed loops went backwards.

A fifth hypothesis was then built and refuted too, and it was the best one. Reading the
detector shows exactly what it looks for: same material, depth difference under 0.0005,
normals within 2 degrees, luminance gradient over 80 - a visible edge on what is
geometrically one plane. This mass approximates a curve in 5.5 m chords, and **eight
adjacent facet pairs have normals under 2 degrees apart, several at 0.00**, so the mass
itself supplies the coplanarity. The hypothesis was that a seam appears where two such
neighbours both carry a same-material solid overlapping in z at the fold they share.
Measured: `cw2` fails with 4 and `curtainwall` passes with 4 - the same number - and the
highest count of all, 8, belongs to `brisesoleil`, which passes.

Five hypotheses, twelve schemes, nothing separates. The probe is kept at
`.superpowers/sdd/2026-08-10-llm-facade-design-agent/probe-plan-cut.mjs` so the next person
does not re-derive the five dead ends.

**Stop hypothesising and look.** The detector reports counts and no coordinates, which is
why five guesses were possible. The next move is to make it report the bounding box of each
visible segment, render one failing scheme, and see where they actually are. Everything above
is inference from primitive lists; that would be observation.

**A warning I gave an author was wrong.** Commissioning the lifted curtain wall I told it
"schemes carrying solid piers die on the plan view; glazed skins pass", from three samples
that morning. The author reasoned from it and glazed the stem to avoid piers at the cut - a
decision it defended well on its own terms - and the scheme died on the plan view anyway. The
pattern was coincidence. Do not hand an author a rule drawn from three points.

**What did land.** `grammar-blind-013-cw2` is a curtain wall on a lifted beam: skin on all
four faces, opening ratios 0.560 to 0.648, skin transparency 0.577 to 0.686, a 0.36 m cornice
on sixteen facets at 9.90 and a 0.30 m soffit band on eight at 1.8609, both by datum and
neither a number in the file. It is accepted, it does not render, and it is the clearest
statement yet of what the plan gate costs: the drawings that fail are not the bad ones.

## 2026-09-01 the seam detector reports where, and seven hypotheses are dead

`persistedSeamMetrics` now returns a bounding box per visible segment, not just a count. That
is why five hypotheses were possible: nothing said where to look. Purely additive, existing
tests green.

Run on the failing curtain wall, the five segments are:

    x  236- 624   y 1281        one horizontal line in three pieces, 123/125/123 px
    x  630        y 1479-1675   two vertical pieces at the same x, 95/93 px

All five lie on the **landing stem**, none on the flying bar. Its own author had predicted
the place in words - "a fascia stands in front of part of the ground facet's glass... the
elevation shows only the line, not the overlap".

**That prediction was wrong, and so was mine.** Correcting the underside datum so a member
stops at whatever stands below it left the five segments **identical to the pixel**. A
seventh hypothesis - that glazing the stem causes it - died too: the passing `curtainwall`
draws 77 members on the ground facets and the failing `cw2` draws 61. More members, passes.

Seven hypotheses, twelve schemes, coordinates in hand, and the cause is still not identified.
**This line is closed.** What is known: the seams are on the stem, they are not the soffit,
not the stem's glazing, not counts, widths, depths, materials, or near-coplanar folds. What
is not known is what geometry at (236..624, 1281) produces them; answering it needs the
compiled mesh at that pixel, not the primitive list.

**The underside correction is kept anyway, on its own merits.** The datum means the line the
building flies at, and a facet is not flying where another facet stands under it - a beam's
fascia does not cut across its own support. Fifty-one grammars byte-identical; only the two
that use the datum move; `own2` still renders with zero seams. Suite 801 green.
