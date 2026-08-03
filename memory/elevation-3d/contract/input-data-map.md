# Input Data Map

Source set:

```text
D:/Data/50_ELE/MAAS_ELEVATION_TEST_SET_20260730
```

## Authority chain

```text
program/geometry-program.json
  -> transforms/matrix4-trace.json
  -> mesh/indexed-mesh.json
```

`mesh/mass.obj` is the provider-friendly geometry representation. `mass/manifest.json` binds each artifact to a SHA-256 value.

## Candidate package

| Input | Use |
| --- | --- |
| `candidate.json` | identity, morphology, storey evidence |
| `mass/manifest.json` | source integrity verification |
| `render.png` | four-panel source board; crop its isometric panel as the sole generation image |
| `mesh/indexed-mesh.json` | authoritative geometry comparison |
| `mesh/mass.obj` | validation reference; not submitted to `image_to_model` |
| `views/*.png` | held-out view evidence; not separate generation inputs |
| `camera-poses.json` | validation and downstream drawing cameras; not Tripo conditioning input |
| `facade-planes.json` | semantic facade/view mapping |
| `floor-guides.json` | floor alignment overlays and review |
| `surface-normals.json` | face orientation and coverage checks |
| `handoff.json` | receiving-pipeline contract |

## Provider mapping for Tripo image-to-model

| Stage or parameter | Candidate source |
| --- | --- |
| crop source | top-left isometric panel of `candidate/render.png` |
| upload `file` | cropped isometric PNG with panel label/border removed |
| task `type` | `image_to_model` |
| first test `texture` | `false` to isolate geometry reconstruction |
| first test `pbr` | `false` |
| held-out validation | opposite/top/front panels plus `mass/views/*.png` |
| geometry reference | `mass/mesh/mass.obj` and `indexed-mesh.json` |
| drawing cameras | `camera-poses.json` after generated-model alignment |

The provider does not consume the stored camera matrices. After generation, align the returned GLB to the source coordinate frame before applying stored cameras or comparing projections.
