import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyDownload } from '../ci/pull-heavy-record.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const repo = process.cwd();
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const root = 'docs/performance/inbox-redesign/evidence';

for (const phase of ['pre', 'post']) test(`db-contract ${phase} record is accepted by the W1 puller`, () => {
  const lane = `db-contract-${phase}`;
  const id = phase === 'pre' ? '696001' : '696002';
  const attempt = '1';
  const artifactName = `heavy-${lane}-${sha}-${id}-${attempt}`;
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'w4w-seal-'));
  try {
    const dir = path.join(temporary, root, sha, 'pre-merge', id);
    mkdirSync(dir, { recursive: true });
    const contracts = Buffer.from('[]\n');
    writeFileSync(path.join(dir, 'contracts.json'), contracts);
    const manifest = {
      tested_sha: sha, tier: 'pre-merge', kind: 'db-contract', phase, target: 'disposable',
      verdict: 'PASS', exit_status: 0, run_id: id, lane, artifact_name: artifactName,
      github_run_id: id, github_run_attempt: attempt, event: 'workflow_dispatch',
      head_branch: 'main', workflow_path: '.github/workflows/inbox-heavy-verification.yml',
      workflow_input_sha: sha, runner_script_sha256: sha256(execFileSync('git', ['show', `${sha}:scripts/inbox-ci/${lane}.sh`])),
      completed_at: new Date().toISOString(), artifacts: { 'contracts.json': sha256(contracts) },
    };
    writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
    const run = { id: Number(id), run_attempt: 1, status: 'completed', event: 'workflow_dispatch',
      head_branch: 'main', path: manifest.workflow_path, head_sha: sha,
      display_title: `Inbox heavy ${lane} ${sha}` };
    const artifact = { name: artifactName, expired: false, size_in_bytes: 1 };
    assert.equal(verifyDownload(repo, temporary, run, artifact, sha).manifest.phase, phase);
    manifest.run_id = `${id}-${phase}`;
    writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
    assert.throws(() => verifyDownload(repo, temporary, run, artifact, sha), /Manifest identity/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
