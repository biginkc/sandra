import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { compareSets, reconcile, snapshot, openReadTxn, stabilityProbe, ACTIVE, planSkeleton } from './outbox-db-contract/readonly.mjs';
import { readonlyGet, comparePlatform, platformFingerprint } from './outbox-db-contract/platform.mjs';
import { assertTarget, parseArgs, compareCatalog } from './outbox-db-contract-readonly.mjs';

const row = (id, body='a') => ({ id, body, status:'queued', from_address:'x', to_address:'y', created_at:'2026-01-01', scheduled_for:null, property_id:null, contact_id:null });
function fails(label, fn, pattern) { assert.throws(fn, pattern, label); }
const TEST_REF='ncsngxlcyxylaeskiteu';
const PROD_REF='copflsklaefwzipsrjqz';
const hosted=ref=>`postgres://postgres.${ref}:unused@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
const api=ref=>`https://${ref}.supabase.co`;

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
  assert.match(entry,/await collect\(client, args\.org/);
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
  }));
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
  }));
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
  await assert.rejects(platformFingerprint('http://127.0.0.1:55421', 'anon', 17, transport), /PLATFORM_UNIDENTIFIED/);
});
test('Outbox source shape and claim pin', () => {
  const actions=readFileSync(new URL('../src/app/(dashboard)/messages/actions.ts',import.meta.url),'utf8');
  const cursor=readFileSync(new URL('../src/app/(dashboard)/messages/queued-cursor.ts',import.meta.url),'utf8');
  const claims=JSON.parse(readFileSync(new URL('./outbox-db-contract/expected/claims-shape.json',import.meta.url),'utf8'));
  assert.deepEqual(claims.keys,['sub','role','aud','email','exp']);
  for(const field of ['body','from_address','to_address','created_at','scheduled_for','property_id','contact_id','properties(id, address, city, state)','contacts(id, first_name, last_name, entity_name, phone_1)']) assert.ok(actions.includes(field),field);
  for(const fragment of ['scheduled_for.gt.','scheduled_for.eq.','scheduled_for.is.null','nullTail']) assert.ok(cursor.includes(fragment),fragment);
});

test('injected Seq Scan plan is rejected',()=>fails('scan',()=>planSkeleton({'Node Type':'Seq Scan','Relation Name':'messages'}),/FAIL SEQ_SCAN/));
test('platform performs exactly two unauthenticated GETs',async()=>{
  const calls=[];
  const { platformFingerprint }=await import('./outbox-db-contract/platform.mjs');
  const transport=async (url,options)=>{calls.push({path:new URL(url).pathname,method:options.method,headers:options.headers});return {ok:true,headers:{get:name=>name==='x-postgrest-version'?'12.2':null},json:async()=>({version:'2.1.0'})}};
  const result=await platformFingerprint('http://127.0.0.1:55421','anon',17,transport);
  assert.deepEqual(calls.map(x=>[x.path,x.method]),[['/rest/v1/','GET'],['/auth/v1/health','GET']]);
  assert.deepEqual(result.postgres_major,'17');
  assert.deepEqual(result.gotrue_major,'2');
});
