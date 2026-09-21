import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareDrawingToSource } from '../tools/facade-pipeline/source-check.mjs';

test('a transcription with missing source is a failed comparison', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'facade-source-'));
  try {
    const result = await compareDrawingToSource({runDir, grammar: {source_photograph:'missing.png'}, heroPath:'hero.png'});
    assert.equal(result.source_fidelity.accepted, false);
    assert.ok(result.source_fidelity.codes.includes('SOURCE_IMAGE_UNREADABLE'));
  } finally { await rm(runDir, {recursive:true, force:true}); }
});

test('an unsourced design has no transcription comparison', async () => {
  assert.deepEqual(await compareDrawingToSource({grammar:{}, heroPath:'hero.png'}), {});
});
