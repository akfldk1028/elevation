# Detailed Architectural Render to SPAR3D Test — 2026-08-03

## Pipeline tested

`creative-013` exact MASS crop -> silhouette-locked photoreal concrete/glass isometric -> Stability hosted SPAR3D -> one textured GLB -> six orthographic/axonometric renders.

## Generation result

- image-to-3D response time: 9.628 seconds
- GLB size: 726,220 bytes
- generated vertices: 9,948
- generated triangles: 17,092
- successful charge: 4 credits

## Visual result

The conditioning isometric is successful as an architectural design image. It adds coherent warm concrete frames, curtain-wall glazing, bronze mullions, roof edges, and shadow gaps while retaining the recognizable curved MASS and terminal block.

The generated GLB preserves much of that appearance and silhouette from a nearby axonometric view. It does **not** preserve the exact building when seen from held-out top/front/side directions. Hidden surfaces are rounded, merged, split, or hallucinated, and the roof/underside relationships are not reliable.

## Decision

- Pass: photorealistic silhouette-locked isometric generation.
- Pass: hosted image-to-3D transport, GLB generation, texture, and same-object rendering.
- Conditional pass: presentation axonometric views close to the conditioning camera.
- Fail: deriving trustworthy plan/elevation drawings from the hosted image-only GLB.

Do not spend more hosted SPAR3D credits on image-only variants expecting hidden-view accuracy. The next geometry test must either condition open-source SPAR3D with the exact MASS point cloud or retain the exact MASS and transfer/project appearance onto it.
