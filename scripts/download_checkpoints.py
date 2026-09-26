#!/usr/bin/env python3
"""
download_checkpoints.py
Find, verify, link and (where the licence allows) fetch the vision checkpoints.

What this does NOT do, and used to claim: silently obtain SAM 3. Meta's SAM 3 weights are a
GATED release - you request access on Hugging Face, are accepted, and authenticate - so no
script here can download them for you. It says so and stops. SAM 2.1 and Grounding DINO are
served from direct URLs and `--download` fetches those two.

  python scripts/download_checkpoints.py             find them, report size, link into checkpoints/
  python scripts/download_checkpoints.py --verify    also sha256 what it found, against the digests below
  python scripts/download_checkpoints.py --download  fetch the two that are not gated

Where each one is looked for, in order: its environment variable (which the segmenters read
first, so a machine set up that way is correctly configured and this script must not call it
MISSING), then `<repo>/checkpoints/`, then the pre-2026-09 layout beside the repository.

The digests are what this project's own runs were made with, measured 2026-09-24. They are here
so a copy of this repository elsewhere can prove it has the same weights - everything else in
this lane is hash-checked (the model hash, the GLB, the source photograph) and the weights were
the one input nobody could verify.
"""

import argparse
import hashlib
import os
import shutil
import sys
import urllib.request

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CHECKPOINTS_DIR = os.path.join(REPO_ROOT, "checkpoints")

CHECKPOINTS = {
    "sam3.pt": {
        "description": "Meta SAM 3 / 3.1 image model",
        "env": "SAM3_CHECKPOINT",
        "page": "https://huggingface.co/facebook/sam3",
        "gated": True,
        "bytes": 3450062241,
        "sha256": "9999e2341ceef5e136daa386eecb55cb414446a00ac2b55eb2dfd2f7c3cf8c9e",
        "legacy_local": [
            os.path.join(REPO_ROOT, "..", "clone", "sam3", "checkpoints", "sam3.pt"),
            os.path.join(REPO_ROOT, "..", "checkpoints", "sam3.pt"),
        ],
    },
    "sam2.1_hiera_small.pt": {
        "description": "SAM 2.1 Hiera Small",
        "env": "SAM2_CHECKPOINT",
        "page": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt",
        "file_url": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt",
        "gated": False,
        "bytes": 184416285,
        "sha256": "6d1aa6f30de5c92224f8172114de081d104bbd23dd9dc5c58996f0cad5dc4d38",
        "legacy_local": [
            os.path.join(REPO_ROOT, "..", "clone", "Grounded-SAM-2", "checkpoints", "sam2.1_hiera_small.pt"),
            os.path.join(REPO_ROOT, "..", "checkpoints", "sam2.1_hiera_small.pt"),
        ],
    },
    "groundingdino_swint_ogc.pth": {
        "description": "Grounding DINO Swin-T OGC",
        "env": "GDINO_CHECKPOINT",
        "page": "https://github.com/IDEA-Research/GroundingDINO/releases/tag/v0.1.0-alpha",
        "file_url": "https://github.com/IDEA-Research/GroundingDINO/releases/download/v0.1.0-alpha/groundingdino_swint_ogc.pth",
        "gated": False,
        "bytes": 693997677,
        "sha256": "3b3ca2563c77c69f651d7bd133e97139c186df06231157a64c507099c52bc799",
        "legacy_local": [
            os.path.join(REPO_ROOT, "..", "clone", "Grounded-SAM-2", "gdino_checkpoints", "groundingdino_swint_ogc.pth"),
            os.path.join(REPO_ROOT, "..", "checkpoints", "groundingdino_swint_ogc.pth"),
        ],
    },
}

GATED_STEPS = """   It is a gated release: a script cannot fetch it for you.
     1. open {page} and request access
     2. `hf auth login` with a token from your accepted account
     3. `hf download {repo} --include "{name}" --local-dir checkpoints`
     4. or put it anywhere and set {env}=/path/to/{name}"""


def digest(path, blocks=1 << 22):
    hasher = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(blocks), b""):
            hasher.update(block)
    return hasher.hexdigest()


def found_at(name, info):
    """Where this checkpoint actually is, in the order the segmenters themselves look."""
    from_env = os.environ.get(info["env"])
    if from_env and os.path.exists(from_env):
        return from_env, info["env"]
    local = os.path.join(CHECKPOINTS_DIR, name)
    if os.path.exists(local):
        return local, "checkpoints/"
    for candidate in info["legacy_local"]:
        if os.path.exists(candidate):
            return candidate, "beside the repository"
    return None, None


def link_into_place(source, target):
    """A hard link, a symlink, or a copy - whichever this filesystem allows."""
    for attempt in (os.link, os.symlink):
        try:
            attempt(source, target)
            return attempt.__name__
        except Exception:
            continue
    shutil.copy2(source, target)
    return "copy"


def fetch(url, target):
    print(f"   downloading {url}")
    urllib.request.urlretrieve(url, target)  # noqa: S310 - a pinned https URL from the table above


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--verify", action="store_true", help="sha256 what was found, against the recorded digests")
    parser.add_argument("--download", action="store_true", help="fetch the checkpoints that are not gated")
    args = parser.parse_args()

    os.makedirs(CHECKPOINTS_DIR, exist_ok=True)
    print(f"[*] checkpoints for {REPO_ROOT}")
    missing = 0

    for name, info in CHECKPOINTS.items():
        path, where = found_at(name, info)

        if path is None and args.download and not info["gated"]:
            try:
                fetch(info["file_url"], os.path.join(CHECKPOINTS_DIR, name))
                path, where = os.path.join(CHECKPOINTS_DIR, name), "checkpoints/"
            except Exception as error:
                print(f" [FAILED] {name}: {error}")

        if path is None:
            missing += 1
            print(f" [MISSING] {name} - {info['description']}")
            if info["gated"]:
                print(GATED_STEPS.format(page=info["page"], repo=info["page"].rsplit("/", 2)[-2] + "/" + info["page"].rsplit("/", 1)[-1], name=name, env=info["env"]))
            else:
                print(f"   run this script with --download, or fetch {info['file_url']}")
                print(f"   or set {info['env']}=/path/to/{name}")
            continue

        size = os.path.getsize(path)
        note = "" if size == info["bytes"] else f"  ** {size} bytes, recorded {info['bytes']} **"
        print(f" [OK] {name} via {where}{note}")

        if args.verify:
            actual = digest(path)
            if actual == info["sha256"]:
                print(f"      sha256 matches ({actual[:16]}...)")
            else:
                missing += 1
                print(f"      ** sha256 {actual[:16]}... does not match the recorded {info['sha256'][:16]}... **")
                print("      This is a different checkpoint from the one this project's runs were made with.")

        # Keep a copy under checkpoints/ so the next run needs no environment at all.
        target = os.path.join(CHECKPOINTS_DIR, name)
        if not os.path.exists(target) and os.path.abspath(path) != os.path.abspath(target):
            print(f"      linked into checkpoints/ by {link_into_place(path, target)}")

    if missing:
        print(f"\n[!] {missing} checkpoint(s) unresolved. The classical trace engine needs none of them:")
        print("    cli.mjs trace <candidate> <image> <name> --roi <roi.json> --engine classical")
        print("    On a real photograph it is refused by the fidelity gate (measured mask_iou 0.802")
        print("    against a floor of 0.90, where tiled SAM 3 scores 0.924) - that is the gate working.")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
