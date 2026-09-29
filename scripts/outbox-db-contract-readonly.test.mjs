import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { compareSets, reconcile, snapshot, openReadTxn, stabilityProbe, ACTIVE, planSkeleton } from './outbox-db-contract/readonly.mjs';
import { readonlyGet, comparePlatform } from './outbox-db-contract/platform.mjs';
import { assertTarget } from './outbox-db-contract-readonly.mjs';

const row = (id, body='a') => ({ id, body, status:'queued', updated_at:'2026-01-01', from_address:'x', to_address:'y', created_at:'2026-01-01', scheduled_for:null, property_id:null, contact_id:null });
function fails(label, fn, pattern) { assert.throws(fn, pattern, label); }
const TEST_REF='ncsngxlcyxylaeskiteu';
const PROD_REF='copflsklaefwzipsrjqz';
const hosted=ref=>`postgres://postgres.${ref}:unused@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
const api=ref=>`https://${ref}.supabase.co`;
test('NC-T5a, NC-A5 target boundary', () => {
  fails('shared loopback', () => assertTarget('shared-readonly','postgres://postgres@127.0.0.1:55422/test'), /TARGET_REFUSED/);
  fails('disposable hosted', () => assertTarget('disposable-readonly','postgres://postgres@db.example.supabase.co/test'), /TARGET_REFUSED/);
  for (const target of ['disposable','disposable-readonly','shared-readonly']) fails(`${target} prod ref`, () => assertTarget(target, hosted(PROD_REF), {apiUrl:api(PROD_REF)}), /TARGET_REFUSED/);
  assert.doesNotThrow(()=>assertTarget('shared-readonly',hosted(TEST_REF),{apiUrl:api(TEST_REF)}));
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
  const mixed=reconcile(before,snapshot([row('2','changed')]),{'1':{status:'sent',updated_at:'2026-01-02'}});
  assert.equal(mixed.verdict,'INCONCLUSIVE'); assert.deepEqual(mixed.diff.map(x=>x.kind),['departed','content_changed']);
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
  for (const source of [ro,plat]) assert.doesNotMatch(source,/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE)\b/);
  assert.doesNotMatch(ro,/fixture\.mjs|contracts\.mjs|\bfetch\(/);
  assert.doesNotMatch(plat,/\bfetch\(/);
  assert.match(ACTIVE,/access_expires_at > now\(\)/);
});
test('NC platform major mismatch',()=>fails('major',()=>comparePlatform({postgres_major:'17',postgrest_major:'12',gotrue_major:'2'},{postgres_major:'17',postgrest_major:'13',gotrue_major:'2'}),/PLATFORM_MISMATCH/));
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
