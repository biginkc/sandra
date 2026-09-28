import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EVIDENCE_ROOT = 'docs/performance/inbox-redesign/evidence';
export const TIERS = new Set(['pre-merge', 'test-env', 'prod-deploy']);
const TEXT_ARTIFACT = /\.(?:json|log|txt|html)$/i;
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
      if (statSync(full).isDirectory()) visit(full, relative);
      else hashes[relative] = sha256(readFileSync(full));
    }
  }
  visit(absoluteDir);
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
}
function visitFiles(folder, visit, root = folder) {
  for (const name of readdirSync(folder)) {
    const full = path.join(folder, name);
    if (statSync(full).isDirectory()) visitFiles(full, visit, root);
    else if (full !== path.join(root, 'manifest.json')) visit(full);
  }
}
export function redactText(value, env = process.env) {
  let redacted = value;
  const secrets = [...new Set(Object.entries(env)
    .filter(([key, secret]) => SECRET_ENV_KEY.test(key) && typeof secret === 'string' && secret.length > 0)
    .map(([, secret]) => secret))].sort((a, b) => b.length - a.length);
  for (const secret of secrets) redacted = redacted.replaceAll(secret, '[REDACTED]');
  return redacted.replace(JWT, '[REDACTED]').replace(SB_KEY, '[REDACTED]');
}
export function redactResultsJson(content, env = process.env) {
  try {
    const results = JSON.parse(content);
    if (results && typeof results === 'object' && results.config && typeof results.config === 'object') {
      delete results.config.webServer;
      content = `${JSON.stringify(results, null, 2)}\n`;
    }
  } catch { /* Keep non-JSON runner output for diagnosis and redact it as text. */ }
  return redactText(content, env);
}
export function redactRunArtifacts(absoluteDir, env = process.env) {
  visitFiles(absoluteDir, full => {
    if (!TEXT_ARTIFACT.test(full)) return;
    const content = readFileSync(full, 'utf8');
    const safe = path.basename(full) === 'results.json' ? redactResultsJson(content, env) : redactText(content, env);
    if (safe !== content) writeFileSync(full, safe);
  });
  // Scan all files, including unrecognized extensions, before a manifest can attest to them.
  visitFiles(absoluteDir, full => {
    if (RESIDUAL_SECRET.test(readFileSync(full, 'utf8'))) throw new Error(`Residual secret in run artifact: ${path.relative(absoluteDir, full)}`);
  });
}
export function writeManifest(repo, relativeDir, fields, env = process.env) {
  const absoluteDir = path.join(repo, relativeDir);
  redactRunArtifacts(absoluteDir, env);
  const manifest = { ...fields, artifacts: artifactHashes(absoluteDir) };
  const safeManifest = redactText(`${JSON.stringify(manifest, null, 2)}\n`, env);
  if (RESIDUAL_SECRET.test(safeManifest)) throw new Error('Residual secret in manifest');
  writeFileSync(path.join(absoluteDir, 'manifest.json'), safeManifest);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const tier = process.argv[2] ?? 'pre-merge';
  assertCleanStart(repo);
  const sha = git(repo, 'rev-parse', 'HEAD');
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID()}`;
  const relativeDir = runPath(sha, tier, runId);
  const absoluteDir = path.join(repo, relativeDir);
  const startedAt = new Date().toISOString();
  mkdirSync(absoluteDir, { recursive: true });
  const identity = `local-${process.pid}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const env = { ...process.env, OUTBOX_RUN_DIR: absoluteDir, INBOX_ACCEPTANCE_ORG_ID: '00000000-0000-0000-0000-000000000bbb', MESSAGING_PROVIDER: 'mock', E2E_RUN_SLUG: identity, E2E_TEST_USER_EMAIL: `e2e-ci+${identity}@bmhgroupkc.com`, E2E_TEST_USER_PASSWORD: `${randomUUID()}${randomUUID()}` };
  const result = spawnSync('npx', ['playwright', 'test', '--config', 'playwright.outbox-regression.config.ts', '--reporter=json'], { cwd: repo, env, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  writeFileSync(path.join(absoluteDir, 'results.json'), redactResultsJson(result.stdout || '', env));
  writeFileSync(path.join(absoluteDir, 'runner.log'), redactText(`${result.stderr || ''}\nexit_status=${result.status ?? 'signal'}\n`, env));
  const status = assertOnlyRunDirDirty(repo, relativeDir);
  writeManifest(repo, relativeDir, {
    tested_sha: sha, tier, run_id: runId, started_at: startedAt, completed_at: new Date().toISOString(),
    runner_script_sha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    clean_tree: { start: true, end_excluding_run_dir: true, excluded_path: relativeDir, end_status: status },
    exit_status: result.status ?? -1,
    fixture_rows: existsSync(path.join(absoluteDir, 'fixture-rows.json')) ? JSON.parse(readFileSync(path.join(absoluteDir, 'fixture-rows.json'), 'utf8')) : [],
    retained_rows: existsSync(path.join(absoluteDir, 'retained-rows.json')) ? JSON.parse(readFileSync(path.join(absoluteDir, 'retained-rows.json'), 'utf8')) : [],
  }, env);
  process.exitCode = result.status ?? 1;
}
