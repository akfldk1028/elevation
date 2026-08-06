# Facade Agent Local Environment

## Active source and generated output

Use `D:/Data/50_ELE/gitagent/.worktrees/geometry-locked-facade-agent` as the active repository. Keep `plugins`, `test`, `docs`, and `test/fixtures` indexed. Generated verification output belongs outside Git under:

- `D:/Data/50_ELE/facade-agent-verification/` for retained offline runs;
- `D:/Data/50_ELE/facade-agent-live-evaluation/<unique-run-id>/` for an explicitly approved live comparison.

The project-level `.idea/50_ELE.iml` excludes those output roots, dependency/build directories, and the inactive Tripo worktree. Save that file before asking PyCharm to reload the project or rebuild indexes.

## Credential names

Supply credentials through the process environment only. Never commit values, paste them into commands, or write them to a run manifest.

- `OPENAI_API_KEY`: GPT Image 2 and the GPT facade-grammar step;
- `ARK_API_KEY`: BytePlus Seedream 5 Pro;
- `DASHSCOPE_API_KEY`: Alibaba Qwen Image 2;
- `DASHSCOPE_WORKSPACE_ID`: Alibaba workspace identifier.

Presence of credentials is capability only. It is not authorization to make a billed request.

## Offline verification

From the active worktree, run the fixture-backed checks without provider credentials:

```powershell
Remove-Item Env:OPENAI_API_KEY,Env:ARK_API_KEY,Env:DASHSCOPE_API_KEY,Env:DASHSCOPE_WORKSPACE_ID -ErrorAction SilentlyContinue
npm run build
node --test --experimental-strip-types test/elevation3d-facade-agent-cli.test.ts test/elevation3d-facade-agent-e2e.test.ts
```

The E2E test injects local provider transports and must report `blocked_external_requests: 0`. It produces three proposal PNGs, three accepted GLBs, and eight delivery PNGs per provider. Retain its output by setting a new, nonexistent location before the test:

```powershell
$env:FACADE_AGENT_E2E_OUTPUT_ROOT = 'D:/Data/50_ELE/facade-agent-verification/<unique-run-id>'
node --test --experimental-strip-types test/elevation3d-facade-agent-e2e.test.ts
```

## Live preflight and execution gate

Use only `gpt-image-2,seedream-5-pro,qwen-image-2`. The design ceilings are `$0.50`, `$0.10`, and `$0.05`, plus a shared grammar ceiling of `$0.35`; their exact maximum is `$1.00`. These are safety ceilings, not quoted prices.

A live preflight validates local evidence, allowlists, credentials, and ceilings without calling a provider. Do not add `--confirm-live` until all offline checks pass and the user freshly approves the exact `$1.00` maximum. A live run must use a unique run ID and exactly one image request per provider; retries remain disabled.

```powershell
node plugins/elevation-3d/lib/facade-agent/cli.mjs preflight `
  --candidate creative-020 `
  --brief brick-punched-window-v1 `
  --dataset-root D:/Data/50_ELE/MAAS_ELEVATION_TEST_SET_20260730 `
  --output-root D:/Data/50_ELE/facade-agent-live-evaluation/<unique-run-id> `
  --run-id <unique-run-id> `
  --providers gpt-image-2,seedream-5-pro,qwen-image-2 `
  --image-budget gpt-image-2=0.50 `
  --image-budget seedream-5-pro=0.10 `
  --image-budget qwen-image-2=0.05 `
  --grammar-budget 0.35
```

After approval, the corresponding `run` command additionally requires `--confirm-live --confirm-total-usd 1.00`. Never reuse a run directory after an uncertain or partially submitted paid operation; inspect its durable status instead.
