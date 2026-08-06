# Facade-agent provider fixtures

The three committed `proposal.png` files are deterministic, synthetic, non-curtain-wall architectural elevations used only for offline verification. They deliberately vary punched-window rhythm, brick tone, bay width, and floor staggering while preserving one opaque five-storey mass.

Regenerate them from the repository root with:

```bash
node test/fixtures/facade-agent/providers/generate-proposals.mjs
```

The E2E test injects these bytes through the real GPT Image 2, Seedream 5 Pro, and Qwen Image 2 response decoders. No provider endpoint or paid API is contacted.
