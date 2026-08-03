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
| `mesh/indexed-mesh.json` | authoritative geometry comparison |
| `mesh/mass.obj` | provider upload or GLB conversion |
| `views/*.png` | source-view evidence and provider conditions |
| `camera-poses.json` | locked browser cameras and projections |
| `facade-planes.json` | semantic facade/view mapping |
| `floor-guides.json` | floor alignment overlays and review |
| `surface-normals.json` | face orientation and coverage checks |
| `handoff.json` | receiving-pipeline contract |

## Provider mapping for Hunyuan3D 3.1

| API parameter | Candidate source |
| --- | --- |
| `File3D` | `mass.obj` or identity-preserving GLB |
| `Image` | `front.png` as the primary reference |
| `MultiViewImages[left]` | `left.png` |
| `MultiViewImages[right]` | `right.png` |
| `MultiViewImages[back]` | `back.png` |
| `MultiViewImages[top]` | `top.png` |
| optional 45-degree view | `axon.png` only after confirming orientation |
| `EnableKeepUV` | `true` |
| `EnablePBR` | test parameter |
| `TextureSize` | initially `2048` |

The API labels do not replace the stored camera matrices. The matrices remain authoritative for local validation and drawing extraction.
