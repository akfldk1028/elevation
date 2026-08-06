# Facade Agent Local Environment

## Active source and generated output

Use `D:/Data/50_ELE/gitagent/.worktrees/geometry-locked-facade-agent` as the active repository. Keep `plugins`, `test`, `docs`, and `test/fixtures` indexed. Generated verification output belongs outside Git under:

- `D:/Data/50_ELE/facade-agent-verification/` for retained offline runs;
- `D:/Data/50_ELE/facade-agent-live-evaluation/<unique-run-id>/` for an explicitly approved live comparison.

The project-level `.idea/50_ELE.iml` excludes those output roots, dependency/build directories, and the inactive Tripo worktree. Save that file before asking PyCharm to reload the project or rebuild indexes.

## Credential names

Supply credentials through the process environment only. Never commit values, paste them into commands, or write them to a run manifest.

- `OPENAI_API_KEY`: optional GPT Image 2 and OpenAI GPT-5.6 grammar routes;
- `ARK_API_KEY`: BytePlus Seedream 5.0 Pro and BytePlus Seed 2.0 Mini grammar routes;
- `DASHSCOPE_API_KEY`: Alibaba Qwen Image 2;
- `DASHSCOPE_WORKSPACE_ID`: Alibaba workspace identifier.

Presence of credentials is capability only. It is not authorization to make a billed request.

## Offline verification

From the active worktree, run the fixture-backed checks without provider credentials:

```powershell
Remove-Item Env:OPENAI_API_KEY,Env:ARK_API_KEY,Env:DASHSCOPE_API_KEY,Env:DASHSCOPE_WORKSPACE_ID -ErrorAction SilentlyContinue
npm run build
node --test test/elevation3d-facade-agent-contract.test.ts test/elevation3d-facade-agent-provider-registry.test.ts test/elevation3d-facade-agent-grammar-router.test.ts test/elevation3d-facade-agent-grammar.test.ts test/elevation3d-facade-agent-byteplus-grammar.test.ts test/elevation3d-facade-agent-harness.test.ts test/elevation3d-facade-agent-cli.test.ts test/elevation3d-facade-agent-e2e.test.ts test/elevation3d-plugin.test.ts test/elevation3d-providers.test.ts --experimental-strip-types
```

The E2E test runs the real Seedream and BytePlus adapter contracts against local fixture transports. It must make exactly one fixture image request and one fixture grammar request, make zero unexpected requests, build one accepted local GLB, and deliver eight distinct 2400 x 2400 PNG views. The persisted run labels both transports `fixture`; these images validate plumbing and local delivery, not provider quality.

Retain a fresh offline run outside Git by setting a new, nonexistent location before the test:

```powershell
$env:FACADE_AGENT_E2E_OUTPUT_ROOT = 'D:/Data/50_ELE/facade-agent-verification/router-offline-20260806-150000'
node --test --experimental-strip-types test/elevation3d-facade-agent-e2e.test.ts
```

Use a newly generated safe run ID instead of the example timestamp whenever the command is actually run.

## Live preflight and execution gate

The recommended economical route is one `seedream-5-pro` image proposal followed by `byteplus-seed-mini` grammar extraction. The safety ceilings are `$0.06` for the image and `$0.01` for grammar; their exact confirmed maximum is `$0.07`. These are safety ceilings, not price claims.

A preflight validates local evidence, allowlists, configuration, and ceilings without calling a provider. Credentials remain process capabilities only. Do not execute a live run until all offline checks, the complete test suite, build, and dependency audit pass; `ARK_API_KEY` is supplied out of band; and the user freshly approves the exact `$0.07` maximum.

Prepared live command — do not run it as part of offline verification:

```powershell
npm run facade:agent -- run `
  --candidate creative-020 `
  --brief brick-punched-window-v1 `
  --dataset-root D:/Data/50_ELE/MAAS_ELEVATION_TEST_SET_20260730 `
  --output-root D:/Data/50_ELE/facade-agent-live-evaluation `
  --run-id seedream-byteplus-live-20260806-150000 `
  --image-provider seedream-5-pro `
  --image-budget seedream-5-pro=0.06 `
  --grammar-provider byteplus-seed-mini `
  --grammar-budget 0.01 `
  --confirm-live `
  --confirm-total-usd 0.07
```

Generate a fresh safe run ID immediately before an approved execution. The image and grammar adapters each receive one single-use submission capability. There is no paid retry, provider fallback, or budget transfer. Never reuse a run directory after an uncertain or partially submitted paid operation; inspect its durable status instead.
