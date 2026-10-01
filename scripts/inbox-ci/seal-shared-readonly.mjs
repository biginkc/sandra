#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG_SECTIONS, hasExactKeys } from '../outbox-db-contract/catalog-sections.mjs';
import { ROLES, SHAPE_NAMES } from '../outbox-db-contract/plan-contract.mjs';
import { NOT_VERIFIED, PLATFORM_FIELDS, PLATFORM_MAJOR_FIELDS, platformDigest, platformVerdict, validatePlatformCombination } from '../outbox-db-contract/platform.mjs';

const ROOT = 'docs/performance/inbox-redesign/evidence';
const REF = 'ncsngxlcyxylaeskiteu';
const DRIFT_FIXTURE_ROOT = 'experiments/inbox-production-install/drift';
const HEX = /^[0-9a-f]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (repo, ...args) => execFileSync('git', args, { cwd: repo });
const CATALOG_FORMAT_VERSION = 2;
const DRIFT_APPROVALS = { idx_message_threads_ai_responder_status: 'e419f623f1922466db14dba7aa091cdd4720924e2b97901088af2dc5719b108a', idx_users_name: '4dbc01feffae5acf04236e5aa3611151cc43e1467f84588e05b025dd9fbc7402' };
const OPERATOR_INDEX_NAMES = new Set(['inbox_parent_message_property','inbox_parent_message_contact','inbox_parent_review_property','inbox_backfill_messages','inbox_backfill_reviews','inbox_backfill_threads','inbox_backfill_thread_identity','inbox_unknown_history_page']);
export const J5A_CATALOG_DRIFT_SUMMARY = "TEST matched the disposable baseline except the pre-existing items listed in the committed TEST drift fixture, none of which is in any migration. They are recorded and replayed, not explained; owners unknown. Production's drift is not yet observed.";
const codepointCompare = (a, b) => { const left = Array.from(a, char => char.codePointAt(0)); const right = Array.from(b, char => char.codePointAt(0)); for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i]; return left.length - right.length; };
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort(codepointCompare).map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
export const catalogFingerprint = sections => { const section_sha256 = Object.fromEntries(Object.entries(sections).sort(([a],[b]) => codepointCompare(a, b)).map(([name,value]) => [name,hash(Buffer.from(stable(value)))])); return { catalog_format_version: CATALOG_FORMAT_VERSION, sections, section_sha256, sha256: hash(Buffer.from(stable({catalog_format_version:CATALOG_FORMAT_VERSION,section_sha256}))) }; };
export function deriveRowtypeTables(sources) {
  const tables = new Set(); const aliases = new Map();
  const qualified = '((?:public|auth|storage|inbox_[a-z_]+|supabase_migrations)\\.[a-z_][a-z_0-9]*)';
  for (const source of sources) {
    for (const match of source.matchAll(new RegExp('\\b([a-z_][a-z0-9_]*)\\.([a-z_][a-z0-9_]*)%rowtype\\b', 'ig'))) tables.add(`${match[1].toLowerCase()}.${match[2].toLowerCase()}`);
    for (const match of source.matchAll(new RegExp(`\\b(?:FROM|JOIN)\\s+${qualified}(?:\\s+(?:AS\\s+)?([a-z_][a-z0-9_]*))?`, 'ig'))) {
      const table = match[1].toLowerCase(); const alias = (match[2] ?? table.split('.').at(-1)).toLowerCase();
      if (!aliases.has(alias)) aliases.set(alias, new Set()); aliases.get(alias).add(table);
    }
    for (const [alias, candidates] of aliases) {
      if (new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\.\\s*\\*`, 'i').test(source)
          || new RegExp(`\\b(?:SELECT\\s+(?:DISTINCT\\s+)?\\*\\s+FROM\\s+${alias}\\b|SELECT\\s+\\(?\\s*${alias}\\s*\\)?\\s*(?:,|FROM|$)|ROW\\s*\\(\\s*${alias}\\s*\\))`, 'i').test(source)) {
        for (const table of candidates) tables.add(table);
      }
    }
  }
  return tables;
}
function reconstructCatalog(baseline, record, { targetRef = REF, candidateSha, rowtypeTables = new Set() } = {}) {
  if (baseline.catalog_format_version !== CATALOG_FORMAT_VERSION || !baseline.sections || !hasExactKeys(baseline.section_sha256, CATALOG_SECTIONS, value => HEX.test(value))) throw new Error('Catalog baseline format mismatch');
  const rebuilt = catalogFingerprint(baseline.sections);
  if (rebuilt.sha256 !== baseline.sha256 || stable(rebuilt.section_sha256) !== stable(baseline.section_sha256)) throw new Error('Catalog baseline digest mismatch');
  if (!record || record.record_version !== 1 || record.catalog_format_version !== CATALOG_FORMAT_VERSION || record.target_ref !== targetRef || record.baseline_digest !== baseline.sha256 || (candidateSha && record.candidate_sha !== candidateSha) || !/^[0-9a-f]{40}$/.test(record.candidate_sha) || !HEX.test(record.sha256)) throw new Error('Drift record binding mismatch');
  const payload = Object.fromEntries(['record_version','target_ref','candidate_sha','baseline_digest','catalog_format_version','items'].map(key => [key, record[key]]));
  if (hash(Buffer.from(stable(payload))) !== record.sha256 || !Array.isArray(record.items)) throw new Error('Drift record digest mismatch');
  const sections = JSON.parse(JSON.stringify(baseline.sections));
  const relations = Object.fromEntries(sections.relations.map(row => [row.identity,row]));
  const seen = new Set();
  const approvals = DRIFT_APPROVALS;
  for (const item of record.items) {
    if (!item || !hasExactKeys(item,['object','attribute','name','canonical_definition','definition_sha256','classification','origin','approval_sha256']) || !['columns','indexes'].includes(item.attribute) || ![item.object,item.name].every(value => typeof value === 'string' && value) || typeof item.canonical_definition !== 'string' || !item.canonical_definition || item.canonical_definition.endsWith('\n') || !HEX.test(item.definition_sha256) || hash(Buffer.from(item.canonical_definition, 'utf8')) !== item.definition_sha256) throw new Error('Drift record item mismatch');
    const identity = `${item.object}\0${item.attribute}\0${item.name}`;
    if (seen.has(identity) || !relations[item.object]) throw new Error('Drift record item collision');
    seen.add(identity);
    if (rowtypeTables.has(item.object)) throw new Error('Drift record rowtype table');
    const c = item.classification;
    if (item.attribute === 'columns') {
      if (!hasExactKeys(c,['class','nullable','default','attidentity','attgenerated','column_acl','owner']) || c.class !== 'column' || c.nullable !== true || c.default !== null || c.attidentity !== '' || c.attgenerated !== '' || c.column_acl !== null || c.owner !== relations[item.object].owner || item.approval_sha256 !== null || item.origin !== 'unknown') throw new Error('Drift record column eligibility mismatch');
    } else {
      if (!hasExactKeys(c,['class','unique','primary','constraint','valid','ready','live','predicate','expression','owner']) || c.class !== 'index' || c.unique !== false || c.primary !== false || c.constraint !== false || c.valid !== true || c.ready !== true || c.live !== true || typeof c.owner !== 'string' || !c.owner || (item.object === 'auth.users' && c.owner !== 'supabase_auth_admin') || OPERATOR_INDEX_NAMES.has(item.name)) throw new Error('Drift record index eligibility mismatch');
      const approval = c.predicate !== null || c.expression === true ? approvals[item.name] : null;
      if ((c.predicate !== null || c.expression === true) && !approval || item.approval_sha256 !== approval) throw new Error('Drift record approval mismatch');
      if (approval && hash(Buffer.from(item.canonical_definition, 'utf8')) !== approval) throw new Error('Drift record approval mismatch');
      if (item.origin !== (item.object === 'auth.users' ? 'platform' : 'unknown') || c.owner !== relations[item.object].owner || (item.object === 'auth.users' && c.owner !== 'supabase_auth_admin')) throw new Error('Drift record origin mismatch');
    }
    const bucket = relations[item.object][item.attribute];
    if (bucket.some(entry => entry.name === item.name)) throw new Error('Drift record baseline collision');
    if (item.attribute === 'columns') bucket.push({name:item.name,type:item.canonical_definition,not_null:!c.nullable,default:c.default,acl:c.column_acl,attgenerated:c.attgenerated,attidentity:c.attidentity});
    else bucket.push({name:item.name,definition:item.canonical_definition,unique:c.unique,primary:c.primary,constraint:c.constraint,valid:c.valid,ready:c.ready,live:c.live,predicate:c.predicate,expression:c.expression,owner:c.owner});
    bucket.sort((a,b) => codepointCompare(item.attribute === 'columns' ? a.name : a.definition, item.attribute === 'columns' ? b.name : b.definition));
  }
  return catalogFingerprint(sections);
}
export { reconstructCatalog };
function keys(value, expected, label) {
  if (!hasExactKeys(value, expected)) throw new Error(`Unexpected ${label} fields`);
}
const forbidden = new Set(['access_token', 'refresh_token', 'apikey', 'service_role', 'sections', 'content']);
function inspect(value) {
  if (Array.isArray(value)) return value.forEach(inspect);
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key.toLowerCase())) throw new Error(`Forbidden key ${key}`);
    inspect(child);
  }
}
function platformSummary(major, reason) {
  const observed = major === NOT_VERIFIED
    ? ({ NAME_UNVERSIONED: 'NOT_VERIFIED: the connection name carried no version', MIXED_NAMES: 'NOT_VERIFIED: some connections carried a matching version and others none (MIXED_NAMES)', NO_CONNECTION: 'NOT_VERIFIED: no PostgREST connection was visible, which does not prove none existed' }[reason] ?? 'NOT_VERIFIED: invalid reason')
    : 'observed from its connection name and matched';
  return `Auth health returned 200 with the publishable key; GoTrue major matched. Our publishable-key PostgREST request was rejected. PostgREST major was ${observed}. On TEST the name carries no version, so this check is waived there in practice; Production is expected to be the same. Connection names are diagnostic labels, not attestations. Release may proceed with hosted PostgREST compatibility unverified. Hosted app/SSR/PostgREST behaviour is inferred from same-SHA disposable runs plus catalog and claim-plumbing equality, which cannot establish hosted runtime/configuration equality; a GoTrue major match does not prove identical hosted claim configuration.`;
}
function validateConsumedPlatform(value, label, requireVerified = false) {
  try { validatePlatformCombination(value, { requireVerifiedPostgrest: requireVerified }); }
  catch { throw new Error(`Invalid ${label} platform combination`); }
  if (value.sha256 !== undefined && value.sha256 !== platformDigest(value)) throw new Error(`${label} platform digest mismatch`);
}
function record(repo, sha, directory, kind, phase, artifact, ref) {
  if (!new RegExp(`^${ROOT}/${sha}/pre-merge/[A-Za-z0-9_-]+$`).test(directory)) throw new Error('Input record path mismatch');
  const manifest = JSON.parse(git(repo, 'show', `${ref}:${directory}/manifest.json`));
  if (manifest.tested_sha !== sha || manifest.tier !== 'pre-merge' || manifest.kind !== kind || manifest.phase !== phase || manifest.target !== 'disposable' || manifest.verdict !== 'PASS' || manifest.exit_status !== 0) throw new Error('Input record identity mismatch');
  const bytes = git(repo, 'show', `${ref}:${directory}/${artifact}`);
  const digest = hash(bytes);
  if (manifest.artifacts?.[artifact] !== digest) throw new Error('Input artifact hash mismatch');
  return { directory, artifact, sha256: digest, data: JSON.parse(bytes), manifest };
}
function driftFixture(repo, sha, targetRef) {
  if (!['ncsngxlcyxylaeskiteu', 'copflsklaefwzipsrjqz'].includes(targetRef)) throw new Error(`Unknown drift target ref ${targetRef}`);
  let fixture;
  try { fixture = JSON.parse(git(repo, 'show', `${sha}:${DRIFT_FIXTURE_ROOT}/${targetRef}.items.json`)); }
  catch { throw new Error(`Missing drift fixture for ${targetRef}`); }
  if (!fixture || fixture.fixture_version !== 1 || !Array.isArray(fixture.items)) throw new Error(`Malformed drift fixture for ${targetRef}`);
  for (const item of fixture.items) {
    if (!item || !hasExactKeys(item, ['object','attribute','name','canonical_definition','definition_sha256','classification','origin','approval_sha256']) || typeof item.canonical_definition !== 'string' || !item.canonical_definition || item.canonical_definition.endsWith('\n') || !HEX.test(item.definition_sha256) || hash(Buffer.from(item.canonical_definition, 'utf8')) !== item.definition_sha256) throw new Error(`Malformed drift fixture item for ${targetRef}`);
  }
  return fixture;
}
function validateReplaySummary(repo, sha, manifest) {
  const fixtureBytes = git(repo, 'show', `${sha}:${DRIFT_FIXTURE_ROOT}/${REF}.items.json`);
  let fixture;
  try { fixture = JSON.parse(fixtureBytes.toString('utf8')); }
  catch { throw new Error('Malformed committed TEST drift fixture'); }
  if (!fixture || fixture.fixture_version !== 1 || !Array.isArray(fixture.items)) throw new Error('Malformed committed TEST drift fixture');
  const summary = manifest.summary;
  if (!summary || summary.j5a !== J5A_CATALOG_DRIFT_SUMMARY || summary.j5a_fixture_sha256 !== hash(fixtureBytes) || !Number.isInteger(summary.j5a_item_count) || summary.j5a_item_count !== fixture.items.length) throw new Error('Drift replay summary metadata mismatch');
}
const driftBindings = value => value.items.map(item => [item.object, item.attribute, item.name, item.definition_sha256].join('\0')).sort(codepointCompare);
function rowtypeTablesAt(repo, sha) {
  try {
    const paths = git(repo, 'ls-tree', '-r', '--name-only', sha, 'supabase/migrations').toString().trim().split('\n').filter(path => /^supabase\/migrations\/2026093004.*\.sql$/.test(path));
    return deriveRowtypeTables(paths.map(file => git(repo, 'show', `${sha}:${file}`).toString()));
  } catch { return new Set(); }
}
export function sealSharedReadonly({ repo, sha, phase, output, catalogRecord, platformRecord, driftRecord, inputSha = sha, inputRef = 'HEAD', now = new Date() }) {
  if (!/^[0-9a-f]{40}$/.test(sha) || phase !== 'pre') throw new Error('Invalid SHA or phase: only pre is supported');
  if (!/^[0-9a-f]{40}$/.test(inputSha) || inputSha !== sha || inputRef !== 'HEAD') throw new Error('Invalid input evidence reference');
  try { git(repo, 'merge-base', '--is-ancestor', sha, 'HEAD'); }
  catch { throw new Error('Input SHA is not ancestor'); }
  if (git(repo, 'status', '--porcelain', '--untracked-files=all').toString().trim()) throw new Error('Evidence worktree must start clean');
  const catalog = record(repo, inputSha, catalogRecord, 'catalog-fingerprint', 'n/a', 'catalog-pre.json', inputRef);
  const platform = record(repo, inputSha, platformRecord, 'db-contract', 'pre', 'platform-config.json', inputRef);
  const driftArtifact = `drift-record-${REF}.json`;
  const drift = driftRecord ? record(repo, inputSha, driftRecord, 'drift-replay', 'n/a', driftArtifact, inputRef) : null;
  if (!drift) throw new Error('Drift replay record required');
  validateReplaySummary(repo, inputSha, drift.manifest);
  const source = JSON.parse(readFileSync(output));
  inspect(source);
  if (source.target !== 'shared-readonly' || source.phase !== phase || source.verdict !== 'PASS') throw new Error('Readonly output identity mismatch');
  keys(source.plans, ROLES, 'plan roles');
  for (const role of ROLES) {
    keys(source.plans[role], SHAPE_NAMES, `${role} plan shapes`);
    for (const shape of SHAPE_NAMES) {
      const plan = source.plans[role][shape];
      keys(plan, ['sha256','messages_scan','total_cost'], `${role}/${shape} plan`);
      if (!HEX.test(plan.sha256) || !['Seq Scan','Index'].includes(plan.messages_scan) || !Number.isFinite(plan.total_cost)) throw new Error('Invalid plan digest');
    }
  }
  keys(source.tls, ['protocol','cipher','leaf_fingerprint','pinned_ca_fingerprint','root_in_peer_chain','upstream_hop_ssl'], 'TLS');
  if (!['TLSv1.2','TLSv1.3'].includes(source.tls.protocol) || typeof source.tls.cipher !== 'string' || !source.tls.cipher ||
      typeof source.tls.leaf_fingerprint !== 'string' ||
      !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(source.tls.leaf_fingerprint) ||
      source.tls.pinned_ca_fingerprint !== '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA' ||
      typeof source.tls.root_in_peer_chain !== 'boolean' ||
      (source.tls.upstream_hop_ssl !== null && (typeof source.tls.upstream_hop_ssl !== 'object' || Array.isArray(source.tls.upstream_hop_ssl) ||
        !hasExactKeys(source.tls.upstream_hop_ssl, ['ssl','version','cipher'], () => true) ||
        typeof source.tls.upstream_hop_ssl.ssl !== 'boolean' ||
        !['version','cipher'].every(k => source.tls.upstream_hop_ssl[k] === null || typeof source.tls.upstream_hop_ssl[k] === 'string')))) throw new Error('Invalid TLS proof');
  if (!source.catalog_indexes || Array.isArray(source.catalog_indexes) || typeof source.catalog_indexes !== 'object') throw new Error('Missing index summary');
  for (const value of Object.values(source.catalog_indexes)) {
    keys(value, ['relation','valid'], 'index summary');
    if (typeof value.relation !== 'string' || typeof value.valid !== 'boolean') throw new Error('Invalid index summary');
  }
  keys(source.comparisons, ['catalog', 'platform'], 'comparison');
  keys(source.comparisons.catalog, ['verdict', 'input_sha256', 'observed_section_sha256', 'observed_catalog_sha256', 'drift_record_sha256'], 'catalog comparison');
  keys(source.comparisons.platform, ['verdict', 'waived_fields', 'waiver_reasons', 'input_sha256', 'observed_sha256'], 'platform comparison');
  keys(source.platform_config, [...PLATFORM_FIELDS, 'sha256'], 'platform config');
  if (source.summary !== platformSummary(source.platform_config.postgrest_major, source.platform_config.postgrest_reason)) throw new Error('Platform summary mismatch');
  keys(source.items, source.items?.queued_invariants ? ['queued_invariants'] : [], 'items');
  if (source.comparisons?.catalog?.verdict !== 'PASS' || source.comparisons.catalog.input_sha256 !== catalog.sha256 || source.comparisons.platform.input_sha256 !== platform.sha256) throw new Error('Comparison input linkage mismatch');
  const fixture = driftFixture(repo, inputSha, REF);
  if (driftBindings(fixture) .join('\n') !== driftBindings(drift.data).join('\n')) throw new Error('Drift fixture/replay definition mismatch');
  const expectedCatalog = reconstructCatalog(catalog.data, drift.data, { targetRef: REF, candidateSha: sha, rowtypeTables: rowtypeTablesAt(repo, sha) });
  const expectedSections = expectedCatalog.section_sha256;
  const observedSections = source.comparisons.catalog.observed_section_sha256;
  if (!hasExactKeys(expectedSections, CATALOG_SECTIONS, digest => typeof digest === 'string' && HEX.test(digest)) ||
      !hasExactKeys(observedSections, CATALOG_SECTIONS, digest => typeof digest === 'string' && HEX.test(digest)) ||
      CATALOG_SECTIONS.some(k => observedSections[k] !== expectedSections[k]) || source.comparisons.catalog.observed_catalog_sha256 !== expectedCatalog.sha256 || source.comparisons.catalog.drift_record_sha256 !== drift.data.sha256) throw new Error('Catalog comparison mismatch');
  if (!HEX.test(source.comparisons.platform.observed_sha256)) throw new Error('Platform comparison digest missing');
  const platformKeys = PLATFORM_FIELDS;
  keys(platform.data, [...platformKeys, 'sha256'], 'consumed platform');
  const consumedPlatform = Object.fromEntries(platformKeys.map(key => [key, platform.data[key]]));
  validateConsumedPlatform({ ...consumedPlatform, sha256: platform.data.sha256 }, 'consumed', true);
  if (!HEX.test(platform.data.sha256)) throw new Error('Consumed platform digest mismatch');
  const waivedFields = source.comparisons.platform.waived_fields;
  if (!Array.isArray(waivedFields) || (waivedFields.length !== 0 && JSON.stringify(waivedFields) !== JSON.stringify(['postgrest_major'])) ||
      JSON.stringify(source.comparisons.platform.verdict) !== JSON.stringify(platformVerdict(waivedFields))) throw new Error('Platform comparison mismatch');
  const waiverReasons = source.comparisons.platform.waiver_reasons;
  const expectedWaiverReasons = source.platform_config.postgrest_major === NOT_VERIFIED ? { postgrest_major: source.platform_config.postgrest_reason } : {};
  if (JSON.stringify(waiverReasons) !== JSON.stringify(expectedWaiverReasons)) throw new Error('Platform waiver reason mismatch');
  const expectedWaivedFields = source.platform_config.postgrest_major === NOT_VERIFIED ? ['postgrest_major'] : [];
  if (JSON.stringify(waivedFields) !== JSON.stringify(expectedWaivedFields)) throw new Error('Platform comparison mismatch');
  validateConsumedPlatform(source.platform_config, 'observed');
  if (PLATFORM_MAJOR_FIELDS.some(k => k !== 'postgrest_major' && platform.data[k] !== source.platform_config[k]) ||
      (source.platform_config.postgrest_major !== NOT_VERIFIED && source.platform_config.postgrest_major !== platform.data.postgrest_major) ||
      (source.platform_config.postgrest_observed_major !== null && source.platform_config.postgrest_observed_major !== platform.data.postgrest_major)) throw new Error('Platform comparison mismatch');
  const observedPlatform = { ...Object.fromEntries(platformKeys.map(key => [key, source.platform_config[key]])), sha256: source.platform_config.sha256 };
  if (source.platform_config.sha256 !== platformDigest(source.platform_config) || source.comparisons.platform.observed_sha256 !== source.platform_config.sha256) throw new Error('Observed platform digest mismatch');
  const runId = `shared-readonly-${phase}-${now.toISOString().replace(/[-:.]/g, '').replace('Z', 'Z')}`;
  const relative = `${ROOT}/${sha}/pre-merge/${runId}`;
  const absolute = path.join(repo, relative);
  const readonly = { verdict: source.verdict, target: 'shared-test', phase, source_output_sha256: hash(readFileSync(output)),
    plans: source.plans, tls: source.tls, catalog_indexes_sha256: hash(Buffer.from(JSON.stringify(source.catalog_indexes))),
    summary: source.summary, platform_config: observedPlatform,
    comparisons: { catalog: { verdict: 'PASS', input_sha256: catalog.sha256, observed_section_sha256: observedSections, observed_catalog_sha256: source.comparisons.catalog.observed_catalog_sha256, drift_record_sha256: drift.data.sha256 }, platform: { verdict: source.comparisons.platform.verdict, waived_fields: waivedFields, waiver_reasons: waiverReasons, input_sha256: platform.sha256, observed_sha256: source.comparisons.platform.observed_sha256 } }, items: {} };
  const queued = source.items?.queued_invariants;
  if (queued) {
    if (typeof queued !== 'object' || Array.isArray(queued) || Object.keys(queued).some(key => !['verdict', 'diff', 'stability_probe'].includes(key)) ||
        !Array.isArray(queued.diff) ||
        !['PASS', 'INCONCLUSIVE'].includes(queued.verdict) ||
        (queued.verdict === 'PASS') !== (queued.diff.length === 0) ||
        (Object.hasOwn(queued, 'stability_probe') && queued.stability_probe !== 'identical')) throw new Error('Invalid queued invariants');
  }
  if (queued) readonly.items.queued_invariants = { verdict: queued.verdict, diff: hash(Buffer.from(JSON.stringify(queued.diff))), ...(queued.stability_probe ? { stability_probe: queued.stability_probe } : {}) };
  inspect(readonly);
  const bytes = Buffer.from(JSON.stringify(readonly, null, 2) + '\n');
  const operatorList = 'scripts/inbox-ci/shared-readonly-operators.json';
  const listBytes = git(repo, 'show', `${sha}:${operatorList}`);
  const scripts = JSON.parse(listBytes).operator_scripts;
  if (!Array.isArray(scripts) || !scripts.includes(operatorList) || new Set(scripts).size !== scripts.length || scripts.some(script => !/^scripts\/[a-z0-9/.-]+$/.test(script) || script.includes('..'))) throw new Error('Invalid operator list');
  const operator_script_sha256 = Object.fromEntries(scripts.map(script => [script, hash(git(repo, 'show', `${sha}:${script}`))]));
  if (scripts.some(script => operator_script_sha256[script] !== hash(readFileSync(path.join(repo, script))))) throw new Error('Operator script differs from tested SHA');
  const manifest = { tested_sha: sha, tier: 'pre-merge', kind: 'shared-readonly', phase, target: 'shared-test', verdict: source.verdict, exit_status: 0, run_id: runId, started_at: now.toISOString(), completed_at: now.toISOString(), clean_tree: { start: true, end_excluding_run_dir: true, excluded_path: relative }, artifacts: { 'readonly.json': hash(bytes) }, target_binding: { project_ref: REF, pooler_user: `postgres.${REF}` }, inputs: { catalog_record: { directory: catalog.directory, artifact: catalog.artifact, sha256: catalog.sha256 }, platform_record: { directory: platform.directory, artifact: platform.artifact, sha256: platform.sha256 }, drift_record: { directory: drift.directory, artifact: drift.artifact, sha256: drift.sha256 } }, operator_script_sha256, event: 'operator', workflow_path: '', github_run_id: '', github_run_attempt: '', waived_fields: waivedFields, waiver_reasons: waiverReasons, items: readonly.items };
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
    console.log(sealSharedReadonly({ repo, sha: args['--sha'], phase: args['--phase'], output: args['--output'], catalogRecord: args['--catalog-record'], platformRecord: args['--platform-record'], driftRecord: args['--drift-record'], inputSha: args['--input-sha'], inputRef: args['--input-ref'] }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
