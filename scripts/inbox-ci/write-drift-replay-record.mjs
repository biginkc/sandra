#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { assertOnlyRunDirDirty, runPath, writeManifest } from '../../scripts/outbox-run-record.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const env = process.env;
if (env.DRIFT_REPLAY_LOCAL_EXECUTION === '1') throw new Error('Local diagnostic cannot seal a replay record');
const work = process.argv[2];
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const runId = String(env.GITHUB_RUN_ID);
const attempt = String(env.GITHUB_RUN_ATTEMPT ?? '1');
if (!work || !path.isAbsolute(work) || !/^[0-9a-f]{40}$/.test(sha) || env.HEAVY_TESTED_SHA !== sha || !/^\d+$/.test(runId) || !/^\d+$/.test(attempt) || env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF_NAME !== 'main' || env.HEAVY_LANE !== 'drift-replay') throw new Error('Invalid drift replay identity');
const relative = runPath(sha, 'pre-merge', runId);
const absolute = path.join(repo, relative);
if (existsSync(path.join(absolute, 'manifest.json'))) throw new Error('Run record already sealed');
mkdirSync(absolute, { recursive: true });
const files = ['drift-record.json', 'catalog-pre.json', 'catalog-post.json', 'pre-readonly.json', 'post-readonly.json', 'contract-suite.txt'];
for (const file of files) {
  const source = path.join(work, file);
  if (!existsSync(source)) throw new Error(`Missing replay result ${file}`);
  copyFileSync(source, path.join(absolute, file));
}
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const record = JSON.parse(readFileSync(path.join(absolute, 'drift-record.json')));
const endStatus = assertOnlyRunDirDirty(repo, relative);
const artifacts = Object.fromEntries(files.map(file => [file, hash(path.join(absolute, file))]));
writeManifest(repo, relative, {
  tested_sha: sha, tier: 'pre-merge', kind: 'drift-replay', phase: 'n/a', target: 'disposable', verdict: 'PASS', exit_status: 0,
  run_id: runId, started_at: new Date(Number(env.INBOX_LANE_STARTED_MS || Date.now())).toISOString(), completed_at: new Date().toISOString(),
  clean_tree: { start: true, end_excluding_run_dir: true, excluded_path: relative, end_status: endStatus }, artifacts,
  runner_script_sha256: hash(path.join(repo, 'scripts/inbox-ci/drift-replay.sh')),
  workflow_path: '.github/workflows/inbox-heavy-verification.yml', workflow_input_sha: sha, github_run_id: runId, github_run_attempt: attempt,
  artifact_name: `heavy-drift-replay-${sha}-${runId}-${attempt}`, event: env.GITHUB_EVENT_NAME, head_branch: env.GITHUB_REF_NAME, lane: 'drift-replay',
  summary: { replayed_items: Array.isArray(record.items) ? record.items.length : 0, drift_record_sha256: record.sha256, j5a: "TEST matched the disposable baseline except eight pre-existing items not in any migration, listed here. They are recorded and replayed, not explained; owners unknown. Production's drift is not yet observed." },
});
