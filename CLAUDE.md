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
