# Facade-agent provider fixtures

The three `proposal.png` fixtures are deterministic, synthetic, non-curtain-wall architectural elevations used only for offline verification. They deliberately vary punched-window rhythm, brick tone, bay width, and floor staggering while preserving one opaque five-storey mass. Regenerated images carry a visible `SYNTHETIC OFFLINE FIXTURE` / `NOT PROVIDER MODEL OUTPUT` banner and include a punched-window frame/glass rhythm plus an explicit entrance-door zone.

Regenerate them from the repository root with:

```bash
node test/fixtures/facade-agent/providers/generate-proposals.mjs
```

The routed E2E generates Seedream fixture bytes locally and returns deterministic BytePlus grammar JSON through the real request, response, common-contract, receipt, builder, validator, and delivery paths. No provider endpoint or paid API is contacted. Its manifests label both transports as `fixture`.

Fixture PNGs validate request binding, persistence, local 3D construction, and rendering; they do not measure Seedream or BytePlus visual quality.
