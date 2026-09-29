import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyDownload, seal } from './pull-heavy-record.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
function fixture() {
  const repo = mkdtempSync(path.join(tmpdir(), 'heavy-pull-repo-'));
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Evidence Test']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
  mkdirSync(path.join(repo, '.github/workflows'), { recursive: true });
  writeFileSync(path.join(repo, '.github/workflows/inbox-heavy-verification.yml'), 'safe: true\n');
  mkdirSync(path.join(repo, 'scripts/inbox-ci'), { recursive: true });
  mkdirSync(path.join(repo, 'e2e/inbox-acceptance'), { recursive: true });
  writeFileSync(path.join(repo, 'scripts/inbox-ci/outbox.sh'), 'echo safe\n');
  writeFileSync(path.join(repo, 'scripts/inbox-ci/migration.sh'), 'echo migration\n');
  writeFileSync(path.join(repo, 'e2e/inbox-acceptance/fault-proxy.mjs'), 'safe\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
  const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const root = mkdtempSync(path.join(tmpdir(), 'heavy-pull-artifact-'));
  const dir = path.join(root, `docs/performance/inbox-redesign/evidence/${sha}/pre-merge/123`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'results.json'), '{}');
  const manifest = {
    tested_sha: sha, tier: 'pre-merge', kind: 'browser', phase: 'pre', target: 'disposable', verdict: 'PASS', run_id: '123',
    exit_status: 0, started_at: '2026-09-28T23:00:00Z', completed_at: '2026-09-29T00:00:00Z', lane: 'outbox',
    workflow_path: '.github/workflows/inbox-heavy-verification.yml', workflow_input_sha: sha,
    github_run_id: '123', github_run_attempt: '2', artifact_name: `heavy-outbox-${sha}-123-2`, event: 'workflow_dispatch', head_branch: 'main',
    runner_script_sha256: hash('echo safe\n'), fault_proxy_script_sha256: hash('safe\n'),
    clean_tree: { start: true, end_excluding_run_dir: true, excluded_path: `docs/performance/inbox-redesign/evidence/${sha}/pre-merge/123` },
    artifacts: { 'results.json': hash('{}') },
  };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  const run = { head_sha: sha, id: 123, run_attempt: 2, event: 'workflow_dispatch', head_branch: 'main', path: manifest.workflow_path, conclusion: 'success', inputs: { sha, lane: 'outbox' }, display_title: `Inbox heavy outbox ${sha}` };
  const artifact = { name: `heavy-outbox-${sha}-123-2`, expired: false, size_in_bytes: 100 };
  return { repo, root, dir, sha, manifest, run, artifact, save() { writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest)); }, check() { return verifyDownload(repo, root, run, artifact, sha); } };
}
test('valid downloaded evidence verifies', () => assert.equal(fixture().check().manifest.verdict, 'PASS'));
test('non-outbox record does not require a fault proxy hash', () => {
  const f = fixture();
  f.manifest.lane = 'migration';
  f.manifest.runner_script_sha256 = hash('echo migration\n');
  delete f.manifest.fault_proxy_script_sha256;
  f.manifest.artifact_name = `heavy-migration-${f.sha}-123-2`;
  f.artifact.name = f.manifest.artifact_name;
  f.run.display_title = `Inbox heavy migration ${f.sha}`;
  f.save();
  assert.equal(f.check().manifest.lane, 'migration');
});
test('outbox record requires its fault proxy hash', () => {
  const f = fixture();
  delete f.manifest.fault_proxy_script_sha256;
  f.save();
  assert.throws(() => f.check(), /Runner\/proxy script hash mismatch/);
});
for (const [label, mutate] of [
  ['non-dispatch', f => { f.run.event = 'pull_request'; }],
  ['non-main', f => { f.run.head_branch = 'feature'; }],
  ['wrong workflow', f => { f.run.path = 'other.yml'; }],
  ['wrong workflow definition SHA', f => { f.run.head_sha = '0'.repeat(40); }],
  ['wrong input sha', f => { f.run.display_title = `Inbox heavy outbox ${'0'.repeat(40)}`; }],
  ['wrong run attempt', f => { f.artifact.name = f.artifact.name.replace(/-2$/, '-1'); }],
  ['manifest attempt mismatch', f => { f.manifest.github_run_attempt = '1'; f.save(); }],
  ['external artifacts', f => { f.manifest.external_artifacts = {}; f.save(); }],
  ['missing artifact', f => { f.manifest.artifacts['missing.txt'] = hash('x'); f.save(); }],
  ['tampered bytes', f => { writeFileSync(path.join(f.dir, 'results.json'), 'tampered'); }],
  ['token JSON key', f => { f.manifest.extra = { access_token: 'secret' }; f.save(); }],
  ['compressed token JSON key', f => { const bytes = Buffer.from(JSON.stringify({ access_token: 'secret' })); writeFileSync(path.join(f.dir, 'details.json.gz'), gzipSync(bytes)); f.manifest.artifacts['details.json.gz'] = hash(gzipSync(bytes)); f.manifest.raw_inflated_sha256 = { 'details.json': hash(bytes) }; f.save(); }],
  ['runner script hash', f => { f.manifest.runner_script_sha256 = '0'.repeat(64); f.save(); }],
  ['over cap', f => { writeFileSync(path.join(f.dir, 'results.json'), Buffer.alloc(40 * 1024 * 1024 + 1)); }],
  ['session file', f => { writeFileSync(path.join(f.dir, 'session.json'), '{}'); }],
  ['env file', f => { writeFileSync(path.join(f.dir, 'local.env'), 'x'); }],
  ['token file', f => { writeFileSync(path.join(f.dir, 'my-token.json'), '{}'); }],
  ['symlink', f => { symlinkSync(path.join(f.dir, 'results.json'), path.join(f.dir, 'linked.json')); }],
]) test(`negative control rejects ${label}`, () => { const f = fixture(); mutate(f); assert.throws(() => f.check()); });

test('seal creates one-parent evidence-only commit on an owned branch', () => {
  const f = fixture();
  const remote = mkdtempSync(path.join(tmpdir(), 'heavy-seal-remote-'));
  execFileSync('git', ['init', '--bare', '-q', remote]);
  execFileSync('git', ['-C', f.repo, 'remote', 'add', 'origin', remote]);
  execFileSync('git', ['-C', f.repo, 'branch', 'evidence-test']);
  execFileSync('git', ['-C', f.repo, 'push', '-q', 'origin', 'evidence-test']);
  const sealed = seal(f.repo, f.root, f.check(), 'evidence-test');
  const parent = execFileSync('git', ['-C', f.repo, 'rev-list', '--parents', '-n', '1', sealed], { encoding: 'utf8' }).trim().split(' ');
  assert.deepEqual(parent, [sealed, f.sha]);
  const files = execFileSync('git', ['-C', f.repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', f.sha, sealed], { encoding: 'utf8' }).trim().split('\n');
  assert(files.every(file => file.startsWith(`docs/performance/inbox-redesign/evidence/${f.sha}/pre-merge/123/`)));
  const identity = execFileSync('git', ['-C', f.repo, 'show', '-s', '--format=%an <%ae>%n%B', sealed], { encoding: 'utf8' });
  assert.match(identity, /^Evidence Test <test@example\.invalid>/);
  assert.match(identity, /Co-Authored-By: Claude Opus 5\.5 <noreply@anthropic\.com>/);
});

test('FAIL run seals and sealed gate rejects its latest result', () => {
  const f = fixture();
  f.run.conclusion = 'failure';
  f.manifest.verdict = 'FAIL';
  f.manifest.exit_status = 1;
  f.save();
  const remote = mkdtempSync(path.join(tmpdir(), 'heavy-seal-remote-'));
  execFileSync('git', ['init', '--bare', '-q', remote]);
  execFileSync('git', ['-C', f.repo, 'remote', 'add', 'origin', remote]);
  const sealed = seal(f.repo, f.root, f.check(), 'evidence-fail');
  const script = `import sys; sys.path.insert(0, ${JSON.stringify(path.resolve('experiments/inbox-release'))}); from sealed_evidence import evaluate, EvidenceError; evaluate(${JSON.stringify(f.repo)}, ${JSON.stringify(f.sha)}, 'pre-merge', ${JSON.stringify('evidence-fail')})`;
  assert.throws(() => execFileSync('python3', ['-c', script], { encoding: 'utf8', stdio: 'pipe' }), error => /latest required check failed/.test(error.stderr));
  assert.match(sealed, /^[a-f0-9]{40}$/);
});
