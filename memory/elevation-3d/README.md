# Geometry-Locked 3D Texturing Research

This folder is the durable research memory for converting an immutable architectural MASS into a textured 3D asset and deriving renders and drawings from that asset.

## Current conclusion

Evaluate two web-deployable strategies:

1. `Hunyuan3D direct texture`: upload the original mesh and labelled multi-view images to a dedicated texture API.
2. `Generated views + web projection`: generate coherent facade views with Wan/Qwen, then project them onto the original mesh in Three.js.

The source mesh remains authoritative in both strategies. Any returned provider mesh must pass a geometry identity gate.

## Reading order

1. `contract/problem-definition.md`
2. `contract/input-data-map.md`
3. `approaches/approach-a-hunyuan-direct.md`
4. `approaches/approach-b-web-projection.md`
5. `evaluation/two-track-test-plan.md`
6. `sources/bibliography.md`

## Status

- Research and design: complete enough for written review.
- Provider credentials: not configured.
- Paid calls: not authorized.
- Implementation: not started.
