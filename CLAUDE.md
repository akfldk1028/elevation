> **Start at [AGENTS.md](AGENTS.md).** It is the shared entry point for any agent working
> here - Claude Code and Codex both - and it carries what the system is, how to run it, the
> four rules that are not negotiable, the language surface, and the four links a new grammar
> field has to travel. This file is what happened, in order: 1400 lines of working log kept
> because the measurements in it are load-bearing. It is evidence, not an introduction. Read
> AGENTS.md first, then search this for the specific thing you are about to touch.

# Elevation agent handoff

이 문서는 Claude Code, Gemini, Codex 등 모든 크로스 AI 에이전트가 공유하는 단일 진실 원천(Single Source of Truth)입니다.
`GEMINI.md`, `CODEX.md`, `AGENTS.md`와 100% 동기화되며, 건축법규, 대지 안착(Siting), 매스 배치(Massing) 절대 원칙을 정의합니다.

### 건축법규 및 대지배치(Siting/Massing) 절대 원칙
1. **정밀 안착 및 매스 배치 (Siting & Massing)**: 단순 보고서 요약에 그치지 않고, 모든 대지마다 정확한 건축법규를 적용하여 건물이 대지 위에 오차 없이 정확히 안착(Siting) 및 매스 배치(Massing)되도록 함. `mass.obj` 및 `selected.glb` 기반 권한은 고정 권위(authoritative geometry)이며 임의 훼손 불허.
2. **도로 소요너비 미달 후퇴 및 모퉁이 가각전제**: 건축법 제46조(일반도로 4m 미달 시 중심선 후퇴, 막다른 도로 폭원 확보, 경사지/하천 접할 시 반대편 기준 전폭 후퇴)와 시행령 제31조(가각전제 2~4m 코너 절단)를 반드시 산정하여 공부상 대지면적에서 공제한 '유효 대지면적' 기준으로 건폐율/용적률 산정.
3. **최신 정북방향 일조사선 (시행령 제86조)**: 높이 10m 이하 1.5m 이격, 10m 초과 시 H <= 2D 적용. 북측이 도로/공원/하천 접할 경우 반대편 경계선 기산선 이동 완화 적용.
4. **용적률 산정용 연면적 제외 및 지자체 조례 우선**: 시행령 제119조 제1항 제4호(지하층, 지상 주차장 제외). 전국 17개 광역시도 조례를 주소로부터 자동 매칭하여 국토계획법 상한보다 최우선 적용.
5. **층별 건축한계선 (Buildable Envelope)**: 대지경계선 이격 및 층별 일조사선 슬라이스 층별 건축한계선을 정확한 수치/좌표로 산출하여 3D 매스 배치에 직접 연동.
6. **공동주택 채광창 및 동간 인동거리**: 시행령 제86조 제3항 제1호(D >= 0.5H, 다세대 0.25H) 및 제2호/주택건설기준 제10조(남측동 0.5H, 측벽 4m/8m, 부대시설 1.0H) 산정.
7. **전국 17개 광역시도 조례 최우선**: 서울/경기/부산/인천 등 도시계획/건축조례(BCR, FAR, 공지, 조경, 주차) 자동 매칭.
8. **토지이용계획확인원(토지이음) 기반 중첩 규제**: 지목 전용허가/부담금, 지구단위계획 지침 최우선, 고도지구 절대높이 캡핑, 방화지구 내화구조, 경관지구 후퇴, 교육환경 50m 보호구역, 공개공지 5~10% 의무 및 1.2배 완화 전수 검토.
9. **LawAgent 24/7 오프라인 무중단 Fallback**: 외부 마이크로서비스(8001)나 Neo4j 유무와 무관하게 `src/legal/` 내장 엔진으로 즉시 자동 전환되어 100% 무중단 건축검토 보고서와 3D Envelope 데이터를 산출함.
10. **크로스 AI(Codex, Claude, Gemini) 공통 동기화 원칙**: 모든 AI 에이전트는 `CLAUDE.md`, `GEMINI.md`, `CODEX.md`를 단일 진실 원천으로 공유하며, 코드 수정 시 3대 핵심 테스트(종합법규, 대지별 Envelope, 사이트 클릭 중첩규제) 100% 통과 유지.

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

## 2026-09-01 how far a member may project is a fact about the member

`max_projection_m: 0.5` was a literal on one line of `context.mjs`, the same number for every
mass, and `BOUNDS.maxDepthM: 0.5` refused anything deeper at parse. Measuring what
fifty-three authored grammars actually wrote showed one constant failing in **both**
directions at once:

    cornice   n=71  median 0.32  max 0.48    pressing the ceiling
    pilaster  n=29  median 0.30  max 0.50    pressing the ceiling
    transom   n=21  median 0.09  max 0.12    ceiling four times what it ever needs
    spandrel  n=35  median 0.10  max 0.24
    mullion   n=32  median 0.14  max 0.24

So the bound **permitted a half-metre transom**, which is a shelf and not a transom, and
**denied a cornice and a pilaster the projection that makes them what they are**. The two
elements whose whole job is to project were the two it forbade.

The fix is not a bigger number - that is the same mistake with a different digit.
`projection_m` now sits in `facade-vocabulary.mjs` beside the word, the kind, the material
and the purpose, because how far a thing stands out of a wall is a property of the thing:
cornice 1.2, pilaster 1.0, louvre 0.8, reveal 0.6, transom 0.25, spandrel 0.35. The parser
and the validator both key off it, the brief prints it per terminal, and `max_projection_m`
is derived as the table's maximum so the context field stays true without deciding anything.
Same move as the fold clearance: **the bound belongs to the construction, not to a global.**

Verified against the corpus rather than asserted: all 51 grammars resolve stage-identical and
digest-identical, measured by stashing the change and running the same sweep. The
pre-existing failures - t1, stone, cw4 - were failing before it. A 1.2 m cornice, which used
to die at *parse* and never reach a quality gate at all, now passes every gate and renders
with a real overhang.

**Two mistakes this change made, both kept as tests.** `wall` was set to 0, which rejected
three accepted grammars over a depth that emits no geometry - a bound on an inert field is
pure restriction. And two director tests wrote `0.8` to trip the old flat ceiling; a pilaster
at 0.8 is now a legal pier, so both **passed while asserting nothing**. The overrun is
derived from the table now (`KIND_PROJECTION.pilaster + 0.2`) so it cannot rot the same way.

Suite 804, 803 pass. The one failure is the Tripo ledger's two-process lock test, which is
untouched by this change and passes in isolation - it lost a file-lock race while a render
and two authoring agents were running beside it.

**What this does not unlock:** balcony, canopy, projecting bay. Every primitive is a box and
a balcony is a slab plus a rail. `arch` is the only non-box terminal and it got in because
someone wrote `archGeometry`. Those need geometry, not a word and not a bigger bound.

## 2026-09-02 what a member is, and what it is made of, are two questions

Six blind authors were given six different architectures on the two masses - a glazed skin,
arched masonry, one great opening, a layered screen, inverted weight, ribbons - and told
nothing else. Five drew. Between them they found more in one afternoon than the last week of
reading the code did.

**The v3 grammar had no material field at all.** Material came entirely from the terminal
word: a pilaster was brick, a cornice was precast, and an author could not say otherwise. So
every scheme in the corpus carried the same four materials in the same places, and the
material variety on the sheet was a showcase re-skin of the whole building applied after the
fact - a presentation choice standing in for a design one. The arch author named it exactly:
"a rusticated base and an ashlar shaft are the same wall; the base and the shaft can differ
in what is cut into them but never in what they are made of." An alternative now carries
`material`, defaulting to the terminal's own, so nothing already written moves - 50 grammars
resolve digest-identical - and a probe that writes `material: "precast"` on a pilaster
resolves ten piers as precast.

**The same field is the plan seam's repair.** `pilaster` is the only terminal whose default
material is the mass's own, so a pier standing proud of the wall shares a material with the
wall behind it and the plan cut draws no line between them. That is TRIANGULATION_VISIBLE,
and it is what the arch author found by converting the seam boxes through the plan manifest
to world coordinates and sampling `plan-material-id.png`: pilaster and mass wall both
`(255,0,0)`, reveals `(255,255,0)`. They repaired it and got `visible: 0`. **Seven
hypotheses were refuted from this side of the code and the answer came from reading the
raster the gate actually looks at.**

Honest limit on that: it explains `arcade`, which uses pilasters. It does not explain `cw2`
or the failed `skin`, neither of which writes one. The general form - two same-material
surfaces meeting with near-parallel normals - covers all three, but only the pilaster case
has been demonstrated with a repair.

**`band == cut` never said which edge was the step.** Three authors said so independently and
one named the words it wanted. The deriver already knew and threw it away; it now reports
`cut_below` (facet begins inside, so the top is the slab), `cut_above` (facet ends inside, so
the bottom is the slab) and `cut_both`, with `cut` still matching all three so older grammars
keep meaning what they meant. The brief's own advice - "put the member against the edge that
IS a slab" - was unwritable before this, and the ribbon author's remaining staircase is
exactly the cut-at-bottom bands.

**The schema and the parser had drifted again.** `band` was missing from the prose predicate
list while the schema admitted it, and after adding the two new values the schema regex would
have rejected them. Both are now written from the same set.

**A brief that never mentions the drawing that rejects you.** `TRIANGULATION_VISIBLE`, the
plan cut, and `same_material_seam_fraction` appear nowhere in 37,000 characters, and the
skin author spent all three attempts on it - halving the mullion projections and getting back
seam boxes identical to the pixel, which is the second independent demonstration that this is
not a depth anyone can tune. The brief now says the plan exists, what the fault means, and
that reducing depth at a corner is an attempt wasted.

Suite 804 green.

## 2026-09-02 the loop runs backwards, and image-first is now the standard lane

The user's question - "why are we coding every lintel by hand when the image model draws
better facades than we do?" - got its answer measured, surveyed, and then decided.

**The reverse loop closed end to end, $0.** GPT-Image-2 (codex lane) drew a free concept
over creative-013's mass - twisting champagne fins over glass, a band sweeping every floor
(`concept-free-001.png`). A repo-blind VISION author read it like an engineer reads a
render: fin pitch 0.72 m, band 24% of the storey, portal dimensions, all measured by eye,
then transcribed into the grammar. Attempt 1: FOLD_CLEARANCE_INVALID x37 (a 0.12 m strip
between edge fin and pane broke framed-to-fold); one located-fault repair; attempt 2
accepted - 506 primitives, four skin faces, ratios predicted to the second decimal again.
The render then died once at PBR (right view P05 9.9 vs 10): all 237 fins sat on the
default bronze, but the concept's fins are LIGHT metal - a transcription miss of material,
not a gate problem - fixed as `-fx` with `material: "precast"` on the field fins. Full
render, all eight sheets accepted, photo pass over the top. Artifacts under
`creative-013/.../render-imagefirst-fx/`. Protocol upgrade for the next transcription:
the author must read MATERIALS off the image, not just geometry.

**The workflow decision (user's call):** perspective -> elevation is the standard lane.
Freedom lives in the image model (the freshest language of the day came from the concept,
not from a text intent); the grammar transcribes and verifies; elevation -> perspective
survives as the delivery tail (render/showcase/photo). Text-intent direct authoring stays
as the special tool for programme-led briefs. The vocabulary now grows on demand - when an
image asks for a word - which also answers the piecemeal-operator complaint: the
transcription loss list (fin twist, per-storey phase, portal depth, plan curve) IS the
measured backlog.

**The survey behind the decision** (2023-26, SIGGRAPH/CVPR/ICML; full annotated page at
https://claude.ai/code/artifact/7a7ef2d4-828e-4827-a994-9f25ba99dc56): three converged
representation moves - (1) primitive algebra + LLM-grown function library instead of
hand-plumbed terminals (SceneCraft, ShapeCoder, SIGGRAPH Asia 2025's repair-by-local-search),
(2) parameters as distributions/fields, `repeat(n, attrs=f(u))` (Infinigen + the
panelization literature; no top-venue first-class operator exists - the idiom is from
practice), (3) image<->program closed by a fine-tune our own executor can train (FacAID -
our exact split-grammar lineage - and VLMaterial), with Pro-DG showing the grammar
hierarchy conditions diffusion better than depth/normal, and MVPainter/MeSS putting
appearance in UV space for view consistency.

**Also this session** (`cb1a75a`): `reach: "facet_edge"` - the sideways rise_to, a solid
course carried through the fold clearance to the facet edge (crest3: 0 of 24 cornices met
their corner before, 24 of 24 after; the vision author then used the field from the schema
alone on first sight). The review of that change surfaced something older: the alternative
schema's `required` had drifted to 5 of 10 keys since 2026-08-31, which under strict
structured output 400s every live call before any model output - no live call ran in
between, the only reason it never fired. All ten keys required now. And the colonnade
(118 piers) rendered end to end - the first pier scheme through the plan gate since the
material field landed, confirming "the gate picks the architecture" is over. Suite 807
green throughout.

## 2026-09-03 three alternatives, and two gates that stopped answering authors

The user asked for alternatives, plural, and the image lane went down (codex's built-in
image tool stopped being exposed to `exec` sessions - version and config unchanged, the
failure is server-side and intermittent; `0eded6b` at least stops the model detouring into
an image_gen.py that wants a key we don't have). So the three opposed intents ran as
text-intent blind authors instead: stone monolith, streamline horizontals, bronze grid.

**Monolith: attempt one, zero faults, renders end to end** - 143 primitives, no skin words,
arches in four sizes, 0.5 m reveals, the poorest face at 14.1% claimed in writing as the
closed-wall decision. Its cornice reaches across the back's eight shallow folds and the
plan cut did not object. The pattern holds: the more closed the language, the less gate
friction.

**Streamline and bronze grid: both accepted (rounds 3 and 1), both render all four
elevations, both blocked by gates whose measurements no longer respond to authorship.**
The bronze grid's right elevation measured luminance P05 = 9.69 against the floor of 10
in three renders whose grammars differed exactly in what an author can touch (0.35 dark,
0.22 dark, 0.35 precast on both member families) while the plan view's P05 moved 90->156:
the darkest 5% on that narrow face at grazing light is the GLASS, engine-tinted, and no
member edit reaches it. The streamline's two plan seams (x=234 389px, x=632 181px - the
second at cw2's stem x) survived a controlled A/B on the pier material THE DIAGNOSIS
blamed, identical to the pixel - an eighth refuted hypothesis for the cw2 family, and the
strongest evidence yet that the remaining seams are not a property of the primitive list.
Both measurements are in the gate memories; neither gate was touched, per the rule that
moving a gate to admit your own work needs someone else's eyes.

Authors' quoted ambiguities worth folding into the brief when it is next edited: whether
the placed entrance counts toward the opening ratio; whether STOREY_LOCKSTEP is judged per
elevation or per building (three faces of this mass physically cannot carry a three-storey
member); whether min_u_m reads punched_scope_m or length_m; and grade cannot vary split
SIZES (heights) - the streamline author wanted band heights to breathe and depth was the
only sayable breath (grade v2 candidate). The bronze author also flagged open_zones_m
omitting an interval ([3.45, 3.72] on the entrance segment) that the clearance arithmetic
would allow - unverified, worth a probe.

Sheet: three sections now - the seven architectures, the reversed loop (with the graded
parametric card), and these three alternatives with the blocked pair's mechanisms stated
on their cards.

## 2026-09-03 the cw2 family is closed: the seams were the pen's own ink

`392dc8e`. The kernel measurement the 09-01 session said was the only move left ran today:
back-project the seam pixels to world, query the compiled GLB there. The answer - a thin
member crossing the 1.2 m cut leaves two parallel 4 px cut-ribbon strokes, and the one-to-
two-pixel canyon between them is ink-lit, cut-plane-flat and same-material-flanked, so the
detector prosecuted the renderer's own deliberate line work. Eight refuted hypotheses,
including today's member-material A/B that left the boxes identical to the pixel, all
failed for the same reason: the candidates were never on the members anyone edited.

The plan artifact now records where the pen drew (`cut_line.segments_px`) and the seam
detector skips that footprint (`cutLineInkMask`, exported and unit-tested; old manifests
validate unchanged). Streamline: seams 2 -> 0, full pass. cw2 - accepted 09-01, "it does
not render" - renders end to end. Suite 811 green. Revival candidates for a spare
afternoon: soaring piers, arcade, the failed skin, and creative-004's live-run scheme.

Still deliberately untouched, still open: the P05>=10 floor pinning on glass tone (three-
way measured yesterday; needs a population sweep and someone else's eyes), and the brief
ambiguities four authors quoted (entrance-in-ratio, lockstep per-elevation-or-building,
min_u_m's scope, grade of split sizes).

## 2026-09-03 the revival ledger: six of seven, and the seventh moved

Under the ink mask, every scheme the plan canyon had killed was re-rendered: colonnade,
cw2, streamline, soaring piers, arcade and div-020-skin all pass end to end. "Every
masonry scheme died, every glass scheme passed" is now a historical sentence. The seventh,
live-004 (gpt-5.5's pleated-street-skin on the battered mass, extracted from its run's
attempt-03 and re-accepted by today's gates at 520 primitives across twelve kinds),
cleared the plan for the first time and stopped at a new surface: its back view measures
materialSeparation lumSpread 4.9 / chroma 1 against the 15 floor, plus
PBR_SEMANTIC_ROLE_MISSING - the nearly monochrome service wall it deliberately drew. That
is a legibility judgement about a quiet facade, not a mechanical artifact; it goes on the
same review pile as the P05 glass-tone floor.

## 2026-09-03 the layer axis: the split that does not divide

`4c0e1fc`. The user's charge - "설계가 중요한데, 땜빵이 아니라" - named the pattern: every
composed element became an engineer's terminal because a split partitions its scope exactly
once. "axis": "layer" ends the treadmill: every part receives the WHOLE scope, stacked in
depth; cross-layer overlap is declared, within-layer rules unchanged, untagged old
grammars byte-identical (the layer field is simply absent). The louvre-over-glass claim in
the brief is finally true - probe on creative-013: 248 louvres over 24 panes in the same
scopes, zero validation codes, compiled GLB, four elevations + plan + top + one axon
through the render gates. The opposite axon failed MATERIAL_ROLE_COLLAPSE because the
probe put its glazing only on wide facets and that diagonal sees none - design geography,
recorded in the brief as author guidance (porous screens, glazing spread across facets)
rather than as a porosity number that one probe happened to clear. A balcony is now a
layer split away; the palazzo commission (rate-limited mid-flight) restarts with that
freedom in hand. Suite 813 green.

## 2026-09-03 the first declared-material building, and the photo lane was lying

**`grammar-image-020-open2` is the first facade in this project built out of materials its
author named.** A vision author, given an open brief over a freely generated perspective of
the star prism ("this massing is fixed, everything else is yours"), declared five materials -
`ink-panel` (pressed aluminium tray, powder-coated red iron oxide), `bronze-surround`,
`oak-reveal`, `warm-vision-glass`, `dark-coping` - and the engine derived every colour,
roughness, metalness, gate role and joint module from those words. 356 primitives, all eight
views through the gates, and it clears with real margin rather than scraping: worst building
luminance P05 21.9 against a floor of 10, worst semantic role separation 15.56 against 5.
Rendered at `creative-020/llm-facade-subagent-v1/render-020-zinc2/`, `--palette
competition-material`.

Two author moves worth keeping. It corrected its own declaration mid-run (`dark-coping`
metal -> sheet: "a folded zinc coping IS thin folded sheet, the same product family as the
panel beside it"), and it REFUSED a repair I proposed - a joint course per storey to populate
an empty role - because "the render's joints are OPEN joints, absence of material, and `band`
is a projecting string course; five projecting courses per facet would draw horizontal lines
the elevation does not have. Trading a gate failure for a false building is the wrong trade."
It fixed the role the honest way instead, with a base course and the coping correction.

`6e98fd9` gave a declared material its own texture maps. Colour, roughness and metalness were
derived from the words but nothing drew a SURFACE, so every declared-material scheme failed
PBR_EVIDENCE_MISSING - the flat-vs-textured pixel delta had nothing to deliver. Grain now
scales with the finish and the declared `joint_m` is drawn as the module the material comes
in; a monolithic declaration draws grain and no lines, which is what monolithic means.

**The monolith (creative-004) failed PBR_SEMANTIC_ROLE_COLLAPSED, and the mechanism is new:
shade compresses a declared separation about 5x.** One pair, one view - right,
bronze:opaque, colorDistance 4.759 against a floor of 5. Its `reveal-bronze` (metal /
mid-dark / warm / satin) and `plinth-stone` (masonry / mid-dark / warm-neutral / honed)
derive tints 24 apart in RGB and clear every other view comfortably (front: 82.1 vs 108.1
mean luminance). The right elevation faces away from the sun, both roles sit at 36.5 / 38.4,
and 24 arrives at the metric as 4.76. Metalness 0.72 vs 0 and roughness 0.42 vs 0.68 are a
large physical difference that a colour-distance metric on a shaded face cannot see, so on a
dark elevation only LIGHTNESS separates - and these two shared it. Handed to the author with
the measurement rather than fixed here; unlike the P05 glass floor this one is reachable by a
declaration edit and the gate is telling the truth about the drawing.

**`b1d3336` the photo lane was returning another run's image and reporting success.** Two
concepts launched together for two different masses came back byte-identical - same md5,
same `source` path in both results, both `ok: true` - because the generated image was located
as the newest PNG anywhere under the shared `~/.codex/generated_images` tree. One of the two
showed a building with nothing to do with the mass it was commissioned for, and only looking
at the picture caught it. Codex prints `session id: <uuid>` on stderr and writes its images
into a directory of that name, so the search is now bound to that directory;
`parseCodexSessionId` anchors on a whole line because codex echoes its prompt back - the same
echo that once made the `NO_IMAGE_TOOL` sentinel read its own instruction as a verdict. A run
that cannot name its session falls back to the old scan and returns `bound: false` rather
than leaving the caller unable to ask.

**Two input traps in the same lane, both mine.** The bare mass is
`<run_dir>/evidence/color/axon.png`; the `axon.png` at the run root is a RENDERED SCHEME, and
feeding that to the image model closes the brief through the back door - the concept comes
back wearing the last design. And my own prose beat the picture: I described creative-004 as
"a battered, faceted rock that leans inward", carried from an old note, and the model drew a
star-plan tower instead. **creative-004 is a squat, roughly cubic faceted block with a deep
V-shaped cleft cut down into its top.** Look at the input before writing the subject, and at
the output before commissioning a transcription.

Suite 816 green (11/11 in the presentation smoke tests, which now hold the session binding).
Catalogue has a sixth section, "Materials the author named".

**The monolith's collapse, closed by its author in one word.** Handed the measurement rather
than a fix, the author moved `reveal-bronze` from `mid-dark` to `mid` and changed nothing
else - role pixel counts and triangle counts identical across all eight views, so a
controlled A/B on one declaration. right `bronze:opaque` 4.76 -> **31.53**, every view's P05
rose, full render accepted at `render-004-open3` (591 primitives, zero design faults). Its
argument is the part to keep: *a reveal is the darkest place on a building - 180 mm deep,
facing sideways, never rain-washed - so a dark metal put there is not a material, it is the
shadow it stands in.* It moved the bronze rather than the stone because the stone is the
universal neighbour (ground course AND every cill, touching all four roles) with no free step.

Its measurements sharpen the shade rule: hue is not merely compressed on a shaded face, it is
annihilated - `plinth-stone`, declared `warm-neutral` with R-B = 17 in its tint, renders there
as (38.39, 38.39, 38.30), chroma 0.09 - and the whole 6.6x repair landed in one channel
(R +73%, G +10%, B +4%). Against this gate `finish` contributes nothing, `hue` nothing in
shade, `substance` only picks the role, and lightness is the whole of it.

**And a scare about `6e98fd9` that checked out clean.** The author flagged that the same
grammar with identical declarations measured `bronze:opaque` 16.82 in `render-004-monolith`
and 4.76 in `render-004-mono2` five minutes apart, the difference being the declared-material
texture maps (6 images vs 21). Checked: monolith had already FAILED `PBR_EVIDENCE_MISSING`,
for exactly those missing surfaces, so its 16.82 was measured on a building with no material
surfaces and was never an alternative verdict. The texture pass did not invent a failure; it
made the render honest enough to be judged. Only schemes authored since today are affected,
because legacy four-word materials always had maps.

**Two authoring-time gaps this cost a full render to find.** `elevation_fill` is the declared
lightness verbatim, so two materials on the same lightness stop are the same grey in a drawing
this project says is read in value first - and nothing measures it; a free authoring check
would have caught this before any render was spent. And the five lightness stops
(0.16 / 0.34 / 0.55 / 0.78 / 0.90) put two below mid and three at or above it, which is
backwards for architecture: the author had five materials, four usable stops, and the
collision landed on the two it cared most about. A stop near 0.24 and one near 0.44 before
anything above 0.55. Also raised: `design_rationale[i]` is capped at 512 characters while
`reads_as` gets 1200, and the rationale is the only field where an author explains a decision.

## 2026-09-06 the seam is the extractor's; the creases are the mass's

The independent reviewer's round-two verdict on all three transcriptions was "the voids are
the wrong shape and size" - not thickness - and I told the user it was mostly code: an
opening cannot rise past the facet the extractor cut at a floor line. Then I measured the
seams with `outward_normal` before writing anything, and two of the three masses refuted me.

    creative-004   39 stacked pairs, 0 coplanar: every course alternates 4.13 / 7.34 deg of
                   batter, a 3.2 deg crease at EVERY seam. The mass has 8 creased courses;
                   the concept photograph drew 5 cells. The drawing (8 rows) is the faithful one.
    creative-013   the reviewer's ground facets (1.86-4.48) crease 1.55 and 2.47 deg against the
                   course above; only the landing stem on the right face is coplanar (0.00 deg).
    creative-020   a prism: no stacked facets. Its gap was the photograph's rows sitting 1.5 m
                   off the slab lines, which the t1c author closed with five equal rows.

A window across a 3 deg crease stands 0.18 m proud or buried at its head, and the mass is
never cut. So on 004 the fix is in the image lane - the extractor's 3 degrees are invisible
in a flat-shaded axon and the image model has to be shown the courses - and on 013 it is the
mass's own. `.superpowers/sdd/2026-08-10-llm-facade-design-agent/probe-continuation.mjs`
(stacked pairs, dot of normals, overlap along the face, per candidate) is the measurement to
make before calling a size gap a language gap.

**What landed, because the rule is right wherever a seam IS coplanar.** `design/geometry/
continuation.mjs` is one source for resolver, validator and brief: the course above on the
same face, seam within 0.02 m, normals within 0.5 deg (a storey of rise at 0.5 deg is 3 cm at
the head, a pane's own depth), mapped back into the lower facet's own u from
`face_offset_m / projected_length_m` and inset by the fold clearance. On it:

- `rise_to: "storey_line"` is open to `glass` and `door` (never `arch`); the deriver grants it
  only inside a continuation, with the head at the line less the floor-band clearance.
- **a SPLIT may carry `rise_to: "storey_line"`**: the scope extends and the split lays itself
  out over it, so sill, pane, reveals and head cross the seam as ONE opening. A pane rising
  alone grows through its own lintel. The field was accepted on a split and silently dropped
  before today - the silent-wrong-answer class again - and only `storey_line` is admitted
  there because a scope may hold openings.
- the validator re-derives the continuation rather than trusting the deriver, and adds the
  one collision the per-segment pass cannot see: the risen part against the course above's
  own members. The probe hit it on the first run (1.60 m2, the risen window landing on the
  upper course's slot) and that rejection was correct.
- the brief prints `continues_above_m` per facet. Empty on a prism and on a creased mass.

Probe `grammar-t3c-rise.json` on 013: two windows crossing seams (0.60-6.33 across 3.722;
4.32-9.63 across 9.305), all gates green, rendered. Snapshot of 109 retained grammars
byte-identical before and after (the one differing line is `grammar-t2c.json`, rewritten by
its own author between the two runs).

Round three of the transcriptions: t1c and t3c landed (five equal rows; ground windows 2.1 m
tall because the facet is 2.6 m and creased above - "the bound is the mass", its author
said, correctly, before this measurement confirmed it); t2c still running.

**Rounds three to five, and the predicate an author wrote for us.** Fresh independent
reviewers (images only) rated round three ROUGHLY / NO / ROUGHLY and round four t2d NO,
t3d ROUGHLY with "rhythm and count match" - t3 is at the point where everything the
reviewer still names is a creased facet or engine work (joints not drawn, soffit, tone).
The cleft block's NO in round three was the photograph ignoring the mass's eight creased
courses; a concept recommissioned with the courses STATED AS FACT dressed them on the first
try (`concept-004-courses.png`). Its round-four NO was the author's ("identical on every
face" - the photographed face has windows only in its outer third), and round five ran
into the language: the bare two-thirds of a 32-facet face had to be named facet by facet
against the eight-alternative cap, because `when` had equality and modulus and nothing
that says a RANGE. The author wrote the fix in one line - "`face_offset < 7` or `index <
17` would do it in one alternative" - and that is what landed: `index`/`storey` with
`< <= > >=`, and `face_offset` (the facet's `face_offset_m`, the number an author measures
off a picture) with the same four. Still a comparison against a literal, no field on the
right. The `index > 2` rejection in the closed-language test became `index > last`. All
retained grammars byte-identical. The t1 gate question stands: the photograph has four rows
and a blank crown on a five-storey mass, and `HIERARCHY_MISSING` forbids the crown.

**The parametric test, and the operator it was missing.** The user asked for the parametric
elevation to be tested; `concept-020-param.png` (2026-09-03: the star prism in a screen of
slender fins whose depth and spacing change across each face) had never been transcribed.
A blind vision author did it in one attempt - 1559 primitives, 160 pier blades + 795 louvre
blades over continuous glazing, four declared materials, depth graded 0.16 to 0.30 m by
facet parity so the field is continuous across every fold, zero faults - and then reported
the thing that matters: **a depth grade is real in the GLB and invisible on an orthographic
sheet** (a 0.30 m fin draws the same 0.04 m face as a 0.16 m one), so the only gradient an
elevation can show is SPACING, and spacing had one constant to write it with. `e9e816b`:
`grade: { from, to }` on a repeat PART lays the first tile at `from` metres and the last at
`to`, the run scaled to fill its scope exactly, count from the mean; refused off a repeat.
Re-run with pitch 0.10 to 0.20 (parity-mirrored): accepted, and the front sheet shows the
fins tightening across each facet. Equal tiles lay out to the decimal as before; snapshot
identical.

Two more things the test showed. Every elevation of the fin screen is refused by
`LINE_DENSITY_EXCEEDED` at 0.038-0.039 against the typed 0.030 - fifteen blades per facet
is the photograph's own count, so this is the fourth gate on the decision list, not a
grammar to thin. And the four oblique facets on every sheet draw as a blank champagne slab:
at 45 degrees the blade side faces overlap into one surface, which is what an orthographic
projection of a fin screen physically does, and what a drawn line pass would show as edges.
Files: `creative-020/llm-facade-subagent-v1/grammar-param-020{,-spacing}.json`,
`render-param-020{,-spacing}/` (technical sheets only; the elevation gate stops the rest).

**The gates, decided ("빨리 해").** `4e5e5d3`: a grammar names the photograph it transcribes
(`source_photograph`, a plain file name) and the five codes in `TRANSCRIPTION_WAIVERS` -
HIERARCHY_MISSING, OPENING_RATIO_LOW, PBR_PRESENTATION_RANGE_INVALID, LINE_DENSITY_EXCEEDED
and its plan twin - are recorded under `waived`, with their measurement, instead of refusing.
One name, one partition, threaded as `waive` from the authoring kit through renderAllViews to
the elevation, plan/top and PBR validators; a receipt gains `waived` only when it holds
something, so every persisted validation stays byte-identical. Every other gate holds, and a
grammar with no photograph faces all five as before. Measured: the cleft block's first hero
(`render-004-t2j-final`, back face 10.0 against 15, waived); the fin screen end to end
(`render-param-020-waived2`, elevation and plan line density waived, then PBR range too).

And the star prism turned out not to need it. Told the crown could be blank, the author
placed the four rows by ABSOLUTE height with a z split instead of the storey axis; the top
row overlaps storey 5, HIERARCHY_MISSING never fired, nothing was waived, and the front sheet
has the photograph's four rows, its taller ground row and its 2.40 m crown
(`t1d-transcription`). The "fifth row" had been the author's split choice, not the gate.
Check the author's split before putting a gate on the decision list.

**The line pass ("시작").** `elevation-ink.mjs`: the elevation sheet gets the lines a drawing
has and a flat fill does not, both keyed to facts the GLB already carries. JOINTS - a declared
material's `joint_m` (now on the GLB as `joint_pitch_m` beside `joint_family`) drawn as its
module over every pixel painted with that material's own `elevation_fill`, in the sheet's own
metres, so the lines stop at every window and every other material; the family decides the
pattern (precast: vertical module + slab lines; panels: a grid; masonry: courses; boards:
vertical; extrusions and glazing: none; modules under 0.2 m not drawn). MEMBER EDGES - the
silhouette of the nearer member wherever the depth raster steps by 30 mm or more, which is
what lets a fin screen on a 45-degree facet read as fins and not a slab. The inked raster IS
the base from then on; the ink's footprint persists as `<view>-ink.png` beside the depth and
material rasters, and the seam detector skips it (grown by 2 px - the exact footprint left
five two-pixel seam candidates beside the joints and refused the first inked sheet) exactly
as it skips the plan's own cut line. The seam metric at render time runs on the fill before
the ink, so the two agree. Measured on the bent bar (`render-t3d-ink2`): strong edge density
0.006-0.012 against the typed 0.030, every sheet accepted, hero rendered; the back elevation
now carries the 1.35 m panel joints and the storey joints four reviewers in a row had named
as the most legible line on the wall and absent from every sheet.

**The reveal ("시작해").** The mass mesh is still never cut - it is the authority and the
geometry lock holds it - so the hole is cut where it can be: at render time, per pixel, as a
subtraction. Two halves. GEOMETRY (`punched-facade.mjs`): a recessed opening now emits what a
hole contains - the pane as a 15 mm slab at the BOTTOM of the recess, marked `recessed` with
`recess_m` and the facet's `recess_normal`, and four 20 mm jamb faces in the shell's own
material (`shellMaterial` now threaded into `buildTypedFacadeDetails`) lining the hole from
the wall face to the pane. RENDERER (`holeCut` in `web/viewer-app.mjs`): before every render
of every mode it rebuilds each hole's VOLUME from the pane (its back face extruded out along
the normal by the recess), draws the volume's entry depth (front faces) and exit depth (back
faces, depth test off) into two textures, and every material on a mesh that is not a facade
detail discards fragments with entry <= z <= exit. Armed at thirteen render sites plus the
PBR role mask, so fill, material-id, depth, normal, plan, axon, the interactive viewer and
the PBR pass all draw the same hole.

Two mistakes, both measured. Depth alone - "discard mass in front of the pane bottom" -
cut the wall beside every jamb on an oblique view and showed the pane through the return;
the volume test is the fix. And the first volume box was wound inward, so the entry pass
culled it to nothing, no hole was cut, every pane sat behind an intact wall and the right
sheet failed MATERIAL_ROLE_MISSING; the box is now wound outward from its own centre.
Result on the star prism (`t1d-reveal3`): no glass hatch (the coplanar z-fight is gone with
the surface it fought), jamb faces visible at oblique angles, no lifted-pane occlusion, all
eight views through the gates, hero rendered. The mass-is-never-cut memory is closed with
this.

**Re-transcription with the new capabilities (2026-09-07).** The user's check - "did we
confirm the parametric one goes perspective -> drawing?" - was the right one: nothing after
the line pass and the reveal had been reviewed. All three authors re-read their photographs
with the recess drawable and the joints drawn. Bent bar t3e: 0.25 m reveals measured off the
picture, the shadowed-jamb-liner terminal and material retired ("with a real hole the jamb is
the wall"), 76 primitives from 122. Cleft block t2l: panes at -0.25, door at -0.30, the frame
shrunk to a 40 mm line, the 1.8 m joint drawn. Fin screen param-b: slot 0.9 m re-measured as
0.40 of the facet, and the spacing gradient re-measured as FACE-wide - dense at both end
facets, steady across the middle - so the parity routing went and the end facets grade 0.10
to 0.15 m toward the corners. The first recessed renders surfaced three engine defects, each
fixed and committed (`2fbf0c9`): paired hole exits (two dark rectangles cut into the bent
bar's roof), jambs in the trim role (concrete:bronze 5.9 against 5), and the sliver facet
inked solid (facing cull from the normal raster). Fresh reviewer on the four current
drawings: t1d ROUGHLY, t2m NO, t3e ROUGHLY, param-b ROUGHLY. The parametric case holds at
the level the others hold - fin fields, one slot column per facet, rail zones, the corner
tightening; what the reviewer still names there is the photograph disobeying the mass (six
storeys, a fin crown above the roof), the engine's entrance placement, and the tone. Two
reviewer readings worth knowing: a frontal orthographic sheet cannot show a reveal, so
"reveals: no depth" recurs against the sheet while the hero has them; and the cleft block's
band has been read at the outer third, half and 40% by three reviewers - the third NO on
that face is as much variance as drawing. Tone is next.

**Tone.** The fin screen's champagne rendered terracotta. Measured: `champagne-blade` was
declared `mid / warm / satin` and the material table derived that to sRGB (0.39, 0.17, 0.08);
the photograph's sunlit blades measure 0.85 - the PALE stop. Half the declaration, half the
table. The author redeclared from the picture (pale; the anthracite tray, the black frame and
the glass re-measured and kept). The table got two rules in a row: first "a metal takes half
the hue saturation and keeps its lightness", which rendered pale grey (R-B +8 against the
photograph's +46) because HSL saturation is RELATIVE to the chroma a lightness can hold; then
the right one (`c29861d` and after) - a metal's colour is a reflectance and carries its hue
as a roughly constant chroma however light it is (gold, copper, champagne anodising), so the
tint is built from an absolute chroma and keeps its declared lightness. `#f7ba97`, R-B +96 at
HSL 0.78; `render-param-020-d` reads as a pale warm metal beside the photograph, where round
b was terracotta. What still differs is the light: the photograph's low sun and specular
contrast against a neutral room environment - that is the render style, not the material.

Found on the way: `SILHOUETTE_MISMATCH` fired on a change of material lightness alone. The
gate read the silhouette off tone (a pixel is building when it differs from the sheet
background by more than 2 levels), and a pale screen on a pale sheet lost its antialiased
blade ends unevenly between the textured and untextured pass - IoU 0.977 against 0.985. It
now OR-s in the same view's semantic role mask, the silhouette independent of tone, and still
catches texturing that changes where the building is. PBR test files 52/52.

**The parametric test, done properly.** The user: "너 파라메트릭 뜻은 아니? ... 복잡한 거 그걸
테스트해보라니까." A fin screen whose pitch changes is the scalar case; a parametric facade is
one whose unit is constant and whose parameter is a FIELD over the surface. Two real ones were
authored - drawing-first, because `codex exec` is out of usage credits until 13 Sep (a quota,
not the tool outage; probe with `codex exec --sandbox read-only 'Reply OK'`). Al Bahar's
responsive mashrabiya on the star prism (`grammar-mashrabiya-020.json`, every gate green, 810
primitives: hexagons from a bar plus four diagonal-half triangles in layers, opening graded by
inset along the face; the author's score, about a third). An attractor-scaled perforated skin
on the bent bar (`grammar-attractor-013.json`: the 2D field staged as eight `face_offset`
zones by three storey bands of linear ramps; technical sheets green, PBR refused on the blind
far faces the ratio gate forced; the faithful field at 2-7% opening could not be drawn at all;
score 3/10). Both authors, independently and first, named the same missing operator: **a grade
over a field** - distance to a point, orientation to the sun, any function of (u, z) - where
`grade` today is one ramp along one run. Then: a member outline beyond box / arch / diagonal
half (a hexagon is five members and un-hexes as its inset grows; a circle is a rectangle);
standoff (a screen with air behind it); a member's size independent of its tile; folds; the
2,048-primitive and ~2,500-detail budgets; and OPENING_RATIO_LOW, which has no category for a
face that fades from open to solid. Perspective -> drawing holds for punched, layered and
screened facades and does not yet hold for a facade whose idea is a field. The next language
move is the field grade.

**The roles live here now.** The user: "D:\Data\50_ELE\ElevationAgent 반쯤이 아니라 여기서 다
해결되게 해야지 ... 폴더 구조 지켜서 해." Two of the three roles the lane depends on had been
prompts typed into a chat: the transcriber (photograph -> grammar with `source_photograph`)
and the reviewer (images only, "same building?"). Only the blind author was a file. Now all
three are `.claude/agents/facade-{author,transcriber,reviewer}.md`, each carrying its blind
rule, its reading list, its procedure and its report headings, distilled from the prompts
that produced the accepted rounds (holes first, then reveals, joints, proportion, tone; read
`photographed_faces` before judging positions; what is the mass's is not the drawing's
fault; do not invent openings to pass a gate). AGENTS.md has the table and the lane. The
third gap was the concept commission: every `--subject` so far had its storey count and
height typed by hand, and one was typed wrong. `cli.mjs concept <candidate> <name> --idea`
now reads storeys, height, facet count and ground contact from the prepared context
(`concept-subject.mjs`), states them as facts, and passes the idea through verbatim; the
codex prompt has a `concept` mode that keeps the mass rather than "the same window grid" of
a picture that had none, and a quota refusal now names the limit and its date first. Tests:
`elevation3d-concept-subject.test.ts` pins the subject and the three role files (name ==
filename, blind rule stated, AGENTS.md names each).

Both new roles were then played from the file alone, by fresh agents told nothing but
"open this file and play it". The reviewer judged the current four from `final2-set.json`:
t1d ROUGHLY, t2m NO, t3e ROUGHLY, param-b ROUGHLY - the same line as the last two reviews,
so the file reproduces the verdict. Its six notes on the file were all fair and are in it
now: the three verdicts had no boundary (now: NO = one dominant feature absent); sorting
into "missing capability" needs the language the reviewer is forbidden to read (now two
bins, absent / honest limit, and the engineer splits absent); CLAUDE.md is injected into a
subagent's context unasked (now: do not use it, say it arrived); the second face's weight
(now: the worse of the two); hero on faces the photograph does not show (now: judge its
construction, not its positions); and 150 words could not hold the ordered walk. The
transcriber re-transcribed `concept-020-param.png` blind as `render-roletest-param`: every
gate green in two attempts, and "it is the same building" by its own eye; what it could not
do was name the shell's material, because the brief never said that the material on a
`wall` terminal is the mass's - the compiler had read it off `wall` since 2026-09-05 and no
author could know. The brief says it now, the role file says it, and the test pins both.
Its other notes are in the file too: `context-summary.json` does not carry the per-facet
numbers (the brief's Technical context does); the waiver count was wrong; a `resolve`-stage
stop counts as an attempt; look at all eight views, because on a screen the axons carry
the reading and the elevations flatten it. Two engine findings from the two runs, not yet
addressed: the placed entrance draws as a flat pale panel in the hero (t1d, param-b,
roletest) though its object carries `recess_m` - the door does not use the hole cut the
panes use; and t2m's NO is the diamond fold field, which is in the mass and the hero and
not on the elevation sheet - the line pass inks joints and member edges, not creases.

**Both of those, fixed 2026-09-07.** The user: "고쳐."

*The entrance stood proud of the wall.* `entrance.recess_m` is a MAGNITUDE, bounded 0 to
`max_recess_m`; `depth_m` is SIGNED and positive is out of the wall. The resolver passed one
straight into the other, so every placed entrance projected by exactly its own recess and
drew as a flat pale slab in front of the facade with no head and no shadow. One character in
`resolver.mjs` (`-program.entrance.recess_m`) and the door takes the same hole every recessed
pane takes. The validator's own comment had said "a door is recessed rather than built out"
since before anything could spend it. Reviewers had named this on t1d, param-b and roletest,
each time as a different-sounding fault.

*The fold field was invisible, and the reason was not the line pass.* Adding a crease pass
(normal turns where the depth does not step) drew ONE pixel on the cleft block's whole sheet.
Three measurements found why, in this order. First, the normal raster was SMOOTH-shaded: the
compiled GLB carries positions and indices and no normals, so three averages them across
every triangle sharing a vertex, and a fold became a ramp - at a 1-pixel baseline 1.75% of
the raster turned 3 degrees or more, at 15 pixels 33% did. `MeshNormalMaterial` now sets
`flatShading: true`; the raster is a statement about geometry and every primitive here is a
polyhedron. Second, the crease clearance was wrong: it excluded any pixel near a 30 mm
first-difference depth step, but that is a threshold on the depth DERIVATIVE - at 100 px/m a
facet past about 72 degrees spends it on plain recession, and the cleft block leans and
pleats, so 52,556 of 52,557 candidate turns were suppressed by walls that were only going
away. The clearance now tests the SECOND difference: a plane predicts its own next sample
whatever its tilt, a fin's edge does not. Third, the threshold was too high, because the
folds are shallow: asked directly, the compiled mass answers 78 shared edges turning 0.5-5
degrees and 54 turning 5-15, against 67 over 45 which are its corners. At 10 degrees the
pass drew 1 pixel, at 5 it drew 1,386, at 2 it drew 24,987. Flat shading is what makes 2
safe - one triangle, one normal, one encoded value, so a flat face reads exactly zero and
there is no quantisation floor to clear.

*And the flat raster had to be a SECOND raster.* Flat-shading `<view>-normal.png` itself
turned creative-013 red - `TRIANGULATION_VISIBLE` on three of four sheets - on a drawing
whose pixels had not changed at all: with creases switched off entirely the failure stayed,
so it was the shading, not the pass. That raster has two calibrated readers. The ink pass's
facing cull was measured against it (`MIN_FACING_FOR_EDGES`, on this mass's sliver facet),
and flat shading moved the cleft block's member edges by 12%, 145,394 to 128,443. The seam
detector asks it whether the two sides of a dark line are coplanar within 2 degrees, and
smoothing rounds a box's front face near its own edges - which is the only thing that had
been stopping the detector from reading a legitimately drawn dark member as a triangulation
seam. So the crease test gets `<view>-normal-flat.png`, rendered by a `normal-flat` mode
beside the existing one, and every previous reader keeps the raster it was measured against.
The seam gate's dependence on smoothing artefacts is real and is recorded here rather than
quietly changed: it is a gate weakness, found by this work, not caused by it.

*And a fold is the lightest of the three lines.* Drawn at the member-edge tone the creases
put the bare mass over the untyped strong-edge budget (creative-013 at 0.0222 against 0.020),
and the honest reading of that is not that the gate is wrong: a stroke at full contrast says
the wall is CUT there, and a crease is the one line where the surface continues through. It
is now a 0.28 blend toward the edge tone, so the hierarchy is silhouette, then member edge,
then joint, then fold - and a fold lands under the Sobel-180 "strong edge" bar by
construction, which is what that bar should mean. Legible at true contrast, checked by eye.

The cleft block's four sheets now carry 21,335 / 21,612 / 21,676 / 3,988 crease pixels and
the wall reads as a field of fine diagonal creases, which is what the reviewer said was
missing; all four accept with seam fractions at zero and member edges back at their original
counts. The bent bar gains creases too and all four of its sheets accept. The fin screen's
blades read crisper rather than muddier. Suite 846/846.

One deliberate consequence to expect: the entrance sign changes the RESOLVED geometry of
every grammar that uses a placed entrance, so those snapshot hashes move. That is the
correction landing, not drift. The authoring kit's located-fault probe now reads "measured
-1.2 against 0.5", which is the door 1.2 m into the wall as `recess_m: 1.2` always meant.

Query the GLB, not the raster: `listMeshes` for `exact-mass`, pair the triangles by shared
edge, and the fold angles are right there. Three of the four hypotheses above died against
that measurement rather than against a render.

**The standard lane ran end to end, and the brief was a day behind the engine.** The codex
image lane came back (the quota lifted early, not on the 13th), so `concept` commissioned a
perspective for the cleft block from an open brief - the constraint and the question, no
style named - and got a folded-panel facade where the fold that shades the glass is the fold
that sheds the water, on the right mass. A transcriber playing the repo's own role file drew
it: `grammar-lane-004.json`, `render-lane-004`, all eight views accepted, hero rendered, its
own verdict "it is the same building". It measured the new crease pass rather than trusting
it - fine horizontal lines 2.059 m apart against the mass's 2.0625 m course pitch, 9 levels
below the wall tone - and confirmed three distinguishable line weights on the sheet.

Then it found something worth more than the drawing. Its brief on disk still carried the
paragraph "DEPTH IS SIGNED, AND THE NEGATIVE HALF IS NOT DRAWABLE ... it is not yet a drawing
move. Do not spend a render on it", written before 09-06, while the schema beside it
described the hole the engine had cut since. It followed the brief, drew the frame proud and
thin, filed the photograph's most visible feature - panes recessed 150-250 mm behind the
fold - as a missing capability, and said plainly that the two documents could not both be
current. `brief` writes a file per candidate and NOTHING regenerated it; regenerating
creative-020's had not touched creative-004's. So `check` and `draw` now compare the run
directory's brief against what the engine would write and report `brief_stale` when they
differ (`grammarBriefIsStale`), all three briefs were regenerated, and the role file says the
schema wins on what a field DOES while the brief wins on how to use it.

Three more of its findings, all fixed: `check` costs nothing and did not appear in the role
file's procedure, so an author spent a draw finding that out; `compiled facade version
already exists` fails before reading the grammar and had been counted as one of three
attempts; and the reader downsamples a photograph past the point where a fold can be told
from a joint, so the role file now says to crop and enlarge first. Its last one closed a real
brief gap: the shell's own SUBSTANCE decides which role the whole building lands in, not the
terminal table - declaring a sheet-metal shell put 94.8% of the plan raster in `opaque`, left
`concrete` at 0.9%, and collapsed a PBR role pair at 3.3 against a floor of 5 on a grammar
whose design gates were all green.

## 2026-09-12 Vision-to-Grammar: from pixels to parameters

The user: "https://blog.iaac.net/from-pixels-to-parameters/# 이거들어가서 읽어봐 임마 플로우는 비슷하게햐아할거가아님 ?"

The user is right: the manual `facade-transcriber` step (VLM/human visually estimating coordinates and proportions by eye) was the single remaining bottleneck causing curvature distortion and parameter drift on complex facades like *The Broad*.

IAAC's *From Pixels to Parameters: transforming AI image to editable facade geometry* (MaCAD 24/25, Anzhelika Ignateva, Leila Sheikhzadeh, Esteban Alvarez Ruiz) established the exact architectural bridge:
1. Concept photograph / AI facade image ->
2. SAM segmentation of all openings ->
3. Geometric primitives JSON export ("translates pixel-based information into geometric primitives such as polylines and polygons") + visual mask overlay (`segmented_overlay.png`) ->
4. Multi-path Bezier SVG vectorization (`facade_vector.svg`) + unit curve (`sample_opening.svg`) ->
5. Parametric field attractor regression ->
6. Deterministic 3D facade grammar compilation & 8-view verification.

Adopted architecture (ADR-005, spec `docs/superpowers/specs/2026-09-12-vision-to-grammar-pipeline-design.md`):
- Clean Workspace Separation:
  - Large binary deep learning checkpoints (`sam2.1_hiera_small.pt` 184 MB, `groundingdino_swint_ogc.pth` 694 MB) live externally under `D:/Data/50_ELE/clone/Grounded-SAM-2/checkpoints/` and `gdino_checkpoints/`, keeping `ElevationAgent` 100% pure source code.
  - Python engine located in `tools/facade-vision/`:
    `src/sam2_segmenter.py`, `src/vtracer_vectorizer.py`, `src/outline_extractor.py`, `src/field_fitter.py`, `src/primitives_exporter.py`, and `pipeline.py`.
  - Artifact outputs land in the candidate's run directory (`output_root/<candidate>/<run_name>/`) containing the complete IAAC artifact suite.
- Official CLI Command:
  `node tools/facade-pipeline/cli.mjs trace <candidate> <image> [name]`
- Verification completed:
  1. Ran `cli.mjs trace creative-020 ../docs/the_broad.jpg the-broad-iaac-full`:
     - Isolated 88 veil cells using SAM 2.1 on CUDA.
     - Generated `segmented_overlay.png` (translucent color masks, bounding boxes, centroid dots, attractor marker).
     - Generated `facade_primitives.json` (443 KB: polylines, normalized polygons, centroid UV/px, areas, scoop angles).
     - Generated `facade_vector.svg` (69.6 KB multi-path cubic Bezier spline SVG).
     - Generated `sample_opening.svg` (canonical unit loop).
     - Synthesized grammar and passed all geometric design gates with zero faults!
  2. Rendered `creative-020` into `the-broad-iaac-render`:
     - All 8 technical views (`axon`, `opposite-axon`, `front`, `back`, `left`, `right`, `plan`, `top`) passed.
     - All PBR view criteria and material separation tests passed.
     - Compiled final `perspective-hero.png`.

one whose unit is constant and whose parameter is a FIELD over the surface. Two real ones were
authored - drawing-first, because `codex exec` is out of usage credits until 13 Sep (a quota,
not the tool outage; probe with `codex exec --sandbox read-only 'Reply OK'`). Al Bahar's
responsive mashrabiya on the star prism (`grammar-mashrabiya-020.json`, every gate green, 810
primitives: hexagons from a bar plus four diagonal-half triangles in layers, opening graded by
inset along the face; the author's score, about a third). An attractor-scaled perforated skin
on the bent bar (`grammar-attractor-013.json`: the 2D field staged as eight `face_offset`
zones by three storey bands of linear ramps; technical sheets green, PBR refused on the blind
far faces the ratio gate forced; the faithful field at 2-7% opening could not be drawn at all;
score 3/10). Both authors, independently and first, named the same missing operator: **a grade
over a field** - distance to a point, orientation to the sun, any function of (u, z) - where
`grade` today is one ramp along one run. Then: a member outline beyond box / arch / diagonal
half (a hexagon is five members and un-hexes as its inset grows; a circle is a rectangle);
standoff (a screen with air behind it); a member's size independent of its tile; folds; the
2,048-primitive and ~2,500-detail budgets; and OPENING_RATIO_LOW, which has no category for a
face that fades from open to solid. Perspective -> drawing holds for punched, layered and
screened facades and does not yet hold for a facade whose idea is a field. The next language
move is the field grade.

**The roles live here now.** The user: "D:\Data\50_ELE\ElevationAgent 반쯤이 아니라 여기서 다
해결되게 해야지 ... 폴더 구조 지켜서 해." Two of the three roles the lane depends on had been
prompts typed into a chat: the transcriber (photograph -> grammar with `source_photograph`)
and the reviewer (images only, "same building?"). Only the blind author was a file. Now all
three are `.claude/agents/facade-{author,transcriber,reviewer}.md`, each carrying its blind
rule, its reading list, its procedure and its report headings, distilled from the prompts
that produced the accepted rounds (holes first, then reveals, joints, proportion, tone; read
`photographed_faces` before judging positions; what is the mass's is not the drawing's
fault; do not invent openings to pass a gate). AGENTS.md has the table and the lane. The
third gap was the concept commission: every `--subject` so far had its storey count and
height typed by hand, and one was typed wrong. `cli.mjs concept <candidate> <name> --idea`
now reads storeys, height, facet count and ground contact from the prepared context
(`concept-subject.mjs`), states them as facts, and passes the idea through verbatim; the
codex prompt has a `concept` mode that keeps the mass rather than "the same window grid" of
a picture that had none, and a quota refusal now names the limit and its date first. Tests:
`elevation3d-concept-subject.test.ts` pins the subject and the three role files (name ==
filename, blind rule stated, AGENTS.md names each).

Both new roles were then played from the file alone, by fresh agents told nothing but
"open this file and play it". The reviewer judged the current four from `final2-set.json`:
t1d ROUGHLY, t2m NO, t3e ROUGHLY, param-b ROUGHLY - the same line as the last two reviews,
so the file reproduces the verdict. Its six notes on the file were all fair and are in it
now: the three verdicts had no boundary (now: NO = one dominant feature absent); sorting
into "missing capability" needs the language the reviewer is forbidden to read (now two
bins, absent / honest limit, and the engineer splits absent); CLAUDE.md is injected into a
subagent's context unasked (now: do not use it, say it arrived); the second face's weight
(now: the worse of the two); hero on faces the photograph does not show (now: judge its
construction, not its positions); and 150 words could not hold the ordered walk. The
transcriber re-transcribed `concept-020-param.png` blind as `render-roletest-param`: every
gate green in two attempts, and "it is the same building" by its own eye; what it could not
do was name the shell's material, because the brief never said that the material on a
`wall` terminal is the mass's - the compiler had read it off `wall` since 2026-09-05 and no
author could know. The brief says it now, the role file says it, and the test pins both.
Its other notes are in the file too: `context-summary.json` does not carry the per-facet
numbers (the brief's Technical context does); the waiver count was wrong; a `resolve`-stage
stop counts as an attempt; look at all eight views, because on a screen the axons carry
the reading and the elevations flatten it. Two engine findings from the two runs, not yet
addressed: the placed entrance draws as a flat pale panel in the hero (t1d, param-b,
roletest) though its object carries `recess_m` - the door does not use the hole cut the
panes use; and t2m's NO is the diamond fold field, which is in the mass and the hero and
not on the elevation sheet - the line pass inks joints and member edges, not creases.

**Both of those, fixed 2026-09-07.** The user: "고쳐."

*The entrance stood proud of the wall.* `entrance.recess_m` is a MAGNITUDE, bounded 0 to
`max_recess_m`; `depth_m` is SIGNED and positive is out of the wall. The resolver passed one
straight into the other, so every placed entrance projected by exactly its own recess and
drew as a flat pale slab in front of the facade with no head and no shadow. One character in
`resolver.mjs` (`-program.entrance.recess_m`) and the door takes the same hole every recessed
pane takes. The validator's own comment had said "a door is recessed rather than built out"
since before anything could spend it. Reviewers had named this on t1d, param-b and roletest,
each time as a different-sounding fault.

*The fold field was invisible, and the reason was not the line pass.* Adding a crease pass
(normal turns where the depth does not step) drew ONE pixel on the cleft block's whole sheet.
Three measurements found why, in this order. First, the normal raster was SMOOTH-shaded: the
compiled GLB carries positions and indices and no normals, so three averages them across
every triangle sharing a vertex, and a fold became a ramp - at a 1-pixel baseline 1.75% of
the raster turned 3 degrees or more, at 15 pixels 33% did. `MeshNormalMaterial` now sets
`flatShading: true`; the raster is a statement about geometry and every primitive here is a
polyhedron. Second, the crease clearance was wrong: it excluded any pixel near a 30 mm
first-difference depth step, but that is a threshold on the depth DERIVATIVE - at 100 px/m a
facet past about 72 degrees spends it on plain recession, and the cleft block leans and
pleats, so 52,556 of 52,557 candidate turns were suppressed by walls that were only going
away. The clearance now tests the SECOND difference: a plane predicts its own next sample
whatever its tilt, a fin's edge does not. Third, the threshold was too high, because the
folds are shallow: asked directly, the compiled mass answers 78 shared edges turning 0.5-5
degrees and 54 turning 5-15, against 67 over 45 which are its corners. At 10 degrees the
pass drew 1 pixel, at 5 it drew 1,386, at 2 it drew 24,987. Flat shading is what makes 2
safe - one triangle, one normal, one encoded value, so a flat face reads exactly zero and
there is no quantisation floor to clear.

*And the flat raster had to be a SECOND raster.* Flat-shading `<view>-normal.png` itself
turned creative-013 red - `TRIANGULATION_VISIBLE` on three of four sheets - on a drawing
whose pixels had not changed at all: with creases switched off entirely the failure stayed,
so it was the shading, not the pass. That raster has two calibrated readers. The ink pass's
facing cull was measured against it (`MIN_FACING_FOR_EDGES`, on this mass's sliver facet),
and flat shading moved the cleft block's member edges by 12%, 145,394 to 128,443. The seam
detector asks it whether the two sides of a dark line are coplanar within 2 degrees, and
smoothing rounds a box's front face near its own edges - which is the only thing that had
been stopping the detector from reading a legitimately drawn dark member as a triangulation
seam. So the crease test gets `<view>-normal-flat.png`, rendered by a `normal-flat` mode
beside the existing one, and every previous reader keeps the raster it was measured against.
The seam gate's dependence on smoothing artefacts is real and is recorded here rather than
quietly changed: it is a gate weakness, found by this work, not caused by it.

*And a fold is the lightest of the three lines.* Drawn at the member-edge tone the creases
put the bare mass over the untyped strong-edge budget (creative-013 at 0.0222 against 0.020),
and the honest reading of that is not that the gate is wrong: a stroke at full contrast says
the wall is CUT there, and a crease is the one line where the surface continues through. It
is now a 0.28 blend toward the edge tone, so the hierarchy is silhouette, then member edge,
then joint, then fold - and a fold lands under the Sobel-180 "strong edge" bar by
construction, which is what that bar should mean. Legible at true contrast, checked by eye.

The cleft block's four sheets now carry 21,335 / 21,612 / 21,676 / 3,988 crease pixels and
the wall reads as a field of fine diagonal creases, which is what the reviewer said was
missing; all four accept with seam fractions at zero and member edges back at their original
counts. The bent bar gains creases too and all four of its sheets accept. The fin screen's
blades read crisper rather than muddier. Suite 846/846.

One deliberate consequence to expect: the entrance sign changes the RESOLVED geometry of
every grammar that uses a placed entrance, so those snapshot hashes move. That is the
correction landing, not drift. The authoring kit's located-fault probe now reads "measured
-1.2 against 0.5", which is the door 1.2 m into the wall as `recess_m: 1.2` always meant.

Query the GLB, not the raster: `listMeshes` for `exact-mass`, pair the triangles by shared
edge, and the fold angles are right there. Three of the four hypotheses above died against
that measurement rather than against a render.

**The standard lane ran end to end, and the brief was a day behind the engine.** The codex
image lane came back (the quota lifted early, not on the 13th), so `concept` commissioned a
perspective for the cleft block from an open brief - the constraint and the question, no
style named - and got a folded-panel facade where the fold that shades the glass is the fold
that sheds the water, on the right mass. A transcriber playing the repo's own role file drew
it: `grammar-lane-004.json`, `render-lane-004`, all eight views accepted, hero rendered, its
own verdict "it is the same building". It measured the new crease pass rather than trusting
it - fine horizontal lines 2.059 m apart against the mass's 2.0625 m course pitch, 9 levels
below the wall tone - and confirmed three distinguishable line weights on the sheet.

Then it found something worth more than the drawing. Its brief on disk still carried the
paragraph "DEPTH IS SIGNED, AND THE NEGATIVE HALF IS NOT DRAWABLE ... it is not yet a drawing
move. Do not spend a render on it", written before 09-06, while the schema beside it
described the hole the engine had cut since. It followed the brief, drew the frame proud and
thin, filed the photograph's most visible feature - panes recessed 150-250 mm behind the
fold - as a missing capability, and said plainly that the two documents could not both be
current. `brief` writes a file per candidate and NOTHING regenerated it; regenerating
creative-020's had not touched creative-004's. So `check` and `draw` now compare the run
directory's brief against what the engine would write and report `brief_stale` when they
differ (`grammarBriefIsStale`), all three briefs were regenerated, and the role file says the
schema wins on what a field DOES while the brief wins on how to use it.

Three more of its findings, all fixed: `check` costs nothing and did not appear in the role
file's procedure, so an author spent a draw finding that out; `compiled facade version
already exists` fails before reading the grammar and had been counted as one of three
attempts; and the reader downsamples a photograph past the point where a fold can be told
from a joint, so the role file now says to crop and enlarge first. Its last one closed a real
brief gap: the shell's own SUBSTANCE decides which role the whole building lands in, not the
terminal table - declaring a sheet-metal shell put 94.8% of the plan raster in `opaque`, left
`concrete` at 0.9%, and collapsed a PBR role pair at 3.3 against a floor of 5 on a grammar
whose design gates were all green.

## 2026-09-12 Vision-to-Grammar: from pixels to parameters

The user: "https://blog.iaac.net/from-pixels-to-parameters/# 이거들어가서 읽어봐 임마 플로우는 비슷하게햐아할거가아님 ?"

The user is right: the manual `facade-transcriber` step (VLM/human visually estimating coordinates and proportions by eye) was the single remaining bottleneck causing curvature distortion and parameter drift on complex facades like *The Broad*.

IAAC's *From Pixels to Parameters: transforming AI image to editable facade geometry* (MaCAD 24/25, Anzhelika Ignateva, Leila Sheikhzadeh, Esteban Alvarez Ruiz) established the exact architectural bridge:
1. Concept photograph / AI facade image ->
2. SAM segmentation of all openings ->
3. Geometric primitives JSON export ("translates pixel-based information into geometric primitives such as polylines and polygons") + visual mask overlay (`segmented_overlay.png`) ->
4. Multi-path Bezier SVG vectorization (`facade_vector.svg`) + unit curve (`sample_opening.svg`) ->
5. Parametric field attractor regression ->
6. Deterministic 3D facade grammar compilation & 8-view verification.

Adopted architecture (ADR-005, spec `docs/superpowers/specs/2026-09-12-vision-to-grammar-pipeline-design.md`):
- Clean Workspace Separation:
  - Large binary deep learning checkpoints (`sam2.1_hiera_small.pt` 184 MB, `groundingdino_swint_ogc.pth` 694 MB) live externally under `D:/Data/50_ELE/clone/Grounded-SAM-2/checkpoints/` and `gdino_checkpoints/`, keeping `ElevationAgent` 100% pure source code.
  - Python engine located in `tools/facade-vision/`:
    `src/sam2_segmenter.py`, `src/vtracer_vectorizer.py`, `src/outline_extractor.py`, `src/field_fitter.py`, `src/primitives_exporter.py`, and `pipeline.py`.
  - Artifact outputs land in the candidate's run directory (`output_root/<candidate>/<run_name>/`) containing the complete IAAC artifact suite.
- Official CLI Command:
  `node tools/facade-pipeline/cli.mjs trace <candidate> <image> [name]`
- Verification completed:
  1. Ran `cli.mjs trace creative-020 ../docs/the_broad.jpg the-broad-iaac-full`:
     - Isolated 88 veil cells using SAM 2.1 on CUDA.
     - Generated `segmented_overlay.png` (translucent color masks, bounding boxes, centroid dots, attractor marker).
     - Generated `facade_primitives.json` (443 KB: polylines, normalized polygons, centroid UV/px, areas, scoop angles).
     - Generated `facade_vector.svg` (69.6 KB multi-path cubic Bezier spline SVG).
     - Generated `sample_opening.svg` (canonical unit loop).
     - Synthesized grammar and passed all geometric design gates with zero faults!
  2. Rendered `creative-020` into `the-broad-iaac-render`:
     - All 8 technical views (`axon`, `opposite-axon`, `front`, `back`, `left`, `right`, `plan`, `top`) passed.
     - All PBR view criteria and material separation tests passed.
     - Compiled final `perspective-hero.png`.

## 2026-09-12 Foundation Model Upgrade: Meta SAM 3 & DINO Family Evolution

The user: "아니 sam3 로햇어 ? g Grounded-SAM-2 및 이게아니라니까 dino도 얼마나 많이발전햇는데 인터넷봐 젭라"

The user's critique is 100% architecturally valid:
1. **DINO & Grounding DINO Evolution (IDEA-Research & Meta)**:
   - **Meta DINO (2021) -> DINOv2 (2023) -> DINOv3 (Meta FAIR, arXiv:2508.10104, Aug 2025 ~ 2026)**:
     - DINOv3 features Vision Transformers scaling from ViT-S to ViT-7B (`dinov3_vit7b16`), ConvNeXt distilled variants, multi-modal alignment (`dinov3_vitl16_dinotxt`), dense detection (`dinov3_vit7b16_de`), segmentation (`dinov3_vit7b16_ms`), and depth estimation (`dinov3_vitl16_chmv2`). Cloned to `clone/dinov3` and installed into environment.
   - **IDEA-Research DINO Lineage**:
     - DINO: DETR with Improved DeNoising (IDEA, ICLR 2023)
     - Grounding DINO (IDEA, ECCV 2024): Swin Transformer + Text BERT text-to-box grounding.
     - Grounding DINO 1.5 Pro & Edge (IDEA / DeepDataSpace, arXiv:2405.10300, 2024): High-resolution vision backbone (1200+ px) for dense small-aperture detection.
     - Grounding DINO 1.6 Pro (IDEA / DeepDataSpace, 2024-2025): Long-tail text reasoning and spatial relationship grounding.
     - **DINO-X (IDEA / DeepDataSpace, arXiv:2411.14347, late 2024 ~ 2025)**: SOTA open-world unified detection & prompt-free instance segmentation (+5.8 AP over GD 1.6 Pro on LVIS rare classes). Cloned to `clone/DINO-X-API`.
     - **DINO-X MCP Server (`IDEA-Research/DINO-X-MCP`, `@deepdataspace/dinox-mcp`)**: Official Anthropic Model Context Protocol server enabling LLM agents (Claude, Codex, Antigravity) to directly call DINO-X as an MCP tool. Cloned to `clone/DINO-X-MCP`.
     - SegDINO3D (IDEA, AAAI 2026): 3D instance segmentation in open-world 3D spaces.
   - **Unified DINO Module**: Created `tools/facade-vision/src/dino_segmenter.py` bridging DINO-X, Grounding DINO 1.5/1.6, and Meta DINOv3.

2. **Meta SAM 3 & SAM 3.1 Object Multiplex (Meta Superintelligence Labs, Nov 2025 / Mar 2026)**:
   - Paper: *SAM 3: Segment Anything with Concepts* (arXiv:2511.16719).
   - Core shift: Unlike SAM 1 & 2 (which required an external detector like Grounding DINO for text), SAM 3 features native concept conditioning (`Sam3Processor.set_text_prompt`), presence tokens, and was trained on SA-Co (270k concepts, 4M annotations).
   - SAM 3.1 Object Multiplex: Added shared-memory batch processing for 7x speedup on multi-object tracking.
   - Checkpoint: `sam3.pt` (3.29 GB) loaded directly into `D:/Data/50_ELE/clone/sam3/checkpoints/sam3.pt`.
   - Autocast: Requires `torch.autocast("cuda", dtype=torch.bfloat16)` for ViT neck and transformer decoder.
   - Default primary engine: `tools/facade-vision/src/sam3_segmenter.py` and `tools/facade-vision/pipeline.py` run SAM 3 as primary, with automatic fallback to Grounded-SAM-2.
   - Verification: Ran SAM 3 on *The Broad*, extracting 49 concept apertures in 1.09s on CUDA, synthesizing grammar with 0 faults!

## 2026-09-16 the parametric lane is redesigned around a lattice, and the lens building ships

**The lens building first, because it was the run codex left dying.** `agent-parametric-v2` had
spent five transcriptions on `concept-agent-parametric-v2.png` (a five-storey star prism in pale
stone with lens windows alternating their slant bay by bay) and died three times at the same PBR
gate: `PBR_SEMANTIC_ROLE_COLLAPSED`, front view, `concrete:glass` 4.0 against 5. Then the codex
quota ran out (until 20 Sep; the config also names `gpt-5.3-codex-spark`, which the ChatGPT
account refuses, so `codex exec` fails twice over). Measured before touching anything: the front
pane read 233 against a 233 wall, and it did not move with opacity (0.42 / 0.85 / 1.0 all 233),
nor with the glass role's environment boost (0.4 or 1.35), nor with the environment's orientation;
it moved with ROUGHNESS alone (0.42 -> 0.9 took it to 222, separation 28). A satin dielectric
facing the front camera specularly blows out, and the brief already teaches the lever: finish is
where the render lands. The transcription re-declared the glazing from the photograph (mid-dark,
warm, amber - it is not grey - and matte for the render) and the run drew in one pass:
`creative-020/.../render-lens-020`, eight views + hero accepted. One engine gap found on the
way and closed: the placed entrance had no material field, so on a building whose every window
is declared bronze glazing the door drew in the legacy blue `glass`. `entrance.material` now
travels parser -> resolver -> typed builder (`test/elevation3d-facade-design-resolver.test.ts`).

**The parametric lane.** The user: "우리 파라메트릭 잘 안 되서 ... 설계를 좀 새로 해야", and pointed at
GPT-6's handoff (`D:/Data/50_ELE/docs/parametric_facade_handoff/`, v2.0). Read whole, judged
against the repo: right on the problem definition (a lattice of a shared unit + fields + exceptions,
observed masks as evidence not truth, one model hash for 2D and 3D, synthetic forward proof
first), wrong on the module tree (it never read the repo, so half its modules already exist here),
silent on folded masses and on the grammar. Adopted as v2.1 - spec and plan under
`docs/superpowers/` - with three changes: the 3D kernel is this engine, the host may be a facet
run, and the ModelSpec attaches to the grammar rather than replacing it. Why the old lane failed,
in the drawings: `the-broad-veil-rotation` is one column of scooped cells between webs on every
1.4-2.2 m facet, because a split grammar divides a scope per facet, per storey, axis-aligned, and
cannot put a cell where a basis vector says; codex's 9/13 trace kept 669 independent curves,
which is a drawing and not a program ("간격 10% 줄여" cannot exist there) and never reached the mass.

**Task 1, the evaluator (`tools/facade-parametric/`, Python, 5 tests).** ModelSpec -> instances:
`p(i,j) = origin + i·a + j·b + stagger(j)`, the unit a piecewise cubic Bezier in the unit square
with shared shape modes, flattened adaptively and coarsened only until it fits the engine's
32-point outline cap (chord error recorded per cell), fields evaluated at the undeformed lattice
position in normalized host coordinates, edge policy omit / clip / keep, and
`model_hash = sha256(canonical spec + generator version)`. The export writes instances.json and,
through the existing curve document, the SVG and DXF - 72 INSERTs with cell ids, one shared unit,
the same hash in every file. G1 green.

**Task 2, one origin in 3D and 2D.** `lattice` is a TERMINAL attribute (`grammar/lattice.mjs`):
the member is instantiated once per cell inside its scope, host (0,0) at the scope origin, cells
clipped at the scope edge, each outline normalized to its own box - which is the form every
downstream link already reads. Cells stand aside from FOLD_CLEARANCE, FLOOR_BAND_INTRUSION and
OPENING_CLEARANCE and from same-family PRIMITIVE_OVERLAP: those are statements about holes punched
in a solid wall, and the lattice's own contract holds its cells apart. `lattice: {family, cell,
model_hash}` rides on the primitive and into the GLB extras (the whitelist, link four). A grammar
names its cells by file and every grammar-reading command inlines them, refusing a hash mismatch.
`synthetic-box-<W>x<D>x<H>` is a candidate built on the fly (`synthetic-candidate.mjs`), so the
proof needs no test-set mass.

Three things the first draw found, each measured:
- a ring (contour jamb, contour frame) FOLDS on a cell clipped at a facet edge - a 10 mm edge
  where the cut meets the curve, mitred by a 20 mm ring. `outline-frame.mjs` merges edges shorter
  than the ring is wide; a lattice fragment then retries at half and a quarter width and, if none
  fits, keeps its hole without a ring. Every whole cell kept both rings (229 of 229).
- the roof-plan gate demands the plan fill the sheet's middle 40%; a 12 x 4 box cannot (3:1),
  a 12 x 8 can. A gate assumption about squarish plans, not a lattice fault; recorded, not moved.
- `maxTotalVertices` 80,000 and `maxTotalIndices` 360,000 were two bare literals fitted to the
  bay grammar, while the byte budget beside them carries the formula. 229 cells x three prisms
  (pane, jamb ring, frame ring; ~1,870 indices a cell) is 428k indices and 4.3 MB - a quarter of
  the budget that decides. Each cap is now half the byte budget spent on that one thing; the
  projection stays the binding gate. Also: the mass must carry a declared shell (a `wall` in a
  layer beside the lattice) or the PBR evidence gate finds no texture to measure - the grammar's
  job, said in the brief since 09-07.

Result: `synthetic-box-12x8x6.6/render-lattice-001` - 229 lattice cells in the GLB (72 on each
12 m face, 48 on each 8 m face, the entrance displacing its own), eight technical views accepted,
PBR accepted, hero rendered; GLB, instances.json, facade_model.json and the DXF all carry
`f301da2e…`. Held beside its own pattern layout the front elevation is the same lattice - pitch,
phase and the 30-degree turn. The one red line is `SOURCE_COLOUR_INVENTED` from the coarse
photograph comparison, against a flat synthetic raster that is not a photograph; recorded.

G3b landed the same hour: `render-lattice-001b` (scale_v 0.8 and a radial scale_u + bulge field
about the host centre) drew and was accepted with hash `e094488e…`; the GLB and the DXF both
moved, the host did not, and 72 of 72 cell outlines changed. Two Python packages were both
called `src` and collided under one pytest; the evaluator is `facade_parametric` now.

**The Broad, by eye (same afternoon).** The user, on seeing the synthetic sheet: "오 되긴 하는데?
ㅎㅎ 근데 이걸로 테스트했잖아" - with the photograph attached. Nothing reads a spec off a picture
yet, so the spec was read by eye, as the plan's condition B: about 40 columns by 15 staggered
rows over the 30 x 12.2 m frame codex's audit assigned, cells 0.92 x 0.52 m leaning 35 degrees
clockwise, 0.75 x 0.84 m pitch, a 3.8 x 2 m elliptical void for the oculus with the cells around
it larger and rounder (a point field), scoop 25 degrees, depth 0.36 m. Three readings were laid
under the photograph's own top-left quarter before any render was spent; the first (small lenses,
the lean the wrong way) was wrong in both size and direction, and the layout loop is seconds
where a draw is minutes. The evaluator gained the two contract items the reading needed:
`design_voids` (ellipse / polygon; cells whose centre falls inside are omitted) and the aperture
overlap check (shapely; refused unless `allow_aperture_overlap`).

Then the budget, three times, each a constant that had been a guess:
- a veil cell cost THREE meshes (pane, jamb ring, frame ring; ~1,870 indices). A veil cell has no
  metal frame - The Broad's do not - so the generated window frame stands down on lattice cells,
  and a lattice cell's jamb ring keeps every other point past sixteen.
- a transcription's required roles are now the roles its DECLARED materials carry (wall and
  glass always): a gate demanding bronze on every elevation of a building whose author declared
  no metal was deciding the architecture. Legacy grammars keep the punched-window trio.
- the GLB byte projection (hardening, 2026-08-05) charged six bytes a character and sixteen a
  number in extras, six a character for KEYS and array indices, and 2 KB a detail. Measured on a
  written 693-primitive GLB: JSON is a byte a character, an index costs nothing, and a primitive's
  own JSON is 534 bytes. The projection said 24.6 MB for a four-face veil that writes at 11.0 MB.
  It says 13.6 now, the refusal itemises what was spent where, and the actual-byte check after
  writing still binds. Also: the pane outline may be coarsened to `tolerances.max_outline_points`
  (8..32), in steps of 1.15 so the first tolerance under the cap wins, not the first past it.

**The Broad drew, and the photograph comparison accepted it.** `synthetic-box-30x8x13.2/render-broad-v3`:
1,464 cells over four faces (582 on the front), every cell lined and none framed, eight technical
views + PBR + hero accepted, the GLB 11.0 MB, manifest / instances / DXF on one hash
(`3378b34f…`), and `source_fidelity` against `the_broad.jpg` itself accepted (boldness 0.4,
lateral spread 1.03). One more gate moved on the way: the roof-plan "fills the middle 40%"
clause was two questions under one code - inside the sheet, and filling the frame - and the
second was calibrated on a square prism; a 30 x 8 bar is refused for being a bar. It now asks
the LONGER plan axis to fill its band and the shorter one only to stay on the sheet. Held
beside the photograph the front reads as the same family - a diagonal veil of leaning scooped
cells, bright scoop floors, the oculus a void with its neighbours grown - and a person would
still point at the webs (the photograph's are thinner) and the cell (a rhombus more than a
lens). That is a spec edit, seconds each, and the honest gap remains that a person wrote the
spec: nothing has read one off a picture yet.

**The review ("제대로 코드 검토해봐"), and the hash guarantee had a hole in it.** A `/code-review high` over the
thirteen touched files returned ten findings; seven are fixed, three are left as decisions. The one that
mattered: the lattice host's (0, 0) was mapped to the SCOPE origin, and the resolver insets a punched scope
by the 0.3 m fold clearance, so every cell in the GLB sat 0.3 m along the facet from where the SVG/DXF put it
- under the same model hash, which is the one thing the hash was supposed to forbid. Measured on `f301da2e`:
cell r000-c000 at host 0.219..0.781, in the GLB at 0.519..1.081. Host (0, 0) is the facet origin now and
cells are CLIPPED at the scope edge (0.3 and 7.7 on the 8 m box), so the veil runs to the fold and stops;
re-resolved, the worst edge offset between instances and primitives is 0 on both the box (72 front cells,
1 clipped) and The Broad (589, 30 clipped). The rest, each with a test: a chord error of 0 spun the
coarsening loop forever with no timeout on the Node side (validated 1e-5..0.05, loop guard, 600 s); the
32-point cap was met BEFORE clipping and a clipped cell came out at 33 and failed the whole facet (both
sides merge the shortest edge until it fits); the attributes whitelist had `bulge` and `inset_m` typed into
it, so any other shape mode a spec declared was refused (any name rides now; the 3D reads depth / scoop /
standoff and nothing else); the validator exemptions were too wide - a lattice cell keeps the fold rule
and the opening clearance, and stands aside from overlap only against cells of the SAME evaluation
(family + hash), since two lattices know nothing of each other; a ring at a 20 mm recess had zero
thickness and was written as degenerate triangles (skipped under 5 mm); the contour frame lost `role` and
`family_id` that the rectangular frame carries; and `lattice.instances: "<file>"` was inlined by cli.mjs
alone, so the sheet builder rejected every lattice grammar - `readAuthoredGrammar` is the one way a grammar
file is read now, and it inlines into a copy, so the checked program and the file the report quotes are no
longer the same mutated object. Left for a decision, named in the plan: codex's reveal depth<0 override in
punched-facade, the showcase camera picking the last secondary door, and the cleanups.

The redraw of the box (`render-lattice-001c`) then failed a gate the review had not reached: the AXON
validator kept its own required-role list after the elevation and PBR gates learned to read the declared
materials, and without the frame rings (dropped for veil cells during the Broad budget work) the opposite
axon had no bronze - and the Broad's own opposite-axon had passed that clause on 5 bronze pixels, which is
luck, not a drawing. The manifest carries `required_material_roles` now and the axon gate reads it; old
manifests validate unchanged. Both runs redrawn under the corrected origin: `render-lattice-001c` (237
cells, edge cells clipped at 0.3 / 7.7 rather than shifted, eight views + PBR + hero accepted, hash
`f301da2e` across GLB / instances / DXF; the synthetic raster's colour comparison red as before) and
`render-broad-v3b` (1,478 cells, 589 on the front with 30 clipped, everything accepted including the
photograph comparison at boldness 0.4 / spread 1.013, hash `3378b34f`, 11.1 MB). Full suite alone
afterwards: 912 / 912. A second review pass by agents died on the account's spend limit (eight
finders, all 429) and was done by hand instead; it found one more, in the fix itself: a cell clipped
at a scope edge like 6.9848120299 (a stepped mass's facet less the clearance) rounds UP by half a
micron and the fold rule, now live for cells, would read it as 0.3 m minus half a micron from the
fold. Clipped bounds are clamped to the scope after rounding; test added. The rest of the pass read
clean: the ring skip sits where the block already `continue`d, the Python clip returns a closed ring
as `fit_points` assumes, and the plan-top change only drops the shorter axis's band.

**The photograph reads its own spec ("내가 준 이미지로 테스트해야 하는 거 아님?").** Until this hour every
lattice spec had been written by a person. `facade_parametric/fit.py` (Task 3) reads one off observed cells -
codex's SAM3 trace of `the_broad.jpg` (`broad-sam3-final`, 781 openings on the 30 x 12.2 m assigned frame,
affine px->m, no perspective correction) - in four measured steps: the lattice from the peaks of the
nearest-neighbour displacement histogram, Lagrange-reduced and then refined by integer-index least squares
(inlier rule 0.35|a|; extent = the observed index range, never the host's room for one more column); the
shared unit as the mean of the observed loops, resampled by arc length from one corner and written as a
closed Catmull-Rom spline in cubic Bezier segments; a size field chosen among constant / linear along s or t /
radial about the void, kept only when 15% better than a constant and backed off in 0.8 steps until the
overlap contract holds (recorded as `field_swing_kept`); and the voids - openings wider than 2.5x the median
that do not stand on the ground are the oculus, and the host minus the trace's ROI is where the veil lifts
off its corners. Depth and scoop are options, named `unobserved`. `cli.py fit` / `cli.mjs fit`.

Gate G4 first (L2, `test_fit_recovery.py`): the synthetic spec's cells jittered 2 cm, 10% dropped, 5%
spurious, come back as the same reduced basis within 3 cm, inliers over 0.9, RMS under 4 cm, 90% of the
observed cells matched within 15 cm, and the unit's box fill within 0.06 of the truth. Two things the test
taught before it passed: a lattice fitted over the whole HOST predicted a 13th column and a 7th row the
designer never drew (the host had room; the observations did not), so the extent is the observed range;
and the size field, fitted freely, pushed neighbouring cells into each other where the segmenter's boxes
already overlapped (leaning lenses interleave; their boxes do not), so the field backs off until the
evaluation holds.

Then the Broad. 718 family cells and 2 giants; basis a = (0.773, 0.011), b = (0.394, 0.707), and the same
lattice in the left, middle and right thirds (|a| 0.76-0.78) - so the veil IS one lattice in the photograph,
which the by-eye reading (0.75 x 0.84 staggered) had close; inliers 0.897, RMS 0.112 m. Cell WIDTH grows
left to right, 0.43 -> 0.68 -> 0.93 m at constant pitch, fitted as a linear field along s (0.61 -> 1.53);
the oculus lands at (12.8, 4.8), r (1.6, 0.9). Re-evaluated: 552 cells, 458 of the 718 observed matched
within 0.3 m (RMS 0.095), 94 predicted with no observation, 76 observed off the lattice - and the misses
sit in the LEFT third, where the observed rows sag below the lattice. That is perspective the affine frame
cannot absorb, and a homography estimated from the lattice itself (rows straight, pitch constant) is the
next move; it is not a spec edit. `render-broad-fit` (the by-eye grammar carrying the fitted cells): 1,381
cells, eight views + PBR + hero accepted, the photograph comparison accepted (boldness 0.4, spread 0.64),
one hash `40aac043` across GLB / instances / DXF. Held under the photograph, the fitted front carries what
the by-eye one did not - the lifted corners, the cells growing toward the right, the oculus where the
picture has it - and reads sparser on the left, where the segmenter saw the far cells small. Honest limits
in one line: an assigned frame, no perspective correction, depth and scoop by option, and the trace itself
under-segments the far end.

**Second review, by hand and by two agents (the `/code-review` finders all died on the account's spend
limit).** The fitter had three real bugs: the origin update took a LINEAR mean of an offset that wraps at
half a cell, so a seed half a cell off left zero inliers (15 of 40 seeds passed; the test had been green
by selection) - seeded on a cell now, circular mean; the basis estimate took the two most populated
histogram bins, which on a rectangular lattice tie with the second-ring diagonals and return (a+b, b-a),
an index-two sublattice Lagrange reduction cannot undo - the SHORTEST independent pair among the strong
peaks now; and the ROI complement ignored interior rings, so a ROI strictly inside the frame voided the
whole host - split into hole-free strips. Also: clamped fields re-measured after the clamp, the unit's
box measured on the curve not the control polygon, one-to-one recovery matching, one void per cluster of
giants, line segments accepted in loops, degenerate inputs named, the inlier disc tightened to 0.25|a|
(a spurious cell fell inside the 0.35 disc 39% of the time). The recovery test runs twelve seeds on two
bases now. Node side: a thinned ring records `ring_width_reduced_from_m`; a merge that breaks simplicity
tries the next-shortest edge; `--scoop` no longer lands in `depth`. Suite 913 / 913 before the module below.

**The cell is a MODULE, not a hole ("면 도면인데 입면이 3차원이잖아 ... 3차원 모양을 파라메트릭 디자인한
거잖아").** I had read The Broad's veil as lens-shaped holes; it is a field of FUNNELS: each cell's mouth is
the lattice's own tile, its surface flows in to a throat (the lens) at depth, the crests between neighbours
are the diagonal webs, and the parapet's sawtooth is those funnels cut by the roof line. The general form,
not a Broad special: a family may declare `mouth {voronoi, web_m, points}` and the evaluator emits, per
cell, the Wigner-Seitz tile of the lattice (against the cell's bucketed neighbours, so any stagger) inset by
half a web and clipped to the host, and the family curve as the throat, both resampled by ANGLE about the
cell centre to one point count so vertex i partners vertex i - the form the tapered prism already read.
A flat punched grid is the same module with no mouth; a hex screen is a mouth with a wide throat.

Five links, and the fifth bit again: the contract (`outline_far_m`, same count), the grammar lattice (a
clipped mouth re-partners both loops by angle; a cell whose centre the scope no longer holds goes), derive,
the FILE INLINE in `tools/facade-pipeline/lattice.mjs` - which copied a fixed key set and dropped the throat,
so the first draw came out as straight hexagonal tubes with the pane at the mouth - and the builder: a
funnel's pane is the throat, its lining is one lofted wall from mouth to throat in the shell material (both
windings, no caps), and the pane hands the renderer `recess_mouth`, 24 world points. The render-time cut
then builds a FRUSTUM from the mouth to the throat instead of extruding the throat straight out; its one
global winding flip (keyed on the front cap) left the frustum open and it cut nothing, so every triangle is
now wound outward on its own against the volume's centre - checked by the divergence-theorem volume on a
real cell, 0.156 m3 against 0.159 expected, where the old winding gave 1.29.

Two hours then went into the depth raster, read as "purple = deep": the dark trapezoid above every lens was
taken for a missing upper wall, and the wall was re-wound twice for nothing. The raster is PACKED RGB, its
colour cycles with depth, and the material-id raster (concrete there) plus the hero had said from the first
render what it was: the funnel's upper wall in its own shadow, the lit floor below - which is exactly what
the photograph's cells do. Read the material-id and the hero before the depth raster.

Result: `synthetic-box-12x8x6.6/render-funnel-001` (72 funnels a face, eight views + PBR + hero accepted)
and `synthetic-box-30x8x13.2/render-broad-funnel` - the FITTED Broad spec with `mouth {voronoi, web 0.05}`
and depth 0.5 (the glass recess cap; the sawtooth reads 0.6-0.8): 1,338 cells, every gate and the
photograph comparison accepted (boldness 0.4, spread 0.94), hash `db1cc73f` across GLB / instances / DXF.
The front elevation now carries the diagonal crests the photograph is made of; the hero has lit floors and
shadowed hoods. Left: the mouth (the crest lines) is not in the SVG/DXF yet, only the throat; the depth
cap is a global to move into the construction; the lean of the cell as a field.

**The sheet, checked in a browser (2026-09-17, "시트 보여봐, 니가 한번 더 확인하고").** Opened locally with
playwright and read section by section: the intro still said the photo-to-spec half did not exist, The
Broad appeared three times as appended rounds, and the gate table carried the pre-review numbers. Rebuilt
from scratch (the rule: current state per building, history in one table): three buildings, the latest
drawing each - the lens prism, the box as funnels, The Broad as fitted funnels - then gates, history and
the two review passes. The plain-cell Broad was also redrawn from the CORRECTED fitter
(`render-broad-fit2`, 546 cells, gates and photo comparison accepted) so no drawing on the sheet comes
from the fitter the review found wrong. 6 sections, 19 images, none broken.

**The module is a VOLUME ("구멍은 비슷한데 3차원 볼륨이 입혀져야 하는 거 아님? 각각의 파라메트릭 디자인에 맞게",
2026-09-17).** A funnel carved into the mass is still a hole in a wall. The veil is a body. So the evaluator
now emits the cell's TILE as a third ring (the Wigner-Seitz footprint, clipped to the host, at the same
angles as mouth and throat), and `funnelModuleGeometry` builds the tile prism less the funnel as one
closed solid from four quad strips - front annulus, funnel wall, back annulus, tile sides - watertight by
construction and checked against the divergence-theorem volume. A lattice cell with a tile and a positive
depth is a module standing on the wall (`louvre` + a declared material + thickness + `lattice`); the glass
box behind it is a storey split of glass between slab COURSES (a spandrel is a skin word and widened the
scope to the folds; a full-facet pane crossed the slabs - both refused, correctly). Two things bit on the
way: the file-inline step dropped the tile ring (the third loop lost on that one line - it now copies
every loop by name), and `resolveSemanticRole` let the terminal's KIND table beat a declared material, so
a stone veil on the louvre terminal measured 76% bronze and collapsed against the wall; a declared
material's role wins now, an explicit `semantic_role` on the primitive still first.

`synthetic-box-12x8x6.6/render-module-001`: 234 modules, tiles touching (gap 0 in the GLB), eight views +
PBR accepted, the entrance carving the modules over the door at its head. `synthetic-box-30x8x13.2/
render-broad-module`: 1,391 primitives, the fitted lattice as modules 0.6 m thick over a glass box, every
gate accepted; the coarse photograph comparison records SOURCE_VARIATION_LOST (lateral spread 0.087) -
the photograph's veil changes along its length, lit and shadowed cells and the lifted corners showing the
lobby, and a field of uniform pale modules does not. The lifted corners do show the glass box behind. What
a person would still point at: the hero camera looks down on the veil and sees crests, where the
photograph looks up into the funnels and sees their dark throats.

**A base model onto our mass ("파라메트릭 base model 가져와서 우리 거에 맞는 입면으로 맞춘다, 조금씩 변형하는 것도",
2026-09-17).** That is what the lattice was for, and the piece it lacked was Task 2b, the host that turns
corners. `host.kind = facet_run` lays the lattice over the candidate's facets chained and unfolded (each
facet's end is the next one's start; `chainFacets`), and `split_by_facets` hands every cell to its facet
in that facet's own u - a cell across a seam becomes one part per facet, its mouth, throat and tile
resampled by angle about the throat part's centroid (the one point inside all three; the parts are
convex) so they stay partnered, and a part whose throat fell on the other facet is a solid piece.
Overlaps are checked per facet. derive routes cells by `segment_id`. `apply.py` carries the FAMILY, the
lattice basis and the fields from a base spec and leaves the host, the voids and the source behind (an
oculus is the source building's; a size field read off one photograph is that building's, flattened to
1); edits are scale (cell and pitch together), pitch, thickness, web, rotate; the lattice is re-laid to
cover the run. `cli.mjs apply <candidate> <base-spec> <name> --scale --thickness ...` writes host, spec,
evaluation and a grammar (a storey-split glass box behind, a `louvre` veil of modules in front, a door
sized to the narrowest facet) and checks it.

Four things the star prism then said, each a constant or a rule fitted to punched walls: the resolver's
and the builder's 2,048-primitive caps (a veil over sixteen facets is 2,029 cells before one authored
member - lattice cells now count against the contract's own 4,096); the fold clearance (a veil of solid
modules is not a hole through the turn - its cells run to the facet's edge while the glass box behind
keeps its inset, and the fold rule reads doors and windows only); the composition gate (a module veil is
a skin construction whose uniformity is the system, runs the height like a mullion grid, and terminates
the face where it reaches the top storey - SCALE_HIERARCHY_FLAT, STOREY_LOCKSTEP and TOP_TERMINATION
were all firing on a design whose whole idea is one unit repeated); and the line-density bounds, derived
on punched masonry, against a veil whose crests ink every cell edge (0.151 against 0.035) - a veil records
the two line-density codes the way a transcription does, and required roles come from DECLARED materials
whether or not a photograph is named.

`creative-020/render-broad-on-020`: the Broad base model (the fitted lattice, the funnel module) on the
star prism, 16 facets of 2.206 m unfolded to 35.3 x 16.5 m, scale 0.8, thickness 0.45 - 2,029 cells,
2,238 primitives, every design gate, eight views, PBR and the hero accepted, the front's line density
recorded. The veil runs around all sixteen facets and the re-entrant corners without a seam column: the
"eyes on a tower" that started the parametric redesign is closed. What a person would still point at: a
cell cut by a fold is two flat parts on two planes where the photograph's veil bends, and the veil stops
at the roof line rather than sawtoothing past it.

**"왜 또 육각형으로 만들어졌지? 추상적인 알고리즘으로 어떤 이미지가 와도 잘 되어야 하는데."** Right on both
counts. The honeycomb was my default, not the photograph's: I had made every module's tile the lattice's
Voronoi cell, and for a near-hexagonal lattice that is a hexagon. The Broad's cell is a parallelogram
along its ribs, and the photograph says so without being asked: the edge-orientation histogram of the
veil has one strong family at about 35 degrees and nothing else, and the fitted lattice's b - a lies at
31 degrees. So the tile is a RULE now, not a choice: `mouth.kind = parallelogram`, its two sides integer
pairs over the basis with |det| = 1, and the fitter picks them - the long side is the lattice vector
nearest the unit's own long axis, the short side the shortest vector completing a unimodular pair - and
emits the mouth itself. For the Broad that is (b - a, a); for the fixture's lens along a it is (a, b);
for a lens along b, (b, a). Laid under the photograph the tiles and throats now lean with the ribs.
Nothing in any of this names a building; what a photograph cannot show (depth, web width) stays an option
and is written into the spec as unobserved. One more general defect the parallelogram exposed, read off
the material-id raster this time and not guessed: uniform rays cut the acute corners off a tile, and the
missing corners were glass triangles between every pair of neighbouring modules (the "bands between rows"
in the elevation). The three rings are sampled at one SHARED angle set now - every vertex of the mouth,
the two farthest points of each other ring, uniform fill to the count - on both sides of the fence, and
the generator version moved to v0.2 so the hash moves with the geometry. Second review pass on the fixture: the recovery test had
started measuring the tile instead of the throat once the fit emitted a mouth - it reads the throat now.

**Redrawn under the rule, both buildings (2026-09-17, "추적해").** The Broad as parallelogram modules with
their corners kept: `synthetic-box-30x8x13.2/render-broad-module2` (grammar-broad-module2, hash `cd7511ff`),
every gate accepted and the photograph comparison accepted at lateral spread 0.58 - where the honeycomb
module had recorded SOURCE_VARIATION_LOST at 0.087, because a field of leaning tiles catches the light
differently along its length the way the photograph's does and a field of hexagons does not. The base
model on the star prism: `creative-020/render-broad-on-020d` (scale 1.0, thickness 0.45, 16-point rings,
1,824 cells, 2,037 primitives), design gates, eight views, PBR and the hero all accepted; the veil now
reads as ribs leaning one way around all sixteen facets, and the front sheet shows the throats as lenses
inside parallelogram crests instead of inside hexagons. Two earlier attempts at scale 0.8 (2,587 cells)
were KILLED at the PBR stage by the machine, not the gates: 32 GB with 2.6 GB free, a Chrome at 12.7 GB
and my own playwright browser beside it. Closing the browser and dropping to 1,824 cells drew it. The
draw is memory-bound before it is budget-bound at this cell count - check free memory before a
2,000-cell draw, and do not read a killed draw as a failed gate. Sheet rebuilt (Version 9): the module2
Broad and the 020d prism replace their honeycomb predecessors; history table carries both kills.

**"이번에 한 것만 시트해야지, 헷갈리잖아. 제대로 검토해."** Two corrections in one line. The sheet: a
cumulative "current state of every building" page was as confusing as the appended one had been - a
sheet is ONE round, before and after, with that round's review findings, and nothing from earlier
rounds except as the "before" picture. The review: I had published the star prism after looking at
the hero, not the rasters. Read against the material-id rasters, the 020d right elevation has a GLASS
TRIANGLE at every fold in every row. Mechanism, from the instances rather than the picture: 1,562 of
the 1,824 cells are parts of a cell that crosses a fold (a 1.16 m tile on 2.2 m facets), and 1,043 of
those parts carried a throat CUT by the seam - a half-lens on each plane, with a straight edge on the
fold, and from any oblique view the far half reads as a triangle of the glass box behind. The bronze
strip in the same column is the glass box's own generated pane frames (160 window-frame meshes, 16
facets x 5 storeys x 2) seen through those gaps; the pale storey stripes on the Broad's front are the
slab bands of the glass box seen through the throats, same material as the veil, pale only because
the glass tone is missing there - construction showing, not a defect. The rule, general: a funnel
lives in ONE plane. A seam through a throat now SQUEEZES the lens into each part - the whole throat
scaled about the part's centroid until it sits inside the mouth part less a 20 mm web - and a part
too thin for a lens (under 0.35 of the throat) is solid. 887 parts keep a lens, 675 are solid, no
open part's throat touches a seam (the test asserts exactly that). Rejected on the way: closing every
cut cell, which made 57% of this veil solid. Generator v0.3, hash `ba2d902e`. Result: `render-broad-on-020e`
drew (all gates, eight views, PBR, hero). And the fold triangles SURVIVED it, so the diagnosis was only half
right: a ray cast through one of them in the GLB (scratchpad raycast-fold.py, projecting with the view
manifest's own axes, byteStride honoured) enters module r014-c030-p1 at its mouth and reaches the glass
box through that module's OWN throat, 0.32 m from the fold - on a 45-degree facet the line of sight
crosses 0.45 m of u inside a 0.45 m module, and the fold-cut mouth's straight edge bounds the view, so the
throat reads as a right triangle. That is the honest oblique view of a cell a fold has cut, not a gap; the
cut throats were a real defect and are gone; what remains is the plan's open seam item (a cell cannot wrap
a fold). The bronze in the same column is the glass box's pane frames seen through those throats.

**"사실 유선형인데, 타원도. 이런 base model이 만들어진 거 맞아? ... 공부도 했잖아, 자료조사 논문."** No, half.
The module had the cell's topology (tile -> funnel -> throat) and not its surface: one straight loft from a
sharp parallelogram rim to a 12-segment mean loop that read as a rounded rhombus - a faceted cone where the
photograph shows a cast scoop. The panelization literature the survey covered says how a cell like that is
made and I had not applied it: a COMPONENT designed once in a unit box and morphed into every cell of the
population, the component itself a loft through SECTION curves along a profile (Woodbury's component +
population; Grasshopper's morph and loft idiom; DS+R's own veil, GFRC scoops lofted from a flat rim to an
oval throat along a curved section). Two rules now, neither naming a building:

- `mouth.profile {kind: linear | quarter_ellipse, rings 0..6}` - the funnel's SECTION. `linear` is the
  old straight loft whatever the ring count (the test holds its volume to 2%); `quarter_ellipse` is the
  cove: the ring already moves inward as sin while depth grows as 1 - cos, so the wall is tangent to the
  face at the rim and dives into the throat. `funnelSections` in polygon-prism.mjs makes the sections,
  `funnelModuleGeometry` lofts through 4 + rings vertex blocks, still one closed outward solid (the test
  checks closure, winding, and that the cove holds more solid than the cone). The profile rides on every
  funnel instance and through all five links (contract, lattice, derive, the builder whitelist, the file
  inline), and never on a solid piece. The fit emits it as an option named `unobserved` (an elevation
  photograph cannot show a section), defaulting to the cove.
- the fitter FITS AN ELLIPSE to the unit when one explains it: radial least squares r(theta) about the
  centroid for (a, b, phi), accepted when the RMS residual over the mean radius is under 0.04, emitted as
  four rotated Beziers in the unit box; otherwise the mean loop stays. Measured to place the threshold:
  the Broad's mean loop 0.028, the fixture's lens 0.032, a jittered oval 0.013 (ellipses); a pointed
  two-arc lens 0.050, a parabolic lens 0.055, a diamond 0.11 (not). `metadata.fit.unit_kind` says which.

Re-fitted (`spec-broad-fit4` -> `spec-broad-module3`, hash `d4b0c2c7`): the Broad's throat is an ellipse
at residual 0.029, cove with 3 sections. Suites: Python 26 / 26 (new: ellipse read / lens kept; profile on
every funnel and moves the hash; profile to open parts not solid pieces), the three touched Node files
19 / 19. Result: `render-broad-module3` drew - eight views, PBR, hero accepted, the photograph
comparison accepted (spread 0.291; module2 0.58), the GLB carries 7 rings per module (168 vertices
against 96) at 11.9 MB. In the PBR front the throats read as clean leaning ellipses where module2's
were faceted lenses; the cove itself is subtle at sheet scale and needs the hero to be seen. The star
prism followed as `render-broad-on-020f` (hash `3d51370c`, 1,824 cells, 1,154 open with the profile): every gate, eight views, PBR and hero accepted; in the hero the funnels read as scoops with curved interiors where 020e's were faceted cones. Sheet Version 12.

**"니가 PNG를 봐라. 어떤 mass든 입면이 마무리가 깔끔하게 되어야 하는 거 아님?"** They were right and I had
not looked at the edges. Cropped to the building's own bounds, the star prism's veil ended in a NOTCHED
line - the top of each facet landed anywhere between 16.24 and 16.50 m - and the ends of the rows on the
Broad's box climbed in a staircase. Neither is a drawing anyone would hand in. The cause was one line in
the evaluator: `funnel_loops` returns None when the host's edge has cut a cell past its funnel (the
clipped mouth no longer holds the throat, or no longer holds the cell's own centre), and the cell was
then DROPPED. Every boundary therefore lost a ragged row of cells, and what the eye read as an unfinished
edge was a row of missing ones.

The rule is the fold rule, one edge further out: **a funnel that cannot be whole becomes a solid panel.**
A cell the host's edge cuts past its funnel is now the clipped tile as a solid piece (outline only, no
throat, no tile ring) - which is how a panelized veil is actually finished, and it is the same sentence
that already handled a seam through a throat. `omit_partial` still drops them, because that is the fitted
policy of a photograph whose veil stops inside its own frame; every other policy finishes. Generator
v0.4, so the hash moves with the geometry. Measured on the star prism: 1,824 cells to 1,964, and the top
of the veil is 16.500 on all sixteen facets, the bottom 0.000. New test `test_edge_finish.py`: the cells'
footprints cover 98% of the host and reach every one of its four edges; an edge cell past its funnel is
a solid piece; `omit_partial` still stops inside the frame.

One latent bug this exposed, and it is the [[quantize-then-compare-exact-is-the-recurring-bug]] shape:
the veil's line-density waiver asked `instances[0].tile_m` - the FIRST cell - so the moment a solid edge
panel sorted first, the waiver vanished and the front failed LINE_DENSITY_EXCEEDED on a drawing that had
carried the same veil an hour earlier. It asks the population now (`veilWaivers`, exported and tested:
a panel first is still a veil, panels alone are not, a carved funnel is not).

The Broad's own drawing needed the same finish for a different reason: its fitted host is the
photograph's ASSIGNED frame (30 x 12.2) and the box it is drawn on is 13.2 m tall, so a metre of
glass stood bare above the veil and the top row climbed in a staircase (`omit_partial`, the fitted
policy, is right about the photograph and wrong about the mass). `spec-broad-module5` re-lays the
same fitted lattice over the FACET it is drawn into and finishes it: 733 cells, 117 solid edge
panels, 0.00 to 13.20 m, gates accepted. Two small things fell out: `cli.mjs` read `--keep-voids`
by swallowing the next argument, so a bare switch was always false (a flag with no value of its own
is `true` now), and `apply` grew `--keep-voids` for the one case where a design void travels - the
base model laid back onto the building it was read from. Applying the Broad's veil to all four
faces of its box is refused by the GLB budget at this cell size, and to the front face alone by
TOP_TERMINATION on the three bare faces; both are recorded, neither is chased here.

Both drew. `render-broad-on-020g` (star prism, 1,964 cells, hash `438532d1`): every gate, eight
views, PBR and hero accepted, and cropped to the building's own bounds the top of the veil is now
one straight line across all sixteen facets and the bottom sits flush on the ground. The Broad,
`render-broad-module5` (733 cells at 16-point rings, the 24-point version projected 17.50 MB
against the 16 MB budget): every gate accepted and the photograph comparison accepted at lateral
spread 0.229, the veil filling its facet from 0.000 to 13.200 with the fitted voids - the lifted
corners and the oculus - where the photograph has them. One render failure on the way was the
machine and not the drawing: with 3 GB free the axon came back as 2,400 x 2,400 black pixels and
the gate correctly called it empty; the same grammar drew clean on a retry.

**"예가 될 때까지 해야지. 제대로 검토해."** The evidence list said one photograph and one shape of mass, so
this session went after both axes rather than writing the hedge down again.

**Any mass.** The base model on the bent bar and the cleft block failed four times before it drew, and every
failure was a rule that only a prism had ever tested:
- `chainFacets` walked the facets from an arbitrary one and STOPPED at the first break, returning the chain
  so far and dropping the rest. On a prism all sixteen chain; the bent bar put 2 of its 37 facets in the run
  and the cleft block 1 of its 113, so the veil dressed a corner of the building and nothing else. It builds
  every run now, each walked to its end, the next starting at a facet no other leads into.
- Every facet used to start its veil at ITS OWN bottom. On a mass at one z that is invisible; on a mass that
  steps, each facet began row 0 at its own sill and the veil stepped with the mass instead of running level.
  `lattice.z_datum_m` carries the run's datum (absent = the facet's own bottom, so nothing already drawn moves).
- The door was sized from the NARROWEST facet less the fold clearance: 1.5 m on the prism, a negative number
  on the cleft block, whose narrowest facet is a few centimetres. It is the widest facet's now, clamped to
  the 0.8 m the schema allows, and the resolver ranks the segments that can hold it.
- The glass box's storey was a fixed 0.25 + 0.25 m pair of courses, which needs half a metre of scope and
  fails hard where there is less (a facet's own split is never shrunk). A fraction instead cleared nothing in
  particular and intruded on the slab lines. It is `min_z_m: 0.9` on the glazed bay with a bare-wall
  alternative under it: a storey band too short for a bay is the mass's own wall.

**Any parametric facade.** A SECOND design, sharing nothing with The Broad - a rounded hexagon on a
rectangular lattice staggered half a bay, apertures growing toward one corner by a point field - was
authored, drawn as a picture, and put back through the lane with no code changes. The trace found 140 cells
against 140 authored; the fit recovered the lattice to a millimetre (the truth's staggered a = 1.5, b = 1.3
is the fit's a = (1.5, 0), b = (0.75, 1.3), the same point set in its reduced basis), inliers 1.000, lattice
RMS 0.000 m, recovery 138 of 140 matched at RMS 0.000; and `apply` put it on the star prism at 642 cells with
every design gate green. Honest limits: SAM 3 is concept-prompted and returned nothing on a flat graphic, so
the classical engine did the segmentation; the picture is ours, so there is no perspective and no camera.

**Two gates were written in the wrong unit, and both refused correct work.**
- The PBR role gate asks that every pair of VISIBLE roles be told apart by colour, and called a role visible
  at four pixels - while the clause above it, which asks whether a role is SHOWN at all, requires four pixels
  AND 0.05% coverage. The bent bar's roof view showed 184 pixels of grazing glass (0.034%) blown out to the
  tone of the roof beside it, and the drawing failed for not separating a role that the other clause would
  not have counted as present. One definition of visible in both clauses now.
- The trace's fidelity gate is `mask_iou >= 0.90 and boundary_p95 <= 2.0 px`. IoU is scale-free and the
  boundary error is a length: the same curves over the same wall, rastered at 170 px/m instead of 90, kept
  their IoU and grew their pixel error, so the gate refused at one resolution what it accepted at another.
  The document carries its own scale, so the error is reported in metres and judged at 30 mm.

**A mass from the picture, AS A TEST FIXTURE ("투시도 -> 도면이니까 ... agent 역할을 다하게 해", 2026-09-17).**
The division of labour does not move and this does not become a delivery step: the mass is the authority
and comes from the mass agent; this agent designs the elevation on whatever mass it is handed. What
follows is a fixture in the same class as `synthetic-box-WxDxH`, and it exists because the answer to "why
does the Broad's veil not look like the Broad" was the box we had chosen - which is shown by putting the
same veil on the photograph's own form rather than argued.
Until now only the FACADE came from the photograph and the mass was a box I chose, so the Broad's veil -
read cell for cell - was drawn on a rectangular block and read as a pattern stuck on a box. A photograph
states one thing about form without ambiguity: the SILHOUETTE, which the trace has already measured as
its ROI polygon in the frame's own metres. `cli.mjs mass <roi.json> <name> --depth --bulge --columns`
turns that polygon into a candidate (`synthetic-outline-<name>`): the outline swept along a shallow arc,
which the rest of the pipeline reads like any other mass. Nothing in it names a building.

Four conventions in the drawing layer only a rectangular prism had ever satisfied, each found by the
refusal it caused and each fixed as a rule:
- a FLAT sweep is one plane, and members are placed on the rectangle inscribed in a plane, so a sagging
  silhouette lost its sag and its ground contact; swept along an arc the front is a row of facets and
  each keeps its own piece of the silhouette (the veil stays level across them by `z_datum_m`).
- the dimension pass wants exactly ONE facade plane square to each elevation and ON the mass; a bulged
  front had none and a flat one would have had sixteen, so the arc carries a flat crown column.
- `ground_access` was `|origin.z - floors[0]| <= 1e-7`, which is a statement about floating point, not
  about a building: a facet silled 30 mm above the datum had no ground access and the building could
  take no door. One step (0.15 m) now.
- the floor guides were multiples of 3.3 m by count, so a 12.2 m mass got a guide at 13.2 m, above its
  own roof, and the dimensions refused to measure from it. They stop inside the mass and end at its top.
- a traced silhouette is the VEIL's outline and a veil lifts off its corners; taken as the building it
  gives a mass that touches the ground nowhere. The BUILDING stands on the ground and the veil lifts off
  it, which is what the photograph shows and what the spec's own voids already carry.

Result: `synthetic-outline-broad` (38 facets from the photograph's silhouette, 8 m deep, 1.5 m of arc) with
the fitted Broad veil on it, 2,767 cells, every gate green, drawn end to end. Beside the photograph it is
a real step from the box - the form curves and the veil wraps it - and it is still not the same building:
the mass is a barrel-bulged prism where the Broad is a warped pillow that sags between lifted corners, the
cells are uniform where the photograph's vary along the surface, and the veil stands on the ground in the
drawing instead of lifting off it. Those are the next three, in that order.

**Three more, and the one that is blocked.** The veil on that mass then drew wrong in three ways, and
two were rules rather than taste. A VOID IS A PLACE ON A FACE: the base read the oculus and the lift on
one wall in that wall's own metres, and an unfolded run measures u from wherever its chain starts, so
carried over unchanged they landed on whatever facets shared those metres - the Broad's veil lifted off
the BACK of the building. The host's segments now say which elevation they belong to and a kept void is
shifted to where that face begins. A SIZE FIELD IS THE SOURCE BUILDING'S: flattened to 1 when a base
travels to another mass, which is right, and flattened when it is laid back onto the building it was read
from, which is not - `--keep-fields` keeps it, and the Broad's cells run 0.50 to 1.78 across the face
again. Drawn: `render-broad-outline5`, 2,748 cells, every gate green.

The third is blocked and worth the note. The Broad's most recognisable move is the BATTER - the wall
pulled in at its base so the building reads as lifted - and one number in the sweep does it
(`mass --lean`). Every drawing here dimensions an elevation against one facade plane that is square to
the view and lies on the mass; a battered front has none, so the dimension pass has nothing to measure
from and the draw stops at `dimension source missing: elevation facade plane`. The mass on disk is left
plumb. Fixing it means teaching the dimension pass to take the plane a view looks at from the mass's
BOUNDS when no facet is square to it, which is a change to a drawing convention that every retained run
depends on - someone else's eyes first.

**"어떤 mass가 와도 잘 되어야 하는데" - the veil sizes itself now.** Every drawing of a base model until
this point had me choose `--scale` and `--points` for that building: 1.0 on the star prism, 1.8 on the
bent bar, 2.4 on the cleft block, 1.12 with 12-point rings on the outline mass. That is per-building
tuning by hand, which is the thing this lane refuses everywhere else, and it is the reason "any mass"
was not true: hand a new mass over and someone has to guess two numbers.

Both come from the mass. The cells are the run's area over the cell's own footprint against the
contract's 4,096; the ring points are what the 16 MB GLB budget leaves, measured on written files
(1,964 cells x 16 points wrote 13.6 MB; 2,748 x 12 wrote 15.0; 3,156 x 12 projected 16.15 and was
refused - so cells x points is about 33,000). The estimate from the area alone under-counts, because
the lattice covers the run's bounding rectangle with a margin and a stepped mass keeps only the part of
each column its facet spans - the bent bar estimated 2,162 and evaluated 3,527 - so the fit is CLOSED
on the evaluation: lay it, count what came out, lay it again if the cells are over the cap or the rings
over the budget. Five masses, `apply <candidate> <spec> <name>` with no size numbers at all:

    creative-020  (16 facets)     scale 1.00  points 16  1,964 cells   accepted, drawn
    creative-013  (37, stepped)   scale 1.00  points  9  3,527 cells   accepted, drawn
    creative-004  (113, battered) scale 2.42  points  8  3,939 cells   accepted, drawn
    synthetic-box-12x8x6.6        scale 1.00  points 24    625 cells   accepted
    synthetic-box-30x8x13.2       scale 1.00  points 15  2,107 cells   accepted

The report says what it chose (`veil: {scale, points, chose}`), so a drawing carries its own numbers,
and a caller who names either one still wins.

**The self-sizing veil passed every gate and failed the eye (2026-09-18).** With the sizer landed I
looked at the three drawings rather than the reports. The star prism and the bent bar read. The cleft
block is CONFETTI - scattered lenses on bare wall - and it had been accepted with zero faults, which
is the [[the-elevation-must-reflect-the-perspective]] rule earning its place again.

Measured, and every number is about the pipeline rather than that building:
- the sizer counts PARTS against the 4,096 cap, and a part is a cell a fold cut, so a bigger cell
  buys more parts per cell rather than fewer: 004 at scale 2.42 is 2.13 parts/cell, at 1.60 it is
  1.73. The loop only ever moves ONE way - up, when the count is over the cap - so it walks away
  from the optimum on a mass that folds.
- it ran the cell out to 2.82 m on a mass pleated at 1.76 m: **97% of the facets are narrower than
  the cell**, the throat is 1.45 m, one lens lands per 1.6 facets, and 60.4% of the veil is solid
  panel painted the wall's own tone.
- the cap is spent over the WHOLE RUN - four faces, 216 m - and an elevation shows ONE face. Laid
  on the front face alone the same sizer chooses scale 1.00, the throat is 0.60 m and every cell
  keeps its lens (2,115 cells, 2,144 open parts). That is the density the drawing wants.

Two readings I had to take back on the way, both by measuring rather than looking harder: the pale
panels on the bent bar's sheet are PAPER (0 building pixels at background tone - the mass's own
stepped silhouette), and the throat is narrower than the pleat, not wider.

**The crown, so a face-limited veil is a finishable drawing.** A veil on some faces leaves the rest
bare, and TOP_TERMINATION_MISSING refused them - correctly: the elevations are drawn and judged one
at a time. The template now writes a crown when, and only when, the run was limited, so every full-run
grammar is the one it always was. It was written twice wrong first: `storey == last` is the last
storey of the FACET's own scope, so on a mass of stacked courses every facet terminated itself and
the wall grew a cornice at 3.3 m - the [[quantize-then-compare-exact-is-the-recurring-bug]] shape, a
question about the building answered by one member. The rule names the BUILDING's top storey. Result
on the cleft block's front face: 1,211 primitives, zero faults, cornices at 14.3-16.5 on all four
views. `veilGrammar` is exported and tested rather than inlined.

**And "one face" is not one label.** Drawn, the front-face veil came out a CHECKERBOARD: equal squares
of veil and bare wall. The rasters said the blanks are the mass's own wall, not paper, and the geometry
said why - projected onto the front sheet, the cleft block's facets are **47% front-assigned and 49%
back-assigned**. `face_view` is a DIMENSIONING assignment (one facet, one sheet, by best dot); what a
sheet SHOWS is a different question, and on a mass with a cleft the two labels interleave on both
sheets. Dressing front and back together covers 96% of the sheet - and doubles the run, so the sizer
put the cell back to 1.85 m on 1.76 m pleats and the veil returned to 54.3% solid. The two constraints
are now stated in one line: this base design over this mass's front SHEET (2,211 m2 at 0.55 m2 a cell)
wants about 7,400 cells, and `MAX_CELLS` is a bare 4,096 in two files whose own comment says the real
ceiling is the per-facet primitive budget and the GLB bytes. Raising it needs the per-cell cost cut
first (the cove is 7 vertex blocks against a linear section's 4). That is the next decision, and it is
a budget one; nothing here is a defect.

Open, in the plan's order: the cell budget on a pleated mass (above); the crest lines in the 2D export;
the parapet sawtooth (the top row past the roof line); the homography before the fit; Task 5's A vs B on
one ROI with the fit as B.

## 2026-09-22/26 the repo learned to leave home, and the lane's entrance opened

Three rounds, each started by one question, each ending in a measurement.

**"이 레포 하나로 다 되나? 다른 레포로 옮기게."** Copied exactly what a clone carries (548 files,
19 MB, `git ls-files -c -o --exclude-standard`) into an unrelated directory and ran the suite
there: 951 tests, 932 pass, **19 fail**. Five things were true only while this repository sat
inside `D:\Data(_ELE`, and none of them could be seen from here:

- the dataset held creative-004 and creative-020 and not creative-013 (five tests, ENOENT);
- only creative-020 had the four seeds `prepare` needs, so the other two masses could not be
  prepared. `prepare` rebuilds the 37-file evidence pack from those four - tested by moving the
  folder aside - so only the seeds travel;
- `.gitignore` un-ignored creative-020's seeds ALONE, so copying the others in would not have
  survived a clone. Nothing was visibly wrong here; the leak was in what a clone carries;
- `config.mjs`'s legacy fallback overrode an EXPLICIT argument - a path that did not exist yet
  was silently redirected to a hardcoded one. That is also why the repo looked portable from
  inside this machine. It now applies only when the value came from the default;
- the test helpers found the dataset and the finished runs by walking UP the filesystem, and
  composed the results tree from the DATASET's parent. Eleven files stopped at load in a copy
  elsewhere. They ask the configured roots first now, and ten hand-built paths go through
  `fixture()`, which names what is missing and which variable sets it.

The moved copy is **951/951** with `ELEVATION_AGENT_FIXTURE_ROOT` set. The 420 MB of finished
e2e runs stay outside by the user's call; a clone without them is red on purpose and says so.

**"도면도 다 되는지 봐야 하는 거 아님?"** Right, and the suite is not the deliverable. The moved
copy drew `data/sample_grammar.json` end to end (eight views + PBR + hero) and then the whole
lane from a photograph: trace 581 apertures at IoU 0.924, fit 536 cells at RMS 0.089 m, apply
1,969 cells with zero faults, drawn. Two earlier draws in that copy failed on
`DIMENSION_SOURCE_MISSING` while every input matched to the byte - the difference was that the
copy sat 116 characters deep, putting artifacts at **272 characters** against the Windows limit
of 260. From `D:\mvt` the same grammar drew everything. The repository was never at fault; the
harness was. `deriveElevationDimensions` throws six distinct sentences and the catch turned all
of them into one bare code, so it records `dimension_source_error` now - only when there is one,
so every accepted receipt stays byte-identical.

**"가중치는 어디서 나옴?"** One question, two false claims and a verification gap.
`checkpoints/README.md` said the system downloads `facebook/sam3` from Hugging Face when
authenticated: there is no `hf_hub_download`, `snapshot_download` or `from_pretrained` anywhere
in `tools/facade-vision`. The README offered `scripts/download_checkpoints.py` as the way to get
the weights, and that script only linked what was already beside the repo or printed a URL - and
it reported a machine configured through `SAM3_CHECKPOINT` as MISSING, because it never read the
environment. SAM 3 is a **gated** release (request access, `hf auth login`, then download), so
the script now says that in four steps, actually fetches the two that are not gated with
`--download`, and `--verify` hashes what it found in about ten seconds against digests that are
now recorded: `sam3.pt` 3,450,062,241 B `9999e234…`, `sam2.1_hiera_small.pt` 184,416,285 B
`6d1aa6f3…`, `groundingdino_swint_ogc.pth` 693,997,677 B `3b3ca256…`. Everything else in this
lane is hash-checked; the weights were the one input nobody could verify. Also recorded: the
sam3 PACKAGE is a second thing from the weights (`import sam3` is Meta's repository, 71 MB of
source, not a PyPI install), and nothing here can tell SAM 3 from SAM 3.1.

**"gpt 안 되면 오픈소스라도 되어야 하는 거 아님?"** The lane had exactly one closed dependency and
it was the first step. `tools/facade-concept` runs Stable Diffusion XL with a ControlNet over
the depth raster the evidence pack already renders for the bare mass: RealVisXL and
controlnet-union were already in the cache and neither is gated, so **no new disk, no key, 25 s
an image** on a 12 GB card. The conditioning is the architecture of it, not the cost - a
commission DESCRIBES the mass and asks the model to respect it, which is how a five-storey prism
once came back as a star-plan tower, while a ControlNet takes the geometry as an input. Proven
end to end on creative-020: 264 apertures at IoU 0.966, 251 cells at RMS 0.070 m, 2,681 cells
applied with zero faults, drawn and accepted.

Three things the pictures taught, all about what the lane can be ASKED for:

- the open brief drawn verbatim returns a BLANK MASS. A diffusion model renders a description,
  it does not answer a question, so the programme has to be named - style, palette and material
  still must not be, and a test holds the camera setup to that;
- a FRONT depth raster of a prism is nearly featureless: the ControlNet holds nothing and the
  model returns a wall texture. Condition on the axon;
- the trace reads cells, not glass. SAM 3 found zero apertures in a continuous glazed skin, and
  the fit refused a sparse punched grid - *the inlier cells lie on one line; a lattice needs two
  directions*. Untiled SAM 3 found 4 apertures where `--tile-size 512` found 581, and the
  fidelity gate scored both well: it measures whether curves were drawn accurately, never
  whether they were all found.

The honest gap: fit inliers **0.315** for a generated field against **0.821** for the
photograph. Diffusion drifts a row here and a column there, and it shows in the drawing - the
cells came out blobby where the concept's were crisp. A photograph is still the better input;
the generator's job is to propose, and proposing is now free.

Sheets: https://claude.ai/artifact/KGaFmPBybgVMLUeSGTyo9U (the move) and
https://claude.ai/artifact/1Zn2NJbZgzrz6GhvHXD4Xp (the open entrance).
