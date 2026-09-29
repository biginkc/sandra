import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitHubRunEnvironment, ensureE2ERunEnvironment } from '../src/lib/supabase/e2e-identity-guard.ts';

export const EVIDENCE_ROOT = 'docs/performance/inbox-redesign/evidence';
export const TIERS = new Set(['pre-merge', 'test-env', 'prod-deploy']);
export function isGitHubE2ERun(env) { return env.CI === '1' || env.GITHUB_ACTIONS === 'true'; }
export function buildOutboxIdentityEnvironment(baseEnv = process.env, githubRunEnvironment = createGitHubRunEnvironment) {
  const run = isGitHubE2ERun(baseEnv)
    ? githubRunEnvironment(baseEnv)
    : { runSlug: `local-${process.pid}-${randomUUID().replaceAll('-', '').slice(0, 12)}`, password: `${randomUUID()}${randomUUID()}` };
  const env = {
    ...baseEnv,
    E2E_RUN_SLUG: run.runSlug,
    E2E_TEST_USER_EMAIL: run.email ?? `e2e-ci+${run.runSlug}@bmhgroupkc.com`,
    E2E_TEST_USER_PASSWORD: run.password,
  };
  ensureE2ERunEnvironment(env);
  return env;
}
function runIdentityLifecycle(command, env, repo) {
  const result = spawnSync('npx', ['tsx', 'scripts/e2e-identity-lifecycle.ts', command], { cwd: repo, env, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`E2E identity ${command} failed: ${result.stderr || result.stdout || result.status}`);
}
export function runOutboxPlaywright(env, repo, { lifecycle = runIdentityLifecycle, playwright = () => spawnSync('npx', ['playwright', 'test', '--config', 'playwright.outbox-regression.config.ts', '--reporter=json'], { cwd: repo, env, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }) } = {}) {
  if (isGitHubE2ERun(env)) lifecycle('preflight', env, repo);
  let result;
  let cleanupError;
  try {
    result = playwright();
  } finally {
    if (isGitHubE2ERun(env)) {
      try { lifecycle('cleanup', env, repo); } catch (error) { cleanupError = error; }
    }
  }
  return { result, cleanupError };
}
const TEXT_ARTIFACT = /\.(?:json|log|txt|html|csv|md)$/i;
const ALLOWED_ARTIFACT = /\.(?:json|log|txt|html|png|csv|gz|md)$/i;
const MAX_RUN_BYTES = 40 * 1024 * 1024;
const O_IDS = Array.from({length: 10}, (_, i) => `O${String(i + 1).padStart(2, '0')}`);
// Seven Outbox specs plus the auth setup dependency; the source test pins both spec sets.
const OUTBOX_PLAYWRIGHT_TEST_COUNT = 8;
const SECRET_ENV_KEY = /KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL|DB_URL|JWT/i;
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const SB_KEY = /sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g;
const RESIDUAL_SECRET = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sb_secret_[A-Za-z0-9_-]+/;
export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function git(repo, ...args) { return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim(); }
export function assertCleanStart(repo) {
  const status = git(repo, 'status', '--porcelain', '--untracked-files=all');
  if (status) throw new Error(`Refusing dirty tree at start:\n${status}`);
}
export function runPath(sha, tier, runId) {
  if (!/^[a-f0-9]{40}$/.test(sha) || !TIERS.has(tier) || !/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Invalid run-record path');
  return `${EVIDENCE_ROOT}/${sha}/${tier}/${runId}`;
}
export function assertOnlyRunDirDirty(repo, dir) {
  const lines = git(repo, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean);
  if (lines.some(line => !line.slice(3).startsWith(`${dir}/`))) throw new Error(`Non-record working-tree changes at end:\n${lines.join('\n')}`);
  return lines;
}
export function artifactHashes(absoluteDir) {
  const hashes = {};
  function visit(folder, prefix = '') {
    for (const name of readdirSync(folder)) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (relative === 'manifest.json') continue;
      const full = path.join(folder, name);
      if (lstatSync(full).isSymbolicLink()) throw new Error(`Symlink in run: ${relative}`);
      if (statSync(full).isDirectory()) visit(full, relative);
      else {
        assertAllowedArtifact(full, absoluteDir);
        hashes[relative] = sha256(readFileSync(full));
      }
    }
  }
  visit(absoluteDir);
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
}
function assertAllowedArtifact(full, root) {
  if (!ALLOWED_ARTIFACT.test(full)) throw new Error(`Disallowed run artifact: ${path.relative(root, full)}`);
}
function visitFiles(folder, visit, root = folder) {
  for (const name of readdirSync(folder)) {
    const full = path.join(folder, name);
    if (lstatSync(full).isSymbolicLink()) throw new Error(`Symlink in run: ${full}`);
    if (statSync(full).isDirectory()) visitFiles(full, visit, root);
    else if (full !== path.join(root, 'manifest.json')) visit(full);
  }
}
export function redactText(value, env = process.env) {
  let redacted = value;
  const secrets = [...new Set(Object.entries(env)
    .filter(([key, secret]) => SECRET_ENV_KEY.test(key) && typeof secret === 'string' && secret.length >= 12)
    .map(([, secret]) => secret))].sort((a, b) => b.length - a.length);
  for (const secret of secrets) redacted = redacted.replaceAll(secret, '[REDACTED]');
  return redacted.replace(JWT, '[REDACTED]').replace(SB_KEY, '[REDACTED]');
}
export function redactResultsJson(content, env = process.env, repo = '') {
  const relativePaths = value => {
    if (typeof value === 'string') {
      const relative = repo ? value.replaceAll(repo, '.') : value;
      return relative.replace(/\/Users\/[A-Za-z0-9._-]+(?:\/[^\s,;:)"'`]+)*/g, '[LOCAL_PATH]');
    }
    if (Array.isArray(value)) return value.map(relativePaths);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, relativePaths(child)]));
    return value;
  };
  try {
    const results = JSON.parse(content);
    if (results && typeof results === 'object' && results.config && typeof results.config === 'object') {
      delete results.config.webServer;
    }
    content = `${JSON.stringify(relativePaths(results), null, 2)}\n`;
  } catch { content = relativePaths(content); }
  return redactText(content, env);
}
export function redactRunArtifacts(absoluteDir, env = process.env, repo = '') {
  visitFiles(absoluteDir, full => {
    assertAllowedArtifact(full, absoluteDir);
    if (!TEXT_ARTIFACT.test(full)) return;
    const content = readFileSync(full, 'utf8');
    const safe = path.basename(full) === 'results.json' ? redactResultsJson(content, env, repo) : redactText(content, env);
    if (safe !== content) writeFileSync(full, safe);
  });
  // Unknown extensions fail closed; scan only approved artifacts before attesting to them.
  visitFiles(absoluteDir, full => {
    assertAllowedArtifact(full, absoluteDir);
    if (TEXT_ARTIFACT.test(full) && RESIDUAL_SECRET.test(readFileSync(full, 'utf8'))) throw new Error(`Residual secret in run artifact: ${path.relative(absoluteDir, full)}`);
  });
}
export function validateOutboxResults(dir) {
  const rows = JSON.parse(readFileSync(path.join(dir, 'row-results.json'), 'utf8'));
  const results = JSON.parse(readFileSync(path.join(dir, 'results.json'), 'utf8'));
  for (const id of O_IDS) {
    const matches = rows.filter(row => row.id === id);
    if (matches.length !== 1 || matches[0].status !== 'pass') throw new Error(`Outbox ${id} missing, skipped, failed or duplicated`);
  }
  if (rows.some(row => !O_IDS.includes(row.id))) throw new Error('Unexpected Outbox row');
  let observedTests = 0;
  const visit = suites => {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
        observedTests++;
        if ((test.results ?? []).length !== 1 || (test.results ?? []).some(result => result.retry !== 0 || result.status !== 'passed')) throw new Error('Playwright skipped, failed or retried test');
        if (test.status !== 'expected') throw new Error('Playwright non-expected test');
      }
      visit(suite.suites);
    }
  };
  visit(results.suites);
  if (results.stats?.expected !== OUTBOX_PLAYWRIGHT_TEST_COUNT || observedTests !== OUTBOX_PLAYWRIGHT_TEST_COUNT || results.stats.skipped !== 0 || results.stats.unexpected !== 0 || results.stats.flaky !== 0) throw new Error('Playwright incomplete, skipped or flaky');
}
export function writeManifest(repo, relativeDir, fields, env = process.env) {
  const absoluteDir = path.join(repo, relativeDir);
  redactRunArtifacts(absoluteDir, env, repo);
  const rawInflated = {};
  visitFiles(absoluteDir, full => {
    if (statSync(full).size > 1024 * 1024) {
      const bytes = readFileSync(full);
      const relative = path.relative(absoluteDir, full).replaceAll(path.sep, '/');
      rawInflated[relative] = sha256(bytes);
      execFileSync('gzip', ['-n', '-9', full]);
    }
  });
  let total = 0; visitFiles(absoluteDir, full => { total += statSync(full).size; });
  if (total > MAX_RUN_BYTES) throw new Error('Run exceeds 40 MiB; refusing to seal');
  const manifest = { ...fields, raw_inflated_sha256: rawInflated, artifacts: artifactHashes(absoluteDir) };
  if (Buffer.byteLength(JSON.stringify(manifest)) + total > MAX_RUN_BYTES) throw new Error('Run exceeds 40 MiB; refusing to seal');
  const safeManifest = redactText(`${JSON.stringify(manifest, null, 2)}\n`, env);
  if (RESIDUAL_SECRET.test(safeManifest)) throw new Error('Residual secret in manifest');
  writeFileSync(path.join(absoluteDir, 'manifest.json'), safeManifest);
  return manifest;
}

async function waitForProxy(proxy, token) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (proxy.exitCode !== null || proxy.signalCode !== null) throw new Error('Outbox fault proxy exited before becoming ready');
    try {
      const response = await fetch('http://127.0.0.1:54321/__outbox_fault/status', {
        headers: { 'x-outbox-fault-token': token }, signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
      throw new Error(`Outbox fault proxy readiness returned ${response.status}`);
    } catch (error) {
      if (error.message?.startsWith('Outbox fault proxy readiness')) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error('Outbox fault proxy did not become ready');
}
async function stopProxy(proxy) {
  if (proxy.exitCode !== null || proxy.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { proxy.kill('SIGKILL'); resolve(); }, 2000);
    proxy.once('exit', () => { clearTimeout(timer); resolve(); });
    if (!proxy.kill('SIGTERM')) { clearTimeout(timer); resolve(); }
  });
}

export function recordOutboxResult({ repo, relativeDir, sha, tier, runId, startedAt, env, result, cleanupError }) {
  const absoluteDir = path.join(repo, relativeDir);
  writeFileSync(path.join(absoluteDir, 'results.json'), redactResultsJson(result.stdout || '', env, repo));
  writeFileSync(path.join(absoluteDir, 'runner.log'), redactText(`${result.stderr || ''}\nexit_status=${result.status ?? 'signal'}\n`, env));
  const failures = [];
  if (result.error) failures.push(`Playwright execution failed: ${result.error}`);
  if (cleanupError) failures.push(`Exact-run cleanup failed: ${cleanupError}`);
  try { validateOutboxResults(absoluteDir); } catch (error) { failures.push(String(error)); }
  const verdict = failures.length || result.status !== 0 ? 'FAIL' : 'PASS';
  if (failures.length) writeFileSync(path.join(absoluteDir, 'validation.log'), failures.join('\n'));
  const status = assertOnlyRunDirDirty(repo, relativeDir);
  const exitStatus = verdict === 'PASS' ? 0 : (result.status || 1);
  writeManifest(repo, relativeDir, {
    tested_sha: sha, tier, kind: 'browser', phase: env.HEAVY_PHASE ?? 'pre', target: 'disposable', verdict, run_id: runId, started_at: startedAt, completed_at: new Date().toISOString(),
    summary: cleanupError ? 'Exact-run cleanup failed' : '', cleanup_failure: Boolean(cleanupError),
    workflow_path: env.GITHUB_WORKFLOW_REF?.split('@')[0]?.replace(/^[^/]+\/[^/]+\//, '') ?? '',
    workflow_input_sha: env.HEAVY_TESTED_SHA ?? '',
    github_run_id: env.GITHUB_RUN_ID ?? '', github_run_attempt: env.GITHUB_RUN_ATTEMPT ?? '',
    artifact_name: isGitHubE2ERun(env) ? `heavy-${env.HEAVY_LANE}-${sha}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}` : '',
    event: env.GITHUB_EVENT_NAME ?? '', head_branch: env.GITHUB_REF_NAME ?? '', lane: env.HEAVY_LANE ?? '',
    runner_script_sha256: sha256(readFileSync(path.join(repo, 'scripts/inbox-ci', `${env.HEAVY_LANE ?? 'outbox'}.sh`))),
    fault_proxy_script_sha256: sha256(readFileSync(path.join(repo, 'e2e/inbox-acceptance/fault-proxy.mjs'))),
    clean_tree: { start: true, end_excluding_run_dir: true, excluded_path: relativeDir, end_status: status },
    exit_status: exitStatus,
    fixture_rows: existsSync(path.join(absoluteDir, 'fixture-rows.json')) ? JSON.parse(readFileSync(path.join(absoluteDir, 'fixture-rows.json'), 'utf8')) : [],
    retained_rows: existsSync(path.join(absoluteDir, 'retained-rows.json')) ? JSON.parse(readFileSync(path.join(absoluteDir, 'retained-rows.json'), 'utf8')) : [],
  }, env);
  return exitStatus;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const tier = process.argv[2] ?? 'pre-merge';
  assertCleanStart(repo);
  const sha = git(repo, 'rev-parse', 'HEAD');
  const runId = isGitHubE2ERun(process.env) ? process.env.GITHUB_RUN_ID : `${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID()}`;
  if (isGitHubE2ERun(process.env) && (!/^[1-9][0-9]*$/.test(runId ?? '') || process.env.HEAVY_TESTED_SHA !== sha)) throw new Error('Invalid CI run identity');
  const relativeDir = runPath(sha, tier, runId);
  const absoluteDir = path.join(repo, relativeDir);
  const startedAt = new Date().toISOString();
  mkdirSync(absoluteDir, { recursive: true });
  const token = `${randomUUID()}${randomUUID()}`;
  const env = buildOutboxIdentityEnvironment({ ...process.env, OUTBOX_RUN_DIR: absoluteDir, OUTBOX_FAULT_TOKEN: token, INBOX_ACCEPTANCE_ORG_ID: '00000000-0000-0000-0000-000000000bbb', MESSAGING_PROVIDER: 'mock' });
  if (isGitHubE2ERun(env)) {
    if (!env.RUNNER_TEMP) throw new Error('GitHub Outbox identity requires RUNNER_TEMP');
    env.E2E_QA_GUARD_STATE = path.join(env.RUNNER_TEMP, `sandra-e2e-browser-qa-${env.E2E_RUN_SLUG}.json`);
  }
  let outcome;
  const proxy = spawn(process.execPath, ['e2e/inbox-acceptance/fault-proxy.mjs'], { cwd: repo, env, stdio: 'ignore' });
  let proxyError;
  proxy.on('error', error => { proxyError = error; });
  try {
    await waitForProxy(proxy, token);
    if (proxyError) throw proxyError;
    outcome = runOutboxPlaywright(env, repo);
  } finally {
    await stopProxy(proxy);
  }
  process.exitCode = recordOutboxResult({ repo, relativeDir, sha, tier, runId, startedAt, env, ...outcome });
}
