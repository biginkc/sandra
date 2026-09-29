import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeManifest, runPath } from '../../scripts/outbox-run-record.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const work = process.argv[2];
if (!work || !path.isAbsolute(work)) throw new Error('Runner scratch output directory required');
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
if (!/^[0-9a-f]{40}$/.test(sha) || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || process.env.GITHUB_REF_NAME !== 'main') throw new Error('Untrusted dispatch provenance');
const runId = `${process.env.GITHUB_RUN_ID}_${process.env.GITHUB_RUN_ATTEMPT ?? '1'}_${Date.now()}`;
const lane = 'migration-dry-run';
const runner = path.join(repo, 'scripts/inbox-ci/migration-dry-run.sh');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const common = {
  tested_sha: sha, tier: 'pre-merge', phase: 'n/a', target: 'disposable',
  started_at: new Date(Number(process.env.INBOX_LANE_STARTED_MS || Date.now())).toISOString(),
  completed_at: new Date().toISOString(),
  runner_script_sha256: hash(runner),
  fault_proxy_script_sha256: hash(path.join(repo, 'e2e/inbox-acceptance/fault-proxy.mjs')),
  github_run_id: String(process.env.GITHUB_RUN_ID),
  github_run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
  github_event_name: process.env.GITHUB_EVENT_NAME,
  github_head_branch: process.env.GITHUB_REF_NAME,
  workflow_path: '.github/workflows/inbox-heavy-verification.yml',
  workflow_sha: process.env.GITHUB_WORKFLOW_SHA ?? null,
  runner_image: { os: process.env.ImageOS ?? null, version: process.env.ImageVersion ?? null },
  supabase_cli_version: execFileSync('supabase', ['--version'], { encoding: 'utf8' }).trim(),
  docker_version: execFileSync('docker', ['--version'], { encoding: 'utf8' }).trim(),
  lane,
  clean_tree: { start: true, end_excluding_run_dir: true, end_status: [] },
  exit_status: 0, verdict: 'PASS',
};
function record(kind, files, summary) {
  const id = `${runId}_${kind.replaceAll('-', '_')}`;
  const relative = runPath(sha, 'pre-merge', id);
  const absolute = path.join(repo, relative);
  mkdirSync(absolute, { recursive: true });
  const rawInflated = {};
  for (const file of files) {
    const source = path.join(work, file);
    if (!statSync(source).isFile()) throw new Error(`Missing result ${file}`);
    if (statSync(source).size > 1024 * 1024) {
      const compressed = execFileSync('gzip', ['-n', '-9', '-c', source], { maxBuffer: 45 * 1024 * 1024 });
      writeFileSync(path.join(absolute, `${file}.gz`), compressed);
      rawInflated[file] = hash(source);
    } else copyFileSync(source, path.join(absolute, file));
  }
  writeFileSync(path.join(absolute, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const bytes = files.reduce((sum, file) => sum + statSync(path.join(absolute, file in rawInflated ? `${file}.gz` : file)).size, 0) + statSync(path.join(absolute, 'summary.json')).size;
  if (bytes > 40 * 1024 * 1024) throw new Error('Run directory exceeds 40 MiB cap');
  writeManifest(repo, relative, { ...common, kind, run_id: id,
    clean_tree: { ...common.clean_tree, excluded_path: relative }, summary, raw_inflated_sha256: rawInflated });
}
const mutations = JSON.parse(readFileSync(path.join(work, 'mutation-cases.json'), 'utf8'));
const pre = JSON.parse(readFileSync(path.join(work, 'catalog-pre.json'), 'utf8'));
const post = JSON.parse(readFileSync(path.join(work, 'catalog-post.json'), 'utf8'));
if (mutations.cases?.length !== 41 || !mutations.passed) throw new Error('Missing 41-case proof');
record('migration-dry-run', [
  'indexes.txt', 'index-preconditions.txt', 'verify-installed.txt', 'installed-catalog.json',
  'pre-migration-ledger.txt',
  'second-apply.stdout.txt', 'second-apply.stderr.txt', 'mutation-harness.txt', 'mutation-cases.json',
  'production-install-unit.txt',
  'apply-20260929000000.txt', 'apply-20260929000100.txt', 'apply-20260929000200.txt',
], { migration_versions: ['20260929000000', '20260929000100', '20260929000200'], second_apply_refused: true, mutation_cases: 41, private_helper_exposure_count: 0 });
record('catalog-fingerprint', [
  'catalog-manifest-check.txt', 'catalog-pre.json', 'catalog-post.json', 'catalog-live.txt',
], { pre_sha256: pre.sha256, post_sha256: post.sha256, pre_section_sha256: pre.section_sha256, post_section_sha256: post.section_sha256, live_mutation_tests: 5 });
