# Facade Grammar v3

## Why the current contract cannot produce a facade

`FacadeProgramV2` is a flat record: zones group storeys, `window_families` lists
sizes, `bay_rules` pairs a zone with one pattern, `articulation` lists trim. Nothing
nests, no rule sees its own position, and every size is absolute. The expressible
design space is therefore "which elevation, which storey, what size", and the renders
show exactly that — the same bay repeated across every facet of every floor.

Reference implementations have not worked this way for twenty years.
`clone/CityEngine_cga/facade_04.cga` builds a facade in five levels:

```cga
Frontfacade -> split(y){ groundfloor_height : Floor(split.index)
                       | floor_height       : Floor(split.index)
                       | {~floor_height     : Floor(split.index)}*
                       | floor_height       : Floor(999)
                       | 0.5                : LedgeAsset }

Floor(i) -> case i == 0 : Subfloor(i)
            case i == 2 : split(y){ ~1 : Subfloor(i) Balcony | 0.5 : TopLedge }
            else        : split(y){ 1 : BottomLedge(i) | ~1 : Subfloor(i) | 0.5 : TopLedge }

Subfloor(i) -> split(x){ 0.5 : Wall | {~tile_width : Tile(i)}* | 0.5 : Wall }

Tile(i) -> case i == 0 : split(x){ ~1 : SolidWall | door_width : DoorTile | ~1 : SolidWall }
           else        : split(x){ ~1 : Wall | window_width : WindowTile | ~1 : Wall }
```

Four mechanisms carry the variety, and v2 has none of them: a rule receives its own
index and passes it down, `case` branches on that index, `~` sizes absorb whatever
space is left, and `*` repeats as many times as fit. Pro-DG (CVPR 2025) reaches the
same structure from the other direction — it represents a facade as a split-grammar
derivation tree and names "grammar expressiveness" as its own limiting factor.

## What v3 is

A closed, bounded split grammar. The model authors symbol rules; deterministic code
derives them against each facade segment's scope. Geometry authority does not move:
the LLM still never names a segment, a coordinate or a path.

### Scope

Every derivation step carries a scope — a rectangle in one segment's `(u, z)` frame,
plus the indices that produced it. Scopes start as the segment's placeable rectangle,
already computed by `usableFaceRectangle`.

```
scope = { u_min, u_max, z_min, z_max, segment_id, face_view,
          index, total, storey, depth }
```

`index` and `total` are the position and count within the split that produced this
scope. `depth` is the derivation depth, bounded below.

### Rules

```jsonc
{
  "schema_version": "arr.elevation3d.facade-grammar.v3",
  "concept_id": "creative-020-pleated-tower-v1",
  "start": "Facade",
  "rules": {
    "Facade": [
      { "split": { "axis": "z", "parts": [
          { "size": "3.3",  "symbol": "GroundFloor" },
          { "size": "~3.3", "symbol": "UpperFloor", "repeat": true },
          { "size": "3.3",  "symbol": "TopFloor" }
      ] } }
    ],
    "UpperFloor": [
      { "when": "index % 2 == 0", "split": { "axis": "u", "parts": [
          { "size": "~1", "symbol": "Wall" },
          { "size": "0.62", "symbol": "Window" },
          { "size": "~1", "symbol": "Wall" }
      ] } },
      { "split": { "axis": "u", "parts": [
          { "size": "0.4", "symbol": "Window" },
          { "size": "~1", "symbol": "Wall" },
          { "size": "0.4", "symbol": "Window" }
      ] } }
    ],
    "Window": [ { "terminal": "glass", "inset_m": 0.05 } ]
  }
}
```

- `rules` maps a symbol to an ordered list of alternatives. The first whose `when`
  holds is taken; an alternative without `when` always holds and acts as `else`.
- An alternative is either a `split` or a `terminal`. Nothing else.
- `parts[].symbol` names another rule, so nesting comes from the rule graph rather
  than from nested literals.

### Sizes

Exactly the three CGA forms, as strings so the prefix is explicit:

| Form | Meaning |
| --- | --- |
| `"2.4"` | absolute metres |
| `"'0.5"` | fraction of the scope along the split axis |
| `"~1"` | floating; the leftover is shared between floating parts by weight |

`repeat: true` on a part tiles it as many times as fit, exactly like CGA's `*`, with
floating sizes adapted to the fit. At most one repeat part per split.

### Predicates

`when` is not an expression language. It is one of a closed set, parsed into a
predicate — never evaluated as code:

```
index == <int>          index % <int> == <int>       index == last
storey == <int>         storey % <int> == <int>      storey == top
face_view == front|back|left|right
```

Two predicates may be joined by `&&`. Nothing else parses.

### Terminals

`wall`, `glass`, `frame`, `door`, `band`, `reveal`. Each carries only an optional
`inset_m` within the authority's projection limits. A terminal emits one typed
primitive, the same shape `punched-facade.mjs` already consumes, so compilation,
validation, rendering and scoring are untouched.

## Bounds

Derivation is bounded so a program cannot exhaust the machine or the primitive
budget: depth ≤ 8, ≤ 32 symbols, ≤ 16 parts per split, ≤ 64 repeats per split, and
the existing 2048 resolved-primitive ceiling still applies. Any rule that recurses
without reducing scope is rejected at parse time, not at derivation time.

## What does not change

The verified context, the source authority binding, `validateMassBacking`, the
elevation and PBR gates, and the deterministic critic all stay as they are. v3
replaces what the model may say, not what the pipeline may trust.

## Out of scope

Stochastic alternatives, texture assets, inserted meshes, and inclined facade
planes. Candidates creative-004 and creative-013 remain blocked on the perimeter
model regardless of grammar.

## Skill packaging

Once derivation works, the capability ships as `skills/facade-grammar/`:

```
SKILL.md            when to use it, the safety boundary, the authoring loop
reference/          the operator table above and one worked facade
scripts/validate.mjs   program -> parse + derive + validate, no render
scripts/preview.mjs    program -> compiled GLB + front elevation
```

The skill exists so the model authors against a reference grammar with a worked
example, instead of against a schema inlined in a prompt. It is packaging, not
capability: it is written after derivation runs, not before.

## Order

1. contract v3 — parse, bounds, predicate parsing, rejection tests
2. derivation — recursive scope splitting, index propagation, terminal emission
3. one real run on creative-020, compared against v13 and v14
4. skill packaging
