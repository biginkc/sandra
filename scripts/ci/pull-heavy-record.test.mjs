import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { copyFileSync, cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { verifyDownload, seal } from './pull-heavy-record.mjs';
import { validateOutboxResults, writeManifest } from '../outbox-run-record.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
function fixture({ historical = false } = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), 'heavy-pull-repo-'));
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Evidence Test']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
  mkdirSync(path.join(repo, '.github/workflows'), { recursive: true });
  writeFileSync(path.join(repo, '.github/workflows/inbox-heavy-verification.yml'), 'safe: true\n');
  mkdirSync(path.join(repo, 'scripts/inbox-ci'), { recursive: true });
  mkdirSync(path.join(repo, 'e2e/inbox-acceptance'), { recursive: true });
  writeFileSync(path.join(repo, 'scripts/inbox-ci/outbox-pre.sh'), 'echo safe\n');
  writeFileSync(path.join(repo, 'scripts/inbox-ci/migration-dry-run.sh'), 'echo migration\n');
  writeFileSync(path.join(repo, 'e2e/inbox-acceptance/fault-proxy.mjs'), 'safe\n');
  if (historical) {
    const old = path.join(repo, `docs/performance/inbox-redesign/evidence/${'a'.repeat(40)}/pre-merge/122`);
    mkdirSync(old, { recursive: true });
    writeFileSync(path.join(old, 'manifest.json'), '{}');
  }
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
  const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const root = mkdtempSync(path.join(tmpdir(), 'heavy-pull-artifact-'));
  const dir = path.join(root, `docs/performance/inbox-redesign/evidence/${sha}/pre-merge/123`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'results.json'), '{}');
  const manifest = {
    tested_sha: sha, tier: 'pre-merge', kind: 'browser', phase: 'pre', target: 'disposable', verdict: 'PASS', run_id: '123',
    exit_status: 0, started_at: '2026-09-28T23:00:00Z', completed_at: '2026-09-29T00:00:00Z', lane: 'outbox-pre',
    workflow_path: '.github/workflows/inbox-heavy-verification.yml', workflow_input_sha: sha,
    github_run_id: '123', github_run_attempt: '2', artifact_name: `heavy-outbox-pre-${sha}-123-2`, event: 'workflow_dispatch', head_branch: 'main',
    runner_script_sha256: hash('echo safe\n'), fault_proxy_script_sha256: hash('safe\n'),
    clean_tree: { start: true, end_excluding_run_dir: true, excluded_path: `docs/performance/inbox-redesign/evidence/${sha}/pre-merge/123` },
    artifacts: { 'results.json': hash('{}') },
  };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  const run = { head_sha: sha, id: 123, run_attempt: 2, event: 'workflow_dispatch', head_branch: 'main', path: manifest.workflow_path, status: 'completed', conclusion: 'success', inputs: { sha, lane: 'outbox-pre' }, display_title: `Inbox heavy outbox-pre ${sha}` };
  const artifact = { name: `heavy-outbox-pre-${sha}-123-2`, expired: false, size_in_bytes: 100 };
  return { repo, root, dir, sha, manifest, run, artifact, save() { writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest)); }, check() { return verifyDownload(repo, root, run, artifact, sha); } };
}
test('valid downloaded evidence verifies', () => assert.equal(fixture().check().manifest.verdict, 'PASS'));
test('workflow upload round trip selects only the new run and preserves its dotfile', () => {
  const f = fixture({ historical: true });
  const hidden = 'playwright/.last-run.json';
  mkdirSync(path.join(f.dir, 'playwright'), { recursive: true });
  writeFileSync(path.join(f.dir, hidden), '{"status":"passed"}');
  f.manifest.artifacts[hidden] = hash('{"status":"passed"}');
  f.save();
  cpSync(f.dir, path.join(f.repo, path.relative(f.root, f.dir)), { recursive: true });
  const workflow = readFileSync('.github/workflows/inbox-heavy-verification.yml', 'utf8');
  const stage = yaml.load(workflow).jobs.lane.steps.find(step => step.name === 'Stage current run record');
  assert.equal(stage.run, 'node scripts/ci/stage-heavy-artifact.mjs');
  const stageScript = path.resolve('scripts/ci/stage-heavy-artifact.mjs');
  assert.throws(() => execFileSync(process.execPath, [stageScript], { cwd: f.repo, env: { ...process.env, HEAVY_TESTED_SHA: f.sha, GITHUB_RUN_ID: '123', HEAVY_RUN_DIR: 'docs/performance/inbox-redesign/evidence/', RUNNER_TEMP: mkdtempSync(path.join(tmpdir(), 'heavy-runner-')) }, stdio: 'pipe' }), /Lane did not export its exact run directory/);
  function roundTrip(source) {
    const upload = yaml.load(source).jobs.lane.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
    const runnerTemp = mkdtempSync(path.join(tmpdir(), 'heavy-runner-'));
    const runDir = `docs/performance/inbox-redesign/evidence/${f.sha}/pre-merge/123`;
    execFileSync(process.execPath, [stageScript], { cwd: f.repo, env: { ...process.env, HEAVY_TESTED_SHA: f.sha, GITHUB_RUN_ID: '123', HEAVY_RUN_DIR: runDir, RUNNER_TEMP: runnerTemp } });
    const uploadRoot = upload.with.path.replace('${{ runner.temp }}', runnerTemp);
    const sourceRoot = path.isAbsolute(uploadRoot) ? uploadRoot : path.join(f.repo, uploadRoot);
    const download = mkdtempSync(path.join(tmpdir(), 'heavy-downloaded-'));
    const targetRoot = path.join(download, 'docs/performance/inbox-redesign/evidence');
    function transfer(dir, relative = '') {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!upload.with['include-hidden-files'] && entry.name.startsWith('.')) continue;
        const next = path.join(relative, entry.name);
        if (entry.isDirectory()) transfer(path.join(dir, entry.name), next);
        else {
          const target = path.join(targetRoot, next);
          mkdirSync(path.dirname(target), { recursive: true });
          copyFileSync(path.join(dir, entry.name), target);
        }
      }
    }
    transfer(sourceRoot);
    return verifyDownload(f.repo, download, f.run, f.artifact, f.sha);
  }
  assert.equal(roundTrip(workflow).manifest.artifacts[hidden], f.manifest.artifacts[hidden]);
  assert.throws(() => roundTrip(workflow.replace('path: ${{ runner.temp }}/heavy-upload/', 'path: docs/performance/inbox-redesign/evidence/')), /Artifact path or sensitive filename refused/);
  assert.throws(() => roundTrip(workflow.replace('include-hidden-files: true', 'include-hidden-files: false')), /Incomplete artifact inventory/);
});
test('non-outbox record does not require a fault proxy hash', () => {
  const f = fixture();
  f.manifest.lane = 'migration-dry-run';
  f.manifest.kind = 'migration-dry-run';
  f.manifest.phase = 'n/a';
  f.manifest.runner_script_sha256 = hash('echo migration\n');
  delete f.manifest.fault_proxy_script_sha256;
  f.manifest.artifact_name = `heavy-migration-dry-run-${f.sha}-123-2`;
  f.artifact.name = f.manifest.artifact_name;
  f.run.display_title = `Inbox heavy migration-dry-run ${f.sha}`;
  f.save();
  assert.equal(f.check().manifest.lane, 'migration-dry-run');
});
test('outbox record requires its fault proxy hash', () => {
  const f = fixture();
  delete f.manifest.fault_proxy_script_sha256;
  f.save();
  assert.throws(() => f.check(), /Runner\/proxy script hash mismatch/);
});
for (const [label, mutate] of [
  ['legacy outbox lane', f => { f.manifest.lane = 'outbox'; f.save(); }],
  ['mislabelled browser phase', f => { f.manifest.phase = 'post'; f.save(); }],
  ['non-dispatch', f => { f.run.event = 'pull_request'; }],
  ['non-main', f => { f.run.head_branch = 'feature'; }],
  ['in-progress run', f => { f.run.status = 'in_progress'; }],
  ['wrong workflow', f => { f.run.path = 'other.yml'; }],
  ['wrong workflow definition SHA', f => { f.run.head_sha = '0'.repeat(40); }],
  ['wrong input sha', f => { f.run.display_title = `Inbox heavy outbox-pre ${'0'.repeat(40)}`; }],
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
  const relative = path.relative(f.root, f.dir);
  mkdirSync(path.join(f.dir, 'playwright', 'x'), { recursive: true });
  writeFileSync(path.join(f.dir, 'playwright', 'x', 'error-context.md'), 'Playwright failure context\n');
  writeFileSync(path.join(f.dir, 'row-results.json'), JSON.stringify([{ id: 'O01', status: 'fail' }]));
  assert.throws(() => validateOutboxResults(f.dir), /Outbox O01/);
  writeManifest(f.root, relative, { ...f.manifest, verdict: 'FAIL', exit_status: 1 }, {});
  assert.equal(f.check().manifest.artifacts['playwright/x/error-context.md'], hash('Playwright failure context\n'));
  const remote = mkdtempSync(path.join(tmpdir(), 'heavy-seal-remote-'));
  execFileSync('git', ['init', '--bare', '-q', remote]);
  execFileSync('git', ['-C', f.repo, 'remote', 'add', 'origin', remote]);
  const sealed = seal(f.repo, f.root, f.check(), 'evidence-fail');
  const script = `import sys; sys.path.insert(0, ${JSON.stringify(path.resolve('experiments/inbox-release'))}); from sealed_evidence import evaluate, EvidenceError; evaluate(${JSON.stringify(f.repo)}, ${JSON.stringify(f.sha)}, 'pre-merge', ${JSON.stringify('evidence-fail')})`;
  assert.throws(() => execFileSync('python3', ['-c', script], { encoding: 'utf8', stdio: 'pipe' }), error => /latest required check failed/.test(error.stderr));
  assert.match(sealed, /^[a-f0-9]{40}$/);
});
