# facade-concept

The first step of the standard lane — MASS → **PERSPECTIVE** → DRAWING — run on this machine.

Every step after the perspective was already local, deterministic code. The perspective itself
came from one closed account, and when that account lost its entitlement the lane lost its
entrance. This tool is the open alternative: Stable Diffusion XL with a ControlNet over the
depth raster the evidence pack already renders for the bare mass.

```bash
python tools/facade-concept/cli.py \
  --control output/<candidate>/<run>/evidence/depth/axon.png \
  --out    output/<candidate>/<run>/concept-<name>.png \
  --subject "A five-storey building of exactly this form, 16.5 m tall, standing on the street. …"
```

Usually you call it through the pipeline instead, which builds the subject from the prepared
context so nobody types the storey count by hand:

```bash
node tools/facade-pipeline/cli.mjs concept <candidate> <name> --engine sdxl --idea "…"
```

## Why a ControlNet and not a better prompt

A commission *describes* the mass in words and asks the model to respect it — which is how a
five-storey prism once came back as a star-plan tower. A ControlNet does not ask: the geometry
is an input, so the facade is invented inside a silhouette that is already correct.

## What it needs

| | | |
|---|---|---|
| `SG161222/RealVisXL_V4.0` | 6,619 MB | ungated, downloads itself |
| `xinsir/controlnet-union-sdxl-1.0` | 2,396 MB | ungated; falls back to `controlnet-canny-sdxl-1.0` |
| `madebyollin/sdxl-vae-fp16-fix` | 639 MB | ungated |
| a CUDA card | ~8–10 GB VRAM | fp16 with model offload; 12 GB is comfortable |

Nothing here is gated, unlike SAM 3 — the first run downloads what it needs. `HF_HOME` moves or
shares the cache. About 25 s an image at 28 steps on an RTX 4070 Ti.

## Three things measured while this was built (2026-09-24)

They are about what the lane can be **asked for**, not about the model, and each cost a run:

1. **A question draws nothing.** The open brief handed over verbatim — *"what facade does a
   building of this shape want?"* — returned a blank white massing model. A diffusion model
   renders a description; it does not answer a question. Name the programme (storeys, windows,
   an entrance). Style, palette and material still must not be named: that rule stands.
2. **A flat depth map is not a constraint.** Conditioned on a prism's *front* raster the model
   returned a close-up curtain wall with no building in it. Condition on the three-quarter axon,
   which carries the form.
3. **The trace reads cells, not glass.** SAM 3 found 0 apertures in a continuous glazed skin —
   correctly, it has none — and the lattice fit refused a sparse punched grid outright: *the
   inlier cells lie on one line; a lattice needs two directions.* What this lane reads back is a
   **dense, doubly periodic field** of discrete cells.

A storey *count* is enforceable by none of this — there are no storeys in a depth map and no
arithmetic in a diffusion model — so the transcriber still reads the picture against the mass
facts, as it always has.

## Provenance

Every image writes `<name>.provenance.json` beside it: base model, ControlNet, both snapshot
hashes, seed, steps, conditioning scale and the subject. A concept nobody can reproduce is not
evidence — the same reason `checkpoints/README.md` records the digest of every weight file.

## Layout

    cli.py                 one JSON object on stdout, non-zero on failure
    src/sdxl_concept.py    prompt composition, pipeline, fallback, provenance
    test/test_concept.py   everything decided before the model runs (no GPU, no weights)
