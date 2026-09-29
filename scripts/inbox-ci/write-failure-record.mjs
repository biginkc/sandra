import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertOnlyRunDirDirty, runPath, writeManifest } from '../../scripts/outbox-run-record.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const env = process.env;
const status = Number(process.argv[2]);
const lane = env.HEAVY_LANE;
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const runId = env.GITHUB_RUN_ID;
const attempt = env.GITHUB_RUN_ATTEMPT ?? '1';
if (!Number.isInteger(status) || status < 1 || status > 255) throw new Error('Invalid failure status');
if (!['catalog-fingerprint', 'db-contract-pre', 'db-contract-post', 'burst', 'perf-120k', 'outbox-pre', 'outbox-post'].includes(lane)) throw new Error('Invalid failure lane');
if (env.PERF_LOCAL_EXECUTION === '1') throw new Error('Local perf diagnostic cannot seal an approval record');
if (env.HEAVY_TESTED_SHA !== sha || !/^[a-f0-9]{40}$/.test(sha) || !/^[0-9]+$/.test(runId ?? '') || !/^[0-9]+$/.test(attempt)) throw new Error('Invalid heavy run identity');
if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF_NAME !== 'main') throw new Error('Untrusted dispatch provenance');
const relative = runPath(sha, 'pre-merge', runId);
const absolute = path.join(repo, relative);
if (existsSync(path.join(absolute, 'manifest.json'))) throw new Error('Run record already sealed');
mkdirSync(absolute, { recursive: true });
writeFileSync(path.join(absolute, 'failure.log'), `lane=${lane}\nexit_status=${status}\n`);
const endStatus = assertOnlyRunDirDirty(repo, relative);
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
writeManifest(repo, relative, {
  tested_sha: sha, tier: 'pre-merge', kind: lane.startsWith('db-contract-') ? 'db-contract' : lane.startsWith('outbox-') ? 'browser' : lane,
  phase: lane === 'db-contract-pre' ? 'pre' : lane === 'db-contract-post' ? 'post' : lane === 'outbox-pre' ? 'pre' : lane === 'outbox-post' ? 'post' : 'n/a',
  target: 'disposable', verdict: 'FAIL', exit_status: status, run_id: runId,
  started_at: new Date(Number(env.INBOX_LANE_STARTED_MS || Date.now())).toISOString(), completed_at: new Date().toISOString(),
  runner_script_sha256: hash(path.join(repo, 'scripts/inbox-ci', `${lane}.sh`)),
  ...(lane.startsWith('outbox-') ? { fault_proxy_script_sha256: hash(path.join(repo, 'e2e/inbox-acceptance/fault-proxy.mjs')) } : {}),
  workflow_path: '.github/workflows/inbox-heavy-verification.yml', workflow_input_sha: sha,
  github_run_id: runId, github_run_attempt: attempt,
  artifact_name: `heavy-${lane}-${sha}-${runId}-${attempt}`,
  event: env.GITHUB_EVENT_NAME, head_branch: env.GITHUB_REF_NAME, lane,
  clean_tree: { start: true, end_excluding_run_dir: true, excluded_path: relative, end_status: endStatus },
  summary: { failure: `Lane exited with status ${status}` },
});
