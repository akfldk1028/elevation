# Model Checkpoints Guide

This directory holds weights for deep learning vision models (SAM 3, Grounded-SAM-2, Grounding DINO).
Due to file size (several GBs), weights are excluded from Git.

## Expected Files

1. **Meta SAM 3 / SAM 3.1**
   - File: `checkpoints/sam3.pt`
   - Alternatively: Set `SAM3_CHECKPOINT=/path/to/sam3.pt`
   - Note: If no local checkpoint is found, the system will attempt to download `facebook/sam3` via Hugging Face Hub if authenticated.

2. **SAM 2.1**
   - File: `checkpoints/sam2.1_hiera_small.pt`
   - Alternatively: Set `SAM2_CHECKPOINT=/path/to/sam2.1_hiera_small.pt`

3. **Grounding DINO**
   - File: `checkpoints/groundingdino_swint_ogc.pth`
   - Alternatively: Set `GDINO_CHECKPOINT=/path/to/groundingdino_swint_ogc.pth`

## Download Helper
You can run:
```bash
python scripts/download_checkpoints.py
```
or set the environment variables mentioned above to point to existing weights on your system.
