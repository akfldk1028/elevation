"""Generate a concept perspective for a mass, locally.

    python tools/facade-concept/cli.py --control <evidence/depth/axon.png> --out <concept.png>
        --subject "..." [--kind depth|canny --steps 30 --seed 7 --scale 0.8 --guidance 6.0]

Writes the image, writes `<out>.provenance.json` beside it, prints one JSON object and exits
non-zero on failure - like every other step of this pipeline.
"""
import argparse
import json
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "src"))
from sdxl_concept import generate  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--control", required=True, help="the mass's own raster: evidence/depth/<view>.png")
    parser.add_argument("--out", required=True)
    parser.add_argument("--subject", required=True, help="the commission: the constraint and the programme")
    parser.add_argument("--kind", default="depth", choices=("depth", "canny"))
    parser.add_argument("--steps", type=int, default=30)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--scale", type=float, default=0.8, help="how hard the mass is held")
    parser.add_argument("--guidance", type=float, default=6.0)
    args = parser.parse_args(argv)

    report = generate(args.control, args.out, args.subject, kind=args.kind, steps=args.steps,
                      seed=args.seed, scale=args.scale, guidance=args.guidance)
    with open(os.path.splitext(args.out)[0] + ".provenance.json", "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=1)
    print(json.dumps(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
