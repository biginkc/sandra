#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from 'pg';
import { makeRest } from '../outbox-db-contract/postgrest.mjs';
import { createFixture } from '../outbox-db-contract/fixture.mjs';
import { platformFingerprint } from '../outbox-db-contract/platform.mjs';
import { readPostgrestMajor } from '../outbox-db-contract/readonly.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const argv = process.argv.slice(2);
const options = Object.fromEntries(argv.reduce((pairs, value, index) => { if (index % 2 === 0) pairs.push([value, argv[index + 1]]); return pairs; }, []));
const phase = options['--phase'];
if (!['pre','post'].includes(phase) || process.env.E2E_DISPOSABLE_DATABASE !== '1' ||
    process.env.E2E_CI_SUPABASE_DB_URL !== 'postgresql://postgres:postgres@127.0.0.1:55422/postgres' ||
    !/^http:\/\/127\.0\.0\.1:55421\/?$/.test(process.env.TEST_SUPABASE_URL ?? '')) throw new Error('REHEARSAL_TARGET_REFUSED');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'inbox-readonly-rehearsal-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
let org = options['--org'];
if (options['--prepare-fixture']) {
  const rest = makeRest(process.env.TEST_SUPABASE_URL, process.env.TEST_SUPABASE_ANON_KEY, process.env.TEST_SUPABASE_SERVICE_ROLE_KEY);
  const fixture = await createFixture({ apiUrl: process.env.TEST_SUPABASE_URL, serviceKey: process.env.TEST_SUPABASE_SERVICE_ROLE_KEY, anonKey: process.env.TEST_SUPABASE_ANON_KEY, rest, runDir: scratch });
  org = fixture.ids.O1;
} else if (options['--fixture-rows']) {
  const rows = JSON.parse(readFileSync(options['--fixture-rows'], 'utf8'));
  org = rows.find(row => row.table === 'organizations')?.id;
}
if (!/^[0-9a-f-]{36}$/i.test(org ?? '')) throw new Error('REHEARSAL_ORG_MISSING');
const dsn = new URL(process.env.E2E_CI_SUPABASE_DB_URL);
const env = { ...process.env, PGHOST: dsn.hostname, PGPORT: dsn.port, PGUSER: decodeURIComponent(dsn.username), PGPASSWORD: decodeURIComponent(dsn.password), PGDATABASE: dsn.pathname.slice(1), PGSSLMODE: 'disable' };
const catalog = spawnSync('python3', ['scripts/outbox-db-contract/catalog-readonly.py'], { env, encoding: 'utf8' });
if (catalog.status !== 0) throw new Error(`REHEARSAL_CATALOG_FAILED ${catalog.stderr}`);
const catalogPath = path.join(scratch, 'catalog.json');
writeFileSync(catalogPath, catalog.stdout);
const client = new Client({ connectionString: process.env.E2E_CI_SUPABASE_DB_URL, ssl: false });
await client.connect();
let major;
let postgrest;
try {
  major = String(Math.floor(Number((await client.query('SHOW server_version_num')).rows[0].server_version_num) / 10000));
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  postgrest = await readPostgrestMajor(client);
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
}
finally { await client.end(); }
const platform = await platformFingerprint(process.env.TEST_SUPABASE_URL, process.env.TEST_SUPABASE_ANON_KEY, major, undefined, { ...postgrest, postgrestMajor: postgrest.postgrest_major, postgrestReason: postgrest.postgrest_reason, postgrestObservedMajor: postgrest.postgrest_observed_major });
const platformPath = path.join(scratch, 'platform.json');
writeFileSync(platformPath, JSON.stringify(platform));
const output = options['--output'] ?? path.join(scratch, 'readonly.json');
const flags = ['--target','disposable-readonly','--phase',phase,'--org',org,'--api-url',process.env.TEST_SUPABASE_URL,
  '--catalog-compare',catalogPath,'--platform-compare',platformPath,'--output',output];
if (phase === 'post') {
  const pre = options['--pre-file'];
  if (!pre) throw new Error('REHEARSAL_PRE_REQUIRED');
  flags.push('--pre-file',pre,'--plan-compare',pre);
}
const run = spawnSync(process.execPath, ['scripts/outbox-db-contract-readonly.mjs',...flags], { env: { ...process.env, DATABASE_URL: process.env.E2E_CI_SUPABASE_DB_URL, SUPABASE_ANON_KEY: process.env.TEST_SUPABASE_ANON_KEY }, encoding:'utf8', maxBuffer: 20*1024*1024 });
if (run.status !== 0) throw new Error(`REHEARSAL_FAILED ${run.stderr.trim()}`);
const record = JSON.parse(readFileSync(output, 'utf8'));
const plans = Object.fromEntries(Object.entries(record.plans).map(([role, shapes]) => [role, Object.fromEntries(Object.entries(shapes).map(([shape, plan]) => [shape, { sha256: plan.sha256, messages_scan: plan.messages_scan, total_cost: plan.total_cost }]))]));
const summary = { verdict: record.verdict, target: 'disposable-readonly', phase, plan_digests: plans,
  catalog_section_sha256: record.comparisons.catalog.observed_section_sha256, platform_sha256: record.platform_config.sha256,
  ...(record.plan_cost_ratios ? { plan_cost_ratios: record.plan_cost_ratios } : {}),
  ...(record.items.indexes ? { indexes: record.items.indexes } : {}) };
if (options['--record']) writeFileSync(options['--record'], JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ output, org, sha256: hash(readFileSync(output)), verdict: record.verdict }));
