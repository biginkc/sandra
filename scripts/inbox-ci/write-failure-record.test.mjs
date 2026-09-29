import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDownload } from '../ci/pull-heavy-record.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lanes = ['catalog-fingerprint', 'db-contract-pre', 'db-contract-post', 'burst', 'perf-120k', 'outbox-pre', 'outbox-post'];

test('early failure writer seals stageable FAIL manifests for each non-migration lane', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'heavy-failure-record-'));
  const repo = path.join(temporary, 'repo');
  mkdirSync(repo);
  try {
    for (const file of [
      'scripts/outbox-run-record.mjs', 'src/lib/supabase/e2e-identity-guard.ts',
      'scripts/outbox-db-contract/catalog-sections.mjs',
      'scripts/inbox-ci/write-failure-record.mjs',
      'e2e/inbox-acceptance/fault-proxy.mjs',
      '.github/workflows/inbox-heavy-verification.yml',
      ...lanes.map(lane => `scripts/inbox-ci/${lane}.sh`),
    ]) {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      cpSync(path.join(source, file), path.join(repo, file));
    }
    writeFileSync(path.join(repo, 'package.json'), '{"type":"module"}\n');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: repo });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    for (const [index, lane] of lanes.entries()) {
      const runId = String(900 + index);
      const env = { ...process.env, HEAVY_LANE: lane, HEAVY_TESTED_SHA: sha,
        GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_NAME: 'main',
        GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: '1' };
      execFileSync('node', ['scripts/inbox-ci/write-failure-record.mjs', '3'], { cwd: repo, env });
      const relative = `docs/performance/inbox-redesign/evidence/${sha}/pre-merge/${runId}`;
      const record = JSON.parse(readFileSync(path.join(repo, relative, 'manifest.json')));
      assert.equal(record.verdict, 'FAIL');
      assert.equal(record.exit_status, 3);
      assert.equal(record.lane, lane);
      assert.equal(record.kind, lane.startsWith('outbox-') ? 'browser' : lane.startsWith('db-contract-') ? 'db-contract' : lane);
      assert.equal(record.phase, lane.endsWith('-pre') ? 'pre' : lane.endsWith('-post') ? 'post' : 'n/a');
      assert.equal('fault_proxy_script_sha256' in record, lane.startsWith('outbox-'));
      assert.ok(record.artifacts['failure.log']);
      const run = { id: Number(runId), run_attempt: 1, status: 'completed', event: 'workflow_dispatch',
        head_branch: 'main', path: '.github/workflows/inbox-heavy-verification.yml', head_sha: sha,
        display_title: `Inbox heavy ${lane} ${sha}` };
      const artifact = { name: `heavy-${lane}-${sha}-${runId}-1`, expired: false, size_in_bytes: 1 };
      const download = path.join(temporary, 'download');
      mkdirSync(path.dirname(path.join(download, relative)), { recursive: true });
      cpSync(path.join(repo, relative), path.join(download, relative), { recursive: true });
      assert.equal(verifyDownload(repo, download, run, artifact, sha).manifest.verdict, 'FAIL');
      rmSync(download, { recursive: true, force: true });
      assert.throws(() => execFileSync('node', ['scripts/inbox-ci/write-failure-record.mjs', '3'], { cwd: repo, env, stdio: 'pipe' }), error => error.stderr.toString().includes('Run record already sealed'));
      rmSync(path.join(repo, relative), { recursive: true, force: true });
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
