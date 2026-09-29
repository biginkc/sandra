import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sealSharedReadonly } from './seal-shared-readonly.mjs';
import { CATALOG_SECTIONS } from '../outbox-db-contract/catalog-sections.mjs';
import { platformFingerprint } from '../outbox-db-contract/platform.mjs';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (repo, ...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
async function producerPlatform() {
  return platformFingerprint('https://example.invalid', 'anon', '17', async url => url.endsWith('/rest/v1/')
    ? new Response('', { status: 200, headers: { 'x-postgrest-version': 'PostgREST/12.2.0' } })
    : new Response(JSON.stringify({ version: '2.151.0' }), { status: 200 }));
}
async function fixture() {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'shared-seal-'));
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  for (const file of JSON.parse(readFileSync('scripts/inbox-ci/shared-readonly-operators.json')).operator_scripts) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); copyFileSync(file, path.join(repo, file));
  }
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  const sha = git(repo, 'rev-parse', 'HEAD');
  const root = `docs/performance/inbox-redesign/evidence/${sha}/pre-merge`;
  const sections = Object.fromEntries(CATALOG_SECTIONS.map(section => [section, 'c'.repeat(64)]));
  // catalog_fingerprint.py writes sections, section_sha256, and sha256; the sealer consumes only the digest map.
  const catalog = { sections: Object.fromEntries(CATALOG_SECTIONS.map(section => [section, []])), section_sha256: sections, sha256: digest(JSON.stringify(sections)) };
  const platform = await producerPlatform();
  function input(id, kind, phase, artifact, data) {
    const directory = `${root}/${id}`; const full = path.join(repo, directory); mkdirSync(full, { recursive: true });
    const bytes = Buffer.from(JSON.stringify(data)); writeFileSync(path.join(full, artifact), bytes);
    writeFileSync(path.join(full, 'manifest.json'), JSON.stringify({ tested_sha: sha, tier: 'pre-merge', kind, phase, target: 'disposable', verdict: 'PASS', exit_status: 0, artifacts: { [artifact]: digest(bytes) } }));
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', id);
    return directory;
  }
  const catalogRecord = input('catalog', 'catalog-fingerprint', 'n/a', 'catalog-pre.json', catalog);
  const platformRecord = input('platform', 'db-contract', 'pre', 'platform-config.json', platform);
  const output = path.join(os.tmpdir(), `shared-output-${sha}.json`);
  const plans = Object.fromEntries(['privileged','member'].map(role => [role, Object.fromEntries(['first','keyset','null_tail'].map(shape => [shape,{sha256:'a'.repeat(64),messages_scan:'Seq Scan',total_cost:10}]))]));
  const source = { verdict: 'PASS', target: 'shared-readonly', phase: 'pre', plans, tls:{ssl:true,version:'TLSv1.3',cipher:'test'}, catalog_indexes:{}, items: {}, platform_config: platform, comparisons: { catalog: { verdict: 'PASS', input_sha256: digest(JSON.stringify(catalog)), observed_section_sha256: sections }, platform: { verdict: 'PASS', input_sha256: digest(JSON.stringify(platform)), observed_sha256: platform.sha256 } } };
  const args = { repo, sha, phase: 'pre', output, catalogRecord, platformRecord };
  const save = () => writeFileSync(output, JSON.stringify(source)); save();
  return { args, source, save, repo, root };
}
test('seals only digest representation linked to committed inputs', async () => {
  const f = await fixture(); const dir = sealSharedReadonly(f.args);
  const output = JSON.parse(readFileSync(path.join(f.repo, dir, 'readonly.json')));
  assert.deepEqual(Object.keys(output).sort(), ['catalog_indexes_sha256','comparisons', 'items', 'phase', 'plans', 'source_output_sha256', 'target', 'tls', 'verdict']);
  assert.equal(JSON.stringify(output).includes('platform_config'), false);
});
test('sealer refuses an operator omitted from the working manifest', async () => {
  const f = await fixture();
  const file = path.join(f.repo, 'scripts/inbox-ci/shared-readonly-operators.json');
  const list = JSON.parse(readFileSync(file));
  list.operator_scripts.pop();
  writeFileSync(file, JSON.stringify(list));
  assert.throws(() => sealSharedReadonly(f.args), /Evidence worktree must start clean|Operator list differs from tested SHA/);
});
test('sealer refuses every missing catalog section and an extra section', async () => {
  for (const omitted of [...CATALOG_SECTIONS, null]) {
    const f = await fixture();
    const file = path.join(f.repo, f.args.catalogRecord, 'catalog-pre.json');
    const catalog = JSON.parse(readFileSync(file));
    if (omitted) delete catalog.section_sha256[omitted];
    else catalog.section_sha256.unexpected = 'c'.repeat(64);
    const bytes = Buffer.from(JSON.stringify(catalog));
    writeFileSync(file, bytes);
    const manifestFile = path.join(f.repo, f.args.catalogRecord, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile));
    manifest.artifacts['catalog-pre.json'] = digest(bytes);
    writeFileSync(manifestFile, JSON.stringify(manifest));
    git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'mutate catalog');
    f.source.comparisons.catalog.input_sha256 = digest(bytes);
    f.source.comparisons.catalog.observed_section_sha256 = catalog.section_sha256;
    f.save();
    assert.throws(() => sealSharedReadonly(f.args), /Catalog comparison mismatch/, omitted ?? 'extra');
  }
});
for (const [label, combined] of [
  ['entire joined catalog section list', { [CATALOG_SECTIONS.join(',')]: 'c'.repeat(64) }],
  ['duplicate-looking joined catalog keys', Object.fromEntries([`${CATALOG_SECTIONS[0]},${CATALOG_SECTIONS[1]}`, ...CATALOG_SECTIONS.slice(2)].map(key => [key, 'c'.repeat(64)]))],
]) test(`sealer refuses ${label}`, async () => {
  const f = await fixture();
  const file = path.join(f.repo, f.args.catalogRecord, 'catalog-pre.json');
  const catalog = JSON.parse(readFileSync(file));
  catalog.section_sha256 = combined;
  const bytes = Buffer.from(JSON.stringify(catalog));
  writeFileSync(file, bytes);
  const manifestFile = path.join(f.repo, f.args.catalogRecord, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestFile));
  manifest.artifacts['catalog-pre.json'] = digest(bytes);
  writeFileSync(manifestFile, JSON.stringify(manifest));
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'mutate catalog');
  f.source.comparisons.catalog.input_sha256 = digest(bytes);
  f.source.comparisons.catalog.observed_section_sha256 = combined;
  f.save();
  assert.throws(() => sealSharedReadonly(f.args), /Catalog comparison mismatch/);
});
test('sealer requires the producer items map', async () => {
  const f = await fixture();
  delete f.source.items;
  f.save();
  assert.throws(() => sealSharedReadonly(f.args), /Unexpected items fields/);
});
test('sealer refuses a queued item without its diff', async () => {
  const f = await fixture();
  f.source.items = { queued_invariants: { verdict: 'PASS' } };
  f.save();
  assert.throws(() => sealSharedReadonly(f.args), /Invalid queued invariants/);
});
test('sealer refuses an INCONCLUSIVE queued item with an empty diff', async () => {
  const f = await fixture();
  f.source.items = { queued_invariants: { verdict: 'INCONCLUSIVE', diff: [] } };
  f.save();
  assert.throws(() => sealSharedReadonly(f.args), /Invalid queued invariants/);
});
for (const [label, mutate] of [
  ['token key', f => { f.source.access_token = 'secret'; f.save(); }],
  ['raw sections', f => { f.source.sections = { raw: 'content' }; f.save(); }],
  ['catalog mismatch', f => { f.source.comparisons.catalog.observed_section_sha256.relations = 'f'.repeat(64); f.save(); }],
  ['platform mismatch', f => { f.source.platform_config.postgres_major = '16'; f.save(); }],
  ['three-key consumed platform', f => { f.replacePlatform(({ sha256, ...data }) => data); }],
  ['wrong consumed platform digest', f => { f.replacePlatform(data => ({ ...data, sha256: '0'.repeat(64) })); }],
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
]) test(`sealer refuses ${label}`, async () => { const f = await fixture(); f.replacePlatform = transform => { const file = path.join(f.repo, f.args.platformRecord, 'platform-config.json'); const bytes = Buffer.from(JSON.stringify(transform(JSON.parse(readFileSync(file))))); writeFileSync(file, bytes); const manifestFile = path.join(f.repo, f.args.platformRecord, 'manifest.json'); const manifest = JSON.parse(readFileSync(manifestFile)); manifest.artifacts['platform-config.json'] = digest(bytes); writeFileSync(manifestFile, JSON.stringify(manifest)); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'mutate platform'); }; assert.throws(() => { mutate(f); sealSharedReadonly(f.args); }); });
test('sealer rejects post before reading evidence', async () => {
  const f = await fixture(); f.args.phase = 'post';
  assert.throws(() => sealSharedReadonly(f.args), /only pre is supported/);
});
test('sealer reports a non-ancestor input SHA', async () => {
  const f = await fixture(); f.args.sha = 'f'.repeat(40); f.args.inputSha = f.args.sha;
  assert.throws(() => sealSharedReadonly(f.args), /Input SHA is not ancestor/);
});
