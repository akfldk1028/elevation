#!/usr/bin/env python3
"""
download_checkpoints.py
Utility to verify, link, or download checkpoints for SAM 3 and Grounded-SAM-2.
"""

import os
import sys
import shutil

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CHECKPOINTS_DIR = os.path.join(REPO_ROOT, "checkpoints")

CHECKPOINTS = {
    "sam3.pt": {
        "description": "Meta SAM 3 / 3.1 Model Checkpoint",
        "url": "https://huggingface.co/facebook/sam3",
        "legacy_local": [
            os.path.join(REPO_ROOT, "..", "clone", "sam3", "checkpoints", "sam3.pt"),
            os.path.join(REPO_ROOT, "..", "checkpoints", "sam3.pt"),
        ]
    },
    "sam2.1_hiera_small.pt": {
        "description": "SAM 2.1 Hiera Small Checkpoint",
        "url": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt",
        "legacy_local": [
            os.path.join(REPO_ROOT, "..", "clone", "Grounded-SAM-2", "checkpoints", "sam2.1_hiera_small.pt"),
            os.path.join(REPO_ROOT, "..", "checkpoints", "sam2.1_hiera_small.pt"),
        ]
    },
    "groundingdino_swint_ogc.pth": {
        "description": "Grounding DINO Swin-T Checkpoint",
        "url": "https://github.com/IDEA-Research/GroundingDINO/releases/download/v0.1.0-alpha/groundingdino_swint_ogc.pth",
        "legacy_local": [
            os.path.join(REPO_ROOT, "..", "clone", "Grounded-SAM-2", "gdino_checkpoints", "groundingdino_swint_ogc.pth"),
            os.path.join(REPO_ROOT, "..", "checkpoints", "groundingdino_swint_ogc.pth"),
        ]
    }
}

def main():
    os.makedirs(CHECKPOINTS_DIR, exist_ok=True)
    print(f"[*] Checking model checkpoints in: {CHECKPOINTS_DIR}")
    
    for filename, info in CHECKPOINTS.items():
        target_path = os.path.join(CHECKPOINTS_DIR, filename)
        if os.path.exists(target_path):
            size_mb = os.path.getsize(target_path) / (1024 * 1024)
            print(f" [OK] {filename} found ({size_mb:.1f} MB)")
            continue
        
        # Check legacy local candidates
        found_local = None
        for cand in info["legacy_local"]:
            if os.path.exists(cand):
                found_local = cand
                break
        
        if found_local:
            print(f" [LINK/COPY] Found local checkpoint at {found_local}. Linking to {target_path}...")
            try:
                os.link(found_local, target_path)
                print(f"   Successfully hard-linked {filename}")
                continue
            except Exception:
                try:
                    os.symlink(found_local, target_path)
                    print(f"   Successfully symlinked {filename}")
                    continue
                except Exception:
                    print(f"   Copying {filename} (this may take a moment)...")
                    shutil.copy2(found_local, target_path)
                    print(f"   Successfully copied {filename}")
                    continue
        
        print(f" [MISSING] {filename} ({info['description']})")
        print(f"   Please download manually from: {info['url']}")
        print(f"   or set environment variable (e.g. {filename.split('.')[0].upper()}_CHECKPOINT)")

if __name__ == "__main__":
    main()
