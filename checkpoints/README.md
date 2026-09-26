# Model Checkpoints Guide

This directory holds weights for the vision models (SAM 3, SAM 2.1, Grounding DINO). They are
several GB and are excluded from Git.

**Nothing in this repository downloads SAM 3.** An earlier version of this file said the system
would fetch `facebook/sam3` from Hugging Face when authenticated; it does not, and never did —
there is no `hf_hub_download`, `snapshot_download` or `from_pretrained` anywhere in
`tools/facade-vision/`. Meta's SAM 3 is a **gated** release, so only you can obtain it.

## What each one is, and where it comes from

| file | source | gated | bytes | sha256 (this project's runs) |
|---|---|---|---|---|
| `sam3.pt` | [facebook/sam3](https://huggingface.co/facebook/sam3) (3.1: [facebook/sam3.1](https://huggingface.co/facebook/sam3.1)) | **yes** | 3,450,062,241 | `9999e2341ceef5e136daa386eecb55cb414446a00ac2b55eb2dfd2f7c3cf8c9e` |
| `sam2.1_hiera_small.pt` | [dl.fbaipublicfiles.com](https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt) | no | 184,416,285 | `6d1aa6f30de5c92224f8172114de081d104bbd23dd9dc5c58996f0cad5dc4d38` |
| `groundingdino_swint_ogc.pth` | [GroundingDINO v0.1.0-alpha](https://github.com/IDEA-Research/GroundingDINO/releases/tag/v0.1.0-alpha) | no | 693,997,677 | `3b3ca2563c77c69f651d7bd133e97139c186df06231157a64c507099c52bc799` |

The digests were measured on 2026-09-24 against the files every drawing in this project was made
with. Check a new machine against them — everything else in this lane is hash-checked and the
weights were the one input that was not.

**SAM 3 or SAM 3.1?** The file is called `sam3.pt` either way and nothing here records which
release it is. If that distinction matters to a result, record it beside the run yourself.

## Getting SAM 3

1. Open <https://huggingface.co/facebook/sam3> and request access.
2. Once accepted, `hf auth login` with a token from that account.
3. `hf download facebook/sam3 --include "sam3.pt" --local-dir checkpoints`
4. Or put it anywhere and set `SAM3_CHECKPOINT=/path/to/sam3.pt`.

The SAM 3 *package* is a second, separate thing: `import sam3` is Meta's repository
(<https://github.com/facebookresearch/sam3>, 71 MB of source), not a PyPI install. Clone it to
`vendor/sam3`, or name it with `SAM3_PATH`. See the README's setup section.

## Where they are looked for

Each segmenter takes the first that exists: its environment variable
(`SAM3_CHECKPOINT` / `SAM2_CHECKPOINT` / `GDINO_CHECKPOINT`), then `<repo>/checkpoints/`, then
the pre-2026-09 layout beside the repository (`<repo>/../clone/…`) — that last one is a courtesy
to this one machine, not something a new checkout should rely on.

## Helper

```bash
python scripts/download_checkpoints.py             # find them, report size, link into checkpoints/
python scripts/download_checkpoints.py --verify    # sha256 against the table above (about 10 s for all three)
python scripts/download_checkpoints.py --download  # fetch the two that are NOT gated
```

It reads the environment variables first, so a machine configured that way is reported as OK
rather than MISSING.

## Without any of them

`cli.mjs trace … --engine classical` needs no weights and no upstream source. On a real
photograph it is then refused by the fidelity gate — measured `mask_iou 0.802` against a floor
of 0.90, where tiled SAM 3 scores 0.924 — which is the gate doing its job, not a broken install.
