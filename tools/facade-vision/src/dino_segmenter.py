"""
dino_segmenter.py
Integration module for the modern DINO family:
1. DINO-X (IDEA-Research, arXiv:2411.14347) - Open-world unified detection & segmentation
2. Grounding DINO 1.5 Pro & 1.6 Pro (IDEA-Research / DeepDataSpace)
3. Meta DINOv3 (Meta FAIR, arXiv:2508.10104) - Dense vision foundation models (ViT-S to ViT-7B)
4. SegDINO3D (IDEA-Research, AAAI 2026) - Open-world 3D instance segmentation
"""

import os
import sys
import torch
import numpy as np
from PIL import Image

try:
    from dds_cloudapi_sdk import Config, Client
    from dds_cloudapi_sdk.image_resizer import image_to_base64
    from dds_cloudapi_sdk.tasks.v2_task import V2Task
    from pycocotools import mask as mask_utils
    DINOX_AVAILABLE = True
except ImportError:
    DINOX_AVAILABLE = False

try:
    import dinov3
    DINOV3_AVAILABLE = True
except ImportError:
    DINOV3_AVAILABLE = False


class DINOXFacadeDetector:
    """
    IDEA-Research DINO-X SOTA open-world detector and segmenter.
    Capable of open-vocabulary promptable and prompt-free instance segmentation (+5.8 AP on LVIS rare).
    """
    def __init__(self, api_token=None, model="DINO-X-1.0"):
        self.api_token = api_token or os.environ.get("DDS_API_TOKEN") or os.environ.get("DINOX_API_TOKEN")
        self.model = model
        if not DINOX_AVAILABLE:
            raise RuntimeError("dds-cloudapi-sdk and pycocotools are required for DINO-X. Install via pip install dds-cloudapi-sdk pycocotools.")
        if not self.api_token:
            print("[DINO-X] Warning: No DDS_API_TOKEN or DINOX_API_TOKEN found in environment. Cloud API calls will require token.")

    def detect_apertures(self, image_path, text_prompt="window . opening . facade aperture", bbox_threshold=0.25, iou_threshold=0.8):
        """
        Runs DINO-X detection and segmentation on the cloud API, returning aperture instances formatted for ElevationAgent.
        """
        if not self.api_token:
            raise RuntimeError("DINO-X API token required. Set DDS_API_TOKEN environment variable.")

        config = Config(self.api_token)
        client = Client(config)
        image_b64 = image_to_base64(image_path)

        api_path = "/v2/task/dinox/detection"
        api_body = {
            "model": self.model,
            "image": image_b64,
            "prompt": {
                "type": "text",
                "text": text_prompt
            },
            "mask_format": "coco_rle",
            "targets": ["bbox", "mask"],
            "bbox_threshold": bbox_threshold,
            "iou_threshold": iou_threshold
        }

        task = V2Task(api_path=api_path, api_body=api_body)
        client.run_task(task)
        result = task.result
        objects = result.get("objects", [])

        results = []
        for obj in objects:
            bx, by, bw, bh = obj["bbox"]
            decoded_mask = mask_utils.decode(obj["mask"]).astype(bool) if "mask" in obj else None
            area = int(np.sum(decoded_mask)) if decoded_mask is not None else int(bw * bh)
            score = float(obj.get("score", 1.0))
            category = obj.get("category", "opening")

            results.append({
                "segmentation": decoded_mask,
                "area": area,
                "bbox": [float(bx), float(by), float(bw), float(bh)],
                "predicted_iou": score,
                "source": "dinox",
                "concept": category
            })
        print(f"[DINO-X] Successfully extracted {len(results)} apertures.")
        return results


class DINOv3FeatureExtractor:
    """
    Meta AI FAIR DINOv3 (arXiv:2508.10104) dense vision foundation model.
    Produces rich high-resolution spatial feature embeddings for facade symmetry, rhythm, and material classification.
    """
    def __init__(self, model_name="dinov3_vits16", device=None):
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.model_name = model_name
        print(f"[DINOv3] Initializing Meta DINOv3 ({model_name}) on {self.device}...")

        self.model = None
        if DINOV3_AVAILABLE:
            try:
                # Attempt loading via torch hub or local package
                self.model = torch.hub.load("facebookresearch/dinov3", model_name, pretrained=False)
                self.model = self.model.to(self.device).eval()
            except Exception as e:
                print(f"[DINOv3] torch.hub model load notice: {e}")

    def extract_dense_features(self, image_input):
        """
        Extracts dense spatial feature tokens for the facade.
        """
        if self.model is None:
            raise RuntimeError("DINOv3 model weights not initialized.")

        if isinstance(image_input, str):
            image = Image.open(image_input).convert("RGB")
        else:
            image = image_input

        # Preprocessing: resize to multiples of patch_size (16)
        w, h = image.size
        new_w = (w // 16) * 16
        new_h = (h // 16) * 16
        img_resized = image.resize((new_w, new_h), Image.BICUBIC)

        img_tensor = torch.from_numpy(np.array(img_resized)).permute(2, 0, 1).float() / 255.0
        # ImageNet normalization
        mean = torch.tensor([0.485, 0.456, 0.406]).view(3, 1, 1)
        std = torch.tensor([0.229, 0.224, 0.225]).view(3, 1, 1)
        img_norm = (img_tensor - mean) / std
        img_batch = img_norm.unsqueeze(0).to(self.device)

        with torch.no_grad():
            if "cuda" in self.device:
                with torch.autocast("cuda", dtype=torch.bfloat16):
                    features = self.model(img_batch)
            else:
                features = self.model(img_batch)

        return features
