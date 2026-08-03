# ADR-004: Enrich the Exact MASS into the Final 3D Object

Status: accepted; supersedes ADR-003 as the production direction

Date: 2026-08-03

## Decision

The final deliverable remains one complete detailed 3D GLB. Build it by enriching the exact source `mass.obj`, not by replacing the source with geometry reconstructed from one image.

The agent must consume the complete candidate package:

- exact indexed mesh/OBJ for visible and hidden geometry;
- approved detailed isometric for facade language, materials, and visual target;
- camera matrices for image-to-surface correspondence;
- facade planes for placement scope and orientation;
- floor guides for storey/slab/window organization;
- geometry program and transform trace for semantic and coordinate constraints.

## Output construction

1. Keep the source MASS as the dimensional envelope and hidden-surface geometry.
2. Analyze the approved image into a structured facade grammar.
3. Create actual shallow 3D facade components: concrete bands, mullions, glazing planes, slab/parapet edges, and service-core panels.
4. Extend the same grammar coherently to surfaces not visible in the approved image using facade planes, floor guides, and adjacency rules.
5. Assign PBR materials and export one enriched GLB in the source coordinate system.
6. Extract every presentation render and every 2D plan/elevation/axonometric drawing from that same GLB.

## Rejected production path

Hosted image-only SPAR3D and Tripo may produce a recognizable nearby axonometric view, but their hidden geometry is hallucinated. The detailed live test produced broken held-out plan/front views. Global scaling cannot repair these local failures. Generated meshes are research references or optional detail donors only.

Local point-conditioned SPAR3D remains a research experiment, not a production dependency. It must outperform exact-MASS enrichment on held-out geometry before adoption.

## Approved visual target

`memory/elevation-3d/assets/creative-013/approved-detailed-isometric-v1.png`

The approved language is warm off-white concrete perimeter/slab bands, dark low-reflectivity curtain wall, bronze vertical mullions, subtle recessed joints, and consistent treatment of the lower terminal block. The target image is authoritative for appearance, while the source MASS is authoritative for geometry and dimensions.
