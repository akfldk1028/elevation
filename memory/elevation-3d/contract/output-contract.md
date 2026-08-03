# Output Contract

Every run is immutable and addressable by candidate and run ID.

```text
results/<candidate-id>/<run-id>/
  request.json
  provider-response.json
  source-identity.json
  geometry-verification.json
  textured-model.glb
  textures/
  renders/
  drawings/
  review.json
  manifest.json
```

## Required evidence

- candidate ID, program hash, geometry hash, PNU;
- input artifact SHA-256 values;
- provider, model, request ID, call and retry counts;
- prompt and contract version;
- actual or estimated cost;
- source and output geometry comparison;
- camera matrix for each derived render/drawing;
- explicit `geometry_mutation_allowed: false` statement.

## Acceptance states

- `accepted`: geometry identity and joint visual review passed.
- `visual-only`: geometry passed but cross-view or drawing review failed.
- `quarantined`: geometry identity failed or provider result is incomplete.
- `dry-run`: no provider request was made.
