import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertOnlyRunDirDirty, writeManifest, runPath } from '../../scripts/outbox-run-record.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
if (process.env.MIGRATION_LOCAL_EXECUTION === '1') throw new Error('Local diagnostic cannot seal a run record');
const work = process.argv[2];
if (!work || !path.isAbsolute(work)) throw new Error('Runner scratch output directory required');
const failed = process.argv[3] === '--fail';
const failureStatus = Number(process.argv[4]);
if (failed && (!Number.isInteger(failureStatus) || failureStatus <= 0 || failureStatus > 255)) throw new Error('Invalid lane failure status');
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
if (!/^[0-9a-f]{40}$/.test(sha) || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || process.env.GITHUB_REF_NAME !== 'main') throw new Error('Untrusted dispatch provenance');
const runId = String(process.env.GITHUB_RUN_ID);
const attempt = String(process.env.GITHUB_RUN_ATTEMPT ?? '1');
const lane = process.env.HEAVY_LANE;
if (!['migration-dry-run', 'catalog-fingerprint'].includes(lane) || process.env.HEAVY_TESTED_SHA !== sha || !/^\d+$/.test(runId) || !/^\d+$/.test(attempt)) throw new Error('Invalid heavy lane identity');
const runner = path.join(repo, 'scripts/inbox-ci', `${lane}.sh`);
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const common = {
  tested_sha: sha, tier: 'pre-merge', phase: 'n/a', target: 'disposable',
  started_at: new Date(Number(process.env.INBOX_LANE_STARTED_MS || Date.now())).toISOString(),
  completed_at: new Date().toISOString(),
  runner_script_sha256: hash(runner),
  fault_proxy_script_sha256: hash(path.join(repo, 'e2e/inbox-acceptance/fault-proxy.mjs')),
  github_run_id: String(process.env.GITHUB_RUN_ID),
  github_run_attempt: attempt,
  artifact_name: `heavy-${lane}-${sha}-${runId}-${attempt}`,
  workflow_input_sha: process.env.HEAVY_TESTED_SHA,
  event: process.env.GITHUB_EVENT_NAME,
  head_branch: process.env.GITHUB_REF_NAME,
  workflow_path: '.github/workflows/inbox-heavy-verification.yml',
  workflow_sha: process.env.GITHUB_WORKFLOW_SHA ?? null,
  runner_image: { os: process.env.ImageOS ?? null, version: process.env.ImageVersion ?? null },
  supabase_cli_version: execFileSync('supabase', ['--version'], { encoding: 'utf8' }).trim(),
  docker_version: execFileSync('docker', ['--version'], { encoding: 'utf8' }).trim(),
  lane,
  exit_status: failed ? failureStatus : 0, verdict: failed ? 'FAIL' : 'PASS',
};
function record(kind, files, summary) {
  const relative = runPath(sha, 'pre-merge', runId);
  const absolute = path.join(repo, relative);
  mkdirSync(absolute, { recursive: true });
  for (const file of files) {
    const source = path.join(work, file);
    if (!statSync(source).isFile()) throw new Error(`Missing result ${file}`);
    copyFileSync(source, path.join(absolute, file));
  }
  writeFileSync(path.join(absolute, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  // FAIL sealing is best-effort: this rejects dirt anywhere outside the run dir,
  // including changes caused by a preflight failure before a stack starts.
  const endStatus = assertOnlyRunDirDirty(repo, relative);
  writeManifest(repo, relative, { ...common, kind, run_id: runId,
    clean_tree: { start: true, end_excluding_run_dir: true, excluded_path: relative, end_status: endStatus }, summary,
    ...(kind === 'catalog-fingerprint' ? { catalog_fingerprint_post_artifact: 'catalog-post.json' } : {}),
  });
}
if (failed) {
  const files = ['failure.log', ...['catalog-live.txt', 'production-install-unit.txt', 'catalog-manifest-check.txt', 'catalog-pre.json', 'catalog-post.json', 'verify-installed.txt', 'mutation-harness.txt'].filter(file => existsSync(path.join(work, file)))];
  record(lane, files, { failure: readFileSync(path.join(work, 'failure.log'), 'utf8').trim() });
} else {
const mutations = JSON.parse(readFileSync(path.join(work, 'mutation-cases.json'), 'utf8'));
const pre = JSON.parse(readFileSync(path.join(work, 'catalog-pre.json'), 'utf8'));
const post = JSON.parse(readFileSync(path.join(work, 'catalog-post.json'), 'utf8'));
if (mutations.cases?.length !== 41 || !mutations.passed) throw new Error('Missing 41-case proof');
const dryRunFiles = [
  'indexes.txt', 'index-preconditions.txt', 'constraint-validation.txt', 'verify-installed.txt', 'installed-catalog.json',
  'pre-migration-ledger.txt',
  'second-apply.stdout.txt', 'second-apply.stderr.txt', 'mutation-role.txt', 'mutation-harness.txt', 'mutation-cases.json',
  'catalog-post-harness.json',
  'production-install-unit.txt',
  'apply-20260930040000.txt', 'apply-20260930040100.txt', 'apply-20260930040200.txt',
];
const catalogFiles = [
  'catalog-manifest-check.txt', 'catalog-pre.json', 'catalog-post.json', 'catalog-live.txt',
];
if (lane === 'migration-dry-run') record(lane, dryRunFiles, { migration_versions: ['20260930040000', '20260930040100', '20260930040200'], second_apply_refused: true, mutation_cases: 41, private_helper_exposure_count: 0 });
else record(lane, catalogFiles, { pre_sha256: pre.sha256, post_sha256: post.sha256, pre_section_sha256: pre.section_sha256, post_section_sha256: post.section_sha256, live_mutation_tests: 5 });
}
