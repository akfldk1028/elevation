---
name: facade-grammar
description: Author a split grammar that a geometry-locked facade agent derives into openings. Use when designing or revising a building facade on a verified MASS candidate, when a facade reads as one repeated bay, or when an elevation needs a different rhythm per floor or per side.
---

# Facade Grammar

Write a facade as a **split grammar**, not as a list of windows. Deterministic code
derives the grammar against each facade segment, so the same rules adapt to a 2.2 m
facet and a 12 m one, and to a five-storey tower and a twenty-storey one.

The MASS is immutable. You never name a segment, a coordinate or a path — you name
symbols, and the resolver places them.

## Why a grammar

A flat list of bay rules can only vary by "which elevation, which storey, what size",
so every facet of every floor ends up identical. A grammar carries an index down the
derivation, so a rule can branch on where it landed. That is where variety comes from.

## The language

```jsonc
{
  "schema_version": "arr.elevation3d.facade-grammar.v3",
  "concept_id": "candidate-concept-v1",
  "start": "Facade",
  "entrance": {
    "segment_selector": "primary_visible_ground_segment",
    "preferred_bay": "central_focus",
    "door_family": "recessed-glazed-portal",
    "width_m": 1.5, "height_m": 3.0, "recess_m": 0.3
  },
  "rules": {
    "Facade": [ { "split": { "axis": "u", "parts": [
        { "size": "0.13", "symbol": "Fold" },
        { "size": "~1",   "symbol": "Body" },
        { "size": "0.13", "symbol": "Fold" }
    ] } } ],
    "Body": [ { "split": { "axis": "z", "parts": [
        { "size": "3.3",  "symbol": "Lobby" },
        { "size": "~3.3", "symbol": "Upper", "repeat": true },
        { "size": "3.3",  "symbol": "Crown" }
    ] } } ],
    "Upper": [
      { "when": "index % 2 == 0", "split": { "axis": "u", "parts": [
          { "size": "~1", "symbol": "Wall" }, { "size": "0.6", "symbol": "Slot" },
          { "size": "0.28", "symbol": "Wall" }, { "size": "0.6", "symbol": "Slot" },
          { "size": "~1", "symbol": "Wall" }
      ] } },
      { "split": { "axis": "u", "parts": [
          { "size": "0.3", "symbol": "Wall" }, { "size": "~1", "symbol": "Ribbon" },
          { "size": "0.3", "symbol": "Wall" }
      ] } }
    ],
    "Slot": [ { "terminal": "glass", "inset_m": 0.04 } ],
    "Fold": [ { "terminal": "pilaster", "depth_m": 0.14 } ],
    "Wall": [ { "terminal": "wall" } ]
  }
}
```

### Rules and alternatives

`rules` maps a symbol to an ordered list of alternatives. The first whose `when`
holds is taken; an alternative with no `when` always holds, so put it last as the
`else`. An alternative is a `split` or a `terminal` — never both.

### Sizes

| Form | Meaning |
| --- | --- |
| `"2.4"` | absolute metres |
| `"'0.5"` | fraction of the scope along the split axis |
| `"~1"` | floating: leftover space shared between floating parts by weight |

`"repeat": true` tiles a floating part as many times as its nominal size fits. One
repeat part per split, and it cannot share a split with other floating parts.

### Predicates

`when` is a closed set, parsed rather than evaluated:

```
index % <n> == <m>      index == <n>      index == last
storey % <n> == <m>     storey == <n>     storey == top
face_view == front | back | left | right
```

Two may be joined with `&&`. Anything else is rejected at parse time.

`index` is the position within the repeat that produced this scope, and `total` its
count — so `index % 2 == 0` alternates floors, and `index == last` marks the top one.

### Terminals

`wall` (emits nothing), `glass`, `door`, `band`, `reveal`, `pilaster`. Each takes an
optional `inset_m` and `depth_m`, both bounded at 0.5 m.

## Authoring loop

```bash
node scripts/validate.mjs <candidate-id> <program.json>
```

Seconds, not minutes. It parses the grammar, derives it against the candidate's real
facets, and reports what came out — counts per elevation, storeys reached, kinds
emitted — plus warnings for a derivation that produced nothing, an empty base or top
storey, or a budget overrun.

It does **not** run the authority-bound checks. Mass backing, fold and floor-band
clearance, opening overlap, line density and the review gate need a verified design
context and a render, and they run in the full pipeline. A clean report here means
the grammar derives, not that the design will be accepted.

`reference/pleated-tower.json` is a worked grammar for a sixteen-facet tower: fold
pilasters, a lobby storey, alternating upper floors, a crown, and a different rhythm
on each elevation.

## What the pipeline will reject

- an opening crossing a fold, a floor band, or the mass edge
- more than one primary entrance, or none
- an elevation whose lowest or highest storey carries no opening
- linework denser than the sheet can carry, or a facade too dark to read
- any grammar that recurses without shrinking its scope

Every one of these is a deterministic check on the derived geometry, not a matter of
taste. Read the codes and change the grammar; do not try to move the geometry.

## Getting variety

Four levers, in the order they pay off:

1. branch on `index` so floors alternate rather than repeat
2. branch on `face_view` so the street side differs from the service side
3. change opening proportion between base, middle and top — a lobby is not a bedroom
   window, and storey height is usually far more available than facet width
4. nest one more level: a tile that splits into wall, opening and wall reads as
   built, where a bare rectangle reads as a hole
