/** Invoke the curve/CAD engine without loading a mass or a neural model in Node. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { REPO_ROOT, resolveRoots, runDirFor } from './config.mjs';
const exec = promisify(execFile);
const python = process.platform === 'win32' ? 'python' : 'python3';
const script = join(REPO_ROOT, 'tools', 'facade-vision', 'pipeline.py');

export async function traceFacade({candidateId, imagePath, name, flags = {}}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(candidateId ?? '')) throw new Error('invalid candidate ID');
  const runName = name ?? `vision-${candidateId}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(runName)) throw new Error('invalid trace name');
  if (!flags.roi) throw new Error('FACADE_ROI_REQUIRED: --roi <polygon-and-scale.json>');
  const roots = resolveRoots({outputRoot: flags.output});
  const out = join(runDirFor(candidateId, {outputRoot: roots.outputRoot}), runName);
  const args = [script, resolve(imagePath), candidateId, runName, out, '--roi', resolve(flags.roi)];
  for (const key of ['engine', 'mask', 'prompt', 'min-area-ratio', 'tile-size']) if (flags[key]) {
    args.push(`--${key}`, key === 'mask' ? resolve(flags[key]) : flags[key]);
  }
  try { await exec(python, args, {maxBuffer: 8 * 1024 * 1024}); }
  catch (error) { throw new Error(`Vision process failed (${error.code ?? error.signal}): ${error.stdout ?? ''}\n${error.stderr ?? error.message}`); }
  return JSON.parse(await readFile(join(out, 'trace-report.json'), 'utf8'));
}

export async function exportFacadeCAD(modelPath, outputDir, editsPath) {
  const args = [script, editsPath ? 'edit' : 'cad', resolve(modelPath), resolve(outputDir)];
  if (editsPath) args.push('--edits', resolve(editsPath));
  const {stdout} = await exec(python, args, {maxBuffer: 8 * 1024 * 1024});
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
}
