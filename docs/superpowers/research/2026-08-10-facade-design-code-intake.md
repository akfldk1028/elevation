# Facade Design Research Code Intake

Recorded: 2026-08-10

Local cache: `D:/Data/50_ELE/research-cache/facade-agent-20260810`

The cache is outside the production repository. No external source has been copied into `gitagent`. Any future adoption requires an explicit per-file provenance record and compatible license review.

| Project | Repository | Pinned commit | License | License SHA-256 | Decision |
| --- | --- | --- | --- | --- | --- |
| Text2CAD | `https://github.com/SadilKhan/Text2CAD.git` | `669a81472ede2269837c22a4d00070eaac360c82` | CC BY-NC-SA 4.0 | `8288376167EBB429D1D2A898B1C2A0A73B0CD3840363F0C279AF7131871F07F2` | Research only; no code copied |
| IFC Bonsai MCP | `https://github.com/Show2Instruct/ifc-bonsai-mcp.git` | `62154932f99d8bff8494c51ddb0b16840fac8fec` | MIT | `A00B677537D8BCE28A3E3F6C834396367333C5138DABF4D10D60AF1D8018D83D` | Study typed door/window tool schemas; independent JavaScript implementation |
| Nova3D | `https://github.com/RareSense/Nova3D.git` | `042ee613aa2fb745d287261eab029d42c704646e` | MIT client; hosted backend proprietary | `56A302539FE9E5CD4F27E1CEB820FBAACC801438E47D14FFD4D983BE252E12FE` | Study named-part and prompt-to-procedure boundaries; exclude backend |
| CADAM | `https://github.com/Adam-CAD/CADAM.git` | `d75f68ca22efc26882ea41137c7fad0240213ed8` | GPL-3.0 | `291E78B030A22154379952977DEAC26249A20CAEEABCC512D1B81654ACEBDBC4` | Architecture reference only; no code copied |

## Adoptable concepts

- use a small typed construction language instead of accepting arbitrary model-written code;
- name every architectural part so revisions address doors, window families, bays, and materials independently;
- separate model intent, deterministic compilation, and geometric validation;
- expose bounded tools with explicit dimensions and semantic roles;
- retain source programs and validation receipts beside compiled GLB artifacts.

## Rejected approaches

- importing Python, Blender, IFC, or OpenSCAD runtimes into the existing Node plugin;
- allowing an LLM to write arbitrary executable geometry code;
- copying CC BY-NC-SA or GPL implementation into the MIT repository;
- treating a generated perspective image as geometric authority;
- depending on Nova3D's proprietary hosted backend.

## Reproduction

Each cache repository is a shallow clone at the pinned commit above. Before using it for further research, verify `git rev-parse HEAD`, a clean `git status --short`, and the recorded SHA-256 of its root `LICENSE` file.
