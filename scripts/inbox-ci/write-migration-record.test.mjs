import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDownload } from '../ci/pull-heavy-record.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const git = (repo, ...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const copy = (repo, file) => { mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); cpSync(path.join(source, file), path.join(repo, file)); };
const versions = ['20260929000000', '20260929000100', '20260929000200'];

test('each W2 lane produces a pullable record and the W1 gate selects both keys', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'w2-record-'));
  const repo = path.join(root, 'repo'); mkdirSync(repo);
  try {
    for (const file of ['scripts/outbox-run-record.mjs', 'scripts/inbox-ci/write-migration-record.mjs', 'scripts/inbox-ci/migration-dry-run.sh', 'scripts/inbox-ci/catalog-fingerprint.sh', 'scripts/ci/pull-heavy-record.mjs', '.github/workflows/inbox-heavy-verification.yml']) copy(repo, file);
    mkdirSync(path.join(repo, 'e2e/inbox-acceptance'), { recursive: true });
    writeFileSync(path.join(repo, 'e2e/inbox-acceptance/fault-proxy.mjs'), '// synthetic proxy\n');
    writeFileSync(path.join(repo, 'package.json'), '{"type":"module"}\n');
    git(repo, 'init'); git(repo, 'add', '.'); git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'candidate');
    const sha = git(repo, 'rev-parse', 'HEAD');
    const work = path.join(root, 'scratch'); mkdirSync(work);
    for (const name of ['indexes.txt', 'index-preconditions.txt', 'verify-installed.txt', 'pre-migration-ledger.txt', 'second-apply.stdout.txt', 'second-apply.stderr.txt', 'mutation-harness.txt', 'production-install-unit.txt', 'catalog-manifest-check.txt', 'catalog-live.txt', ...versions.map(v => `apply-${v}.txt`)]) writeFileSync(path.join(work, name), 'synthetic disposable evidence\n');
    writeFileSync(path.join(work, 'installed-catalog.json'), '{}\n');
    writeFileSync(path.join(work, 'mutation-cases.json'), JSON.stringify({ passed: true, cases: Array(41).fill({ drift_caught: true, restored_pass: true }) }));
    for (const phase of ['pre', 'post']) writeFileSync(path.join(work, `catalog-${phase}.json`), JSON.stringify({ sha256: phase, section_sha256: { catalog: phase } }));
    const bin = path.join(root, 'bin'); mkdirSync(bin);
    for (const name of ['supabase', 'docker']) { const file = path.join(bin, name); writeFileSync(file, '#!/bin/sh\necho synthetic-version\n', { mode: 0o755 }); }
    for (const [lane, id] of [['migration-dry-run', '901'], ['catalog-fingerprint', '902']]) {
      execFileSync('node', [path.join(repo, 'scripts/inbox-ci/write-migration-record.mjs'), work], { cwd: repo, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_NAME: 'main', GITHUB_RUN_ID: id, GITHUB_RUN_ATTEMPT: '2', HEAVY_LANE: lane, HEAVY_TESTED_SHA: sha } });
      const prefix = `docs/performance/inbox-redesign/evidence/${sha}/pre-merge/${id}`;
      const manifest = JSON.parse(readFileSync(path.join(repo, prefix, 'manifest.json')));
      const download = path.join(root, `download-${id}`);
      mkdirSync(path.dirname(path.join(download, prefix)), { recursive: true });
      cpSync(path.join(repo, prefix), path.join(download, prefix), { recursive: true });
      const artifactName = `heavy-${lane}-${sha}-${id}-2`;
      const run = { id: Number(id), run_attempt: 2, event: 'workflow_dispatch', head_branch: 'main', path: '.github/workflows/inbox-heavy-verification.yml', conclusion: 'success', head_sha: sha, display_title: `Inbox heavy ${lane} ${sha}` };
      const artifact = { name: artifactName, expired: false, size_in_bytes: 1000 };
      assert.equal(manifest.kind, lane);
      assert.equal(verifyDownload(repo, download, run, artifact, sha).manifest.kind, lane);
      assert.throws(() => verifyDownload(repo, download, run, { ...artifact, name: artifactName.replace(/-2$/, '-3') }, sha), /Artifact attempt mismatch/);
      const saved = manifest.workflow_input_sha;
      manifest.workflow_input_sha = '0'.repeat(40);
      writeFileSync(path.join(download, prefix, 'manifest.json'), JSON.stringify(manifest));
      assert.throws(() => verifyDownload(repo, download, run, artifact, sha), /Manifest provenance/);
      manifest.workflow_input_sha = saved;
      writeFileSync(path.join(download, prefix, 'manifest.json'), JSON.stringify(manifest));
    }
    for (const id of ['901', '902']) {
      const prefix = `docs/performance/inbox-redesign/evidence/${sha}/pre-merge/${id}`;
      git(repo, 'add', '--', prefix);
      git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', `evidence ${id}`);
    }
    const gate = `import sys; sys.path.insert(0, ${JSON.stringify(path.join(source, 'experiments/inbox-release'))}); import sealed_evidence as s; c=s.collect(${JSON.stringify(repo)}, ${JSON.stringify(sha)}); assert ('pre-merge','migration-dry-run','n/a','disposable') in c['selected']; assert ('pre-merge','catalog-fingerprint','n/a','disposable') in c['selected']`;
    execFileSync('python3', ['-c', gate], { cwd: repo });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
