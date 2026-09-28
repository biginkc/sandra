import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EVIDENCE_ROOT = 'docs/performance/inbox-redesign/evidence';
export const TIERS = new Set(['pre-merge', 'test-env', 'prod-deploy']);
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
export function writeManifest(repo, relativeDir, fields) {
  const absoluteDir = path.join(repo, relativeDir);
  const manifest = { ...fields, artifacts: artifactHashes(absoluteDir) };
  writeFileSync(path.join(absoluteDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
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
  writeFileSync(path.join(absoluteDir, 'results.json'), result.stdout || '');
  writeFileSync(path.join(absoluteDir, 'runner.log'), `${result.stderr || ''}\nexit_status=${result.status ?? 'signal'}\n`);
  const status = assertOnlyRunDirDirty(repo, relativeDir);
  writeManifest(repo, relativeDir, {
    tested_sha: sha, tier, run_id: runId, started_at: startedAt, completed_at: new Date().toISOString(),
    runner_script_sha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    clean_tree: { start: true, end_excluding_run_dir: true, excluded_path: relativeDir, end_status: status },
    exit_status: result.status ?? -1,
    fixture_rows: existsSync(path.join(absoluteDir, 'fixture-rows.json')) ? JSON.parse(readFileSync(path.join(absoluteDir, 'fixture-rows.json'), 'utf8')) : [],
    retained_rows: existsSync(path.join(absoluteDir, 'retained-rows.json')) ? JSON.parse(readFileSync(path.join(absoluteDir, 'retained-rows.json'), 'utf8')) : [],
  });
  process.exitCode = result.status ?? 1;
}
