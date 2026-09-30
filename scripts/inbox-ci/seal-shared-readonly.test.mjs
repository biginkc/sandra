import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { catalogFingerprint, reconstructCatalog, sealSharedReadonly } from './seal-shared-readonly.mjs';
import { CATALOG_SECTIONS } from '../outbox-db-contract/catalog-sections.mjs';
import { NOT_VERIFIED, platformDigest, platformFingerprint } from '../outbox-db-contract/platform.mjs';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
const hostedSummary = reason => `Auth health returned 200 with the publishable key; GoTrue major matched. Our publishable-key PostgREST request was rejected. PostgREST major was NOT_VERIFIED: ${reason === 'NAME_UNVERSIONED' ? 'the connection name carried no version' : reason === 'MIXED_NAMES' ? 'some connections carried a matching version and others none (MIXED_NAMES)' : 'no PostgREST connection was visible, which does not prove none existed'}. On TEST the name carries no version, so this check is waived there in practice; Production is expected to be the same. Connection names are diagnostic labels, not attestations. Release may proceed with hosted PostgREST compatibility unverified. Hosted app/SSR/PostgREST behaviour is inferred from same-SHA disposable runs plus catalog and claim-plumbing equality, which cannot establish hosted runtime/configuration equality; a GoTrue major match does not prove identical hosted claim configuration.`;
function waive(f, reason = 'NO_CONNECTION', observed = null) {
  f.source.platform_config.postgrest_major = NOT_VERIFIED;
  f.source.platform_config.postgrest_reason = reason;
  f.source.platform_config.postgrest_observed_major = observed;
  f.source.platform_config.sha256 = platformDigest(f.source.platform_config);
  f.source.summary = hostedSummary(reason);
  f.source.comparisons.platform.verdict = { postgres_major: 'PASS', postgrest_major: NOT_VERIFIED, gotrue_major: 'PASS' };
  f.source.comparisons.platform.waived_fields = ['postgrest_major'];
  f.source.comparisons.platform.waiver_reasons = { postgrest_major: reason };
  f.source.comparisons.platform.observed_sha256 = f.source.platform_config.sha256;
}
const git = (repo, ...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
async function producerPlatform() {
  return platformFingerprint('https://example.invalid', 'anon', '17', async url => url.endsWith('/rest/v1/')
    ? new Response('', { status: 200, headers: { 'x-postgrest-version': 'PostgREST/12.2.0' } })
    : new Response(JSON.stringify({ version: '2.151.0' }), { status: 200 }), { postgrestMajor: '12' });
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
  const rawSections = Object.fromEntries(CATALOG_SECTIONS.map(section => [section, []]));
  const sections = Object.fromEntries(CATALOG_SECTIONS.slice().sort().map(section => [section, digest(Buffer.from(stable(rawSections[section])))]));
  const catalog = { catalog_format_version: 2, sections: rawSections, section_sha256: sections, sha256: digest(Buffer.from(stable({catalog_format_version:2,section_sha256:sections}))) };
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
  const driftPayload = { record_version: 1, target_ref: 'ncsngxlcyxylaeskiteu', candidate_sha: sha, baseline_digest: catalog.sha256, catalog_format_version: 2, items: [] };
  const drift = { ...driftPayload, sha256: digest(Buffer.from(stable(driftPayload))) };
  const driftRecord = input('drift', 'drift-replay', 'n/a', 'drift-record.json', drift);
  const output = path.join(os.tmpdir(), `shared-output-${sha}.json`);
  const plans = Object.fromEntries(['privileged','member'].map(role => [role, Object.fromEntries(['first','keyset','null_tail'].map(shape => [shape,{sha256:'a'.repeat(64),messages_scan:'Seq Scan',total_cost:10}]))]));
  const source = { verdict: 'PASS', target: 'shared-readonly', phase: 'pre', summary: 'Auth health returned 200 with the publishable key; GoTrue major matched. Our publishable-key PostgREST request was rejected. PostgREST major was observed from its connection name and matched. On TEST the name carries no version, so this check is waived there in practice; Production is expected to be the same. Connection names are diagnostic labels, not attestations. Release may proceed with hosted PostgREST compatibility unverified. Hosted app/SSR/PostgREST behaviour is inferred from same-SHA disposable runs plus catalog and claim-plumbing equality, which cannot establish hosted runtime/configuration equality; a GoTrue major match does not prove identical hosted claim configuration.', plans, tls:{protocol:'TLSv1.3',cipher:'test',leaf_fingerprint:'AA:'.repeat(31)+'AA',pinned_ca_fingerprint:'80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA',root_in_peer_chain:false,upstream_hop_ssl:{ssl:false,version:null,cipher:null}}, catalog_indexes:{}, items: {}, platform_config: platform, comparisons: { catalog: { verdict: 'PASS', input_sha256: digest(Buffer.from(JSON.stringify(catalog))), observed_section_sha256: sections, observed_catalog_sha256: catalog.sha256, drift_record_sha256: drift.sha256 }, platform: { verdict: 'PASS', waived_fields: [], waiver_reasons: {}, input_sha256: digest(Buffer.from(JSON.stringify(platform))), observed_sha256: platform.sha256 } } };
  const args = { repo, sha, phase: 'pre', output, catalogRecord, platformRecord, driftRecord };
  const save = () => writeFileSync(output, JSON.stringify(source)); save();
  return { args, source, save, repo, root, catalog, drift };
}
function driftHarness() {
  const sections = Object.fromEntries(CATALOG_SECTIONS.map(section => [section, []]));
  sections.relations = [
    { identity: 'public.message_threads', owner: 'postgres', columns: [{ name: 'existing', type: 'uuid', not_null: false, default: null, acl: null, attgenerated: '', attidentity: '' }], indexes: [], constraints: [], triggers: [], policies: [] },
    { identity: 'auth.users', owner: 'supabase_auth_admin', columns: [], indexes: [], constraints: [], triggers: [], policies: [] },
    { identity: 'inbox_parent.work', owner: 'postgres', columns: [], indexes: [], constraints: [], triggers: [], policies: [] },
  ];
  const baseline = catalogFingerprint(sections);
  const column = (object = 'public.message_threads', name = 'new_column') => ({ object, attribute: 'columns', name, canonical_definition: 'uuid', classification: { class: 'column', nullable: true, default: null, attidentity: '', attgenerated: '', column_acl: null, owner: 'postgres' }, origin: 'unknown', approval_sha256: null });
  const index = (name = 'idx_new', overrides = {}) => ({ object: 'public.message_threads', attribute: 'indexes', name, canonical_definition: `CREATE INDEX ${name} ON public.message_threads USING btree (existing)`, classification: { class: 'index', unique: false, primary: false, constraint: false, valid: true, ready: true, live: true, predicate: null, expression: false, owner: 'postgres', ...overrides }, origin: 'unknown', approval_sha256: null });
  const record = (items = [column()]) => {
    const payload = { record_version: 1, target_ref: 'ncsngxlcyxylaeskiteu', candidate_sha: 'a'.repeat(40), baseline_digest: baseline.sha256, catalog_format_version: 2, items };
    return { ...payload, sha256: digest(Buffer.from(stable(payload))) };
  };
  return { baseline, column, index, record };
}
test('sealer mutation matrix rejects every catalog-drift guard', () => {
  const h = driftHarness();
  const valid = h.record();
  const observed = reconstructCatalog(h.baseline, valid);
  const reject = (label, mutate) => {
    const record = JSON.parse(JSON.stringify(valid));
    mutate(record);
    record.sha256 = digest(Buffer.from(stable(Object.fromEntries(['record_version','target_ref','candidate_sha','baseline_digest','catalog_format_version','items'].map(key => [key, record[key]])))));
    assert.throws(() => reconstructCatalog(h.baseline, record, { targetRef: 'ncsngxlcyxylaeskiteu', candidateSha: 'a'.repeat(40) }), /Drift record|Catalog baseline/, label);
  };
  for (const [label, mutate] of [
    ['duplicate entry', record => { record.items.push(JSON.parse(JSON.stringify(record.items[0]))); }],
    ['baseline override', record => { record.items[0].name = 'existing'; }],
    ['default column', record => { record.items[0].classification.default = 'now()'; }],
    ['identity column', record => { record.items[0].classification.attidentity = 'd'; }],
    ['generated column', record => { record.items[0].classification.attgenerated = 's'; }],
    ['column ACL', record => { record.items[0].classification.column_acl = '{postgres=r}'; }],
    ['unknown class', record => { record.items[0].attribute = 'triggers'; }],
    ['malformed canonical definition', record => { record.items[0].canonical_definition = ''; }],
    ['section-level entry', record => { record.items[0].object = 'sections'; }],
    ['attribute-level entry', record => { record.items[0].attribute = 'relations'; }],
    ['wrong ref', record => { record.target_ref = 'wrong'; }],
    ['wrong SHA', record => { record.candidate_sha = 'b'.repeat(40); }],
    ['wrong baseline digest', record => { record.baseline_digest = 'c'.repeat(64); }],
    ['wrong format', record => { record.catalog_format_version = 3; }],
    ['mislabelled origin', record => { record.items[0].origin = 'platform'; }],
    ['rowtype-table item', record => { record.items[0].object = 'inbox_parent.work'; record.items[0].classification.owner = 'postgres'; }],
    ['operator-index name collision', record => { record.items = [h.index('inbox_parent_message_property')]; }],
    ['unique index', record => { record.items = [h.index('idx_unique', { unique: true })]; }],
    ['invalid index', record => { record.items = [h.index('idx_invalid', { valid: false })]; }],
    ['unready index', record => { record.items = [h.index('idx_unready', { ready: false })]; }],
    ['non-live index', record => { record.items = [h.index('idx_dead', { live: false })]; }],
    ['unapproved predicate', record => { record.items = [h.index('idx_bad_predicate', { predicate: '(existing IS NOT NULL)' })]; }],
    ['expression-only index', record => { record.items = [h.index('idx_bad_expression', { expression: true })]; }],
    ['approval digest mismatch', record => { record.items = [h.index('idx_message_threads_ai_responder_status', { predicate: '(ai_responder_status IS NOT NULL)' })]; record.items[0].approval_sha256 = 'd'.repeat(64); }],
    ['constraint-backed index', record => { record.items = [h.index('idx_constraint', { constraint: true })]; }],
  ]) reject(label, mutate);
  const missingBaseline = JSON.parse(JSON.stringify(h.baseline));
  missingBaseline.sections.relations[0].columns = [];
  assert.throws(() => reconstructCatalog(missingBaseline, valid), /Catalog baseline digest/, 'missing baseline column');
  const stale = h.record(); stale.items[0].canonical_definition = 'text'; stale.sha256 = digest(Buffer.from(stable(Object.fromEntries(['record_version','target_ref','candidate_sha','baseline_digest','catalog_format_version','items'].map(key => [key, stale[key]])))));
  assert.notEqual(reconstructCatalog(h.baseline, stale).sha256, observed.sha256, 'stale or changed item');
  const extra = h.record([h.column(), h.index()]);
  assert.notEqual(reconstructCatalog(h.baseline, extra).sha256, observed.sha256, 'unrecorded extra');
  const post = reconstructCatalog(h.baseline, valid);
  const substituted = h.record(); substituted.baseline_digest = post.sha256;
  substituted.sha256 = digest(Buffer.from(stable(Object.fromEntries(['record_version','target_ref','candidate_sha','baseline_digest','catalog_format_version','items'].map(key => [key, substituted[key]])))));
  assert.throws(() => reconstructCatalog(h.baseline, substituted), /Drift record binding|digest/, 'PRE/POST record substitution');
  const postCollision = h.record(); postCollision.baseline_digest = post.sha256;
  postCollision.sha256 = digest(Buffer.from(stable(Object.fromEntries(['record_version','target_ref','candidate_sha','baseline_digest','catalog_format_version','items'].map(key => [key, postCollision[key]])))));
  assert.throws(() => reconstructCatalog(post, postCollision), /baseline collision/, 'POST collision');
});
test('seals only digest representation linked to committed inputs', async () => {
  const f = await fixture(); const dir = sealSharedReadonly(f.args);
  const output = JSON.parse(readFileSync(path.join(f.repo, dir, 'readonly.json')));
  assert.deepEqual(Object.keys(output).sort(), ['catalog_indexes_sha256','comparisons', 'items', 'phase', 'plans', 'platform_config', 'source_output_sha256', 'summary', 'target', 'tls', 'verdict']);
  assert.equal(JSON.stringify(output).includes('platform_config'), true);
});
test('sealer records a PostgREST NOT_VERIFIED waiver and covers it in the digest', async () => {
  const f = await fixture();
  waive(f);
  f.save();
  const dir = sealSharedReadonly(f.args);
  const manifest = JSON.parse(readFileSync(path.join(f.repo, dir, 'manifest.json')));
  assert.deepEqual(manifest.waived_fields, ['postgrest_major']);
});
test('sealer rejects a NOT_VERIFIED disposable baseline', async () => {
  const f = await fixture();
  const file = path.join(f.repo, f.args.platformRecord, 'platform-config.json');
  const baseline = JSON.parse(readFileSync(file));
  baseline.postgrest_major = NOT_VERIFIED;
  baseline.postgrest_reason = 'NO_CONNECTION';
  baseline.postgrest_observed_major = null;
  baseline.sha256 = platformDigest(baseline);
  const bytes = Buffer.from(JSON.stringify(baseline));
  writeFileSync(file, bytes);
  const manifestFile = path.join(f.repo, f.args.platformRecord, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestFile));
  manifest.artifacts['platform-config.json'] = digest(bytes);
  writeFileSync(manifestFile, JSON.stringify(manifest));
  waive(f);
  f.source.comparisons.platform.input_sha256 = digest(bytes);
  f.save();
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'mutate baseline');
  assert.throws(() => sealSharedReadonly(f.args), /Platform comparison mismatch|Invalid consumed platform combination/);
});
test('sealer rejects a waived field with a bare PASS verdict', async () => {
  const f = await fixture();
  waive(f);
  delete f.source.comparisons.platform.verdict;
  f.save();
  assert.throws(() => sealSharedReadonly(f.args), /Platform comparison mismatch|Unexpected platform comparison fields/);
});
test('sealer rejects a recorded NOT_VERIFIED field without its waiver', async () => {
  const f = await fixture();
  waive(f);
  delete f.source.comparisons.platform.waived_fields;
  delete f.source.comparisons.platform.waiver_reasons;
  f.save();
  assert.throws(() => sealSharedReadonly(f.args), /Platform comparison mismatch|Unexpected platform comparison fields/);
});
test('sealer rejects a waived field when the recorded value matches the baseline', async () => {
  const f = await fixture();
  f.source.comparisons.platform.verdict = { postgres_major: 'PASS', postgrest_major: NOT_VERIFIED, gotrue_major: 'PASS' };
  f.source.comparisons.platform.waived_fields = ['postgrest_major'];
  f.source.comparisons.platform.waiver_reasons = { postgrest_major: 'NAME_UNVERSIONED' };
  f.save();
  assert.throws(() => sealSharedReadonly(f.args), /Platform comparison mismatch|Platform waiver reason mismatch/);
});
test('sealer rejects a waiver-shaped but non-exact PostgREST value', async () => {
  const f = await fixture();
  f.source.platform_config.postgrest_major = 'unknown';
  f.source.platform_config.sha256 = platformDigest(f.source.platform_config);
  f.source.comparisons.platform.observed_sha256 = f.source.platform_config.sha256;
  f.save();
  assert.throws(() => sealSharedReadonly(f.args), /Platform comparison mismatch|Invalid observed platform combination/);
});
test('sealer rejects a mismatching MIXED_NAMES observed major hidden behind NOT_VERIFIED', async () => {
  const f = await fixture();
  waive(f, 'MIXED_NAMES', '13');
  f.save();
  assert.throws(() => sealSharedReadonly(f.args), /Platform comparison mismatch/);
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
    assert.throws(() => sealSharedReadonly(f.args), /Catalog (?:baseline format mismatch|comparison mismatch)/, omitted ?? 'extra');
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
  assert.throws(() => sealSharedReadonly(f.args), /Catalog (?:baseline format mismatch|comparison mismatch)/);
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
