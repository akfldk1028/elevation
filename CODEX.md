# Codex Elevation Agent Guidelines & Architectural Single Source of Truth

이 문서는 Codex, Claude Code, Gemini 등 모든 크로스 AI 에이전트가 공유하는 단일 진실 원천(Single Source of Truth)입니다.
`GEMINI.md`, `CLAUDE.md`, `AGENTS.md`, `memory/MEMORY.md`와 100% 동기화되며, 건축법규, 대지 안착(Siting), 매스 배치(Massing), 입면 검증(Elevation Gates), 최신 비전 파운데이션 모델(SAM 3, DINOv3, DINO-X) 파이프라인, 그리고 Codex CLI 실행 지침을 정의합니다.

---

## 1. 건축법규 및 대지배치(Siting/Massing) 절대 원칙

1. **정밀 안착 및 매스 배치 (Siting & Massing)**
   - 단순 보고서 요약에 그치지 않고, 모든 대지마다 정확한 건축법규를 적용하여 건물이 대지 위에 오차 없이 정확히 안착(Siting) 및 매스 배치(Massing)되도록 함.
   - `mass.obj` 및 `selected.glb` 기반의 폴리곤·평면·카메라·아티팩트 권한은 고정 권위(authoritative geometry)이며 임의 훼손 불허.

2. **도로 소요너비 미달 후퇴 및 모퉁이 가각전제**
   - **건축법 제46조**: 일반도로 4m 미달 시 중심선 후퇴, 막다른 도로(길이 10m 미만 2m, 10m~35m 3m, 35m 이상 6m/도시지역외 4m) 폭원 확보. 반대편 경사지/하천/철도 접할 시 반대편 경계선 기준 전폭 후퇴.
   - **시행령 제31조 (가각전제)**: 교차각 및 도로 너비에 따른 2~4m 코너 절단.
   - 후퇴 면적은 공부상 대지면적에서 엄격히 공제한 **'유효 대지면적'**을 기준으로 건폐율(BCR)과 용적률(FAR) 산정.

3. **최신 정북방향 일조사선 (시행령 제86조)**
   - 전용주거지역 및 일반주거지역: 건축물 높이 10m 이하 1.5m 이격, 높이 10m 초과 시 건축물 높이의 1/2 이상 정북방향 대지경계선으로부터 이격 ($H \le 2D$).
   - 북측이 도로, 공원, 하천, 녹지 등에 접할 경우 반대편 경계선으로 기산선 이동 완화 규정 엄격 적용.

4. **용적률 산정용 연면적 및 지자체 조례 우선 원칙**
   - **시행령 제119조 제1항 제4호**: 지하층 면적, 지상층 주차장 면적, 초고층 피난안전구역, 옥상 피난공간은 용적률 산정용 연면적에서 엄격히 제외.
   - 전국 17개 광역시도(서울/경기/부산/인천/대구/대전/광주/울산/세종/제주 등) 도시계획조례 및 건축조례(BCR, FAR, 대지안의 공지, 조경, 부설주차장)를 주소로부터 자동 매칭하여 국토계획법 상한보다 최우선 적용.

5. **층별 건축한계선 (Buildable Envelope)**
   - 대지경계선 이격 및 층별 일조사선을 슬라이스한 층별 건축한계선(Buildable Envelope)을 정확한 수치 및 3D 다각형 좌표로 산출하여 3D 매스 배치에 직접 연동.

6. **공동주택 채광창 및 동간 인동거리**
   - **시행령 제86조 제3항 제1호**: 채광창 방향 대지경계선 이격거리 $D \ge 0.5H$ (다세대주택 $0.25H$).
   - **시행령 제86조 제3항 제2호 및 주택건설기준 등에 관한 규정 제10조**: 동일 대지 내 2개 동 이상 배치 시 채광창 대면 남측동 $0.5H$, 측벽 대면 4m/8m, 부대복리시설 대면 $1.0H$ 확보.

7. **토지이용계획확인원(토지이음) 기반 중첩 규제**
   - 사이트(필지) 지정 시 중첩 규제 전수 검토: 지목 전용허가/대체산림자원조성비/농지보전부담금, 지구단위계획 지침 최우선, 고도지구 절대높이 캡핑, 방화지구 내화구조/드렌처, 경관지구 건축선 후퇴, 교육환경보호구역(절대보호구역 50m 유해시설 금지), 공개공지(5~10% 확보 시 용적률/높이 1.2배 완화).

8. **무중단 Fallback & 크로스 AI 동기화**
   - 외부 마이크로서비스(8001)나 Neo4j 유무와 무관하게 `src/legal/` 내장 엔진으로 즉시 자동 전환되어 100% 무중단 건축검토 보고서와 3D Envelope 데이터를 산출함.
   - 모든 AI 에이전트(Codex, Claude, Gemini)는 본 규칙을 단일 진실 원천으로 공유하며, 코드 수정 시 3대 핵심 테스트(종합법규, 대지별 Envelope, 사이트 클릭 중첩규제) 100% 통과 유지.

---

## 2. 입면(Elevation) 품질 게이트 및 8대 뷰 검증 기준

ElevationAgent의 핵심은 8개 모든 뷰와 PBR 렌더링에서 무결함(Zero Defect)을 유지하는 것입니다:

1. **8대 필수 도면 및 뷰 (All 8 Views)**
   - **직교 도면 (Orthographic)**: `front`, `back`, `left`, `right`, `plan` (1.2m 컷), `top`
   - **투시 및 축측 (Perspective & Axonometric)**: `axon`, `opposite-axon`, `perspective-hero`
   - 모든 뷰는 2400x2400 해상도, 표준 여백(9%), 통일된 픽셀/미터 스케일을 준수해야 함.

2. **동일 재료 심선 검출 방지 (`TRIANGULATION_VISIBLE`)**
   - 평면도(1.2m 컷) 및 입면도에서 동일 재료간 단차가 없는데 선이 남는 결함 방지.
   - `cutLineInkMask`를 통해 렌더러 자체의 펜 잉크 스트로크가 가짜 심선으로 오인되지 않도록 마스킹 처리.
   - 파셋 분할부에서는 평탄 셰이딩 노멀 래스터(`normal-flat`)를 병행하여 경사진 매스(creative-004)의 능선(crease)은 선명히 살리고 평면 접합부 심선 오류는 0으로 유지.

3. **개구부 비율 및 전면 투명도 (`OPENING_RATIO`, `GROUND_TRANSPARENCY`)**
   - 입면별 최소 개구율 충족 (4개 입면 중 최악 입면 기준 검증, 21%~35% 이상 권장).
   - 단, `source_photograph`를 명시한 사진 전사(Transcription)의 경우 파사드 베일(The Broad)이나 차양 스크린(Al Bahar) 재현 시 waivable 게이트로 안전하게 예외 인정.
   - 지상층(`storey == 1`)은 주출입구 및 가로 활성화를 위해 적정 투명도와 명확한 출입구(portal/entrance) 배치 필수.

4. **상부 종결성 (`TOP_TERMINATION`)**
   - 최상층(`storey == 5`)은 코니스(`cornice`) 또는 파라펫으로 4개 입면(`front`, `back`, `left`, `right`) 모두 명확히 종결되어야 함.

5. **스케일 위계 및 층간 연계 (`STOREY_LOCKSTEP`, `SCALE_HIERARCHY`)**
   - 1개 층이 5번 반복되는 아파트형 격자 탈피: 2개 층 이상 연속되는 거대 오더(`max_storey_span >= 2`) 및 개구부 크기 다양성(`scale_ratio >= 2.3`) 확보.

6. **층간 슬래브 침범 금지 (`FLOOR_BAND_INTRUSION`)**
   - 창호 상하단은 층간 슬래브 라인과 0.15m 이상 안전 이격 유지 (단, 전층 스패닝 커튼월 창호는 슬래브를 완전히 관통하여 합법적 연속성 유지).

7. **PBR 물리 렌더링 및 시맨틱 롤 (`PBR_PRESENTATION_RANGE_INVALID`, `MATERIAL_ROLE_MISSING`)**
   - 콘크리트(`concrete`), 벽돌/패널(`opaque`), 창호 프레임(`bronze`), 유리(`glass`) 등 최소 4개 시맨틱 롤이 각 뷰마다 올바르게 분배되어야 함.
   - P05 휘도 $\ge 10$, 시맨틱 롤 간 색상 및 밝기 분리도(contrast) 기준 충족.

---

## 3. 비전 파운데이션 모델 파이프라인 (Vision-to-Grammar)

1. **Meta SAM 3 & SAM 3.1 (Segment Anything with Concepts)**
   - 체크포인트: `sam3.pt` (3.29 GB, `clone/sam3/checkpoints/sam3.pt`).
   - 오픈 보캐뷸러리 개념 프롬프팅 (`Sam3Processor.set_text_prompt`) 지원으로 외부 디텍터 없이 텍스트(`window`, `opening`, `aperture`)로 입면 부재 직접 분할.
   - CUDA BFloat16 자동 가속 지원.

2. **DINO 패밀리 2대 계보 통합**
   - **Meta FAIR DINOv3 (arXiv:2508.10104)**: ViT-S부터 7B 매개변수 기반 고해상도 고밀도 특징 맵(Dense feature extraction) 추출, 입면 대칭성/리듬 분석.
   - **IDEA-Research DINO-X (arXiv:2411.14347) & Grounding DINO 1.5/1.6 Pro**: 프롬프트 기반/무프롬프트 개방형 객체 검출 및 분할, 공식 MCP 도구(`DINO-X-MCP`) 연동.
   - **Grounded-SAM-2 (Grounding DINO + SAM 2.1)**: 오프라인/로컬 자동 폴백 엔진.

3. **벡터화 및 파라메트릭 역설계**
   - **VTracer**: 픽셀 마스크를 다중 3차 베지어 스플라인(`facade_vector.svg`) 및 단위 창호 SVG(`sample_opening.svg`)로 무손실 벡터화.
   - **Douglas-Peucker & Convex Hull**: 정규화 [0..1] 외곽선(`outline`) 생성.
   - **2D Field Attractor Fitting**: 오큘러스/유리 개구부 중심점 좌표 및 면적 분포로부터 거리/방위 기반 2차원 파라메트릭 인셋 필드 계수 역산.
   - **문법 합성**: `arr.elevation3d.facade-grammar.v3` 규격 준수 JSON 출력 -> `cli.mjs check` 및 `render`로 100% 무결함 8뷰 CAD 생성.

---

## 4. Codex 실행 지침 및 오류/쿼터 대응 원칙

1. **Codex CLI 실행 및 세션 바인딩**
   - 프롬프트 바이트는 반드시 stdin을 통해 전달(`-` 인자 사용), 셸 인자 분해 및 이스케이프 왜곡 방지.
   - 이미지 생성 시 `session id`를 stderr 또는 thread 이벤트에서 파싱하여 개별 세션 디렉터리(`~/.codex/generated_images/<session_id>/`)에서만 산출물을 취득.

2. **쿼터 초과(Usage Limit) 및 계정 권한 대응**
   - `You’ve hit your usage limit`: 쿼터 리셋 일시를 파싱하여 `CODEX_QUOTA_EXCEEDED`를 명확히 상위 파이프라인에 통지.
   - `not supported when using Codex with a ChatGPT account`: 권한 불일치 에러 감지 시 즉시 Claude/Gemini/로컬 엔진으로 자동 Fallback.
   - 이미지 생성 외의 코드 작성/문법 해석/검증 태스크는 Codex에 의존하지 않고 로컬 Claude/Gemini 에이전트로 무중단 전환.

3. **Pleated Mass (creative-004) 작업 원칙**
   - 113개 패싯, 1.76m 미세 절첩 매스에서 셀 예산(MAX_CELLS) 및 솔리드 파트 비율 < 25% 유지.
   - 단순 사각 범위(`usableFaceRectangle`) 대신 실제 벽체 다각형(`wall_patch`)에 맞춘 슬라이스 및 접합 유지.
   - 상부 톱니형 파라펫(`sawtooth crest`) 및 절첩부 접합선 다듬기 완료 유지.
