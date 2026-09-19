import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Deliberately omit all inherited application, cloud and provider credentials.
const basic = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'CI', 'GITHUB_ACTIONS', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
if (process.env.SANDRA_CANARY_DOCKER_HOST) {
  if (!process.env.SANDRA_CANARY_DOCKER_HOST.startsWith('unix:///')) throw new Error('Only a local Docker socket is allowed');
  basic.DOCKER_HOST = process.env.SANDRA_CANARY_DOCKER_HOST;
}
const workdir = await mkdtemp(path.join(tmpdir(), 'sandra-disposable-canary-'));
let activeChild;
let cancelled = false;
let cleaning = false;
let forceKill;
function terminate(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  forceKill = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') console.error('Could not terminate owned child'); }
  }, 5000);
  forceKill.unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (cleaning || cancelled) return;
  cancelled = true;
  process.exitCode = 1;
  terminate(activeChild);
});
function run(command, args, env = basic, capture = false) {
  if (cancelled && !cleaning) return Promise.reject(new Error('Disposable run cancelled'));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, detached: true, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    activeChild = child;
    let stdout = '';
    let timedOut = false;
    const timeout = cleaning ? setTimeout(() => { timedOut = true; terminate(child); }, 60000) : undefined;
    if (capture) { child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.resume(); }
    child.on('error', reject);
    child.on('close', code => {
      if ((cancelled && !cleaning) || timedOut) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') console.error('Could not kill remaining owned process group'); }
      }
      clearTimeout(timeout);
      clearTimeout(forceKill);
      activeChild = undefined;
      if (code === 0 && !timedOut && (!cancelled || cleaning)) resolve(stdout);
      else reject(new Error(`${command} ${args[0]} exited ${code}${cancelled ? ' after cancellation' : ''}`));
    });
  });
}
let initialized = false;
try {
  await run('supabase', ['init', '--workdir', workdir]);
  initialized = true;
  await cp(path.join(root, 'supabase/migrations'), path.join(workdir, 'supabase/migrations'), { recursive: true });
  await run('supabase', ['start', '--workdir', workdir]);
  const status = JSON.parse(await run('supabase', ['status', '--workdir', workdir, '--output', 'json'], basic, true));
  if (status.API_URL !== 'http://127.0.0.1:54321' || status.DB_URL !== 'postgresql://postgres:postgres@127.0.0.1:54322/postgres') throw new Error('Unexpected local stack endpoints');
  const testEnv = {
    ...basic,
    TEST_SUPABASE_URL: status.API_URL,
    TEST_SUPABASE_DB_URL: status.DB_URL,
    TEST_SUPABASE_ANON_KEY: status.ANON_KEY,
    TEST_SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
  };
  await run('npx', ['tsx', 'scripts/provision-disposable-canary-owner.ts'], testEnv);
  await run('npx', ['vitest', 'run', '--config', 'vitest.disposable-canary.config.ts'], testEnv);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  cleaning = true;
  // The unique project is destroyed even after seed/test failure. No shared reset.
  try {
    if (initialized) await run('supabase', ['stop', '--workdir', workdir, '--no-backup']);
    await rm(workdir, { recursive: true, force: true });
  } catch (error) {
    console.error(`Disposable stack cleanup failed: ${error.message}; retained ${workdir}`);
    process.exitCode = 1;
  }
}
