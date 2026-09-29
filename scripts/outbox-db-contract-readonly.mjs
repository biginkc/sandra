#!/usr/bin/env node
import { Client } from 'pg';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { collect, reconcile, stabilityProbe } from './outbox-db-contract/readonly.mjs';
import { platformFingerprint, comparePlatform } from './outbox-db-contract/platform.mjs';
import { CATALOG_SECTIONS, hasExactKeys } from './outbox-db-contract/catalog-sections.mjs';
import { connectionConfig, assertBackendTls } from './outbox-db-contract/connection.mjs';
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
export function catalogChildEnv(dsn, parentEnv) {
  const url = new URL(dsn);
  const env = { ...parentEnv, PGDATABASE: url.pathname.slice(1), PGHOST: url.hostname, PGPORT: url.port, PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGSSLMODE: parentEnv.INBOX_CATALOG_TLS_MODE ?? 'disable' };
  delete env.PGSSLROOTCERT;
  if (env.PGSSLMODE === 'verify-full') env.PGSSLROOTCERT = parentEnv.NODE_EXTRA_CA_CERTS ?? 'system';
  return env;
}
async function catalog(dsn) {
  const path = 'experiments/inbox-production-install/catalog_fingerprint.py';
  if (!existsSync(path)) throw new Error('CATALOG_TOOL_UNAVAILABLE: rebase migrations branch');
  const run = spawnSync('python3', ['scripts/outbox-db-contract/catalog-readonly.py'], { env: catalogChildEnv(dsn, process.env), encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`CATALOG_FAILED ${run.stderr.trim()}`);
  return JSON.parse(run.stdout);
}
export function compareCatalog(pinned, observed) {
  for (const [side, value] of [['expected', pinned], ['observed', observed]]) {
    const sections = value?.section_sha256;
    if (!hasExactKeys(sections, CATALOG_SECTIONS, digest => typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest))) {
      throw new Error(`CATALOG_MISMATCH ${side} sections`);
    }
  }
  for (const section of CATALOG_SECTIONS) if (pinned.section_sha256[section] !== observed.section_sha256[section]) throw new Error(`CATALOG_MISMATCH ${section}`);
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
async function main() {
  const dsn = process.env.DATABASE_URL;
  if (!dsn) throw new Error('DATABASE_URL_REQUIRED');
  assertTarget(args.target, dsn, { apiUrl: args['api-url'] });
  if (args.boundary) throw new Error('TARGET_REFUSED');
  const hostedReadOnly = ['shared-readonly', 'production'].includes(args.target);
  if (args['probe-connection']) {
    if (!hostedReadOnly || args.phase || args.org) throw new Error('TARGET_REFUSED');
    const probe = new Client(connectionConfig(args.target, dsn));
    await probe.connect();
    try {
      await probe.query('SET default_transaction_read_only=on');
      await probe.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const isolation = (await probe.query('SHOW transaction_isolation')).rows[0].transaction_isolation;
      const readonly = (await probe.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
      if (isolation !== 'repeatable read' || readonly !== 'on') throw new Error('READ_PRECONDITION_FAILED');
      const tls = await assertBackendTls(probe);
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
  const client = new Client(connectionConfig(args.target, dsn));
  await client.connect();
  try {
    const failures = [];
    const preBytes = args['pre-file'] ? await readFile(args['pre-file']) : null;
    const pre = preBytes ? JSON.parse(preBytes) : null;
    if (pre && (pre.target !== args.target || pre.phase !== 'pre')) throw new Error('PLAN_PRE_TARGET_MISMATCH');
    const data = await collect(client, args.org, { previousIds: pre ? Object.keys(pre.queued.per_row) : [], hosted: hostedReadOnly });
    const major = (await client.query('SHOW server_version_num')).rows[0].server_version_num.slice(0, 2);
    const result = { verdict: 'PASS', items: {}, summary: 'no hosted HTTP 200 was observed at the shared boundary; hosted app/SSR/PostgREST behaviour is inferred from same-SHA disposable runs plus catalog-fingerprint, platform-config and claim-plumbing equality; a GoTrue major match does not prove identical hosted claim configuration.', target: args.target, phase: args.phase, ...data };
    if (args.target === 'production') { result.member_org_count = data.member_orgs.length; delete result.member_orgs; }
    if (args['pre-file']) {
      result.items.queued_invariants = reconcile(pre.queued, data.queued, data.current_status);
      if (result.items.queued_invariants.verdict === 'INCONCLUSIVE' && args.target === 'shared-readonly' && args.phase === 'post') result.items.queued_invariants.stability_probe = await stabilityProbe(client, args.org);
      if (result.items.queued_invariants.verdict === 'INCONCLUSIVE' && args.target === 'production') result.verdict = 'INCONCLUSIVE';
    }
    delete result.current_status;
    if (args['api-url']) result.platform_config = await platformFingerprint(args['api-url'], process.env.SUPABASE_ANON_KEY, major);
    if (args['platform-compare']) {
      const bytes = await readFile(args['platform-compare']);
      comparePlatform(JSON.parse(bytes), result.platform_config);
      result.comparisons = { ...result.comparisons, platform: { verdict: 'PASS', input_sha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'), observed_sha256: result.platform_config.sha256 } };
    }
    if (args['catalog'] || args['catalog-compare']) {
      process.env.INBOX_CATALOG_TLS_MODE = hostedReadOnly ? 'verify-full' : 'disable';
      result.catalog_fingerprint = await catalog(dsn);
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
      let catalogVerdict = 'PASS', catalogReason;
      try { compareCatalog(pinned, result.catalog_fingerprint); }
      catch (error) {
        catalogVerdict = result.items.indexes?.verdict === 'INCONCLUSIVE' ? 'INCONCLUSIVE' : 'FAIL';
        catalogReason = error.message;
        if (catalogVerdict === 'FAIL') { result.verdict = 'FAIL'; failures.push(error.message); }
      }
      result.comparisons = { ...result.comparisons, catalog: { verdict: catalogVerdict, ...(catalogReason ? { reason: catalogReason } : {}), input_sha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'), observed_section_sha256: result.catalog_fingerprint.section_sha256 } };
    }
    if (args['plan-compare'] && result.items.indexes?.verdict !== 'INCONCLUSIVE') {
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
