#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = 'docs/performance/inbox-redesign/evidence';
const REF = 'ncsngxlcyxylaeskiteu';
const HEX = /^[0-9a-f]{64}$/;
const CATALOG_SECTIONS = new Set(['created_objects_present', 'extensions', 'functions', 'index_names', 'relations', 'schema_migrations', 'schemas', 'trigger_names', 'types']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (repo, ...args) => execFileSync('git', args, { cwd: repo });
function keys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) throw new Error(`Unexpected ${label} fields`);
}
const forbidden = new Set(['access_token', 'refresh_token', 'apikey', 'service_role', 'sections', 'content']);
function inspect(value) {
  if (Array.isArray(value)) return value.forEach(inspect);
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key.toLowerCase())) throw new Error(`Forbidden key ${key}`);
    inspect(child);
  }
}
function record(repo, sha, directory, kind, phase, artifact, ref) {
  if (!new RegExp(`^${ROOT}/${sha}/pre-merge/[A-Za-z0-9_-]+$`).test(directory)) throw new Error('Input record path mismatch');
  const manifest = JSON.parse(git(repo, 'show', `${ref}:${directory}/manifest.json`));
  if (manifest.tested_sha !== sha || manifest.tier !== 'pre-merge' || manifest.kind !== kind || manifest.phase !== phase || manifest.target !== 'disposable' || manifest.verdict !== 'PASS' || manifest.exit_status !== 0) throw new Error('Input record identity mismatch');
  const bytes = git(repo, 'show', `${ref}:${directory}/${artifact}`);
  const digest = hash(bytes);
  if (manifest.artifacts?.[artifact] !== digest) throw new Error('Input artifact hash mismatch');
  return { directory, artifact, sha256: digest, data: JSON.parse(bytes) };
}
export function sealSharedReadonly({ repo, sha, phase, output, catalogRecord, platformRecord, inputSha = sha, inputRef = 'HEAD', now = new Date() }) {
  if (!/^[0-9a-f]{40}$/.test(sha) || phase !== 'pre') throw new Error('Invalid SHA or phase: only pre is supported');
  if (!/^[0-9a-f]{40}$/.test(inputSha) || inputSha !== sha || inputRef !== 'HEAD') throw new Error('Invalid input evidence reference');
  try { git(repo, 'merge-base', '--is-ancestor', sha, 'HEAD'); }
  catch { throw new Error('Input SHA is not ancestor'); }
  if (git(repo, 'status', '--porcelain', '--untracked-files=all').toString().trim()) throw new Error('Evidence worktree must start clean');
  const catalog = record(repo, inputSha, catalogRecord, 'catalog-fingerprint', 'n/a', 'catalog-pre.json', inputRef);
  const platform = record(repo, inputSha, platformRecord, 'db-contract', 'pre', 'platform-config.json', inputRef);
  const source = JSON.parse(readFileSync(output));
  inspect(source);
  if (source.target !== 'shared-readonly' || source.phase !== phase || source.verdict !== 'PASS') throw new Error('Readonly output identity mismatch');
  keys(source.comparisons, ['catalog', 'platform'], 'comparison');
  keys(source.comparisons.catalog, ['verdict', 'input_sha256', 'observed_section_sha256'], 'catalog comparison');
  keys(source.comparisons.platform, ['verdict', 'input_sha256', 'observed_sha256'], 'platform comparison');
  keys(source.platform_config, ['postgres_major', 'postgrest_major', 'gotrue_major', 'sha256'], 'platform config');
  keys(source.items ?? {}, source.items?.queued_invariants ? ['queued_invariants'] : [], 'items');
  if (source.comparisons?.catalog?.verdict !== 'PASS' || source.comparisons.catalog.input_sha256 !== catalog.sha256 || source.comparisons?.platform?.verdict !== 'PASS' || source.comparisons.platform.input_sha256 !== platform.sha256) throw new Error('Comparison input linkage mismatch');
  const expectedSections = catalog.data.section_sha256;
  const observedSections = source.comparisons.catalog.observed_section_sha256;
  if (!expectedSections || typeof expectedSections !== 'object' || Array.isArray(expectedSections) ||
      !observedSections || typeof observedSections !== 'object' || Array.isArray(observedSections) ||
      !Object.keys(expectedSections).length || Object.keys(expectedSections).some(k => !CATALOG_SECTIONS.has(k)) ||
      Object.keys(expectedSections).sort().join() !== Object.keys(observedSections).sort().join() ||
      Object.keys(expectedSections).some(k => !HEX.test(expectedSections[k]) || observedSections[k] !== expectedSections[k])) throw new Error('Catalog comparison mismatch');
  if (!HEX.test(source.comparisons.platform.observed_sha256)) throw new Error('Platform comparison digest missing');
  const platformKeys = ['postgres_major', 'postgrest_major', 'gotrue_major'];
  keys(platform.data, platformKeys, 'consumed platform');
  if (platformKeys.some(k => !/^[0-9]+$/.test(platform.data[k]) || platform.data[k] !== source.platform_config[k])) throw new Error('Platform comparison mismatch');
  const observedPlatform = Object.fromEntries(platformKeys.map(key => [key, source.platform_config[key]]));
  if (source.platform_config.sha256 !== hash(JSON.stringify(observedPlatform)) || source.comparisons.platform.observed_sha256 !== source.platform_config.sha256) throw new Error('Observed platform digest mismatch');
  const runId = `shared-readonly-${phase}-${now.toISOString().replace(/[-:.]/g, '').replace('Z', 'Z')}`;
  const relative = `${ROOT}/${sha}/pre-merge/${runId}`;
  const absolute = path.join(repo, relative);
  const readonly = { verdict: source.verdict, target: 'shared-test', phase, comparisons: { catalog: { verdict: 'PASS', input_sha256: catalog.sha256, observed_section_sha256: observedSections }, platform: { verdict: 'PASS', input_sha256: platform.sha256, observed_sha256: source.comparisons.platform.observed_sha256 } }, items: {} };
  const queued = source.items?.queued_invariants;
  if (queued) {
    if (typeof queued !== 'object' || Array.isArray(queued) || Object.keys(queued).some(key => !['verdict', 'diff', 'stability_probe'].includes(key)) ||
        !['PASS', 'INCONCLUSIVE'].includes(queued.verdict) ||
        (Object.hasOwn(queued, 'stability_probe') && queued.stability_probe !== 'identical')) throw new Error('Invalid queued invariants');
  }
  if (queued) readonly.items.queued_invariants = { verdict: queued.verdict, ...(queued.diff ? { diff: hash(Buffer.from(JSON.stringify(queued.diff))) } : {}), ...(queued.stability_probe ? { stability_probe: queued.stability_probe } : {}) };
  inspect(readonly);
  const bytes = Buffer.from(JSON.stringify(readonly, null, 2) + '\n');
  const scripts = ['scripts/inbox-ci/seal-shared-readonly.mjs', 'scripts/outbox-db-contract-readonly.mjs'];
  const operator_script_sha256 = Object.fromEntries(scripts.map(script => [script, hash(git(repo, 'show', `${sha}:${script}`))]));
  if (scripts.some(script => operator_script_sha256[script] !== hash(readFileSync(path.join(repo, script))))) throw new Error('Operator script differs from tested SHA');
  const manifest = { tested_sha: sha, tier: 'pre-merge', kind: 'shared-readonly', phase, target: 'shared-test', verdict: source.verdict, exit_status: 0, run_id: runId, started_at: now.toISOString(), completed_at: now.toISOString(), clean_tree: { start: true, end_excluding_run_dir: true, excluded_path: relative }, artifacts: { 'readonly.json': hash(bytes) }, target_binding: { project_ref: REF, pooler_user: `postgres.${REF}` }, inputs: { catalog_record: { directory: catalog.directory, artifact: catalog.artifact, sha256: catalog.sha256 }, platform_record: { directory: platform.directory, artifact: platform.artifact, sha256: platform.sha256 } }, operator_script_sha256, event: 'operator', workflow_path: '', github_run_id: '', github_run_attempt: '', items: readonly.items };
  mkdirSync(path.dirname(absolute), { recursive: true });
  mkdirSync(absolute, { recursive: false });
  writeFileSync(path.join(absolute, 'readonly.json'), bytes, { flag: 'wx' });
  writeFileSync(path.join(absolute, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return relative;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, item, i, all) => { if (i % 2 === 0) pairs.push([item, all[i + 1]]); return pairs; }, []));
    const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
    console.log(sealSharedReadonly({ repo, sha: args['--sha'], phase: args['--phase'], output: args['--output'], catalogRecord: args['--catalog-record'], platformRecord: args['--platform-record'], inputSha: args['--input-sha'], inputRef: args['--input-ref'] }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
