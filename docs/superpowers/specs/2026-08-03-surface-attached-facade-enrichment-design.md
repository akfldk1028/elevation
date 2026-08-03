# Surface-Attached Facade Enrichment Design

## Goal

Replace facade-envelope boxes with deterministic shallow prisms whose base polygons are clipped directly from source triangles, so curved and nonconvex MASS geometry passes strict surface, component, floor, and facade validation without changing the exact base primitive.

## Geometry architecture

The generator partitions indexed source triangles by connected component and never merges components, even when their facade projections overlap. For each authored facade view it orients triangle normals away from the building centroid, selects triangles facing that view, and retains each triangle's component and source-triangle identity.

Details are made by clipping one selected source triangle at a time against scalar bands:

- floor bands: a narrow vertical interval centered on each authored floor guide;
- mullions: the intersection of each triangle with a nominal equal-bay tangent interval;
- opaque panels: the lower spandrel interval of each authored storey;
- glazing: the upper interval of each authored storey;
- parapets: the top interval defined by `parapet_height_m`.

Each nonempty polygon becomes its own closed shallow prism. Its base lies on one source triangle. Concrete, bronze, and opaque details extrude by bounded positive depth along the authored facade normal; glass extrudes by bounded negative `glazing_recess_m`. Because no primitive combines polygons from two source triangles or components, detached projections cannot bridge.

If a component/view has no nominal mullion intersection, a deterministic small polygon clipped around the nearest available source-triangle tangent position provides coverage and records that local nominal offset.

## Semantics and export

Every detail carries `kind`, `view`, `component_id`, `source_triangle_index`, `material`, and applicable `elevation_m`, `floor_m`, `bay`, and `offset_m` extras. Export preserves these extras per GLB primitive. Base POSITION and index accessors remain byte-for-byte derived from the original arrays with an identity node transform.

Material semantics are fixed:

- floor bands and parapets: concrete;
- mullions: bronze;
- glazing: glass;
- opaque panels: opaque.

## Validation and tests

Unit tests cover exact base immutability, detached overlapping component projections, inward glazing, parapet grammar, concrete floor bands, equal nominal bays, and vertex/sample proximity to actual triangles. The existing strict validator is used without weakening tolerances. Final verification runs focused enrichment/validation tests, the full suite, TypeScript build, and diff checks, followed by a retained real creative-013 unified run with seven drawings and no provider calls.

## Failure behavior

If no outward-facing triangle is found for a view, selection falls back deterministically to the component triangles with the greatest authored-normal alignment rather than generating envelope geometry. Empty clipped polygons are omitted. Safe fallback remains exact base-only concrete geometry.
