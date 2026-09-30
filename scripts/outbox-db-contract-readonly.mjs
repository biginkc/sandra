#!/usr/bin/env node
import { Client } from 'pg';
import { readFile, writeFile } from 'node:fs/promises';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { collect, reconcile, stabilityProbe } from './outbox-db-contract/readonly.mjs';
import { platformFingerprint, compareObservedPlatform, comparePlatform, platformVerdict, NOT_VERIFIED } from './outbox-db-contract/platform.mjs';
import { CATALOG_SECTIONS, hasExactKeys } from './outbox-db-contract/catalog-sections.mjs';
import { connectionConfig, connectionEvidence, pinnedCa } from './outbox-db-contract/connection.mjs';
import { catalogIndexes, compareIndexes, comparePlans, planCostRatios } from './outbox-db-contract/plan-contract.mjs';
export { CATALOG_SECTIONS } from './outbox-db-contract/catalog-sections.mjs';

export function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    parsed[argv[i].slice(2)] = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[++i];
  }
  return parsed;
}
const args = parseArgs(process.argv.slice(2));
const fail = (message, code = 1) => { console.error(message); process.exit(code); };
const TEST_REF = 'ncsngxlcyxylaeskiteu';
const PROD_REF = 'copflsklaefwzipsrjqz';
const CATALOG_FORMAT_VERSION = 2;
const HEX = /^[0-9a-f]{64}$/;
const DRIFT_APPROVALS = Object.freeze({
  idx_message_threads_ai_responder_status: 'e419f623f1922466db14dba7aa091cdd4720924e2b97901088af2dc5719b108a',
  idx_users_name: '4dbc01feffae5acf04236e5aa3611151cc43e1467f84588e05b025dd9fbc7402',
});
const OPERATOR_INDEX_NAMES = new Set(['inbox_parent_message_property','inbox_parent_message_contact','inbox_parent_review_property','inbox_backfill_messages','inbox_backfill_reviews','inbox_backfill_threads','inbox_backfill_thread_identity','inbox_unknown_history_page']);
const ROWTYPE_TABLES = new Set(['inbox_backfill.jobs','inbox_control.baseline_progress','inbox_maintained.queue','inbox_maintained.rows','inbox_parent.work','inbox_safety.routes']);
const stable = value => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const sha256 = value => createHash('sha256').update(value).digest('hex');
export const catalogFingerprint = sections => {
  const section_sha256 = Object.fromEntries(Object.entries(sections).sort(([a],[b]) => a.localeCompare(b)).map(([name, value]) => [name, sha256(stable(value))]));
  return { catalog_format_version: CATALOG_FORMAT_VERSION, sections, section_sha256, sha256: sha256(stable({ catalog_format_version: CATALOG_FORMAT_VERSION, section_sha256 })) };
};
function validateCatalogBaseline(value, label = 'catalog') {
  if (!value || value.catalog_format_version !== CATALOG_FORMAT_VERSION || !value.sections || !hasExactKeys(value.sections, CATALOG_SECTIONS, () => true) || !hasExactKeys(value.section_sha256, CATALOG_SECTIONS, digest => HEX.test(digest))) throw new Error(`CATALOG_MISMATCH ${label} format`);
  const rebuilt = catalogFingerprint(value.sections);
  if (stable(rebuilt.section_sha256) !== stable(value.section_sha256) || rebuilt.sha256 !== value.sha256) throw new Error(`CATALOG_MISMATCH ${label} digest`);
  return value;
}
function validateDriftRecord(record, baseline, { targetRef, candidateSha } = {}) {
  if (!record || !hasExactKeys(record, ['record_version','target_ref','candidate_sha','baseline_digest','catalog_format_version','items','sha256'])) throw new Error('DRIFT_RECORD_STALE malformed');
  if (record.record_version !== 1 || record.catalog_format_version !== CATALOG_FORMAT_VERSION || (targetRef && record.target_ref !== targetRef) || (candidateSha && record.candidate_sha !== candidateSha) || !/^[0-9a-f]{40}$/.test(record.candidate_sha) || !HEX.test(record.baseline_digest)) throw new Error('DRIFT_RECORD_STALE binding');
  if (record.baseline_digest !== baseline.sha256 || record.sha256 !== sha256(stable(Object.fromEntries(['record_version','target_ref','candidate_sha','baseline_digest','catalog_format_version','items'].map(key => [key, record[key]]))))) throw new Error('DRIFT_RECORD_STALE digest');
  const relations = Object.fromEntries(baseline.sections.relations.map(row => [row.identity, row]));
  const seen = new Set();
  for (const item of record.items) {
    if (!item || !hasExactKeys(item, ['object','attribute','name','canonical_definition','classification','origin','approval_sha256']) || !['columns','indexes'].includes(item.attribute) || ![item.object,item.name].every(value => typeof value === 'string' && value) || typeof item.canonical_definition !== 'string' || !item.canonical_definition || item.canonical_definition.endsWith('\n')) throw new Error('DRIFT_RECORD_STALE item');
    const identity = `${item.object}\0${item.attribute}\0${item.name}`;
    if (seen.has(identity)) throw new Error('DRIFT_RECORD_STALE duplicate');
    seen.add(identity);
    if (!relations[item.object]) throw new Error('DRIFT_RECORD_STALE object');
    if (ROWTYPE_TABLES.has(item.object)) throw new Error('DRIFT_RECORD_STALE rowtype table');
    const c = item.classification;
    if (item.attribute === 'columns') {
      if (!hasExactKeys(c, ['class','nullable','default','attidentity','attgenerated','column_acl','owner']) || c.class !== 'column' || c.nullable !== true || c.default !== null || c.attidentity !== '' || c.attgenerated !== '' || c.column_acl !== null || c.owner !== relations[item.object].owner || item.approval_sha256 !== null || item.origin !== 'unknown') throw new Error('DRIFT_RECORD_STALE column');
    } else {
      if (!hasExactKeys(c, ['class','unique','primary','constraint','valid','ready','live','predicate','expression','owner']) || c.class !== 'index' || c.unique !== false || c.primary !== false || c.constraint !== false || c.valid !== true || c.ready !== true || c.live !== true || typeof c.owner !== 'string' || !c.owner || (item.object === 'auth.users' && c.owner !== 'supabase_auth_admin') || OPERATOR_INDEX_NAMES.has(item.name)) throw new Error('DRIFT_RECORD_STALE index');
      const approval = c.predicate !== null || c.expression === true ? DRIFT_APPROVALS[item.name] : null;
      if ((c.predicate !== null || c.expression === true) && !approval || item.approval_sha256 !== approval) throw new Error('DRIFT_RECORD_STALE approval');
      if (approval && sha256(Buffer.from(item.canonical_definition, 'utf8')) !== approval) throw new Error('DRIFT_RECORD_STALE approval');
      if (item.origin !== (item.object === 'auth.users' ? 'platform' : 'unknown') || (item.object === 'auth.users' && c.owner !== 'supabase_auth_admin')) throw new Error('DRIFT_RECORD_STALE origin');
    }
  }
  return record;
}
function reconstructCatalog(baseline, record) {
  validateCatalogBaseline(baseline, 'baseline');
  validateDriftRecord(record, baseline);
  const sections = JSON.parse(JSON.stringify(baseline.sections));
  const relations = Object.fromEntries(sections.relations.map(row => [row.identity, row]));
  for (const item of record.items) {
    const bucket = relations[item.object][item.attribute];
    if (bucket.some(entry => entry.name === item.name)) throw new Error('DRIFT_RECORD_STALE collision');
    const c = item.classification;
    if (item.attribute === 'columns') bucket.push({ name: item.name, type: item.canonical_definition, not_null: !c.nullable, default: c.default, acl: c.column_acl, attgenerated: c.attgenerated, attidentity: c.attidentity });
    else bucket.push({ name: item.name, definition: item.canonical_definition, unique: c.unique, primary: c.primary, constraint: c.constraint, valid: c.valid, ready: c.ready, live: c.live, predicate: c.predicate, expression: c.expression, owner: c.owner });
    bucket.sort((a,b) => (item.attribute === 'columns' ? a.name.localeCompare(b.name) : a.definition.localeCompare(b.definition)));
  }
  return catalogFingerprint(sections);
}
function assertTarget(target, dsn, { apiUrl, ack = process.env.INBOX_PROD_READONLY_ACK } = {}) {
  if (!['shared-readonly', 'production', 'disposable-readonly'].includes(target)) throw new Error('TARGET_REFUSED');
  const suppliedUrls = [dsn, apiUrl ?? '', process.env.SUPABASE_URL ?? ''];
  if ((target === 'production' && suppliedUrls.some(value => value.includes(TEST_REF))) ||
      (target !== 'production' && suppliedUrls.some(value => value.includes(PROD_REF))) ||
      (target === 'disposable-readonly' && suppliedUrls.some(value => value.includes(TEST_REF)))) throw new Error('TARGET_REFUSED');
  let u;
  try { u = new URL(dsn); } catch { throw new Error('TARGET_REFUSED'); }
  if (!['postgres:', 'postgresql:'].includes(u.protocol)) throw new Error('TARGET_REFUSED');
  if ([...u.searchParams.keys()].some(key => /^ssl/i.test(key))) throw new Error('TARGET_REFUSED');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (target === 'disposable-readonly') {
    if (!loopback || process.env.E2E_DISPOSABLE_DATABASE !== '1') throw new Error('TARGET_REFUSED');
  } else {
    const ref = target === 'production' ? PROD_REF : TEST_REF;
    if (loopback || !u.hostname.endsWith('.pooler.supabase.com') || decodeURIComponent(u.username) !== `postgres.${ref}` || u.pathname !== '/postgres') throw new Error('TARGET_REFUSED');
    if (target === 'production' && ack !== PROD_REF) throw new Error('TARGET_REFUSED');
  }
  if (apiUrl) {
    let api;
    try { api = new URL(apiUrl); } catch { throw new Error('TARGET_REFUSED'); }
    if (target === 'disposable-readonly') {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname)) throw new Error('TARGET_REFUSED');
    } else if (api.protocol !== 'https:' || api.hostname !== `${target === 'production' ? PROD_REF : TEST_REF}.supabase.co` || api.pathname !== '/' || api.search || api.hash || api.username || api.password) throw new Error('TARGET_REFUSED');
  }
}
export { assertTarget };
const catalogCaTempDir = '__INBOX_CATALOG_CA_TEMP_DIR';
export function catalogChildEnv(dsn, parentEnv, target, expectedFingerprint) {
  const url = new URL(dsn);
  if ([...url.searchParams.keys()].some(key => /^ssl/i.test(key))) throw new Error('TARGET_REFUSED');
  const hosted = target === 'shared-readonly' || target === 'production';
  if (!hosted && target !== 'disposable-readonly') throw new Error('TARGET_REFUSED');
  const env = { ...parentEnv };
  for (const key of Object.keys(env)) {
    if (/^PG[A-Z_]/i.test(key)) delete env[key];
  }
  delete env.INBOX_CATALOG_HOSTED_TLS;
  delete env.INBOX_CATALOG_LOCAL_TLS;
  Object.assign(env, { PGDATABASE: url.pathname.slice(1), PGHOST: url.hostname,
    PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), LC_ALL: 'C' });
  if (hosted) {
    const ca = pinnedCa(parentEnv, expectedFingerprint);
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'sandra-catalog-ca-'), { mode: 0o700 });
    const tempPath = path.join(tempDir, 'root.pem');
    try {
      writeFileSync(tempPath, ca.pem, { mode: 0o600 });
      chmodSync(tempPath, 0o600);
    } catch (error) {
      rmSync(tempDir, { recursive: true, force: true });
      throw error;
    }
    Object.defineProperty(env, catalogCaTempDir, { value: tempDir, enumerable: false, configurable: true });
    Object.assign(env, { PGSSLMODE: 'verify-full', PGSSLROOTCERT: tempPath,
      PGSSLMINPROTOCOLVERSION: 'TLSv1.2', PGGSSENCMODE: 'disable', INBOX_CATALOG_HOSTED_TLS: '1' });
  } else env.PGSSLMODE = 'disable';
  return env;
}
export function disposeCatalogChildEnv(env) {
  if (env?.[catalogCaTempDir]) {
    rmSync(env[catalogCaTempDir], { recursive: true, force: true });
    delete env[catalogCaTempDir];
  }
}
async function catalog(dsn, target) {
  const path = 'experiments/inbox-production-install/catalog_fingerprint.py';
  if (!existsSync(path)) throw new Error('CATALOG_TOOL_UNAVAILABLE: rebase migrations branch');
  const env = catalogChildEnv(dsn, process.env, target);
  let run;
  try {
    run = spawnSync('python3', ['scripts/outbox-db-contract/catalog-readonly.py'], { env, encoding: 'utf8' });
  } finally {
    disposeCatalogChildEnv(env);
  }
  if (run.status !== 0) throw new Error(`CATALOG_FAILED ${run.stderr.trim()}`);
  return JSON.parse(run.stdout);
}
export function compareCatalog(pinned, observed, { driftRecord = null, targetRef, candidateSha } = {}) {
  validateCatalogBaseline(pinned, 'expected');
  validateCatalogBaseline(observed, 'observed');
  if (pinned.catalog_format_version !== observed.catalog_format_version) throw new Error('CATALOG_MISMATCH format');
  if (driftRecord) {
    const baselineRelations = Object.fromEntries(pinned.sections.relations.map(row => [row.identity, row]));
    const observedRelations = Object.fromEntries(observed.sections.relations.map(row => [row.identity, row]));
    for (const [object, relation] of Object.entries(observedRelations)) {
      if (!baselineRelations[object]) throw new Error('CATALOG_DRIFT_UNRECORDED');
      for (const attribute of ['columns','indexes']) {
        const allowed = new Set((baselineRelations[object][attribute] ?? []).map(item => item.name));
        const recorded = new Set(driftRecord.items.filter(item => item.object === object && item.attribute === attribute).map(item => item.name));
        if ((relation[attribute] ?? []).some(item => !allowed.has(item.name) && !recorded.has(item.name))) throw new Error('CATALOG_DRIFT_UNRECORDED');
      }
    }
    let expected;
    try { validateDriftRecord(driftRecord, pinned, { targetRef, candidateSha }); expected = reconstructCatalog(pinned, driftRecord); }
    catch (error) { if (error.message === 'CATALOG_MISMATCH baseline digest') throw error; throw new Error('DRIFT_RECORD_STALE'); }
    for (const section of CATALOG_SECTIONS) if (expected.section_sha256[section] !== observed.section_sha256[section]) throw new Error(section === 'relations' ? 'DRIFT_RECORD_STALE' : `CATALOG_MISMATCH ${section}`);
    return;
  }
  for (const [side, value] of [['expected', pinned], ['observed', observed]]) {
    const sections = value?.section_sha256;
    if (!hasExactKeys(sections, CATALOG_SECTIONS, digest => typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest))) {
      throw new Error(`CATALOG_MISMATCH ${side} sections`);
    }
  }
  for (const section of CATALOG_SECTIONS) if (pinned.section_sha256[section] !== observed.section_sha256[section]) {
    if (section === 'relations') throw new Error('CATALOG_DRIFT_UNRECORDED');
    throw new Error(`CATALOG_MISMATCH ${section}`);
  }
}
export function assertSealedPre({ manifest, sealed, sealedBytes, rawBytes, target }) {
  const expectedTarget = target === 'shared-readonly' ? 'shared-test' : 'production';
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  if (manifest?.kind !== 'shared-readonly' || manifest.phase !== 'pre' || manifest.target !== expectedTarget ||
      manifest.verdict !== 'PASS' || manifest.exit_status !== 0 || manifest.artifacts?.['readonly.json'] !== sha(sealedBytes) ||
      sealed?.phase !== 'pre' || sealed.target !== expectedTarget || sealed.verdict !== 'PASS' ||
      sealed.source_output_sha256 !== sha(rawBytes)) throw new Error('PLAN_PRE_NOT_SEALED');
  return sealed;
}
export const platformSummary = (postgrestMajor, target, reason = null) => {
  const observed = postgrestMajor === NOT_VERIFIED
    ? ({
      NAME_UNVERSIONED: 'NOT_VERIFIED: the connection name carried no version',
      MIXED_NAMES: 'NOT_VERIFIED: some connections carried a matching version and others none (MIXED_NAMES)',
      NO_CONNECTION: 'NOT_VERIFIED: no PostgREST connection was visible, which does not prove none existed',
    }[reason] ?? 'NOT_VERIFIED: invalid reason')
    : target === 'disposable-readonly' ? 'observed from its HTTP response and SQL connection name and matched' : 'observed from its connection name and matched';
  if (target === 'disposable-readonly') return `Auth health returned 200 with the publishable key; GoTrue major matched. Our publishable-key PostgREST request returned 200. PostgREST major was ${observed}. Disposable app/SSR/PostgREST behaviour was directly checked by the disposable HTTP/SQL contract.`;
  return `Auth health returned 200 with the publishable key; GoTrue major matched. Our publishable-key PostgREST request was rejected. PostgREST major was ${observed}. On TEST the name carries no version, so this check is waived there in practice; Production is expected to be the same. Connection names are diagnostic labels, not attestations. Release may proceed with hosted PostgREST compatibility unverified. Hosted app/SSR/PostgREST behaviour is inferred from same-SHA disposable runs plus catalog and claim-plumbing equality, which cannot establish hosted runtime/configuration equality; a GoTrue major match does not prove identical hosted claim configuration.`;
};
export async function main({ argv = args, createClient = config => new Client(config), makeClientConfig = connectionConfig, collectData = collect, readCatalog = catalog, readConnectionEvidence = connectionEvidence, getPinnedCa = pinnedCa } = {}) {
  const args = argv;
  const dsn = process.env.DATABASE_URL;
  if (!dsn) throw new Error('DATABASE_URL_REQUIRED');
  assertTarget(args.target, dsn, { apiUrl: args['api-url'] });
  if (args.boundary) throw new Error('TARGET_REFUSED');
  const hostedReadOnly = ['shared-readonly', 'production'].includes(args.target);
  if (args['probe-connection']) {
    if (!hostedReadOnly || args.phase || args.org) throw new Error('TARGET_REFUSED');
    const probe = createClient(makeClientConfig(args.target, dsn));
    await probe.connect();
    try {
      const tls = await readConnectionEvidence(probe, dsn, getPinnedCa());
      await probe.query('SET default_transaction_read_only=on');
      await probe.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const isolation = (await probe.query('SHOW transaction_isolation')).rows[0].transaction_isolation;
      const readonly = (await probe.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
      if (isolation !== 'repeatable read' || readonly !== 'on') throw new Error('READ_PRECONDITION_FAILED');
      if ((await probe.query('SELECT 1 AS one')).rows[0].one !== 1) throw new Error('PROBE_FAILED');
      await probe.query('ROLLBACK');
      const record = JSON.stringify({ verdict: 'PASS', target: args.target, tls, transaction: { isolation, read_only: readonly }, select_one: true }, null, 2) + '\n';
      if (args.output) await writeFile(args.output, record, { flag: 'wx', mode: 0o600 });
      else console.log(record.trim());
    } catch (error) { await probe.query('ROLLBACK').catch(() => {}); throw error; }
    finally { await probe.end(); }
    return;
  }
  if (hostedReadOnly && !process.env.SUPABASE_ANON_KEY) throw new Error('READ_PRECONDITION_FAILED');
  if (hostedReadOnly && (!args['api-url'] || !args['catalog-compare'] || !args['platform-compare'] || (args.phase === 'post' && (!args['pre-file'] || !args['plan-compare'])))) throw new Error('READ_PRECONDITION_FAILED');
  if (!['pre','post'].includes(args.phase)) throw new Error('PHASE_REQUIRED');
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(args.org ?? '')) throw new Error('ORG_ID_REQUIRED');
  const client = createClient(makeClientConfig(args.target, dsn));
  await client.connect();
  try {
    const failures = [];
    const preBytes = args['pre-file'] ? await readFile(args['pre-file']) : null;
    const pre = preBytes ? JSON.parse(preBytes) : null;
    if (pre && (pre.target !== args.target || pre.phase !== 'pre')) throw new Error('PLAN_PRE_TARGET_MISMATCH');
    const tls = hostedReadOnly ? await readConnectionEvidence(client, dsn, getPinnedCa()) : null;
    const data = await collectData(client, args.org, { previousIds: pre ? Object.keys(pre.queued.per_row) : [] });
    const major = String(Math.floor(Number((await client.query('SHOW server_version_num')).rows[0].server_version_num) / 10000));
    const result = { verdict: 'PASS', items: {}, summary: platformSummary(data.postgrest_major, args.target, data.postgrest_reason), target: args.target, phase: args.phase, ...data, ...(tls ? { tls } : {}) };
    if (args.target === 'production') { result.member_org_count = data.member_orgs.length; delete result.member_orgs; }
    if (args['pre-file']) {
      result.items.queued_invariants = reconcile(pre.queued, data.queued, data.current_status);
      if (result.items.queued_invariants.verdict === 'INCONCLUSIVE' && args.target === 'shared-readonly' && args.phase === 'post') result.items.queued_invariants.stability_probe = await stabilityProbe(client, args.org);
      if (result.items.queued_invariants.verdict === 'INCONCLUSIVE' && args.target === 'production') result.verdict = 'INCONCLUSIVE';
    }
    delete result.current_status;
    if (args['api-url']) {
      result.platform_config = await platformFingerprint(args['api-url'], process.env.SUPABASE_ANON_KEY, major, undefined, {
        mode: hostedReadOnly ? 'hosted' : 'disposable', postgrestMajor: data.postgrest_major,
        postgrestReason: data.postgrest_reason, postgrestObservedMajor: data.postgrest_observed_major,
      });
      if (pre?.platform_config) compareObservedPlatform(pre.platform_config, result.platform_config);
      result.summary = platformSummary(result.platform_config.postgrest_major, args.target, result.platform_config.postgrest_reason);
    }
    if (args['platform-compare']) {
      const bytes = await readFile(args['platform-compare']);
      const platformComparison = comparePlatform(JSON.parse(bytes), result.platform_config);
      result.comparisons = { ...result.comparisons, platform: { verdict: platformVerdict(platformComparison.waived_fields), waived_fields: platformComparison.waived_fields, waiver_reasons: platformComparison.waiver_reasons, input_sha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'), observed_sha256: result.platform_config.sha256 } };
    }
    if (args['catalog'] || args['catalog-compare']) {
      result.catalog_fingerprint = await readCatalog(dsn, args.target);
      result.catalog_indexes = catalogIndexes(result.catalog_fingerprint);
      if (pre) {
        try {
          const indexCheck = compareIndexes(pre.catalog_indexes, result.catalog_indexes);
          result.items.indexes = indexCheck;
          if (indexCheck.verdict === 'INCONCLUSIVE') result.verdict = 'INCONCLUSIVE';
        } catch (error) {
          if (!/^FAIL INDEX_(?:ABSENT|INVALID) /.test(error.message)) throw error;
          result.items.indexes = { verdict: 'FAIL', reason: error.message };
          result.verdict = 'FAIL'; failures.push(error.message);
        }
      }
    }
    if (args['catalog-compare']) {
      const bytes = await readFile(args['catalog-compare']);
      const pinned = JSON.parse(bytes);
      const driftRecord = args['catalog-drift-record'] ? JSON.parse(await readFile(args['catalog-drift-record'])) : null;
      let catalogVerdict = 'PASS', catalogReason;
      try { compareCatalog(pinned, result.catalog_fingerprint, { driftRecord, targetRef: args.target === 'production' ? PROD_REF : TEST_REF, candidateSha: args['candidate-sha'] ?? process.env.HEAVY_TESTED_SHA }); }
      catch (error) {
        catalogVerdict = result.items.indexes?.verdict === 'INCONCLUSIVE' ? 'INCONCLUSIVE' : 'FAIL';
        catalogReason = error.message;
        if (catalogVerdict === 'FAIL') { result.verdict = 'FAIL'; failures.push(error.message); }
      }
      result.comparisons = { ...result.comparisons, catalog: { verdict: catalogVerdict, ...(catalogReason ? { reason: catalogReason } : {}), input_sha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'), observed_section_sha256: result.catalog_fingerprint.section_sha256, observed_catalog_sha256: result.catalog_fingerprint.sha256, ...(driftRecord ? { drift_record_sha256: driftRecord.sha256 } : {}) } };
    }
    if (args['plan-compare']) {
      const sealedBytes = await readFile(args['plan-compare']);
      let pinned = JSON.parse(sealedBytes);
      if (hostedReadOnly) {
        const manifest = JSON.parse(await readFile(path.join(path.dirname(args['plan-compare']), 'manifest.json'), 'utf8'));
        pinned = assertSealedPre({ manifest, sealed: pinned, sealedBytes, rawBytes: preBytes, target: args.target });
        if (pinned.catalog_indexes_sha256 !== createHash('sha256').update(JSON.stringify(pre.catalog_indexes)).digest('hex')) throw new Error('PLAN_PRE_NOT_SEALED');
      } else if (pinned.target !== pre.target || pinned.phase !== 'pre') throw new Error('PLAN_PRE_TARGET_MISMATCH');
      if (JSON.stringify(pinned.plans) !== JSON.stringify(pre.plans)) throw new Error('PLAN_PRE_TARGET_MISMATCH');
      result.plan_cost_ratios = planCostRatios(pinned, result.plans);
      try { comparePlans({ ...pinned, target: args.target }, result.plans, args.target); }
      catch (error) {
        if (!error.message.startsWith('FAIL PLAN_REGRESSION ')) throw error;
        result.items.plans = { verdict: 'FAIL', reason: error.message };
        result.verdict = 'FAIL'; failures.push(error.message);
      }
    }
    delete result.catalog_fingerprint;
    const serialized = JSON.stringify(result, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > 40 * 1024 * 1024) throw new Error('RUN_RECORD_TOO_LARGE');
    if (args.output) await writeFile(args.output, serialized, { flag: 'wx', mode: 0o600 });
    else console.log(JSON.stringify(result));
    if (failures.length) throw new Error(failures.join('; '));
    if (result.verdict !== 'PASS') throw new Error(result.items.indexes?.reason === 'INDEXES_NOT_BUILT' ? 'INCONCLUSIVE INDEXES_NOT_BUILT' : 'INCONCLUSIVE QUIET_WINDOW_REQUIRED');
  } finally { await client.end(); }
}
if (process.argv[1]?.endsWith('outbox-db-contract-readonly.mjs')) main().catch(e => fail(e.message, e.message === 'READ_PRECONDITION_FAILED' ? 3 : 1));
