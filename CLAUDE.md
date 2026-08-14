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
