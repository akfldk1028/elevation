# 파라메트릭 입면: 격자(lattice) 표현과 검증 설계 — v2.1 (리포 매핑판)

**작성일:** 2026-09-16
**원본:** `D:/Data/50_ELE/docs/parametric_facade_handoff/parametric_facade_handoff/PARAMETRIC_FACADE_IMPLEMENTATION.md` (GPT-6, v2.0, 2026-09-15)
**이 문서의 성격:** v2.0의 표현·순서를 채택하고, 이 리포(ElevationAgent)에 이미 있는 것에 매핑해 범위를 줄인 실행 설계. 실행 결과 보고서가 아니다.

---

## 0. 한 문장

만들 것은 "이미지를 따라 그린 곡선 수백 개"가 아니라, **기본 유닛 + 격자 + 위치별 변형 필드 + 예외**로 그 입면을 설명하는 생성 프로그램이며, 같은 프로그램에서 3D(기존 엔진)와 2D CAD(기존 곡선 문서)가 나온다.

이미 이 리포가 도달했던 실패 두 가지가 이 문장의 근거다.

- 2026-09-13 `the-broad-veil-rotation`: 분할 문법으로 The Broad 베일을 쓰니 파셋마다 셀 한 줄짜리 기둥이 되어 "눈 달린 타워"로 그려졌다. 원인은 셀을 **놓는** 연산자가 없어서(문법은 파셋별·층별·축 정렬 분할만 한다) 격자를 손으로 흉내 낸 것.
- 2026-09-13 `broad-sam3-deduplicated`: SAM3로 669개 셀을 따서 DXF는 만들었지만 셀이 전부 독립 곡선이라 "간격을 줄여"가 성립하지 않고, 3D로 붙일 규칙도 없었다.

---

## 1. v2.0에서 그대로 채택하는 것

- 표현: `families[]` (기본 곡선 + shape mode) × `lattice` (origin, basis_a, basis_b, stagger, edge_policy) × `fields` (상수 → 선형 → 저해상도 격자 보간) + `design_voids` + `exceptions` + `uncertain_regions`.
- 인스턴스 상태: `observed` / `inferred` / `designed` / `unresolved`. SAM 마스크는 관측이지 정답이 아니다.
- 원본은 하나: `ModelSpec + generator version + 매개변수`. SVG/DXF/GLB는 파생이며 같은 `model_hash`를 싣는다.
- 순서: Task 0(감사) → 1(합성 forward) → 2(같은 원본의 3D·2D) → 그 뒤에 역복원.
- 금지: bbox로 곡선 대체, 검출 안 됨 = 구멍 없음, 실행 성공 = 형상 정확, 실측 아닌 치수에 "실측" 표기, 원설계자의 규칙을 복원했다는 주장.

## 2. v2.0과 다르게 하는 것 세 가지

| v2.0 | v2.1 (이 리포) | 이유 |
|---|---|---|
| 3D 커널로 CadQuery/Rhino 검토 | **기존 엔진**: `buildTypedFacadeDetails`의 outline 프리미티브 + recess/holeCut + `rotate_deg`/`scoop_deg` | 이미 렌즈 구멍·스쿱·회전을 8뷰로 그린다(`render-lens-020`, 2026-09-16). 두 벌을 만들지 않는다 |
| host = 단일 평면(12×6 m) | **host = 파셋 런(펼친 u 좌표)**. 셀 중심은 펼친 좌표에서 계산하고 파셋 경계에서 윤곽을 클리핑 | 우리 매스는 다면체. 이게 없으면 별 프리즘에서 격자가 기둥으로 끊긴다 |
| ModelSpec은 별도 경로 | 문법의 스코프에 연결: 분할 `axis: "lattice"`가 family를 참조 | LLM이 새로 설계하는 스킨과 사진 역복원이 **같은 표현**을 쓴다 |

역복원 Task 3·6·7(수치 피팅, VLM 구조 후보, 패치 루프)은 **앞 단계가 되고 난 뒤** 별도 결정한다. 이 문서의 범위는 Task 0–2와 Task 5(사진 ROI 반자동)까지다.

---

## 3. Task 0 감사 결과: 설계서 모듈 ↔ 리포

| v2.0 모듈 | 리포 | 상태 |
|---|---|---|
| observations (SAM3 / DINO+SAM2, ROI, 타일, 신뢰도) | `tools/facade-vision/src/{sam3,dino,sam2}_segmenter.py`, `observations.py`, `tiles.py` | 있음 (19 pytest 통과) |
| export SVG/DXF, 인스턴스 편집, radial/linear 필드 | `tools/facade-vision/src/curve_document.py`, `parametric.py` (`arr.elevation3d.facade-curves.v1`) | 있음 (669셀 DXF ezdxf 재검증됨) |
| compile_3d: 관통/오목 구멍, 깊이, 회전, 스쿱, 스탠드오프 | `plugins/elevation-3d/lib/facade-agent/punched-facade.mjs`, `polygon-prism.mjs`, viewer `holeCut` | 있음 |
| render + validate (8뷰, PBR 게이트, 원본 비교) | `tools/facade-pipeline/index.mjs` → `renderAuthoredFacade` | 있음 |
| 필드(point/line/plane/sun/mix, falloff), grade(5 속성) | `design/grammar/contract.mjs` `fields`, `grade` | 있음 — 문법 쪽 |
| **contracts / prototypes / lattice / evaluate** (ModelSpec → 인스턴스) | 없음 | **핵심 공백** |
| 파셋 런(펼침) + 경계 클리핑 | 없음 (`continuation.mjs`는 코플래너 이음만) | 공백 |
| 문법 연결 `axis:"lattice"` | 없음 | 공백 |
| fitting / losses / structure / patching | 없음 | 보류 |

현재 회귀 기준(동결): `npm test` 883/883(단독 실행), `render-lens-020` 8뷰 수용, `broad-sam3-deduplicated` DXF 검증 JSON.

---

## 4. 표현: ModelSpec v2.1

v2.0의 14장 JSON을 유지하되 다음만 바꾼다.

- 단위는 **미터**(리포 전체가 m). v2.0 예시의 mm 값은 어댑터에서 1/1000.
- `host`는 두 형태를 허용한다.
  - `{"kind":"plane", "width_m", "height_m"}` — 합성 테스트, 사진 ROI.
  - `{"kind":"facet_run", "candidate":"creative-020", "segments":[segment_id...]}` — 준비된 후보의 인접 파셋 열. u는 파셋 길이를 누적한 펼친 좌표, v는 세계 z.
- `lattice.edge_policy`: `omit_partial` | `clip` | `keep`. 파셋 런에서는 파셋 경계도 "edge"이며 `clip`이 기본이다. 클리핑은 셀 윤곽(미터 폴리곤)을 파셋 직사각형으로 Sutherland–Hodgman 절단.
- `fields`의 입력 좌표는 변형 전 격자 위치를 host 폭·높이로 정규화한 (s, t). 기존 문법의 `point/line/plane/sun/mix` 필드를 그대로 쓸 수 있도록 `kind`를 공유한다.
- 셀 속성: `scale_u, scale_v, rotation_deg, depth_m, scoop_deg, bulge(shape mode)`. 문법의 `grade.attr` 다섯 개와 겹치는 것은 이름을 같게 둔다.
- 인스턴스 출력(평가기 결과) 스키마는 codex의 `facade-curves.v1`의 `instances[]`와 호환: `{id, unit, center_m, width_m, height_m, scale_u, scale_v, rotation_deg, offset_m, provenance}` + `outline_m`(클리핑 후 폴리곤) + `segment_id`.

## 5. 구현 위치

```
tools/facade-parametric/                 # Python — 평가기 (피팅이 수천 번 호출하므로 NumPy)
  contracts.py      validate_spec: enum·범위·참조·선형종속 basis·NaN 거절
  prototypes.py     piecewise cubic Bezier → 샘플 폴리곤(현 오차 ≤ 5 mm), shape_modes
  lattice.py        p(i,j) = origin + i·a + j·b + stagger(j); host 경계/파셋 경계 클리핑
  fields.py         constant / linear / grid; 기존 point·line·plane·sun·mix와 동일 수식
  evaluate.py       ModelSpec → instances.json (+ model_hash: canonical spec + generator version)
  export.py         instances → facade-curves.v1 → curve_document.py의 SVG/DXF 재사용
  test/             synthetic_facade_001.json(v2.0 14장, m 단위 변환) 기반
plugins/elevation-3d/lib/facade-agent/design/grammar/
  lattice.mjs       axis:"lattice" — family를 참조, instances를 읽어 typed window 프리미티브로
                    (outline, depth_m, rotate_deg, scoop_deg, standoff_m; segment_id로 파셋 배정)
tools/facade-pipeline/cli.mjs
  lattice <spec.json> <out>            # 평가 + 2D (Python)
  draw   <candidate> <grammar.json>    # 문법이 family를 참조하면 lattice.mjs 경유 (기존 명령)
```

JS 쪽은 **평가하지 않는다**. 인스턴스 JSON을 읽어 프리미티브로 바꾸는 얇은 어댑터만 둔다. 평가기가 두 벌이면 해시가 갈라진다.

---

## 6. 검증: 무엇이 검증되고 무엇이 안 되는가

### 6.1 검증 수준

| 수준 | 입력 | 정답 | 검증 가능? |
|---|---|---|---|
| L1 forward | 합성 스펙 S0 | 규칙·곡선·격자·깊이 전부 | **완전**: 결정론 |
| L2 알려진 규칙의 역복원 | S0를 렌더 + 누락 0/10/30%, 그림자 (S1) | 손상 전 스펙 | **정량**: 매개변수·경계 오차 |
| L3 사진·생성 이미지 | Broad ROI (R0), codex 콘셉트 (G0) | 없음. 소수 수동 확인 셀만 | **판정 + 부분 정량**: 같은 건물 판정, 수동 셀 대비 경계 오차, 편집 동작 |
| L4 원설계 규칙·실제 깊이 | — | — | **불가**. 주장하지 않는다 |

### 6.2 게이트 (v2.0 19.4를 리포 수치로)

| 게이트 | 기준 | 리포에서 재는 방법 |
|---|---|---|
| G1 합성 생성 | 72셀, 전부 폐합, ID 유일, host 안 | `pytest tools/facade-parametric/test` |
| G2 실제 3D | 합성 12×6 박스 후보에 72개 구멍이 GLB에 존재; 정면·측면 geometry-only 뷰에서 관통 확인 | `test/helpers/facade-design-fixture.ts`의 `boxMesh`로 후보 준비 → `draw` → material-id 래스터에서 셀 수 |
| G3 같은 원본 | SVG/DXF/GLB manifest의 `model_hash` 동일; DXF read-back 루프 수 72, chord error ≤ 0.5 mm | `verify_cad.py` 확장 |
| G3b 편집 | `scale_v` 0.8, basis_a ×0.9, radial field 추가 → 세 출력이 모두 바뀌고 host는 불변 | 해시 비교 + 도면 diff |
| **G3c 접힘** | 파셋 런 host에서 파셋 경계를 가로지르는 셀이 클리핑되어 양쪽에 존재; 경계 양쪽 셀 중심의 격자 위상 오차 < 1 cm | creative-020 별 프리즘, 셀 중심을 `segment_id`별로 집계 |
| G4 합성 역피팅 | 중심/경계 95% 오차 ≤ 3 px, 누락·중복 0 | Task 3 이후 |
| G5 사진 ROI | 수동 확인 셀 대비 오차 보고, 조건 A(독립 곡선) 대 B(공유 유닛) 비교 공개 | Task 5 |
| G6 같은 건물 | 리뷰어 역할 파일(`.claude/agents/facade-reviewer.md`) YES | 기존 최상위 기준 |

### 6.3 금지

결과를 본 뒤 기준을 낮추지 않는다. 함수 종료 = 합격이 아니다. 수동 유닛을 준 실험을 자동이라 쓰지 않는다. 모든 어두운 영역을 관통 구멍으로 보지 않는다. 깨진 마스크와 닮은 정도로 성공을 재지 않는다.

---

## 7. 순서와 산출물

1. **Task 1** — `tools/facade-parametric/` 평가기 + G1. 산출: `instances.json`, `pattern_layout.svg`.
2. **Task 2** — 합성 박스 후보 + `axis:"lattice"` 어댑터 + G2/G3/G3b. 산출: 8뷰, GLB, DXF, 같은 해시의 manifest.
3. **Task 2b** — 파셋 런 host + 클리핑 + G3c (creative-020). 여기서 "눈 달린 타워" 문제가 닫히는지 본다.
4. **Task 5** — Broad ROI: 대표 유닛·반복 방향을 수동으로 주고 B를 돌려 A(현 SAM 곡선)와 같은 ROI에서 비교. G5·G6.
5. 그 뒤 Task 3(피팅)·6(VLM 구조 후보)은 결과를 보고 결정.

각 Task는 실패 테스트 → 실패 확인 → 최소 구현 → 통과 → 회귀(`npm test` 단독 실행) 순서. 커밋은 사용자 지시가 있을 때만.

## 8. 하지 않는 것

새 CAD 커널, 새 foundation model 학습, SAM 재학습, 멀티에이전트 증설, 매스 변경, 유료 이미지 재생성, 원설계 규칙·실제 깊이의 복원 주장.
