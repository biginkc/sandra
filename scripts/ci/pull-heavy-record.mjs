import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hasExactKeys } from '../outbox-db-contract/catalog-sections.mjs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = 'docs/performance/inbox-redesign/evidence';
const WORKFLOW = '.github/workflows/inbox-heavy-verification.yml';
const LANES = Object.freeze({
  'outbox-pre': ['browser', 'pre'], 'outbox-post': ['browser', 'post'],
  'db-contract-pre': ['db-contract', 'pre'], 'db-contract-post': ['db-contract', 'post'],
  'migration-dry-run': ['migration-dry-run', 'n/a'], 'catalog-fingerprint': ['catalog-fingerprint', 'n/a'], 'drift-replay': ['drift-replay', 'n/a'],
  burst: ['burst', 'n/a'], 'perf-120k': ['perf-120k', 'n/a'],
});
const MAX_RUN = 40 * 1024 * 1024;
const MAX_COMMIT = 120 * 1024 * 1024;
const HEX = /^[a-f0-9]{40}$/;
const SHA256 = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (repo, ...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' }).trim();
const forbiddenName = name => /(^|\/)(?:session[^/]*\.json|[^/]*\.env|[^/]*token[^/]*|[^/]*\.pem)(?:\.gz)?$/i.test(name);
const forbiddenKeys = new Set(['access_token', 'refresh_token', 'apikey', 'service_role']);
function inspectJson(value) {
  if (Array.isArray(value)) return value.forEach(inspectJson);
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key.toLowerCase())) throw new Error(`Forbidden JSON key: ${key}`);
    inspectJson(child);
  }
}
function filesUnder(root) {
  const result = [];
  function visit(dir) {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const mode = lstatSync(full);
      if (mode.isSymbolicLink() || (!mode.isDirectory() && !mode.isFile())) throw new Error(`Unsafe artifact: ${full}`);
      if (mode.isDirectory()) visit(full); else result.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
  visit(root);
  return result.sort();
}
export function verifyDownload(repo, root, run, artifact, expectedSha) {
  if (!HEX.test(expectedSha) || run.status !== 'completed' || run.event !== 'workflow_dispatch' || run.head_branch !== 'main' || run.path !== WORKFLOW) throw new Error('Run provenance mismatch');
  if (!HEX.test(run.head_sha ?? '') || SHA256(execFileSync('git', ['show', `${run.head_sha}:${WORKFLOW}`], { cwd: repo })) !== SHA256(execFileSync('git', ['show', `${expectedSha}:${WORKFLOW}`], { cwd: repo }))) throw new Error('Workflow definition hash mismatch');
  const attempt = String(run.run_attempt);
  const id = String(run.id);
  if (!artifact.name.endsWith(`-${id}-${attempt}`) || artifact.expired || !artifact.size_in_bytes) throw new Error('Artifact attempt mismatch or incomplete artifact');
  const paths = filesUnder(root);
  const prefix = `${ROOT}/${expectedSha}/pre-merge/${id}/`;
  if (!paths.length || paths.some(p => !p.startsWith(prefix) || forbiddenName(p))) throw new Error('Artifact path or sensitive filename refused');
  const dir = path.join(root, prefix);
  const total = paths.reduce((sum, p) => sum + statSync(path.join(root, p)).size, 0);
  if (total > MAX_RUN || total > MAX_COMMIT) throw new Error('Evidence exceeds 40 MiB run cap');
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  inspectJson(manifest);
  if ('external_artifacts' in manifest) throw new Error('External artifacts forbidden');
  if (manifest.tested_sha !== expectedSha || manifest.tier !== 'pre-merge' || manifest.run_id !== id || !Number.isInteger(manifest.exit_status) || !['PASS', 'FAIL', 'INCONCLUSIVE'].includes(manifest.verdict)) throw new Error('Manifest identity or verdict mismatch');
  if (run.conclusion !== 'success' && (manifest.verdict === 'PASS' || manifest.exit_status === 0)) throw new Error('Manifest contradicts workflow conclusion');
  if (run.display_title !== `Inbox heavy ${manifest.lane} ${expectedSha}` || artifact.name !== `heavy-${manifest.lane}-${expectedSha}-${id}-${attempt}` || manifest.artifact_name !== artifact.name) throw new Error('Dispatch title/artifact identity mismatch');
  if (manifest.github_run_id !== id || String(manifest.github_run_attempt) !== attempt || manifest.event !== run.event || manifest.head_branch !== run.head_branch || manifest.workflow_path !== WORKFLOW || manifest.workflow_input_sha !== expectedSha) throw new Error('Manifest provenance or attempt mismatch');
  if (LANES[manifest.lane]?.[0] !== manifest.kind || LANES[manifest.lane]?.[1] !== manifest.phase || manifest.target !== 'disposable' || manifest.runner_script_sha256 !== SHA256(execFileSync('git', ['show', `${expectedSha}:scripts/inbox-ci/${manifest.lane}.sh`], { cwd: repo })) || (manifest.kind === 'browser' && manifest.fault_proxy_script_sha256 !== SHA256(execFileSync('git', ['show', `${expectedSha}:e2e/inbox-acceptance/fault-proxy.mjs`], { cwd: repo })))) throw new Error('Runner/proxy script hash mismatch');
  const actual = paths.filter(p => p !== `${prefix}manifest.json`).map(p => p.slice(prefix.length));
  if (!hasExactKeys(manifest.artifacts, actual, digest => typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest))) throw new Error('Incomplete artifact inventory');
  for (const relative of actual) {
    if (!/\.(?:json|log|txt|html|png|csv|gz|md)$/i.test(relative) || forbiddenName(relative)) throw new Error('Forbidden artifact file');
    const bytes = readFileSync(path.join(dir, relative));
    if (SHA256(bytes) !== manifest.artifacts[relative]) throw new Error(`Artifact hash mismatch: ${relative}`);
    if (relative.endsWith('.gz')) {
      const inflated = gunzipSync(bytes, { maxOutputLength: MAX_RUN });
      const original = relative.slice(0, -3);
      if (manifest.raw_inflated_sha256?.[original] !== SHA256(inflated)) throw new Error(`Inflated artifact hash mismatch: ${relative}`);
      if (original.endsWith('.json')) inspectJson(JSON.parse(inflated));
    } else if (relative.endsWith('.json')) inspectJson(JSON.parse(bytes));
  }
  if (new Date(manifest.completed_at).toString() === 'Invalid Date') throw new Error('Invalid completion time');
  const validator = path.resolve(fileURLToPath(new URL('../../experiments/inbox-release/sealed_evidence.py', import.meta.url)));
  const python = `import sys; from pathlib import Path; sys.path.insert(0, str(Path(sys.argv[1]).parent)); from sealed_evidence import validate_downloaded_manifest; validate_downloaded_manifest(Path(sys.argv[2]), sys.argv[3], set(sys.argv[5:]), sys.argv[4])`;
  execFileSync('python3', ['-c', python, validator, root, prefix.slice(0, -1), expectedSha, ...paths], { stdio: 'pipe' });
  return { prefix: prefix.slice(0, -1), manifest, bytes: total };
}
export function seal(repo, source, verified, branch) {
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith('-') || branch.includes('..')) throw new Error('Unsafe branch name');
  const tested = verified.manifest.tested_sha;
  let base, existing = true;
  try { base = git(repo, 'rev-parse', `refs/heads/${branch}`); }
  catch {
    existing = false; base = tested;
    if (git(repo, 'ls-remote', '--heads', 'origin', branch)) throw new Error('Remote branch exists but local branch is missing');
  }
  if (git(repo, 'merge-base', tested, base) !== tested) throw new Error('Evidence branch is not based on tested SHA');
  const priorManifests = git(repo, 'ls-tree', '-r', '--name-only', base, '--', `${ROOT}/${tested}/pre-merge`).split('\n').filter(p => p.endsWith('/manifest.json'));
  for (const manifestPath of priorManifests) {
    const prior = JSON.parse(git(repo, 'show', `${base}:${manifestPath}`));
    if (new Date(prior.completed_at) > new Date(verified.manifest.completed_at)) throw new Error('Non-monotonic evidence completion time');
  }
  const prior = git(repo, 'rev-list', '--reverse', `${tested}..${base}`).split('\n').filter(Boolean);
  if (prior.some(commit => git(repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', `${commit}^`, commit).split('\n').some(file => file && !file.startsWith(`${ROOT}/${tested}/`)))) throw new Error('Branch contains non-evidence commits after tested SHA');
  const scratch = mkdtempSync(path.join(tmpdir(), 'sandra-heavy-seal-'));
  try {
    git(repo, 'worktree', 'add', '--detach', scratch, base);
    cpSync(path.join(source, verified.prefix), path.join(scratch, verified.prefix), { recursive: true, errorOnExist: true, force: false });
    const changed = git(scratch, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean);
    if (!changed.length || changed.some(line => !line.slice(3).startsWith(`${verified.prefix}/`))) throw new Error('Evidence-only commit check failed');
    git(scratch, 'add', '--', verified.prefix);
    git(scratch, 'commit', '-m', `Seal heavy evidence ${verified.manifest.github_run_id}`, '-m', 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>');
    const sealed = git(scratch, 'rev-parse', 'HEAD');
    if (git(scratch, 'rev-list', '--parents', '-n', '1', sealed).split(' ').length !== 2) throw new Error('Evidence commit must have one parent');
    git(scratch, 'push', 'origin', `${sealed}:refs/heads/${branch}`, ...(existing ? [`--force-with-lease=refs/heads/${branch}:${base}`] : []));
    git(repo, 'update-ref', `refs/heads/${branch}`, sealed, ...(existing ? [base] : []));
    return sealed;
  } finally { try { git(repo, 'worktree', 'remove', '--force', scratch); } catch {} rmSync(scratch, { recursive: true, force: true }); }
}
async function main() {
  const [runId, sha, branch] = process.argv.slice(2);
  if (!/^\d+$/.test(runId) || !HEX.test(sha) || !branch) throw new Error('Usage: pull-heavy-record.mjs <run-id> <sha> <evidence-branch>');
  const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const run = JSON.parse(gh('api', `repos/biginkc/sandra/actions/runs/${runId}`));
  if (!HEX.test(run.head_sha ?? '')) throw new Error('Invalid workflow head SHA');
  try { git(repo, 'cat-file', '-e', `${run.head_sha}^{commit}`); } catch { git(repo, 'fetch', 'origin', run.head_sha); }
  const listing = JSON.parse(gh('api', `repos/biginkc/sandra/actions/runs/${runId}/artifacts`));
  const artifact = listing.artifacts?.find(a => a.name.endsWith(`-${runId}-${run.run_attempt}`));
  if (!artifact) throw new Error('Artifact for exact attempt missing');
  const download = mkdtempSync(path.join(tmpdir(), 'sandra-heavy-download-'));
  try {
    gh('run', 'download', runId, '-R', 'biginkc/sandra', '-n', artifact.name, '-D', path.join(download, ROOT));
    const verified = verifyDownload(repo, download, run, artifact, sha);
    console.log(seal(repo, download, verified, branch));
  } finally { rmSync(download, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
