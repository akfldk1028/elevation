# What stops the facade agent on two of the three test masses

For whoever owns massing. Nothing here is a facade-design problem and I have not touched any
of it. Measured 2026-08-18 on `MAAS_ELEVATION_TEST_SET_20260730`.

## The short version

The facade design layer is mass-agnostic and always was. Nothing under
`plugins/elevation-3d/lib/facade-agent/design/` names a candidate, reads a mesh, or carries a
hard-coded dimension; it reads twelve abstract fields off a segment and nothing else:

    segment_id  face_id  face_view/view  face_index  face_total  length_m
    local_z  normal  ground_access  visibility_score  placeable

It never gets the chance. **`deriveFacadeSegmentsFromMass` in `punched-facade.mjs` throws for
two of the three candidates**, before the LLM, the gates or the renderer see anything. The two
failures have different causes and only one of them is a bug.

## Per candidate, measured

| | vertices | z levels | exactly-vertical tris | tilted tris | wall area vertical / tilted | result |
|---|---|---|---|---|---|---|
| creative-020 | 35 | 2 | 32 | 0 | 582 / 0 | **16 segments, works** |
| creative-004 | 86 | 13 | 20 | **118** | **582 / 749** | throws |
| creative-013 | 184 | 15 | 240 | 2 | 471 / 0.1 | throws |

creative-020 is a plain extruded prism. It is the only candidate the whole pipeline has ever
run on, and **every threshold in this repo was tuned on it alone** — seam length 48 px,
untyped strong-edge 0.020, presentation ambient 1.7/2.2/0.86, the opening-ratio target, the
face-kind profile. None has been shown to be a property of the pipeline rather than of that
one building.

## creative-004 — battered walls are discarded, and the footprint cannot close

    invalid facade topology: perimeter is not one closed cycle
    (walked 3 of 3 segments from facade-segment-481b...; the chain ends at corner
     facade-corner-41a5... and nothing starts there, so the footprint is self-intersecting)

Three wall segments. A closed footprint needs at least four, so the walk was never going to
succeed.

The cause is upstream of the walk: the grouping keeps a triangle only when `Math.abs(n[2])`
is at or below `1e-7`, i.e. **exactly** vertical. creative-004 is a battered mass — 118 of its
triangles are tilted between 1e-7 and 15 degrees off vertical, and they carry **749 m² of wall
against the 582 m² that is exactly vertical**. More than half the building's wall is dropped
before the perimeter is assembled, leaving three disconnected planes.

This is the one that looks like a real limitation rather than a bug.

**How much a tolerance would recover, measured.** Sweeping the acceptance angle on
creative-004:

| accepted tilt | vertical plane groups | wall area |
|---|---|---|
| exactly vertical (today) | **3** | 582 m2 |
| <= 5 deg | 39 | 1125 m2 |
| **<= 10 deg** | **52** | **1331 m2** |
| <= 20 deg | 52 | 1331 m2 |

Today's filter keeps 3 of 52 planes and 44% of the wall. **The count saturates at 10 degrees**
- nothing further appears between 10 and 20 - so every wall on this building is within 10
degrees of vertical and a 10-degree tolerance is not an arbitrary loosening that risks
sweeping in roof surfaces. Whether the right answer is a tolerance, a projection, or treating
a battered plane as its own facet type is still yours; this only says what is being lost.

**A synthetic authority is not a way around this, and should not be.**
`assertCanonicalFacadeSegmentAuthority` requires the supplied authority to match the canonical
derivation byte for byte, so the design layer cannot be fed hand-built segments. That lock is
correct and was left alone. `harness-004.mjs` in the sdd directory assembles one anyway, purely
to measure - it reaches 67 segments across all four views on creative-004 - and it is refused
at the evidence pack, which is the system working. **No elevation can be produced for this
candidate until the derivation itself yields its walls.**
 A sloped wall is a wall.
Deciding what a facade segment *is* on a battered surface — does it stay a rectangle in the
plane of the slope, does `local_z` become slope-length or true height, does the fold between
two battered planes still have a vertical corner — is a massing decision, and everything
downstream will follow whatever it produces as long as the twelve fields above come out.

## creative-013 — a plane finds none of its own group backing it

    invalid facade geometry: detail lacks exact-MASS backing
    (plane 2.3575 x 1.3157 m at 9.269,0.334,4.476; covered 0.000000000 of 3.101669840 m2,
     short by 3.102e+0, relative 1.000e+0)

Not a tilt problem: 240 of its triangles are exactly vertical and 2 are not. **Covered is
exactly zero**, not a rounding shortfall, on a plane the function derived from a coplanar
triangle group — which is self-contradictory and reads as a bug in that path.

Probing the grouping directly (`probe-mass-backing.mjs`) shows most of its 81 coplanar groups
fail earlier still, inside `boundaryPolygons`, with `boundary vertex N joins 4 edges` — a pinch
point, two coplanar patches meeting at a single vertex, which is what stepped massing produces
where a setback returns to the same plane. The walker refuses it explicitly.

Three things not yet eliminated: `massSupportTriangles` requires all three points within 1e-5
of the plane; `deriveFacadeSegmentsFromMass` passes one global `closedShellOrientation` for
every triangle, which is fine for a single closed prism and may not be for this; and the plane
origin is chosen by matching a vertex on `(u, z)` alone — the failing group reports
`originFound=false`, so its origin came from the `planePoint` fallback rather than a real
vertex.

## Two readings to not repeat

**It is not that the code assumes rectangular faces.** `usableFaceRectangle` already takes the
face boundary polygon (`design/geometry/face-polygon.mjs`) and inscribes the largest rectangle
in it (`design/geometry/inscribed-rect.mjs`).

**Decomposing a cut face into several rectangles is not the fix.** Each rectangle becomes its
own facet, the start rule derives once per facet, and you get a pier at every artificial
boundary — the "stripes on every fold" bug this codebase already paid for once.

## How to reproduce

    cd .superpowers/sdd/2026-08-10-llm-facade-design-agent
    node probe-mass-backing.mjs creative-004     # per-group topology and inscribed rects
    node probe-mass-backing.mjs creative-013

`prepare-any-candidate.mjs` in the same directory builds a full design context for any
candidate without needing a retained delivery, once the derivation stops throwing. Note that
neither creative-004 nor creative-013 ships a GLB; deriving and validating a facade needs only
the mesh, but rendering one needs a GLB from somewhere.
