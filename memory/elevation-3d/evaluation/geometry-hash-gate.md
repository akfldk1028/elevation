# Geometry Identity Gate

Provider output is never authoritative by default.

## Checks

1. Parse source `indexed-mesh.json` and output mesh.
2. Normalize only file-format differences such as numeric representation and vertex/face ordering.
3. Compare vertex count and triangle count.
4. Compare coordinate multisets with a documented floating-point tolerance.
5. Compare triangle connectivity after remapping normalized vertex identities.
6. Compare bounds and orthographic silhouettes from all locked cameras.
7. Recompute and record normalized geometry hash.

## Policy

- Attribute, material, UV, and texture changes are allowed.
- Position or connectivity changes are not allowed.
- A failed gate changes the result status to `quarantined`.
- No render from a quarantined model may be labelled an accepted elevation or drawing.
