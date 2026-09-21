"""
sam3_segmenter.py
Integration module for Meta SAM 3 (Segment Anything with Concepts) & SAM 3.1 Object Multiplex.
Direct foundation model concept prompting (open-vocabulary) for architectural facades.
Lineage: Meta Superintelligence Labs (November 2025 / SAM 3.1 March 2026).
"""

import os
import sys
import torch
import numpy as np
from PIL import Image

current_dir = os.path.dirname(os.path.abspath(__file__))
root_50 = os.path.abspath(os.path.join(current_dir, "..", "..", "..", ".."))
sys.path.append(os.path.join(root_50, "clone", "sam3"))

try:
    from sam3.model_builder import build_sam3_image_model
    from sam3.model.sam3_image_processor import Sam3Processor
    SAM3_AVAILABLE = True
except Exception as e:
    SAM3_AVAILABLE = False
    _SAM3_IMPORT_ERROR = str(e)

class SAM3FacadeSegmenter:
    """
    SAM 3 Architectural Facade Segmenter.
    Natively supports open-vocabulary concept prompting without separate detector models.
    """
    def __init__(self, checkpoint_path=None, device=None, load_from_hf=True):
        if not SAM3_AVAILABLE:
            raise RuntimeError(f"SAM 3 is not available: {_SAM3_IMPORT_ERROR}")
        
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        print(f"[SAM 3] Initializing Meta SAM 3 image model on {self.device}...")
        
        # Autocast is scoped to inference below, never leaked into the caller.
        if "cuda" in self.device:
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True
        
        # Check local checkpoints
        candidates = [
            checkpoint_path,
            os.path.join(root_50, "clone", "sam3", "checkpoints", "sam3.pt"),
            os.path.join(root_50, "checkpoints", "sam3.pt"),
        ]
        local_ckpt = next((c for c in candidates if c and os.path.exists(c)), None)
        
        if local_ckpt:
            print(f"[SAM 3] Loading local checkpoint: {local_ckpt}")
            self.model = build_sam3_image_model(checkpoint_path=local_ckpt, load_from_HF=False, device=self.device)
        else:
            if not load_from_hf:
                raise RuntimeError('SAM3_CHECKPOINT_MISSING: provide a local checkpoint')
            print(f"[SAM 3] Loading via Hugging Face Hub (facebook/sam3)...")
            self.model = build_sam3_image_model(load_from_HF=True, device=self.device)
            
        self.processor = Sam3Processor(self.model, confidence_threshold=0.08)
        print("[SAM 3] Model initialized successfully for concept prompting.")

    def generate_masks(self, image_input, text_prompt="window", confidence_threshold=0.08):
        """
        Runs open-vocabulary concept segmentation on the input image using Meta SAM 3.
        Supports single concept or multi-concept (separated by . or ,).
        Returns list of dicts: [{'segmentation': np.ndarray, 'area': int, 'bbox': [x, y, w, h], 'score': float}]
        """
        if isinstance(image_input, str):
            image = Image.open(image_input).convert("RGB")
        elif isinstance(image_input, np.ndarray):
            image = Image.fromarray(image_input).convert("RGB")
        else:
            image = image_input

        self.processor.confidence_threshold = confidence_threshold

        # Parse concepts (single words perform best in SAM 3 tokenizer)
        concepts = [c.strip() for c in text_prompt.replace(",", ".").split(".") if c.strip()]
        if not concepts:
            concepts = ["window"]

        all_results = []
        with torch.inference_mode(), torch.autocast(device_type='cuda', dtype=torch.bfloat16, enabled='cuda' in self.device):
            inference_state = self.processor.set_image(image)
            for c in concepts:
                print(f"[SAM 3] Running concept prompt: '{c}' (thresh={confidence_threshold})...")
                output = self.processor.set_text_prompt(prompt=c, state=inference_state)
                masks = output.get("masks", [])
                boxes = output.get("boxes", [])
                scores = output.get("scores", [])
                print(f"[SAM 3] Extracted {len(masks)} concept instances for '{c}'.")

                for i in range(len(masks)):
                    m = masks[i].cpu().numpy().astype(bool) if hasattr(masks[i], "cpu") else np.array(masks[i], dtype=bool)
                    if m.ndim == 3:
                        m = m.squeeze(0)
                    b = boxes[i].cpu().float().numpy().tolist() if hasattr(boxes[i], "cpu") else list(boxes[i])
                    x0, y0, x1, y1 = b
                    s = float(scores[i].cpu().float().item()) if hasattr(scores[i], "cpu") else float(scores[i])
                    
                    all_results.append({
                        "segmentation": m,
                        "area": int(np.sum(m)),
                        "bbox": [float(x0), float(y0), float(x1 - x0), float(y1 - y0)],
                        "predicted_iou": s,
                        "source": "sam3_concept",
                        "concept": c,
                    })

        # Remove severe duplicates across concepts if any
        final_results = []
        for res in sorted(all_results, key=lambda x: x["predicted_iou"], reverse=True):
            r_box = res["bbox"]
            r_area = res["area"]
            duplicate = False
            for kept in final_results:
                k_box = kept["bbox"]
                # IoU on bbox
                ix0 = max(r_box[0], k_box[0])
                iy0 = max(r_box[1], k_box[1])
                ix1 = min(r_box[0] + r_box[2], k_box[0] + k_box[2])
                iy1 = min(r_box[1] + r_box[3], k_box[1] + k_box[3])
                if ix1 > ix0 and iy1 > iy0:
                    inter = (ix1 - ix0) * (iy1 - iy0)
                    union = r_box[2] * r_box[3] + k_box[2] * k_box[3] - inter
                    if union > 0 and (inter / union) > 0.7:
                        duplicate = True
                        break
            if not duplicate:
                final_results.append(res)

        print(f"[SAM 3] Total unique apertures selected: {len(final_results)}")
        return final_results
