import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const phase of ['startup', 'tests']) test(`cancellation during ${phase} stops the owned project`, { timeout: 15000 }, async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'canary-runner-contract-'));
  const bin = path.join(sandbox, 'bin');
  await mkdir(bin);
  const marker = path.join(sandbox, 'ready');
  const stopped = path.join(sandbox, 'stopped');
  const executable = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const name = require('node:path').basename(process.argv[1]);
if (name === 'supabase' && args[0] === 'init') {
  fs.mkdirSync(require('node:path').join(args[args.indexOf('--workdir')+1], 'supabase'), {recursive:true});
} else if (name === 'supabase' && args[0] === 'stop') {
  fs.writeFileSync(${JSON.stringify(stopped)}, args[args.indexOf('--workdir')+1]);
} else if (name === 'supabase' && args[0] === 'status') {
  console.log(JSON.stringify({ API_URL:'http://127.0.0.1:54321', DB_URL:'postgresql://postgres:postgres@127.0.0.1:54322/postgres', ANON_KEY:'fake', SERVICE_ROLE_KEY:'fake' }));
} else if ((${JSON.stringify(phase)} === 'startup' && name === 'supabase' && args[0] === 'start') || (${JSON.stringify(phase)} === 'tests' && name === 'npx' && args[0] === 'vitest')) {
  fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
`;
  for (const name of ['supabase', 'npx']) await writeFile(path.join(bin, name), executable, { mode: 0o755 });
  const runner = spawn(process.execPath, ['scripts/run-disposable-canaries.mjs'], { cwd: root, env: { PATH: `${bin}:${process.env.PATH}`, HOME: sandbox, TMPDIR: sandbox }, stdio: 'ignore' });
  const closed = new Promise(resolve => runner.on('close', (code, signal) => resolve({code,signal})));
  try {
    for (let i=0; i<100; i++) {
      try { await access(marker); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    const childPid = Number(await readFile(marker, 'utf8'));
    runner.kill('SIGTERM');
    const result = await closed;
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    const ownedDirectory = await readFile(stopped, 'utf8');
    await assert.rejects(access(ownedDirectory));
    assert.throws(() => process.kill(childPid, 0), /ESRCH/);
  } finally {
    runner.kill('SIGKILL');
    await rm(sandbox, {recursive:true, force:true});
  }
});
