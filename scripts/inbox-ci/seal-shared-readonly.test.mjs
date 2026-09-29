import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sealSharedReadonly } from './seal-shared-readonly.mjs';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (repo, ...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
function fixture() {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'shared-seal-'));
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  for (const file of ['scripts/inbox-ci/seal-shared-readonly.mjs', 'scripts/outbox-db-contract-readonly.mjs']) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); copyFileSync(file, path.join(repo, file));
  }
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  const sha = git(repo, 'rev-parse', 'HEAD');
  const root = `docs/performance/inbox-redesign/evidence/${sha}/pre-merge`;
  const sections = { relations: 'c'.repeat(64) };
  const platform = { postgres_major: '17', postgrest_major: '12', gotrue_major: '2' };
  function input(id, kind, phase, artifact, data) {
    const directory = `${root}/${id}`; const full = path.join(repo, directory); mkdirSync(full, { recursive: true });
    const bytes = Buffer.from(JSON.stringify(data)); writeFileSync(path.join(full, artifact), bytes);
    writeFileSync(path.join(full, 'manifest.json'), JSON.stringify({ tested_sha: sha, tier: 'pre-merge', kind, phase, target: 'disposable', verdict: 'PASS', exit_status: 0, artifacts: { [artifact]: digest(bytes) } }));
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', id);
    return directory;
  }
  const catalogRecord = input('catalog', 'catalog-fingerprint', 'n/a', 'catalog-pre.json', { section_sha256: sections });
  const platformRecord = input('platform', 'db-contract', 'pre', 'platform-config.json', platform);
  const output = path.join(os.tmpdir(), `shared-output-${sha}.json`);
  const source = { verdict: 'PASS', target: 'shared-readonly', phase: 'pre', platform_config: { ...platform, sha256: digest(JSON.stringify(platform)) }, comparisons: { catalog: { verdict: 'PASS', input_sha256: digest(JSON.stringify({ section_sha256: sections })), observed_section_sha256: sections }, platform: { verdict: 'PASS', input_sha256: digest(JSON.stringify(platform)), observed_sha256: digest(JSON.stringify(platform)) } } };
  const args = { repo, sha, phase: 'pre', output, catalogRecord, platformRecord };
  const save = () => writeFileSync(output, JSON.stringify(source)); save();
  return { args, source, save, repo, root };
}
test('seals only digest representation linked to committed inputs', () => {
  const f = fixture(); const dir = sealSharedReadonly(f.args);
  const output = JSON.parse(readFileSync(path.join(f.repo, dir, 'readonly.json')));
  assert.deepEqual(Object.keys(output).sort(), ['comparisons', 'items', 'phase', 'target', 'verdict']);
  assert.equal(JSON.stringify(output).includes('platform_config'), false);
});
for (const [label, mutate] of [
  ['token key', f => { f.source.access_token = 'secret'; f.save(); }],
  ['raw sections', f => { f.source.sections = { raw: 'content' }; f.save(); }],
  ['catalog mismatch', f => { f.source.comparisons.catalog.observed_section_sha256.relations = 'f'.repeat(64); f.save(); }],
  ['platform mismatch', f => { f.source.platform_config.postgres_major = '16'; f.save(); }],
  ['consumed hash mismatch', f => { f.source.comparisons.catalog.input_sha256 = '0'.repeat(64); f.save(); }],
  ['forged platform digest', f => { f.source.comparisons.platform.observed_sha256 = '0'.repeat(64); f.source.platform_config.sha256 = '0'.repeat(64); f.save(); }],
  ['stability probe content', f => { f.source.items = { queued_invariants: { verdict: 'INCONCLUSIVE', stability_probe: { message_body: 'private' } } }; f.save(); }],
  ['unexpected comparison field', f => { f.source.comparisons.catalog.message_body = 'private'; f.save(); }],
  ['wrong phase', f => { f.args.phase = 'post'; }],
  ['INCONCLUSIVE source verdict', f => { f.source.verdict = 'INCONCLUSIVE'; f.save(); }],
  ['FAIL source verdict', f => { f.source.verdict = 'FAIL'; f.save(); }],
  ['missing input', f => { f.args.catalogRecord = `${f.root}/missing`; }],
  ['substituted input', f => { f.args.catalogRecord = f.args.platformRecord; }],
  ['non-PASS input', f => { const file = path.join(f.repo, f.args.catalogRecord, 'manifest.json'); const manifest = JSON.parse(readFileSync(file)); manifest.verdict = 'FAIL'; writeFileSync(file, JSON.stringify(manifest)); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'mutate input'); }],
  ['input hash mismatch', f => { const file = path.join(f.repo, f.args.catalogRecord, 'manifest.json'); const manifest = JSON.parse(readFileSync(file)); manifest.artifacts['catalog-pre.json'] = '0'.repeat(64); writeFileSync(file, JSON.stringify(manifest)); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'mutate hash'); }],
]) test(`sealer refuses ${label}`, () => { const f = fixture(); assert.throws(() => { mutate(f); sealSharedReadonly(f.args); }); });
test('sealer rejects post before reading evidence', () => {
  const f = fixture(); f.args.phase = 'post';
  assert.throws(() => sealSharedReadonly(f.args), /only pre is supported/);
});
test('sealer reports a non-ancestor input SHA', () => {
  const f = fixture(); f.args.sha = 'f'.repeat(40); f.args.inputSha = f.args.sha;
  assert.throws(() => sealSharedReadonly(f.args), /Input SHA is not ancestor/);
});
