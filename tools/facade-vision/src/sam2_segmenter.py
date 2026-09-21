"""
sam2_segmenter.py
Grounded-SAM-2 deep learning segmentation runner.
Combines Grounding DINO (text prompt detection) and SAM 2.1 (promptable segmentation).
Uses the same detector/segmenter combination discussed by IAAC; not their source implementation.
"""

import os
import sys
import torch
import numpy as np
from PIL import Image

current_dir = os.path.dirname(os.path.abspath(__file__))
repo_root = os.path.abspath(os.path.join(current_dir, "..", "..", ".."))
root_50 = os.path.abspath(os.path.join(repo_root, ".."))

sam2_search_paths = [
    os.environ.get("SAM2_PATH"),
    os.environ.get("GROUNDED_SAM2_PATH"),
    os.path.join(repo_root, "clone", "Grounded-SAM-2"),
    os.path.join(repo_root, "clone", "Grounded-SAM-2", "grounding_dino"),
    os.path.join(repo_root, "vendor", "Grounded-SAM-2"),
    os.path.join(root_50, "clone", "Grounded-SAM-2"),
    os.path.join(root_50, "clone", "Grounded-SAM-2", "grounding_dino"),
]
for p in sam2_search_paths:
    if p and os.path.exists(p) and p not in sys.path:
        sys.path.insert(0, p)

try:
    from sam2.build_sam import build_sam2
    from sam2.automatic_mask_generator import SAM2AutomaticMaskGenerator
    from sam2.sam2_image_predictor import SAM2ImagePredictor
    SAM2_AVAILABLE = True
except ImportError:
    SAM2_AVAILABLE = False

try:
    from grounding_dino.groundingdino.util.inference import load_model as load_gdino_model, predict as predict_gdino, load_image as load_gdino_image
    from torchvision.ops import box_convert
    GDINO_AVAILABLE = True
except Exception:
    GDINO_AVAILABLE = False

def find_sam2_checkpoint():
    env_ckpt = os.environ.get("SAM2_CHECKPOINT")
    if env_ckpt and os.path.exists(env_ckpt):
        return env_ckpt
    candidates = [
        os.path.join(repo_root, "checkpoints", "sam2.1_hiera_small.pt"),
        os.path.join(root_50, "clone", "Grounded-SAM-2", "checkpoints", "sam2.1_hiera_small.pt"),
        os.path.join(root_50, "clone", "checkpoints", "sam2.1_hiera_small.pt"),
        os.path.join(root_50, "checkpoints", "sam2.1_hiera_small.pt"),
        os.path.join(current_dir, "..", "checkpoints", "sam2.1_hiera_small.pt"),
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return candidates[0]

def find_gdino_checkpoint():
    env_ckpt = os.environ.get("GDINO_CHECKPOINT")
    if env_ckpt and os.path.exists(env_ckpt):
        return env_ckpt
    candidates = [
        os.path.join(repo_root, "checkpoints", "groundingdino_swint_ogc.pth"),
        os.path.join(root_50, "clone", "Grounded-SAM-2", "gdino_checkpoints", "groundingdino_swint_ogc.pth"),
        os.path.join(root_50, "clone", "checkpoints", "groundingdino_swint_ogc.pth"),
        os.path.join(root_50, "checkpoints", "groundingdino_swint_ogc.pth"),
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return candidates[0]

def find_gdino_config():
    env_cfg = os.environ.get("GDINO_CONFIG")
    if env_cfg and os.path.exists(env_cfg):
        return env_cfg
    candidates = [
        os.path.join(repo_root, "clone", "Grounded-SAM-2", "grounding_dino", "groundingdino", "config", "GroundingDINO_SwinT_OGC.py"),
        os.path.join(root_50, "clone", "Grounded-SAM-2", "grounding_dino", "groundingdino", "config", "GroundingDINO_SwinT_OGC.py"),
        os.path.join(root_50, "groundingdino", "config", "GroundingDINO_SwinT_OGC.py"),
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return candidates[0]

class SAM2FacadeSegmenter:
    def __init__(self, checkpoint=None, model_cfg="configs/sam2.1/sam2.1_hiera_s.yaml", device=None):
        if not SAM2_AVAILABLE:
            raise RuntimeError("SAM-2 is not installed. Run pip install -e clone/Grounded-SAM-2.")
        
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.checkpoint = checkpoint or find_sam2_checkpoint()
        print(f"[Grounded-SAM-2] Loading SAM 2.1 ({os.path.basename(self.checkpoint)}) on {self.device}...")
        self.model = build_sam2(model_cfg, self.checkpoint, device=self.device)
        self.predictor = SAM2ImagePredictor(self.model)
        self.mask_generator = SAM2AutomaticMaskGenerator(
            self.model,
            points_per_side=32,
            pred_iou_thresh=0.75,
            stability_score_thresh=0.85,
            min_mask_region_area=100,
        )

        self.gdino_model = None
        if GDINO_AVAILABLE:
            gdino_ckpt = find_gdino_checkpoint()
            gdino_cfg = find_gdino_config()
            if os.path.exists(gdino_ckpt) and os.path.exists(gdino_cfg):
                try:
                    print(f"[Grounded-SAM-2] Loading Grounding DINO ({os.path.basename(gdino_ckpt)}) on {self.device}...")
                    self.gdino_model = load_gdino_model(gdino_cfg, gdino_ckpt, device=self.device)
                    print("[Grounded-SAM-2] Grounding DINO ready for open-vocabulary prompt guidance.")
                except Exception as e:
                    print(f"[Grounded-SAM-2] Grounding DINO loading skipped: {e}")

    @torch.inference_mode()
    def generate_masks(self, image_input, text_prompt="window . opening . aperture .", automatic=False):
        """
        Segment facade aperture components using IAAC Grounded-SAM-2 flow:
        1. Grounding DINO text prompt detection for aperture bounding boxes.
        2. SAM 2.1 prompt-guided box predictor for high-precision masks.
        3. SAM 2.1 automatic grid masks for full spatial coverage.
        """
        image_path = None
        if isinstance(image_input, str):
            image_path = image_input
            image_pil = Image.open(image_input).convert("RGB")
            image_np = np.array(image_pil)
        elif isinstance(image_input, np.ndarray):
            image_np = image_input
            image_pil = Image.fromarray(image_input).convert("RGB")
        else:
            image_pil = image_input
            image_np = np.array(image_pil)

        h, w = image_np.shape[:2]
        masks_result = []

        if not automatic and (self.gdino_model is None or image_path is None):
            raise RuntimeError('GROUNDING_DINO_REQUIRED: detector unavailable or image path missing')
        # Step 1: Grounding DINO + SAM 2.1 Prompted Prediction
        if self.gdino_model is not None and image_path is not None:
            try:
                print(f"[Grounded-SAM-2] Running Grounding DINO with prompt: '{text_prompt}'...")
                image_source, image_tensor = load_gdino_image(image_path)
                boxes, confidences, labels = predict_gdino(
                    model=self.gdino_model,
                    image=image_tensor,
                    caption=text_prompt,
                    box_threshold=0.10,
                    text_threshold=0.10,
                    device=self.device
                )
                print(f"[Grounded-SAM-2] Detected {len(boxes)} aperture boxes.")
                if len(boxes) > 0:
                    boxes = boxes * torch.Tensor([w, h, w, h])
                    xyxy = box_convert(boxes=boxes, in_fmt="cxcywh", out_fmt="xyxy").numpy()
                    
                    self.predictor.set_image(image_source)
                    prompt_masks, scores, _ = self.predictor.predict(
                        point_coords=None,
                        point_labels=None,
                        box=xyxy,
                        multimask_output=False
                    )
                    if prompt_masks.ndim == 4:
                        prompt_masks = prompt_masks.squeeze(1)

                    for i in range(len(prompt_masks)):
                        m = prompt_masks[i]
                        area = int(np.sum(m))
                        x0, y0, x1, y1 = [float(v) for v in xyxy[i]]
                        score_val = float(np.ravel(scores[i])[0]) if i < len(scores) else 0.95
                        masks_result.append({
                            "segmentation": m,
                            "area": area,
                            "bbox": [x0, y0, x1 - x0, y1 - y0],
                            "predicted_iou": score_val,
                            "source": "grounded_sam2"
                        })
                    print(f"[Grounded-SAM-2] Added {len(prompt_masks)} prompt-guided opening masks.")
            except Exception as e:
                raise RuntimeError(f'GROUNDING_DINO_INFERENCE_FAILED: {e}') from e

        if not automatic:
            if not masks_result:
                raise RuntimeError('NO_GROUNDED_OPENINGS: DINO found no prompted components')
            return masks_result

        # Step 2: SAM 2.1 Automatic Grid Detection for full coverage
        auto_masks = self.mask_generator.generate(image_np)
        print(f"[Grounded-SAM-2] SAM 2.1 generated {len(auto_masks)} automatic grid masks.")
        for am in auto_masks:
            am["source"] = "sam2_auto"
            masks_result.append(am)

        print(f"[Grounded-SAM-2] Total candidate masks compiled: {len(masks_result)}")
        return masks_result
