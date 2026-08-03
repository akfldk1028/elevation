# Approach C: Tripo Single Render to 3D

## Goal

Turn one existing isometric MASS render into one actual 3D GLB in a single provider generation task.

## Flow

```text
candidate/render.png
  -> locate and crop isometric panel
  -> remove panel label, border, and excess whitespace
  -> upload cropped PNG
  -> Tripo image_to_model (first test: geometry only)
  -> download generated GLB immediately
  -> normalize orientation, scale, and origin
  -> compare against original OBJ and held-out views
  -> render axon, opposite, top, front, right, back, and left
```

## Why geometry-only first

The first question is whether the provider reconstructs the MASS correctly. Texture and PBR can obscure geometric errors and cost additional credits. Appearance generation is a separate later test.

## Failure signals

- the four-panel board is interpreted as multiple objects;
- the open court or concavity is filled;
- curved geometry becomes straight or fragmented;
- disconnected pieces merge or vanish;
- output orientation cannot be aligned reliably;
- held-out front/top/opposite silhouettes disagree materially.
