# LLM facade design agent v1 handoff (next session)

- 작업 브랜치: `llm-facade-design-agent-v1`  
- 작업트리: `D:\Data\50_ELE\gitagent\.worktrees\geometry-locked-facade-agent`
- 목표: 설계 생성 기반으로 입면/투시가 살아있는 facade 결과를 `exact-MASS` GLB 경로에서 계속 생산

## 즉시 확인할 것

- 현재 v5 실행 산출물: `D:\Data\50_ELE\facade-agent-verification\llm-facade-design-agent-20260810\creative-020\llm-facade-v5`
- `state.json`이 `succeeded`인지
- 핵심 셀렉션/산출 해시:
  - 컴파일 GLB: `c0a19abb28b6ee65d966df12c4299bcba6ff7877762f63840ec8e5b2bd52b49a`
  - 기술 패널: `d4fbdde6b05d0f3f1b9b8968e70f8289f4bec0e46f4ab5f679b854f35f2ee858`
  - 렌더 검증: `9fb7ad336f98bda5cbc2ccab95b43a79bf2c6c8afe09e3e9c68831483d531b8a`
  - contact sheet: `73b9cde26dc69ce2cdaf5004125cb9df9213d8a816ea3c25689d2e636920b270`
  - hero: `483fa166f1dcd9ae5e48a0e5b1b0865d988cae6bf417c43e327ca4f2537e3219`

## 설계 수정 포인트(기본 루프)

1. `plugins/elevation-3d/lib/facade-agent/design/`의 `rawProgram` 입력을 바꿔 구조를 제안
2. `plugins/elevation-3d/lib/facade-agent/punched-facade.mjs`에서 타입드 재질/기호 규칙과 입면 디테일 반영
3. `plugins/elevation-3d/lib/enrichment.mjs`에서 deterministic PBR 텍스처 적용 일관성 유지
4. `plugins/elevation-3d/lib/texturing/render-validator.mjs`/`all-views` 경로에서 카메라/프레임 경계 검증이 무너지지 않는지 유지
5. 변경 후 `npm test -- --test-concurrency=1 test/elevation3d-facade-design-*.test.ts --experimental-strip-types`

## 다음 AI 세션에 남길 규칙

- LLM은 텍스트 제안만 확정; geometry/authority/evidence는 반드시 기존 검증 파이프라인 통과 산출물로만 커밋
- generated image는 아이디어 참고용. 최종 승인 산출은 `technical-render` + `pbr-render` + `render-validation`을 통과한 결과만 사용
- 문, 창, 입면 표현 개선은 `design` 패키지(`contract/resolver/validator/compiler/state`)에서 타입/검증 우선으로 진행
- 각 커밋 뒤 `memory/elevation-3d/README.md`의 LLM 섹션과 `run_real` 결과를 갱신
