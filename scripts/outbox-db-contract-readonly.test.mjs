import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { collect, compareSets, reconcile, snapshot, openReadTxn, stabilityProbe, readPostgrestMajor, ACTIVE, planSkeleton } from './outbox-db-contract/readonly.mjs';
import { readonlyGet, compareObservedPlatform, comparePlatform, platformFingerprint, NOT_VERIFIED } from './outbox-db-contract/platform.mjs';
import { assertTarget, main, parseArgs, compareCatalog, assertSealedPre, catalogChildEnv, platformSummary } from './outbox-db-contract-readonly.mjs';
import { connectionConfig, pinnedCa } from './outbox-db-contract/connection.mjs';
import { describePlan, comparePlans, catalogIndexes, compareIndexes, OPERATOR_INDEXES, OPERATOR_RELATIONS } from './outbox-db-contract/plan-contract.mjs';

const row = (id, body='a') => ({ id, body, status:'queued', from_address:'x', to_address:'y', created_at:'2026-01-01', scheduled_for:null, property_id:null, contact_id:null });
function fails(label, fn, pattern) { assert.throws(fn, pattern, label); }
const TEST_REF='ncsngxlcyxylaeskiteu';
const PROD_REF='copflsklaefwzipsrjqz';
const hosted=ref=>`postgres://postgres.${ref}:unused@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
const api=ref=>`https://${ref}.supabase.co`;

test('catalog child env derives disposable mode and refuses missing hosted pin', () => {
  const dsn = 'postgres://catalog:unused@127.0.0.1:5432/postgres';
  const disposable = catalogChildEnv(dsn, { PGSSLMODE: 'require', PGHOST: 'wrong' }, 'disposable-readonly');
  assert.equal(disposable.PGSSLMODE, 'disable');
  assert.equal(disposable.PGHOST, '127.0.0.1');
  assert.equal(Object.hasOwn(disposable, 'PGSSLROOTCERT'), false);
  fails('hosted pin', () => catalogChildEnv(dsn, {}, 'shared-readonly'), /TLS_CA_REQUIRED/);
});

// Read the DDL, rather than treating the synthetic local tables as the schema.
// The three 2026093004* files are the Inbox install and define the POST phase.
const tableNames = ['messages', 'memberships', 'organizations', 'properties', 'contacts'];
const migrationsDir = new URL('../supabase/migrations/', import.meta.url);
function migrationColumns(includeInbox) {
  const columns = Object.fromEntries(tableNames.map(name => [name, new Map()]));
  for (const file of readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort()) {
    if (!includeInbox && /^2026093004\d+_inbox_/.test(file)) continue;
    const sql = readFileSync(new URL(file, migrationsDir), 'utf8').replace(/--[^\n]*/g, '');
    for (const name of tableNames) {
      const create = new RegExp(`\\bcreate\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(?:public\\.)?${name}\\s*\\(([\\s\\S]*?)^\\);`, 'gim');
      for (const match of sql.matchAll(create)) {
        for (const line of match[1].split('\n')) {
          const column = /^\s*([a-z_][\w]*)\s+(uuid|text|timestamptz|boolean|integer|int|bigint|numeric|jsonb|date|time|interval)\b/i.exec(line);
          if (column) columns[name].set(column[1].toLowerCase(), column[2].toLowerCase());
        }
      }
      const alter = new RegExp(`\\balter\\s+table\\s+(?:if\\s+exists\\s+)?(?:public\\.)?${name}\\b([\\s\\S]*?);`, 'gi');
      for (const match of sql.matchAll(alter)) {
        for (const add of match[1].matchAll(/\badd\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_][\w]*)\s+(uuid|text|timestamptz|boolean|integer|int|bigint|numeric|jsonb|date|time|interval)\b/gi)) {
          columns[name].set(add[1].toLowerCase(), add[2].toLowerCase());
        }
        for (const drop of match[1].matchAll(/\bdrop\s+column\s+(?:if\s+exists\s+)?([a-z_][\w]*)\b/gi)) columns[name].delete(drop[1].toLowerCase());
      }
    }
  }
  return columns;
}
function checkerColumns(source) {
  const refs = [];
  const aliases = { m: 'messages', msg: 'messages', mb: 'memberships', p: 'properties', c: 'contacts' };
  for (const [, alias, column] of source.matchAll(/\b(m|msg|mb|p|c)\.([a-z_][\w]*)\b/g)) refs.push([aliases[alias], column]);
  // Fail if a public-table query regresses to an unqualified column. A dot
  // between an alias and its column is required in every SELECT/WHERE/ORDER.
  const sql = source.match(/(?:`[^`]*`|'[^'\n]*'|"[^"\n]*")/g)?.join(' ') ?? '';
  for (const [, list] of sql.matchAll(/\bSELECT\s+([a-z_][\w]*(?:\s*,\s*[a-z_][\w]*)*)\s+FROM\s+public\./gi)) {
    assert.fail(`unqualified SELECT list: ${list}`);
  }
  return [...new Map(refs.map(ref => [ref.join('.'), ref])).values()];
}
test('checker SQL and local fixture use migration-defined PRE and POST columns', () => {
  const pre = migrationColumns(false), post = migrationColumns(true);
  const source = readFileSync(new URL('./outbox-db-contract/readonly.mjs', import.meta.url), 'utf8');
  const refs = checkerColumns(source);
  assert.ok(refs.length > 20, 'the scanner must cover joined and unaliased reads');
  for (const [table, column] of refs) {
    assert.ok(pre[table].has(column), `PRE lacks ${table}.${column}`);
    assert.ok(post[table].has(column), `POST lacks ${table}.${column}`);
  }
  assert.throws(() => {
    for (const [table, column] of checkerColumns(source + " SELECT m.updated_at FROM public.messages m")) {
      assert.ok(pre[table].has(column), `PRE lacks ${table}.${column}`);
    }
  }, /PRE lacks messages\.updated_at/);
  const fixture = readFileSync(new URL('./outbox-db-contract/readonly-local.sql', import.meta.url), 'utf8');
  for (const name of tableNames) {
    const body = new RegExp(`CREATE TABLE public\\.${name}\\(([^;]+)\\);`, 'i').exec(fixture)?.[1];
    assert.ok(body, `local fixture lacks ${name}`);
    const local = [...body.matchAll(/(?:^|,)\s*([a-z_][\w]*)\s+(uuid|text|timestamptz|boolean|integer|int|bigint|numeric|jsonb)\b/gi)];
    assert.ok(local.length, `local fixture has no parsed columns for ${name}`);
    for (const [, column, type] of local) {
      assert.equal(pre[name].get(column), type.toLowerCase(), `local ${name}.${column} differs from PRE DDL`);
      assert.equal(post[name].get(column), type.toLowerCase(), `local ${name}.${column} differs from POST DDL`);
    }
    for (const [table, column] of refs.filter(([table]) => table === name)) {
      assert.ok(local.some(([, field]) => field === column), `local fixture lacks ${table}.${column}`);
    }
  }
});
test('NC-T5a, NC-A5 target boundary', () => {
  fails('shared loopback', () => assertTarget('shared-readonly','postgres://postgres@127.0.0.1:55422/test'), /TARGET_REFUSED/);
  fails('disposable hosted', () => assertTarget('disposable-readonly','postgres://postgres@db.example.supabase.co/test'), /TARGET_REFUSED/);
  for (const target of ['disposable-readonly','shared-readonly']) fails(`${target} prod ref`, () => assertTarget(target, hosted(PROD_REF), {apiUrl:api(PROD_REF)}), /TARGET_REFUSED/);
  const previous = process.env.SUPABASE_URL;
  const previousDisposable = process.env.E2E_DISPOSABLE_DATABASE;
  process.env.SUPABASE_URL = api(PROD_REF);
  process.env.E2E_DISPOSABLE_DATABASE = '1';
  try {
    fails('disposable loopback with prod ref in environment', () => assertTarget('disposable-readonly', 'postgres://postgres@127.0.0.1:55422/test', {apiUrl:'http://127.0.0.1:55421'}), /TARGET_REFUSED/);
  } finally {
    if (previous === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previous;
    if (previousDisposable === undefined) delete process.env.E2E_DISPOSABLE_DATABASE;
    else process.env.E2E_DISPOSABLE_DATABASE = previousDisposable;
  }
  assert.doesNotThrow(()=>assertTarget('shared-readonly',hosted(TEST_REF),{apiUrl:api(TEST_REF)}));
});
test('argument parser preserves flags followed by a flag or end of args', () => {
  assert.deepEqual(parseArgs(['--boundary', '--target', 'production', '--dry-run']), {boundary:true,target:'production','dry-run':true});
});
test('NC-T5b Production binding and acknowledgement', () => {
  for (const dsn of [hosted(TEST_REF),'postgres://postgres@127.0.0.1:55422/postgres']) fails('wrong database',()=>assertTarget('production',dsn,{apiUrl:api(PROD_REF),ack:PROD_REF}),/TARGET_REFUSED/);
  for (const ack of [undefined,'wrong']) fails('ack',()=>assertTarget('production',hosted(PROD_REF),{apiUrl:api(PROD_REF),ack}),/TARGET_REFUSED/);
  fails('wrong api',()=>assertTarget('production',hosted(PROD_REF),{apiUrl:api(TEST_REF),ack:PROD_REF}),/TARGET_REFUSED/);
  assert.doesNotThrow(()=>assertTarget('production',hosted(PROD_REF),{apiUrl:api(PROD_REF),ack:PROD_REF}));
  const run=spawnSync(process.execPath,['scripts/outbox-db-contract-readonly.mjs','--target','production','--phase','pre'],{env:{...process.env,DATABASE_URL:hosted(PROD_REF),INBOX_PROD_READONLY_ACK:'wrong'},encoding:'utf8',timeout:5000});
  assert.equal(run.status,1); assert.match(run.stderr,/TARGET_REFUSED/);
});
test('NC-T5c Production uses the asserted read-only transaction path', async () => {
  const entry=readFileSync(new URL('./outbox-db-contract-readonly.mjs',import.meta.url),'utf8');
  assert.match(entry,/const hostedReadOnly = \['shared-readonly', 'production'\]\.includes\(args\.target\)/);
  assert.match(entry,/collectData = collect/);
  assert.match(entry,/await collectData\(client, args\.org/);
  const seen=[]; const c={query:async sql=>{seen.push(sql);return {rows:[sql.includes('transaction_isolation')?{transaction_isolation:'read committed'}:{transaction_read_only:'on'}]}}};
  await assert.rejects(openReadTxn(c,'BEGIN READ ONLY'),/READ_PRECONDITION_FAILED/);
  assert.deepEqual(seen,['BEGIN READ ONLY','SHOW transaction_isolation','SHOW transaction_read_only']);
});
test('NC-T5d Production module graph excludes write modules and service-role key', () => {
  const entry=readFileSync(new URL('./outbox-db-contract-readonly.mjs',import.meta.url),'utf8');
  const ro=readFileSync(new URL('./outbox-db-contract/readonly.mjs',import.meta.url),'utf8');
  const plat=readFileSync(new URL('./outbox-db-contract/platform.mjs',import.meta.url),'utf8');
  for (const source of [entry,ro,plat]) {
    assert.doesNotMatch(source,/\b(?:fixture|contracts|mutations|privileges)(?:\.mjs)?\b/);
    assert.doesNotMatch(source,/SUPABASE_SERVICE_ROLE_KEY/);
  }
});
test('NC-B4 HTTP allowlist', async () => {
  for (const path of ['/messages?tab=outbox','/auth/v1/token','/rest/v1/messages']) await assert.rejects(readonlyGet('http://127.0.0.1:1'+path), /READONLY_HTTP_DENIED/);
  await assert.rejects(readonlyGet('http://127.0.0.1:1/auth/v1/health',{method:'POST'}), /READONLY_HTTP_DENIED/);
});
test('NC-C2 isolation mutation fails before snapshot', async () => {
  const seen=[]; const c={query:async sql=>{seen.push(sql); return {rows:[sql.includes('transaction_isolation')?{transaction_isolation:'read committed'}:{transaction_read_only:'on'}]}}};
  await assert.rejects(openReadTxn(c,'BEGIN READ ONLY'),/READ_PRECONDITION_FAILED/);
  assert.deepEqual(seen,['BEGIN READ ONLY','SHOW transaction_isolation','SHOW transaction_read_only']);
});
test('NC-B1/B2/B3/C4/C5/C6 set oracle', () => {
  const a={id:'1',org_id:'o1'}, b={id:'2',org_id:'o2'}, foreign={id:'3',org_id:'foreign'};
  assert.equal(compareSets([a,b],[a,b]).verdict,'PASS');
  fails('restrictive',()=>compareSets([a,b],[a]),/RLS_OVERRESTRICTIVE/);
  fails('wrong sub',()=>compareSets([a,b],[]),/RLS_OVERRESTRICTIVE/);
  fails('leak beyond pages',()=>compareSets([a,b],[a,b,foreign]),/RLS_LEAK/);
  fails('single-org forged',()=>compareSets([a],[a,b]),/RLS_LEAK/);
  fails('empty ref',()=>compareSets([],[]),/EMPTY_SCOPE/);
});
test('NC-Q1/Q2/Q3/Q4/Q5 reconciliation', async () => {
  const before=snapshot([row('1'),row('2')]);
  assert.equal(reconcile(before,snapshot([row('1'),row('2')])).verdict,'PASS');
  const mixed=reconcile(before,snapshot([row('2','changed')]),{'1':{status:'sent',created_at:'2026-01-01'}});
  assert.equal(mixed.verdict,'INCONCLUSIVE'); assert.deepEqual(mixed.diff.map(x=>x.kind),['departed','content_changed']);
  assert.equal(reconcile(before,snapshot([{...row('1'),created_at:'2026-01-02'},row('2')])).diff[0].kind,'content_changed');
  assert.equal(reconcile(before,snapshot([row('1'),row('2'),row('3')])).verdict,'INCONCLUSIVE');
  const forged=snapshot([row('1'),row('2','changed')]); forged.aggregate_sha256=before.aggregate_sha256;
  assert.equal(reconcile(before,forged).verdict,'INCONCLUSIVE');
});
test('NC-C3 each stability observation opens a new transaction', () => {
  const source=readFileSync(new URL('./outbox-db-contract/readonly.mjs',import.meta.url),'utf8');
  assert.match(source,/const first = await observe\(client, org\);[\s\S]*const second = await observe\(client, org\)/);
  assert.match(source,/export async function observe[\s\S]*await openReadTxn\(client\)/);
});
test('NC-R1/R2 static surface', () => {
  const ro=readFileSync(new URL('./outbox-db-contract/readonly.mjs',import.meta.url),'utf8');
  const plat=readFileSync(new URL('./outbox-db-contract/platform.mjs',import.meta.url),'utf8');
  const forbidden = /(?<!\.)\b(?:insert|update|delete|truncate|merge|copy|alter|create|drop|grant|revoke)\b(?!_)/i;
  assert.doesNotMatch('updated_at and hash.update(value)', forbidden);
  for (const source of [ro,plat]) assert.doesNotMatch(source,forbidden);
  assert.doesNotMatch(ro,/fixture\.mjs|contracts\.mjs|\bfetch\(/);
  assert.doesNotMatch(plat,/\bfetch\(/);
  assert.match(ACTIVE,/access_expires_at > now\(\)/);
});
test('NC platform major mismatch',()=>fails('major',()=>comparePlatform({postgres_major:'17',postgrest_major:'12',gotrue_major:'2'},{postgres_major:'17',postgrest_major:'13',gotrue_major:'2'}),/PLATFORM_MISMATCH/));
test('RULING pg_stat_activity outcomes are scoped, strict, and duplicate-tolerant', async () => {
  let sql;
  const query = rows => ({ query: async statement => { sql = statement; return { rows }; } });
  assert.equal(await readPostgrestMajor(query([])), NOT_VERIFIED);
  assert.equal(await readPostgrestMajor(query([{application_name:'PostgREST 12.2.0'}, {application_name:'PostgREST 12.3.1'}])), '12');
  await assert.rejects(readPostgrestMajor(query([{application_name:'PostgREST 12.2.0'}, {application_name:'PostgREST 13.0.0'}])), /PLATFORM_AMBIGUOUS/);
  await assert.rejects(readPostgrestMajor(query([{application_name:'PostgREST 12.2.0'}, {application_name:''}])), /PLATFORM_UNIDENTIFIED/);
  await assert.rejects(readPostgrestMajor(query([{application_name:null}])), /PLATFORM_UNIDENTIFIED/);
  assert.match(sql, /usename='authenticator'/);
  assert.match(sql, /datname=current_database\(\)/);
  await assert.rejects(readPostgrestMajor({query: async () => { throw new Error('database unavailable'); }}), /PLATFORM_READ_FAILED/);
});
test('RULING collect reads PostgREST before its read-only transaction commits', async () => {
  const trace = [];
  const message = { id: '1', body: 'a', status: 'queued', from_address: 'x', to_address: 'y', created_at: '2026-01-01', scheduled_for: null, property_id: null, contact_id: null, property: null, contact: null };
  const plan = { 'Node Type': 'Index Scan', 'Relation Name': 'messages', Schema: 'public', 'Index Name': 'messages_queue_idx', 'Total Cost': 10 };
  const client = { query: async (sql) => {
    trace.push(sql);
    if (sql === 'SHOW transaction_isolation') return { rows: [{ transaction_isolation: 'repeatable read' }] };
    if (sql === 'SHOW transaction_read_only') return { rows: [{ transaction_read_only: 'on' }] };
    if (sql.startsWith('SELECT has_table_privilege')) {
      return { rows: [Object.fromEntries([...sql.matchAll(/\sAS\s+([a-z_][\w]*)/gi)].map(([, key]) => [key, true]))] };
    }
    if (sql.includes('FROM pg_stat_activity')) return { rows: [{ application_name: 'PostgREST 12.2.0' }] };
    if (sql === 'SELECT now() AS at') return { rows: [{ at: '2026-01-01T00:00:00Z' }] };
    if (sql.includes('SELECT mb.user_id FROM public.memberships mb')) return { rows: [{ user_id: 'member' }] };
    if (sql.includes('SELECT msg.id,msg.org_id')) return { rows: [{ id: '1', org_id: 'org' }] };
    if (sql.includes('SELECT mb.org_id FROM public.memberships mb')) return { rows: [{ org_id: 'org' }] };
    if (sql.includes('SELECT m.id,') && sql.includes("m.org_id=$1")) return { rows: [message] };
    if (sql.startsWith('EXPLAIN')) return { rows: [{ 'QUERY PLAN': [{ Plan: plan }] }] };
    if (sql.includes('auth.uid() AS uid')) return { rows: [{ uid: 'member', role: 'authenticated' }] };
    if (sql.includes('scheduled_for > $1') || sql.includes('scheduled_for IS NULL AND m.id > $1')) return { rows: [] };
    if (sql.includes('FROM public.messages m LEFT JOIN') && sql.includes("WHERE m.status='queued'") && !sql.includes('m.org_id=$1')) return { rows: [message] };
    return { rows: [] };
  } };
  const result = await collect(client, 'org');
  const statIndex = trace.findIndex(sql => sql.includes('FROM pg_stat_activity'));
  const commitIndex = trace.lastIndexOf('COMMIT');
  assert.equal(result.postgrest_major, '12');
  assert.ok(statIndex >= 0 && statIndex < commitIndex, 'PostGREST observation must precede COMMIT');
  assert.match(trace[statIndex], /usename='authenticator'/);
  assert.match(trace[statIndex], /datname=current_database\(\)/);
});
const catalogSections = ['relations', 'functions', 'types', 'extensions', 'schemas', 'index_names', 'trigger_names', 'schema_migrations', 'created_objects_present'];
const catalogMap = () => Object.fromEntries(catalogSections.map((name, index) => [name, String(index).padStart(64, 'a')]));
test('NC catalog empty section map fails', () => {
  fails('empty expected', () => compareCatalog({section_sha256:{}}, {section_sha256:catalogMap()}), /CATALOG_MISMATCH/);
  fails('empty observed', () => compareCatalog({section_sha256:catalogMap()}, {section_sha256:{}}), /CATALOG_MISMATCH/);
});
test('NC catalog omitted section fails', () => {
  const expected = catalogMap();
  delete expected.relations;
  fails('omitted expected', () => compareCatalog({section_sha256:expected}, {section_sha256:catalogMap()}), /CATALOG_MISMATCH/);
  fails('omitted observed', () => compareCatalog({section_sha256:catalogMap()}, {section_sha256:expected}), /CATALOG_MISMATCH/);
});
test('NC catalog extra section fails', () => {
  fails('extra observed', () => compareCatalog({section_sha256:catalogMap()}, {section_sha256:{...catalogMap(), unexpected:'f'.repeat(64)}}), /CATALOG_MISMATCH/);
  fails('extra expected', () => compareCatalog({section_sha256:{...catalogMap(), unexpected:'f'.repeat(64)}}, {section_sha256:catalogMap()}), /CATALOG_MISMATCH/);
});
test('NC catalog refuses a single key containing the entire joined section list', () => {
  const combined = { [catalogSections.slice().sort().join(',')]: 'f'.repeat(64) };
  fails('combined expected', () => compareCatalog({section_sha256:combined}, {section_sha256:combined}), /CATALOG_MISMATCH/);
  fails('combined observed', () => compareCatalog({section_sha256:catalogMap()}, {section_sha256:combined}), /CATALOG_MISMATCH/);
});
test('NC catalog refuses duplicate-looking keys that collide when joined', () => {
  const sections = catalogSections.slice().sort();
  const keys = [`${sections[0]},${sections[1]}`, ...sections.slice(2)];
  const collided = Object.fromEntries(keys.map(key => [key, 'f'.repeat(64)]));
  assert.equal(keys.join(','), sections.join(','));
  fails('joined collision expected', () => compareCatalog({section_sha256:collided}, {section_sha256:collided}), /CATALOG_MISMATCH/);
  fails('joined collision observed', () => compareCatalog({section_sha256:catalogMap()}, {section_sha256:collided}), /CATALOG_MISMATCH/);
});
test('NC catalog malformed digest fails on either side', () => {
  fails('malformed expected', () => compareCatalog({section_sha256:{...catalogMap(), relations:'x'}}, {section_sha256:{...catalogMap(), relations:'x'}}), /CATALOG_MISMATCH/);
  fails('malformed observed', () => compareCatalog({section_sha256:catalogMap()}, {section_sha256:{...catalogMap(), relations:'x'}}), /CATALOG_MISMATCH/);
});
test('NC catalog changed policies or grants digest fails', () => {
  const changed = {...catalogMap(), relations:'f'.repeat(64)};
  fails('relation policies/grants', () => compareCatalog({section_sha256:catalogMap()}, {section_sha256:changed}), /CATALOG_MISMATCH/);
  assert.doesNotThrow(() => compareCatalog({section_sha256:catalogMap()}, {section_sha256:catalogMap()}));
});
test('NC platform accepts only identifiable PostgREST versions', async () => {
  const probe = async (server, versionHeader) => platformFingerprint('http://127.0.0.1:55421', 'anon', 17, async url => ({
    ok:true,
    headers:{get:name => name === 'server' ? server : name === 'x-postgrest-version' ? versionHeader : null},
    json:async()=>({version:'2.1.0'}),
  }), { postgrestMajor: '12' });
  await assert.rejects(probe('nginx/1.25.5', null), /PLATFORM_UNIDENTIFIED/);
  await assert.rejects(probe(null, null), /PLATFORM_UNIDENTIFIED/);
  await assert.rejects(probe('PostgREST/garbage', null), /PLATFORM_UNIDENTIFIED/);
  assert.equal((await probe('PostgREST/12.2.0', null)).postgrest_major, '12');
  assert.equal((await probe(null, '12.2.0')).postgrest_major, '12');
});
test('NC platform identifies PostgREST from an OpenAPI body behind Cloudflare', async () => {
  const probe = body => platformFingerprint('http://127.0.0.1:55421', 'anon', 17, async url => ({
    ok: true,
    headers: {get: name => name === 'server' ? 'cloudflare' : null},
    json: async () => new URL(url).pathname === '/rest/v1/' ? body : {version: '2.1.0'},
  }), { postgrestMajor: '12' });
  assert.equal((await probe({swagger: '2.0', info: {version: '12.2.3 (abcdef)'}})).postgrest_major, '12');
  await assert.rejects(probe({openapi: '3.0.0', info: {}}), /PLATFORM_UNIDENTIFIED/);
  await assert.rejects(probe({openapi: '3.0.0', info: {version: 'nginx'}}), /PLATFORM_UNIDENTIFIED/);
  await assert.rejects(probe({info: {version: '12.2.3'}}), /PLATFORM_UNIDENTIFIED/);
  await assert.rejects(probe({swagger: '2.0', info: {version: '12.2.3 nginx'}}), /PLATFORM_UNIDENTIFIED/);
  await assert.rejects(probe({swagger: '2.0', info: {version: 'nginx 12.2.3'}}), /PLATFORM_UNIDENTIFIED/);
});
test('NC platform rejects a non-JSON PostgREST body', async () => {
  const transport = async url => ({
    ok: true,
    headers: {get: name => name === 'server' ? 'cloudflare' : null},
    json: async () => {
      if (new URL(url).pathname === '/rest/v1/') throw new SyntaxError('Unexpected token');
      return {version: '2.1.0'};
    },
  });
  await assert.rejects(platformFingerprint('http://127.0.0.1:55421', 'anon', 17, transport, { postgrestMajor: '12' }), /PLATFORM_UNIDENTIFIED/);
});
test('Outbox source shape and claim pin', () => {
  const actions=readFileSync(new URL('../src/app/(dashboard)/messages/actions.ts',import.meta.url),'utf8');
  const cursor=readFileSync(new URL('../src/app/(dashboard)/messages/queued-cursor.ts',import.meta.url),'utf8');
  const claims=JSON.parse(readFileSync(new URL('./outbox-db-contract/expected/claims-shape.json',import.meta.url),'utf8'));
  assert.deepEqual(claims.keys,['sub','role','aud','email','exp']);
  for(const field of ['body','from_address','to_address','created_at','scheduled_for','property_id','contact_id','properties(id, address, city, state)','contacts(id, first_name, last_name, entity_name, phone_1)']) assert.ok(actions.includes(field),field);
  for(const fragment of ['scheduled_for.gt.','scheduled_for.eq.','scheduled_for.is.null','nullTail']) assert.ok(cursor.includes(fragment),fragment);
});

const plan = (scan, cost = 10, index = 'messages_queue_idx') => describePlan({ 'Node Type':scan, 'Relation Name':'messages', Schema:'public', 'Index Name':index, 'Total Cost':cost });
const planRecord = (target, phase, scan = 'Index Scan') => ({ target, phase, plans: Object.fromEntries(['privileged','member'].map(role => [role, Object.fromEntries(['first','keyset','null_tail'].map(shape => [shape, plan(scan)]))])) });
test('SEQ PRE natural Seq Scan passes and records a digest', () => {
  const observed = plan('Seq Scan');
  assert.equal(observed.messages_scan, 'Seq Scan');
  assert.match(observed.sha256, /^[a-f0-9]{64}$/);
  assert.equal(planSkeleton({'Node Type':'Seq Scan','Relation Name':'messages'}).length, 1);
});
test('SEQ POST Index to Seq fails with role and shape, same target only', () => {
  const pre = planRecord('shared-readonly','pre');
  const post = planRecord('shared-readonly','post');
  post.plans.member.null_tail = plan('Seq Scan');
  fails('regression', () => comparePlans(pre, post.plans, 'shared-readonly'), /FAIL PLAN_REGRESSION member null_tail/);
  fails('cross target', () => comparePlans(pre, post.plans, 'production'), /PLAN_PRE_TARGET_MISMATCH/);
});
test('SEQ changed index passes and cost ratio is informational', () => {
  const pre = planRecord('production','pre');
  const post = planRecord('production','post');
  post.plans.member.keyset = plan('Index Only Scan', 20, 'different_index');
  assert.equal(comparePlans(pre, post.plans, 'production').member.keyset, 2);
  const seqPre = planRecord('production','pre','Seq Scan');
  assert.equal(comparePlans(seqPre, post.plans, 'production').member.keyset, 2);
});
test('SEQ index absence, invalidity and pre-build inconclusive remain distinct', () => {
  const pre = { old_queue: { relation:'public.messages', valid:true } };
  const full = Object.fromEntries([...OPERATOR_INDEXES,'old_queue'].map(name => [name,{relation:OPERATOR_RELATIONS[name] ?? 'public.messages',valid:true}]));
  assert.deepEqual(compareIndexes(pre, {old_queue:full.old_queue}), {verdict:'INCONCLUSIVE',reason:'INDEXES_NOT_BUILT'});
  const absent = {...full}; delete absent.old_queue;
  fails('absent',()=>compareIndexes(pre,absent),/FAIL INDEX_ABSENT old_queue/);
  const invalid = {...full,old_queue:{relation:'public.messages',valid:false}};
  fails('invalid',()=>compareIndexes(pre,invalid),/FAIL INDEX_INVALID old_queue/);
  fails('wrong relation',()=>compareIndexes(pre,{...full,inbox_backfill_reviews:{relation:'public.messages',valid:true}}),/FAIL INDEX_ABSENT inbox_backfill_reviews/);
  assert.equal(compareIndexes(pre,full).verdict,'PASS');
  const fingerprint = { sections:{relations:[{identity:'public.messages',indexes:[{definition:'CREATE INDEX old_queue ON public.messages USING btree (id)',valid:true,ready:true}]}]}};
  assert.equal(catalogIndexes(fingerprint).old_queue.valid,true);
});
test('SEQ hosted TLS config requires pinned CA and disposable disables TLS', () => {
  for (const target of ['shared-readonly','production'])
    fails('missing pin', () => connectionConfig(target, hosted(target === 'production' ? PROD_REF : TEST_REF), {}), /TLS_CA_REQUIRED/);
  assert.equal(connectionConfig('disposable-readonly','postgres://postgres@127.0.0.1:55422/postgres',{}).ssl,false);
  const source = readFileSync(new URL('./outbox-db-contract/connection.mjs',import.meta.url),'utf8');
  assert.match(source,/rejectUnauthorized: true/);
  assert.doesNotMatch(source.replace('rejectUnauthorized: true','rejectUnauthorized: false'),/rejectUnauthorized: true/);
});
test('SEQ POST accepts only hashed sealed PRE output for the same target', () => {
  const rawBytes = Buffer.from('{"target":"shared-readonly","phase":"pre"}');
  const sealed = {target:'shared-test',phase:'pre',verdict:'PASS',source_output_sha256:readableDigest(rawBytes)};
  const sealedBytes = Buffer.from(JSON.stringify(sealed));
  const manifest = {kind:'shared-readonly',phase:'pre',target:'shared-test',verdict:'PASS',exit_status:0,artifacts:{'readonly.json':readableDigest(sealedBytes)}};
  assert.equal(assertSealedPre({manifest,sealed,sealedBytes,rawBytes,target:'shared-readonly'}),sealed);
  fails('wrong target',()=>assertSealedPre({manifest,sealed,sealedBytes,rawBytes,target:'production'}),/PLAN_PRE_NOT_SEALED/);
  fails('mutated raw',()=>assertSealedPre({manifest,sealed,sealedBytes,rawBytes:Buffer.from('changed'),target:'shared-readonly'}),/PLAN_PRE_NOT_SEALED/);
  fails('mutated seal',()=>assertSealedPre({manifest:{...manifest,artifacts:{'readonly.json':'f'.repeat(64)}},sealed,sealedBytes,rawBytes,target:'shared-readonly'}),/PLAN_PRE_NOT_SEALED/);
});
function readableDigest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
test('RULING disposable performs two blocking GETs and proves SQL/HTTP equality',async()=>{
  const calls=[];
  const { platformFingerprint }=await import('./outbox-db-contract/platform.mjs');
  const transport=async (url,options)=>{calls.push({path:new URL(url).pathname,method:options.method,headers:options.headers});return {ok:true,status:200,headers:{get:name=>name==='x-postgrest-version'?'12.2':null},json:async()=>({version:'2.1.0'})}};
  const result=await platformFingerprint('http://127.0.0.1:55421','anon',17,transport,{postgrestMajor:'12'});
  assert.deepEqual(calls.map(x=>[x.path,x.method]),[['/rest/v1/','GET'],['/auth/v1/health','GET']]);
  assert.deepEqual(calls.map(x=>x.headers),[{apikey:'anon'},{apikey:'anon'}]);
  assert.deepEqual(result.postgres_major,'17');
  assert.deepEqual(result.postgrest_major,'12');
  assert.deepEqual(result.gotrue_major,'2');
  await assert.rejects(platformFingerprint('http://127.0.0.1:55421','anon',17,transport,{postgrestMajor:'13'}), /PLATFORM_MISMATCH postgrest_major/);
});
test('RULING hosted sends publishable apikey, makes no REST call, and allows only NOT_VERIFIED', async () => {
  const calls = [];
  const transport = async (url, options) => {
    calls.push({ path: new URL(url).pathname, headers: options.headers });
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ version: '2.151.0' }) };
  };
  const result = await platformFingerprint('https://example.invalid', 'publishable', '17', transport, { mode: 'hosted', postgrestMajor: NOT_VERIFIED });
  assert.deepEqual(calls, [{ path: '/auth/v1/health', headers: { apikey: 'publishable' } }]);
  assert.equal(result.postgrest_major, NOT_VERIFIED);
  await assert.rejects(platformFingerprint('https://example.invalid', undefined, '17', transport, { mode: 'hosted', postgrestMajor: '12' }), /PLATFORM_READ_FAILED/);
  await assert.rejects(platformFingerprint('https://example.invalid', 'publishable', '17', transport, { mode: 'hosted', postgrestMajor: 'not-a-major' }), /PLATFORM_READ_FAILED/);
});
test('RULING checker summary uses target-appropriate observed or NOT_VERIFIED wording', () => {
  const disposableObserved = platformSummary('12', 'disposable-readonly');
  assert.match(disposableObserved, /PostgREST request returned 200/);
  assert.doesNotMatch(disposableObserved, /request was rejected/);
  assert.match(disposableObserved, /observed from its HTTP response and SQL connection name and matched/);
  const hostedMissing = platformSummary(NOT_VERIFIED, 'shared-readonly');
  assert.match(hostedMissing, /request was rejected/);
  assert.match(hostedMissing, /NOT_VERIFIED: no PostgREST connection was visible, which does not prove none existed/);
  assert.match(hostedMissing, /Hosted app\/SSR\/PostgREST behaviour is inferred from same-SHA disposable runs plus catalog and claim-plumbing equality\./);
});
const mainData = postgrest_major => ({ queued: { count: 1, per_row: {} }, current_status: {}, member_orgs: [], postgrest_major, rls: { verdict: 'PASS' }, plans: {} });
const fakeMainClient = () => ({ connect: async () => {}, end: async () => {}, query: async sql => sql === 'SHOW server_version_num' ? { rows: [{ server_version_num: '170000' }] } : { rows: [] } });
async function withMainEnv(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await fn(); }
  finally {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
}
test('RULING main wires disposable mode and enforces SQL equals HTTP', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'readonly-main-disposable-'));
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const pathname = new URL(url).pathname;
    calls.push({ pathname, headers: options.headers });
    return pathname === '/rest/v1/'
      ? { ok: true, status: 200, headers: { get: name => name === 'x-postgrest-version' ? 'PostgREST/12.2.0' : null }, json: async () => ({}) }
      : { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ version: '2.151.0' }) };
  };
  try {
    await withMainEnv({ DATABASE_URL: 'postgres://postgres@127.0.0.1:55422/postgres', E2E_DISPOSABLE_DATABASE: '1', SUPABASE_ANON_KEY: 'publishable' }, async () => {
      const output = path.join(dir, 'result.json');
      await main({ argv: { target: 'disposable-readonly', phase: 'pre', org: '00000000-0000-0000-0000-000000000001', 'api-url': 'http://127.0.0.1:55421', output }, createClient: fakeMainClient, collectData: async () => mainData('12') });
      assert.deepEqual(calls.map(call => call.pathname), ['/rest/v1/', '/auth/v1/health']);
      assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')).platform_config.postgrest_major, '12');
    });
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
test('RULING main hosted mode makes no REST call and carries field-scoped NOT_VERIFIED', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'readonly-main-hosted-'));
  const previousFetch = globalThis.fetch;
  const calls = [];
  const sections = Object.fromEntries(['relations', 'functions', 'types', 'extensions', 'schemas', 'index_names', 'trigger_names', 'schema_migrations', 'created_objects_present'].map(name => [name, 'a'.repeat(64)]));
  const platform = { postgres_major: '17', postgrest_major: '12', gotrue_major: '2' };
  const catalogPath = path.join(dir, 'catalog.json');
  const platformPath = path.join(dir, 'platform.json');
  writeFileSync(catalogPath, JSON.stringify({ section_sha256: sections }));
  writeFileSync(platformPath, JSON.stringify(platform));
  globalThis.fetch = async (url, options) => {
    calls.push({ pathname: new URL(url).pathname, headers: options.headers });
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ version: '2.151.0' }) };
  };
  try {
    await withMainEnv({ DATABASE_URL: `postgres://postgres.${TEST_REF}:unused@aws-0-us-east-1.pooler.supabase.com:5432/postgres`, SUPABASE_ANON_KEY: 'publishable' }, async () => {
      const output = path.join(dir, 'result.json');
      await main({ argv: { target: 'shared-readonly', phase: 'pre', org: '00000000-0000-0000-0000-000000000001', 'api-url': api(TEST_REF), 'catalog-compare': catalogPath, 'platform-compare': platformPath, output }, createClient: fakeMainClient, makeClientConfig: () => ({}), collectData: async () => mainData(NOT_VERIFIED), readCatalog: async () => ({ sections: { relations: [] }, section_sha256: sections }), readConnectionEvidence: async () => ({ protocol: 'TLSv1.3' }), getPinnedCa: () => ({}) });
      const result = JSON.parse(readFileSync(output, 'utf8'));
      assert.deepEqual(calls, [{ pathname: '/auth/v1/health', headers: { apikey: 'publishable' } }]);
      assert.deepEqual(result.comparisons.platform.waived_fields, ['postgrest_major']);
      assert.deepEqual(result.comparisons.platform.verdict, { postgres_major: 'PASS', postgrest_major: NOT_VERIFIED, gotrue_major: 'PASS' });
    });
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
test('RULING main POST rejects a hosted major that differs from PRE observation', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'readonly-main-post-'));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => new URL(url).pathname === '/rest/v1/'
    ? { ok: true, status: 200, headers: { get: name => name === 'x-postgrest-version' ? 'PostgREST/13.0.0' : null }, json: async () => ({}) }
    : { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ version: '2.151.0' }) };
  try {
    await withMainEnv({ DATABASE_URL: 'postgres://postgres@127.0.0.1:55422/postgres', E2E_DISPOSABLE_DATABASE: '1', SUPABASE_ANON_KEY: 'publishable' }, async () => {
      const pre = { target: 'disposable-readonly', phase: 'pre', queued: { per_row: {} }, platform_config: { postgres_major: '17', postgrest_major: '12', gotrue_major: '2', sha256: readableDigest(Buffer.from(JSON.stringify({ postgres_major: '17', postgrest_major: '12', gotrue_major: '2' }))) } };
      const prePath = path.join(dir, 'pre.json');
      writeFileSync(prePath, JSON.stringify(pre));
      await assert.rejects(main({ argv: { target: 'disposable-readonly', phase: 'post', org: '00000000-0000-0000-0000-000000000001', 'api-url': 'http://127.0.0.1:55421', 'pre-file': prePath }, createClient: fakeMainClient, collectData: async () => mainData('13') }), /PLATFORM_MISMATCH postgrest_major/);
    });
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
test('RULING Postgres and GoTrue remain blocking while PostgREST waiver is field-scoped', () => {
  fails('postgres', () => comparePlatform({postgres_major:'17',postgrest_major:'12',gotrue_major:'2'}, {postgres_major:'16',postgrest_major:NOT_VERIFIED,gotrue_major:'2'}), /PLATFORM_MISMATCH postgres_major/);
  fails('gotrue', () => comparePlatform({postgres_major:'17',postgrest_major:'12',gotrue_major:'2'}, {postgres_major:'17',postgrest_major:NOT_VERIFIED,gotrue_major:'1'}), /PLATFORM_MISMATCH gotrue_major/);
  assert.deepEqual(comparePlatform({postgres_major:'17',postgrest_major:'12',gotrue_major:'2'}, {postgres_major:'17',postgrest_major:NOT_VERIFIED,gotrue_major:'2'}), {waived_fields:['postgrest_major']});
  assert.doesNotThrow(() => compareObservedPlatform({postgres_major:'17',postgrest_major:NOT_VERIFIED,gotrue_major:'2'}, {postgres_major:'17',postgrest_major:'12',gotrue_major:'2'}));
  assert.doesNotThrow(() => compareObservedPlatform({postgres_major:'17',postgrest_major:NOT_VERIFIED,gotrue_major:'2'}, {postgres_major:'17',postgrest_major:NOT_VERIFIED,gotrue_major:'2'}));
  fails('non-exact waiver', () => compareObservedPlatform({postgres_major:'17',postgrest_major:'unknown',gotrue_major:'2'}, {postgres_major:'17',postgrest_major:NOT_VERIFIED,gotrue_major:'2'}), /PLATFORM_MISMATCH postgrest_major/);
  fails('observed mismatch', () => compareObservedPlatform({postgres_major:'17',postgrest_major:'12',gotrue_major:'2'}, {postgres_major:'17',postgrest_major:'13',gotrue_major:'2'}), /PLATFORM_MISMATCH postgrest_major/);
});
