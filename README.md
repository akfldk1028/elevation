# ElevationAgent

AI-driven Architectural **Mass-to-Elevation Dressing & 8-View Technical Drawing Engine**.

---

## 🏛️ Core Philosophy: "The Mass is the Authority"
1. **대지 및 매스 절대 원칙 (The Mass is the Authority):**
   - 건물의 3D 매스(Mass)는 대지 조건, 용적률(FAR), 건폐율(BCR), 정북일조 사선제한, 도로후퇴 등 건축법규에 의해 사전 확정된 **절대 기준**입니다.
   - 인공지능이 매스의 외곽 형태나 체적을 임의로 왜곡하거나 제멋대로 생성하지 않습니다.
2. **3단계 드레싱 파이프라인 (Mass ➡️ Concept ➡️ Elevation Dressing):**
   - **Step 1 (Mass):** 확정된 3D 기준 매스 (`data/datasets/candidates/<id>/mass/mesh/mass.obj`)
   - **Step 2 (Concept):** 사용자가 제시한 생성형 파사드 컨셉 이미지 분석 (창호, 루버, 재질, 비례 분해 및 4점 호모그래피 투시 정사 보정)
   - **Step 3 (Dressing & Draw):** 매스 표면에 건축법규와 파라메트릭 규칙에 맞춰 오차 없이 입혀(Dressing), **8대 정규 건축 도면**(Front, Back, Left, Right, Axon, Opposite-Axon, Plan, Top) 및 PBR GLB 3D 모델로 출력합니다.

---

## 📁 Repository Structure (Self-Contained)

```
ElevationAgent/
├── data/
│   └── datasets/              # Built-in sample masses (creative-020, creative-004)
│       └── candidates/
│           ├── creative-020/  # Standard commercial/office mass
│           └── creative-004/  # Complex pleated faceted mass
├── checkpoints/               # Neural model weights (git-ignored, helper script provided)
│   ├── README.md
│   ├── sam3.pt                # Meta SAM 3 / 3.1
│   ├── sam2.1_hiera_small.pt  # SAM 2.1
│   └── groundingdino_swint_ogc.pth # Grounding DINO
├── output/                    # Generated schemes, GLBs, and 8 elevation drawings
├── tools/
│   ├── facade-parametric/     # Python parametric lattice fitting & facet clipping
│   ├── facade-vision/         # Vision feature extraction (SAM3, SAM2, DINO, VTracer)
│   ├── facade-pipeline/       # Node.js workflow orchestrator & CLI
│   └── facade-presentation/   # Catalog and presentation sheet builders
├── plugins/
│   └── elevation-3d/          # 3D mass compilation & WebGL/Canvas rendering
├── test/                      # Comprehensive test suite (Python & TypeScript)
├── scripts/
│   └── download_checkpoints.py# Model weights verification & downloader
├── elevation-agent.json       # Repo-relative path configuration
├── package.json               # Node.js dependencies
└── README.md
```

---

## 🚀 Quick Start in Any Repository / Environment

### 1. Prerequisites
- **Node.js**: >= 18.0.0
- **Python**: >= 3.10
- **CUDA**: Optional (CPU fallback supported, CUDA recommended for SAM3/DINO)

### 2. Installation
```bash
# 1. Install Node.js dependencies
npm install

# 2. Install Python dependencies
pip install -r tools/facade-parametric/requirements.txt
pip install -r tools/facade-vision/requirements.txt
```

### 3. Model Weights Setup
If running neural vision models (SAM 3 / Grounded-SAM-2):
```bash
python scripts/download_checkpoints.py
```
*Or set environment variables:*
- `SAM3_CHECKPOINT=/path/to/sam3.pt`
- `SAM2_CHECKPOINT=/path/to/sam2.1_hiera_small.pt`
- `GDINO_CHECKPOINT=/path/to/groundingdino_swint_ogc.pth`

---

## 🛠️ Usage

### 1. Parametric Facade Fitting & Elevation Generation
Apply a facade grammar/trace to a mass and render all 8 drawings:
```bash
# 1. Apply facade scheme to mass
node tools/facade-pipeline/cli.mjs apply creative-020 test_broad_authentic_veil.json

# 2. Render 8 technical views and 3D GLB
node tools/facade-pipeline/cli.mjs draw creative-020
```

### 2. Vision Feature Extraction from Concept Image
Extract opening contours and lattice parameters from a concept image with 4-point homography perspective rectification:
```bash
python tools/facade-vision/trace_runner.py path/to/concept.png --engine sam3 --rectify --output output/trace.json
```

---

## ⚙️ Configuration (`elevation-agent.json`)
Paths are repo-relative by default and can be overridden via environment variables:
```json
{
  "dataset_root": "./data/datasets",
  "output_root": "./output",
  "fixture_root": "./test/fixtures"
}
```
- `ELEVATION_AGENT_DATASET_ROOT`: Override dataset directory
- `ELEVATION_AGENT_OUTPUT_ROOT`: Override output directory
- `ELEVATION_AGENT_FIXTURE_ROOT`: Override fixture directory
