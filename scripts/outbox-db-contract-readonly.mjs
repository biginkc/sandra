#!/usr/bin/env node
import { Client } from 'pg';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { collect, reconcile, stabilityProbe } from './outbox-db-contract/readonly.mjs';
import { platformFingerprint, comparePlatform } from './outbox-db-contract/platform.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') && (a.push([v.slice(2), all[i + 1]])), a), []));
const fail = (message, code = 1) => { console.error(message); process.exit(code); };
function assertTarget(target, dsn) {
  if (/copflsklaefwzipsrjqz/i.test(dsn) || /copflsklaefwzipsrjqz/i.test(process.env.SUPABASE_URL ?? '')) throw new Error('TARGET_REFUSED');
  const u = new URL(dsn);
  if (!['postgres:', 'postgresql:'].includes(u.protocol)) throw new Error('TARGET_REFUSED');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (target === 'shared-readonly' && (loopback || !u.hostname.endsWith('.pooler.supabase.com') || !/^postgres\.[a-z0-9]+$/.test(decodeURIComponent(u.username)))) throw new Error('TARGET_REFUSED');
  if (target === 'disposable-readonly' && (!loopback || process.env.E2E_DISPOSABLE_DATABASE !== '1')) throw new Error('TARGET_REFUSED');
  if (target === 'shared-readonly' && !['ncsngxlcyxylaeskiteu','copflsklaefwzipsrjqz'].includes(decodeURIComponent(u.username).slice('postgres.'.length))) throw new Error('TARGET_REFUSED');
  if (!['shared-readonly', 'disposable-readonly'].includes(target)) throw new Error('TARGET_REFUSED');
}
export { assertTarget };
async function catalog(dsn) {
  const path = 'experiments/inbox-production-install/catalog_fingerprint.py';
  if (!existsSync(path)) throw new Error('CATALOG_TOOL_UNAVAILABLE: rebase migrations branch');
  const run = spawnSync('python3', ['scripts/outbox-db-contract/catalog-readonly.py'], { env: { ...process.env, PGDATABASE: new URL(dsn).pathname.slice(1), PGHOST: new URL(dsn).hostname, PGPORT: new URL(dsn).port, PGUSER: decodeURIComponent(new URL(dsn).username), PGPASSWORD: decodeURIComponent(new URL(dsn).password) }, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`CATALOG_FAILED ${run.stderr.trim()}`);
  return JSON.parse(run.stdout);
}
async function main() {
  const dsn = process.env.DATABASE_URL;
  if (!dsn) throw new Error('DATABASE_URL_REQUIRED');
  assertTarget(args.target, dsn);
  if (args.target === 'shared-readonly' && !['test','production'].includes(args.boundary)) throw new Error('BOUNDARY_REQUIRED');
  if (args.target === 'shared-readonly' && ((args.boundary === 'test' && new URL(dsn).username !== 'postgres.ncsngxlcyxylaeskiteu') || (args.boundary === 'production' && new URL(dsn).username !== 'postgres.copflsklaefwzipsrjqz'))) throw new Error('TARGET_REFUSED');
  if (args['api-url']) {
    const api = new URL(args['api-url']);
    const loopbackApi = ['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname);
    if ((args.target === 'shared-readonly' && (loopbackApi || api.hostname !== (args.boundary === 'test' ? 'ncsngxlcyxylaeskiteu.supabase.co' : 'copflsklaefwzipsrjqz.supabase.co'))) || (args.target === 'disposable-readonly' && !loopbackApi)) throw new Error('TARGET_REFUSED');
  }
  if (args.target === 'shared-readonly' && !process.env.SUPABASE_ANON_KEY) throw new Error('READ_PRECONDITION_FAILED');
  if (args.target === 'shared-readonly' && (!args['api-url'] || !args['catalog'] || !args['platform-compare'] || (args.phase === 'post' && (!args['pre-file'] || !args['plan-compare'] || !args['catalog-compare'])))) throw new Error('READ_PRECONDITION_FAILED');
  if (!['pre','post'].includes(args.phase)) throw new Error('PHASE_REQUIRED');
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(args.org ?? '')) throw new Error('ORG_ID_REQUIRED');
  const client = new Client({ connectionString: dsn, ssl: args.target === 'shared-readonly' ? { rejectUnauthorized: true } : false });
  await client.connect();
  try {
    const pre = args['pre-file'] ? JSON.parse(await readFile(args['pre-file'], 'utf8')) : null;
    const data = await collect(client, args.org, { previousIds: pre ? Object.keys(pre.queued.per_row) : [] });
    const major = (await client.query('SHOW server_version_num')).rows[0].server_version_num.slice(0, 2);
    const result = { verdict: 'PASS', items: {}, summary: 'no hosted HTTP 200 was observed at the shared boundary; hosted app/SSR/PostgREST behaviour is inferred from same-SHA disposable runs plus catalog-fingerprint, platform-config and claim-plumbing equality; a GoTrue major match does not prove identical hosted claim configuration.', target: args.target, phase: args.phase, ...data };
    if (args.boundary === 'production') { result.member_org_count = data.member_orgs.length; delete result.member_orgs; }
    if (args['pre-file']) {
      result.items.queued_invariants = reconcile(pre.queued, data.queued, data.current_status);
      if (args['plan-compare']) {
        const pinned = JSON.parse(await readFile(args['plan-compare'], 'utf8'));
        const indexes = p => [...new Set(Object.values(p).flatMap(shapes => Object.values(shapes).flat()).map(x => x.index).filter(Boolean))].sort();
        if (JSON.stringify(indexes(pinned.plans)) !== JSON.stringify(indexes(data.plans))) throw new Error('FAIL PLAN_INDEX_DRIFT');
      }
      if (result.items.queued_invariants.verdict === 'INCONCLUSIVE' && args.boundary === 'test' && args.phase === 'post') result.items.queued_invariants.stability_probe = await stabilityProbe(client, args.org);
      if (result.items.queued_invariants.verdict === 'INCONCLUSIVE' && args.boundary === 'production') result.verdict = 'INCONCLUSIVE';
    }
    delete result.current_status;
    if (args['api-url']) result.platform_config = await platformFingerprint(args['api-url'], process.env.SUPABASE_ANON_KEY, major);
    if (args['platform-compare']) comparePlatform(JSON.parse(await readFile(args['platform-compare'], 'utf8')), result.platform_config);
    if (args['catalog']) result.catalog_fingerprint = await catalog(dsn);
    if (args['catalog-compare']) {
      const pinned = JSON.parse(await readFile(args['catalog-compare'], 'utf8'));
      for (const [section, digest] of Object.entries(pinned.section_sha256)) if (result.catalog_fingerprint?.section_sha256?.[section] !== digest) throw new Error(`CATALOG_MISMATCH ${section}`);
    }
    const serialized = JSON.stringify(result, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > 40 * 1024 * 1024) throw new Error('RUN_RECORD_TOO_LARGE');
    if (args.output) await writeFile(args.output, serialized, { flag: 'wx', mode: 0o600 });
    else console.log(JSON.stringify(result));
    if (result.verdict !== 'PASS') throw new Error('INCONCLUSIVE QUIET_WINDOW_REQUIRED');
  } finally { await client.end(); }
}
if (process.argv[1]?.endsWith('outbox-db-contract-readonly.mjs')) main().catch(e => fail(e.message, e.message === 'READ_PRECONDITION_FAILED' ? 3 : 1));
