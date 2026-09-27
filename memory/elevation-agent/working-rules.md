# Working rules

Each one is here because breaking it cost a day. They are about how a round is run, not about
what the code does; for that, start at `AGENTS.md`.

---

## Choose the mass deliberately, every time

Nine authors in a row were given `creative-013` because it was first in the list, and every
elevation the project produced came out stepped. It was read as a failure of the grammar for
weeks. It was the mass: the sheet showed one building. The same thing happened a second time
before it was written down.

There are three test-set masses and they are different on purpose — a 16-facet star prism
(`creative-020`), a stepped bent bar (`creative-013`, which is a bridge and flies above grade),
and a pleated cleft block (`creative-004`, 113 facets). Plus `synthetic-box-<W>x<D>x<H>`, built
on the fly, for engine work that needs a mass and not a design. **Name which one you are using
and why.** If a rule only works on one of them, it is not a rule yet.

## A green gate is not the acceptance test — and the corollary

The rule is in `AGENTS.md`. What belongs here is the habit that enforces it:

- **Crop the drawing to the building's own bounds and look at its four edges** before you publish
  or report. The hero hides them. A veil that ended in a notched line at the roof and a staircase
  at the ends passed every gate; cropping the front elevation showed it in a second.
- Read the **material-id raster and the hero before the depth raster**. The depth raster is packed
  RGB and its colour cycles with depth: two hours went into "purple = deep" and the wall was
  re-wound twice for nothing.
- **Cast the ray before the fix.** A render symptom got a diagnosis, a fix and a ten-minute
  redraw before a GLB ray query showed the pixel was correct geometry — a throat seen obliquely
  through a fold-cut mouth. Query the GLB, not the raster; ray first, fix second, redraw third.
- **Look at the input as well as the output.** Two concept runs launched together came back with
  the same image and both reported `ok: true`; one of them showed a building with nothing to do
  with the mass it was commissioned for. Only opening the picture caught it.

## One round per sheet

A sheet shows **one round**: before, after, and that round's review findings. Not a cumulative
"current state of every building" page, and never an appended log — both were tried and both were
confusing to read. Review the rasters and the four cropped edges before publishing, not after.

## The machine is part of the method

32 GB here, and a browser that holds ten of them.

- **`npm test` runs alone.** With 0.4 GB free it was killed twice and reported two browser-render
  tests as failures; both passed 9/9 when their files ran by themselves. `--test-concurrency=2`
  keeps the render tests from stacking. 951 tests, about ten minutes.
- **One draw at a time.** A draw over ~2,000 cells is memory-bound before it is budget-bound.
  Three have been killed by the machine, one of them returning a 2,400 x 2,400 black axon that
  the gate correctly called empty.
- **A killed draw is not a failed gate.** Check free memory before reading a refusal as a verdict:
  an empty output file means the process died, and `no foreground pixels` at 0.9 GB free means the
  same thing. Retry with memory free before diagnosing.
- **A path can be the bug.** Windows stops at 260 characters. A copy of this repo 116 characters
  deep failed every draw with `DIMENSION_SOURCE_MISSING` while the mass, the context and the
  compiled GLB matched to the byte.

## Feedback is worth more than another gate

Every operator this language gained in 2026-09 was found by an author failing or asking, not by
reading the code. Blind authors — agents given the brief and nothing else — pass on attempt one
with zero faults and then report the one thing the brief could not say. When something is hard,
commission an author and read what they ask for.

And do not hand an author a rule drawn from three samples: "schemes with solid piers die on the
plan view" was told to an author from three runs that morning, the author designed around it, and
the scheme died anyway. The pattern was coincidence.

## Ask the population, never one member

`instances[0].tile_m` decided whether a veil kept its line-density waiver, so the day a solid edge
panel sorted first the waiver vanished and a drawing that had passed an hour earlier failed. The
same shape of bug has appeared four times: a check that asks ONE member what it means of the SET.

## When a gate refuses work you believe in, check its units before its threshold

Two gates were written in the wrong unit and refused correct drawings: a PBR role called visible
at four pixels while the clause above it needed four pixels AND 0.05% coverage, and a trace
fidelity gate that mixed a scale-free IoU with a boundary error in PIXELS — the same curves
rastered larger kept the IoU and grew the error.

And never move a gate to admit your own work without someone else's eyes on it.

## Sending anything outward is a decision, not a step

This repository is **public**. Source photographs are supplied locally and their ROI files —
which record each image's sha256 — are what travels. Before committing an asset you did not
make, say so and let the owner decide.
