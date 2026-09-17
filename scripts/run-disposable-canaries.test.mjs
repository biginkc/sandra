import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('disposable stack starts a reduced local service set and verifies owned cleanup', async () => {
  const source = await readFile(path.join(root, 'scripts/run-disposable-canaries.mjs'), 'utf8');
  assert.match(source, /--exclude/);
  assert.match(source, /DISPOSABLE_SUPABASE_EXCLUDES/);
  assert.match(source, /mailpit/);
  assert.match(source, /assertDiskHeadroom/);
  assert.match(source, /docker.*volume.*ls/s);
  assert.match(source, /docker.*volume.*rm/s);
  assert.match(source, /Owned Docker resources remain after cleanup/);
});

test('browser acceptance is an explicit opt-in with generated local credentials', async () => {
  const source = await readFile(path.join(root, 'scripts/run-disposable-canaries.mjs'), 'utf8');
  assert.match(source, /SANDRA_CANARY_BROWSER === '1'/);
  assert.match(source, /playwright.*playwright\.sequence-readiness\.config\.ts/s);
  assert.match(source, /NEXT_PUBLIC_SUPABASE_ANON_KEY: status\.ANON_KEY/);
  assert.match(source, /SUPABASE_SERVICE_ROLE_KEY: status\.SERVICE_ROLE_KEY/);
  assert.match(source, /SEQUENCE_READINESS_LEDGER_TOKEN/);
  assert.match(source, /E2E_TEST_USER_PASSWORD: browserIdentity\.password/);
  assert.match(source, /NEXT_FONT_GOOGLE_MOCKED_RESPONSES/);
  const browserConfig = await readFile(path.join(root, 'playwright.sequence-readiness.config.ts'), 'utf8');
  assert.match(
    browserConfig,
    /command:\s*"npm run build -- --webpack && npx next start --hostname 127\.0\.0\.1 -p 3557"/,
  );
  assert.match(browserConfig, /E2E_AUTH_BYPASS:\s*""/);
  assert.match(browserConfig, /NODE_ENV:\s*"production"/);
  assert.match(browserConfig, /NEXT_FONT_GOOGLE_TURBOPACK_MOCKED_RESPONSES:\s*"0"/);
  assert.match(browserConfig, /NEXT_TELEMETRY_DISABLED:\s*"1"/);
  assert.match(browserConfig, /SEQUENCE_READINESS_PRODUCTION_BROWSER:\s*"1"/);
  assert.doesNotMatch(browserConfig, /next dev/);
});

test('browser-only mode requires browser acceptance and skips Vitest', async () => {
  const source = await readFile(path.join(root, 'scripts/run-disposable-canaries.mjs'), 'utf8');
  assert.match(source, /SANDRA_CANARY_BROWSER_ONLY === '1'/);
  assert.match(source, /browserOnlyEnabled && !browserAcceptanceEnabled/);
  assert.match(source, /browserOnly:\s*browserOnlyEnabled/);
  assert.match(source, /if \(!browserOnlyEnabled\)[\s\S]*vitest/);
  assert.match(source, /testLane:[\s\S]*'browser-only'/);
});

for (const phase of ['startup', 'tests']) test(`cancellation during ${phase} stops the owned project`, { timeout: 30000 }, async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'canary-runner-contract-'));
  const bin = path.join(sandbox, 'bin');
  await mkdir(bin);
  const marker = path.join(sandbox, 'ready');
  const stopped = path.join(sandbox, 'stopped');
  const dockerLog = path.join(sandbox, 'docker.log');
  const dockerRemoved = path.join(sandbox, 'docker-removed');
  const executable = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const name = require('node:path').basename(process.argv[1]);
const tmp = process.env.TMPDIR;
const project = fs.readdirSync(tmp).find((entry) => entry.startsWith('sandra-disposable-canary-'));
const ownedContainers = project ? ['supabase_api_' + project, 'supabase_rest_' + project] : [];
const ownedVolumes = project ? ['supabase_db_' + project, 'supabase_storage_' + project] : [];
const unrelated = ['supabase_db_other-project'];
if (name === 'supabase' && args[0] === 'init') {
  fs.mkdirSync(require('node:path').join(args[args.indexOf('--workdir')+1], 'supabase'), {recursive:true});
} else if (name === 'supabase' && args[0] === '--version') {
  console.log('2.116.0');
} else if (name === 'supabase' && args[0] === 'stop') {
  fs.writeFileSync(${JSON.stringify(stopped)}, args[args.indexOf('--workdir')+1]);
} else if (name === 'supabase' && args[0] === 'status') {
  console.log(JSON.stringify({ API_URL:'http://127.0.0.1:54321', DB_URL:'postgresql://postgres:postgres@127.0.0.1:54322/postgres', ANON_KEY:'fake', SERVICE_ROLE_KEY:'fake' }));
} else if (name === 'docker' && args[1] === 'ls') {
  const owned = args[0] === 'container' ? ownedContainers : ownedVolumes;
  const all = fs.existsSync(${JSON.stringify(dockerRemoved)}) ? owned.filter((resource) => !fs.readFileSync(${JSON.stringify(dockerRemoved)}, 'utf8').split('\\n').includes(resource)) : owned;
  console.log([...all, ...unrelated].join('\\n'));
} else if (name === 'docker' && (args[0] === 'rm' || args[0] === 'volume') && args.includes('rm')) {
  fs.appendFileSync(${JSON.stringify(dockerLog)}, args.join(' ') + '\\n');
  const removed = args.filter((value) => value.startsWith('supabase_'));
  fs.appendFileSync(${JSON.stringify(dockerRemoved)}, removed.join('\\n') + '\\n');
} else if ((${JSON.stringify(phase)} === 'startup' && name === 'supabase' && args[0] === 'start') || (${JSON.stringify(phase)} === 'tests' && name === 'npx' && args[0] === 'vitest')) {
  fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
`;
  for (const name of ['supabase', 'npx', 'docker']) await writeFile(path.join(bin, name), executable, { mode: 0o755 });
  const runner = spawn(process.execPath, ['scripts/run-disposable-canaries.mjs'], { cwd: root, env: { PATH: `${bin}:${process.env.PATH}`, HOME: sandbox, TMPDIR: sandbox, SANDRA_CANARY_RUNNER_CONTRACT: '1' }, stdio: 'ignore' });
  const closed = new Promise(resolve => runner.on('close', (code, signal) => resolve({code,signal})));
  try {
    for (let i=0; i<300; i++) {
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
    const dockerCalls = await readFile(dockerLog, 'utf8');
    assert.match(dockerCalls, /supabase_api_sandra-disposable-canary-/);
    assert.match(dockerCalls, /supabase_db_sandra-disposable-canary-/);
    assert.doesNotMatch(dockerCalls, /other-project/);
  } finally {
    runner.kill('SIGKILL');
    await rm(sandbox, {recursive:true, force:true});
  }
});
