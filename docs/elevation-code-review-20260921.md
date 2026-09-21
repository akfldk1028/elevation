# ElevationAgent 로직 검토 — 2026-09-21

범위: CLI, perspective-workflow, vision trace, SAM3/SAM2 어댑터, parametric fit/apply/evaluate, 저장된 실행 증거. 전체 저장소의 보안·정확성 감사가 아닌 현재 동작 경로 중심 검토다. 이번 요청에서는 엔진 동작을 변경하지 않았다.

## 우선 확인할 사항

1. **[P1 / 연결 누락] 자동 이미지 에이전트가 파라메트릭 피팅 경로를 호출하지 않는다.** `tools/facade-pipeline/perspective-workflow.mjs:150`은 LLM이 반환한 grammar를 직접 검사·렌더링한다. `fitLattice`, `applyBaseModel`, `readAuthoredGrammar` 호출은 없다. 반면 CLI의 `fit`, `apply`, `draw`는 별도 경로다. 따라서 최근 lattice 개선이 자동 이미지 전사에도 그대로 사용된다고 설명하면 안 된다. 권장: 이미지 관측과 매스의 좌표 대응을 확정한 뒤 피팅·평가 산출물을 명시적으로 연결하고 동일 모델 해시를 검증한다.

2. **[P2 / 승인 조건] SAM3 실패가 최종 승인을 막지 않는다.** `perspective-workflow.mjs:114`에서 오류를 `vision.ok=false`로 기록하고 계속 진행한다. `:178` 최종 승인식에는 vision 성공 여부가 없다. 모의 실행에서 SAM3 예외와 최종 `ok=true`가 동시에 발생하는 것을 재현했다. 기록은 숨기지 않지만, CLI의 요약 응답에는 vision 상태가 드러나지 않는다. 권장: 필수 분석 정책이면 실패로 중단하고, 선택 분석 정책이면 승인 상태와 사용자 표시를 명확히 분리한다.

3. **[P2 / 재개] 관찰 이전 단계에서 중단된 작업은 resume할 수 없다.** `perspective-workflow.mjs:79`는 재개 시 observation.json과 vision.json이 이미 있다고 가정한다. 이미지 생성 후 관찰 호출이 실패한 경우 resume은 observation.json ENOENT로 다시 실패한다. 모의 실행으로 재현했다. 권장: 마지막으로 검증된 단계부터 재개하고 없는 단계의 산출물은 다시 생성한다.

4. **[P1 / 기하 한계] trace→fit의 미터 좌표가 투시 보정 결과는 아니다.** `tools/facade-vision/src/curve_document.py:71`은 ROI 경계 상자와 사용자가 지정한 폭·높이로 좌표를 선형 환산하며 `:78`에 `affine_user_scale`, `depth: unobserved`라고 기록한다. fit은 이 좌표를 그대로 사용한다. 임의 투시 사진에서는 원근 왜곡이 반복 간격·유닛 형상·크기 변화에 섞일 수 있다. 이는 코드에 명시된 제한이며 현재 경로에서 homography 자동 보정을 확인하지 못했다. 권장: 면별 대응점·카메라/매스 기반 정사 보정을 fit 전에 추가한다.

## SAM3와 DINO의 실제 상태

- 자동 에이전트 기본값: `engine='sam3'`, tile 512. 실제 로딩: `trace_runner.py:28` → `SAM3FacadeSegmenter` → `build_sam3_image_model`, `Sam3Processor`.
- `--engine sam2`: Grounding DINO 검출 상자 → SAM 2.1 마스크. 기본 SAM3와 동시에 합치는 구조가 아니다. detector가 없거나 검출 실패이면 명시적인 예외를 낸다.
- DINO-X / DINOv3 래퍼 파일은 존재하지만 검토한 표준 trace/agent 경로에서 호출되지 않는다. 파일 존재를 실제 사용으로 설명하면 안 된다.
- 저장된 `broad-sam3-final/trace-report.json`: engine sam3, tile 512, 관측 인스턴스 781개, mask IoU 0.925416. 이는 내보낸 곡선 대 선택된 마스크의 일치도이며 건축 요소의 의미 정확도가 아니다.
- `stitched-final-20260921/spec.json`은 이 SAM3 관측을 base_source로 보존한다. 이후 draw는 저장된 grammar/instances로 렌더링하며 SAM3를 재실행하지 않는다.

## 검증 증거

- 현재 하네스 테스트 13/13 통과: workspace `continuation-20260921-review-harness-tests.log`.
- 검토 재현 2/2: `continuation-20260921-review-probes.log`. 이 통과는 버그의 존재를 확인한 것이며 수정 완료가 아니다.
- 실제 creative-004 draw: `continuation-verified-20260921`, 기술 8방향 accepted, PBR accepted, 최종 hero 생성. GLB 10,578,132 bytes; 오전 모델과 byte-identical.
- Python 46 tests + 12 subtests 통과. 앞선 전체 Node 실행은 947/949 통과, 실패 파일 재검증은 각각 13/13, 6/6 통과. 전체 949개를 다시 모두 통과시켰다고 보고하지 않는다.
- 최근 결과는 Broad 패턴을 다른 고정 매스에 적용한 사례다. 생성 이미지와 도면의 일치가 승인된 자동 전사 사례로 분류하지 않는다.

## 설명용 PPT

`../docs/elevation_logic_20260921/ElevationAgent_현재로직_20260921.pptx`에 실제 경로, SAM3/DINO 역할, 파라메트릭 모델, 최근 결과와 미완성 연결을 정리한다. 구현 사실은 로컬 코드와 저장 산출물에 근거한다.
