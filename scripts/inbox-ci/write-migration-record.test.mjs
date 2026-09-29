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
const versions = ['20260930000000', '20260930000100', '20260930000200'];

test('each W2 lane produces a pullable record and the W1 gate selects both keys', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'w2-record-'));
  const repo = path.join(root, 'repo'); mkdirSync(repo);
  try {
    for (const file of ['scripts/outbox-run-record.mjs', 'src/lib/supabase/e2e-identity-guard.ts', 'scripts/inbox-ci/write-migration-record.mjs', 'scripts/inbox-ci/migration-dry-run.sh', 'scripts/inbox-ci/catalog-fingerprint.sh', 'scripts/ci/pull-heavy-record.mjs', '.github/workflows/inbox-heavy-verification.yml']) copy(repo, file);
    mkdirSync(path.join(repo, 'e2e/inbox-acceptance'), { recursive: true });
    writeFileSync(path.join(repo, 'e2e/inbox-acceptance/fault-proxy.mjs'), '// synthetic proxy\n');
    writeFileSync(path.join(repo, 'package.json'), '{"type":"module"}\n');
    git(repo, 'init'); git(repo, 'add', '.'); git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'candidate');
    const sha = git(repo, 'rev-parse', 'HEAD');
    const work = path.join(root, 'scratch'); mkdirSync(work);
    for (const name of ['indexes.txt', 'index-preconditions.txt', 'constraint-validation.txt', 'verify-installed.txt', 'pre-migration-ledger.txt', 'second-apply.stdout.txt', 'second-apply.stderr.txt', 'mutation-role.txt', 'mutation-harness.txt', 'production-install-unit.txt', 'catalog-manifest-check.txt', 'catalog-live.txt', ...versions.map(v => `apply-${v}.txt`)]) writeFileSync(path.join(work, name), 'synthetic disposable evidence\n');
    writeFileSync(path.join(work, 'installed-catalog.json'), '{}\n');
    writeFileSync(path.join(work, 'mutation-cases.json'), JSON.stringify({ passed: true, cases: Array(41).fill({ drift_caught: true, restored_pass: true }) }));
    for (const phase of ['pre', 'post']) writeFileSync(path.join(work, `catalog-${phase}.json`), JSON.stringify({ sha256: phase, section_sha256: { catalog: phase } }));
    cpSync(path.join(work, 'catalog-post.json'), path.join(work, 'catalog-post-harness.json'));
    const bin = path.join(root, 'bin'); mkdirSync(bin);
    for (const name of ['supabase', 'docker']) { const file = path.join(bin, name); writeFileSync(file, '#!/bin/sh\necho synthetic-version\n', { mode: 0o755 }); }
    const writer = path.join(repo, 'scripts/inbox-ci/write-migration-record.mjs');
    const baseEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_NAME: 'main', GITHUB_RUN_ID: '901', GITHUB_RUN_ATTEMPT: '2', HEAVY_LANE: 'migration-dry-run', HEAVY_TESTED_SHA: sha };
    const invoke = env => execFileSync('node', [writer, work], { cwd: repo, env: { ...baseEnv, ...env }, encoding: 'utf8', stdio: 'pipe' });
    assert.throws(() => invoke({ MIGRATION_LOCAL_EXECUTION: '1' }), error => error.stderr?.toString().includes('Local diagnostic cannot seal a run record'));
    for (const [env, message] of [[{ GITHUB_EVENT_NAME: 'push' }, 'Untrusted dispatch provenance'], [{ GITHUB_REF_NAME: 'feature' }, 'Untrusted dispatch provenance'], [{ HEAVY_LANE: 'outbox' }, 'Invalid heavy lane identity'], [{ HEAVY_TESTED_SHA: '0'.repeat(40) }, 'Invalid heavy lane identity']]) {
      assert.throws(() => invoke(env), error => error.stderr?.toString().includes(message));
    }
    const completeCases = readFileSync(path.join(work, 'mutation-cases.json'));
    writeFileSync(path.join(work, 'mutation-cases.json'), JSON.stringify({ passed: true, cases: Array(40).fill({ drift_caught: true, restored_pass: true }) }));
    assert.throws(() => invoke({}), error => error.stderr?.toString().includes('Missing 41-case proof'));
    writeFileSync(path.join(work, 'mutation-cases.json'), completeCases);
    writeFileSync(path.join(repo, 'unrelated.txt'), 'unexpected edit\n');
    assert.throws(() => invoke({}), error => error.stderr?.toString().includes('Non-record working-tree changes at end'));
    rmSync(path.join(repo, 'unrelated.txt'));
    rmSync(path.join(repo, `docs/performance/inbox-redesign/evidence/${sha}/pre-merge/901`), { recursive: true, force: true });
    writeFileSync(path.join(work, 'failure.log'), 'line=22\ncommand=false\nexit_status=17\n');
    assert.throws(() => execFileSync('node', [writer, work, '--fail', '0'], { cwd: repo, env: { ...baseEnv, GITHUB_RUN_ID: '903' }, stdio: 'pipe' }), error => error.stderr?.toString().includes('Invalid lane failure status'));
    execFileSync('node', [writer, work, '--fail', '17'], { cwd: repo, env: { ...baseEnv, GITHUB_RUN_ID: '903', HEAVY_LANE: 'catalog-fingerprint' } });
    const failPath = `docs/performance/inbox-redesign/evidence/${sha}/pre-merge/903/manifest.json`;
    const failManifest = JSON.parse(readFileSync(path.join(repo, failPath)));
    assert.equal(failManifest.verdict, 'FAIL');
    assert.equal(failManifest.exit_status, 17);
    assert.ok(failManifest.artifacts['failure.log']);
    rmSync(path.dirname(path.join(repo, failPath)), { recursive: true, force: true });
    for (const [lane, id] of [['migration-dry-run', '901'], ['catalog-fingerprint', '902']]) {
      invoke({ HEAVY_LANE: lane, GITHUB_RUN_ID: id });
      const prefix = `docs/performance/inbox-redesign/evidence/${sha}/pre-merge/${id}`;
      const manifest = JSON.parse(readFileSync(path.join(repo, prefix, 'manifest.json')));
      const download = path.join(root, `download-${id}`);
      mkdirSync(path.dirname(path.join(download, prefix)), { recursive: true });
      cpSync(path.join(repo, prefix), path.join(download, prefix), { recursive: true });
      const artifactName = `heavy-${lane}-${sha}-${id}-2`;
      const run = { id: Number(id), run_attempt: 2, status: 'completed', event: 'workflow_dispatch', head_branch: 'main', path: '.github/workflows/inbox-heavy-verification.yml', conclusion: 'success', head_sha: sha, display_title: `Inbox heavy ${lane} ${sha}` };
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
      rmSync(path.join(repo, prefix), { recursive: true, force: true });
    }
    for (const id of ['901', '902']) {
      const prefix = `docs/performance/inbox-redesign/evidence/${sha}/pre-merge/${id}`;
      mkdirSync(path.dirname(path.join(repo, prefix)), { recursive: true });
      cpSync(path.join(root, `download-${id}`, prefix), path.join(repo, prefix), { recursive: true });
      git(repo, 'add', '--', prefix);
      git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', `evidence ${id}`);
    }
    const gate = `import sys; sys.path.insert(0, ${JSON.stringify(path.join(source, 'experiments/inbox-release'))}); import sealed_evidence as s; c=s.collect(${JSON.stringify(repo)}, ${JSON.stringify(sha)}); assert ('pre-merge','migration-dry-run','n/a','disposable') in c['selected']; assert ('pre-merge','catalog-fingerprint','n/a','disposable') in c['selected']`;
    execFileSync('python3', ['-c', gate], { cwd: repo });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
