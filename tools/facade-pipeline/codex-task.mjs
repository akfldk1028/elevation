/** Structured local Codex invocation. Prompt bytes travel on stdin, never through a shell. */
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, delimiter } from 'node:path';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';

export function terminateCodex(child) {
  if (!child.pid) return;
  if (process.platform==='win32') {
    const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{shell:false,windowsHide:true,stdio:'ignore'});
    killer.on('error',()=>child.kill());
  } else child.kill();
}

export async function codexExecutable() {
  if (process.platform !== 'win32') return {command:'codex', prefix:[]};
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const script = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (await access(script).then(()=>true,()=>false)) return {command:process.execPath, prefix:[script]};
    const cmd = join(dir, 'codex.cmd');
    if (await access(cmd).then(()=>true,()=>false)) return {command:cmd, prefix:[]};
    const exe = join(dir, 'codex.exe');
    if (await access(exe).then(()=>true,()=>false)) return {command:exe, prefix:[]};
  }
  throw new Error('CODEX_EXECUTABLE_MISSING: install the local Codex CLI');
}

export async function runCodexTask({prompt, images=[], directory, name='response', timeoutMs=900000}) {
  await mkdir(directory, {recursive:true});
  const answerPath = join(directory, `${name}.json`);
  const promptPath = join(directory, `${name}.prompt.txt`);
  await writeFile(promptPath, prompt, 'utf8');
  const {command, prefix} = await codexExecutable();
  const args = [...prefix, 'exec', '--skip-git-repo-check', '--json', '--cd', directory,
                '--output-last-message', answerPath];
  for (const image of images) args.push('--image', image);
  args.push('-');
  let output = '';
  const events=createWriteStream(join(directory,`${name}.events.jsonl`));
  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {shell:false, windowsHide:true, stdio:['pipe','pipe','pipe']});
    let timedOut = false;
    const timer = setTimeout(()=>{timedOut=true; terminateCodex(child);}, timeoutMs);
    const collect=data=>{events.write(data); output=(output+data).slice(-128*1024);};
    child.stdout.on('data',collect);
    child.stderr.on('data',collect);
    child.on('error', error=>{clearTimeout(timer); events.end(); reject(error);});
    child.on('close', code=>{clearTimeout(timer); events.end(); timedOut ? reject(new Error('CODEX_TASK_TIMEOUT')) : resolve(code);});
    child.stdin.on('error', ()=>{});
    child.stdin.end(prompt);
  });
  if (code !== 0) {
    if (/usage limit/i.test(output)) {
      const match = /try again at ([^.]+)\./i.exec(output);
      const resetTime = match ? match[1].trim() : 'see settings';
      throw new Error(`CODEX_QUOTA_EXCEEDED: usage limit reached (resets: ${resetTime}). Fallback to local/Claude lane.`);
    }
    if (/not supported when using Codex with a ChatGPT account/i.test(output)) {
      throw new Error('CODEX_ENTITLEMENT_REFUSED: ChatGPT account entitlement not supported. Fallback to local/Claude lane.');
    }
    throw new Error(`CODEX_TASK_FAILED (${code}): ${output.slice(-2500)}`);
  }
  const answer = await readFile(answerPath, 'utf8');
  const value = JSON.parse(answer.trim());
  return {value, receipt:{prompt_sha256:createHash('sha256').update(prompt).digest('hex'),
    answer_sha256:createHash('sha256').update(answer).digest('hex'), answer:answerPath,
    thread_id: /"thread_id"\s*:\s*"([^"]+)"/.exec(output)?.[1] ?? null}};
}
