import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { createRequire } from 'node:module';
const { retryReceiptTransaction } = createRequire(import.meta.url)('../../src/lib/messaging/receipt-persistence.ts') as typeof import('../../src/lib/messaging/receipt-persistence');

// Fixed owned synthetic target: never accepts arbitrary URLs or credentials.
const connectionString = 'postgres://postgres@127.0.0.1:58782/sandra_inbox_t1';
const a = new pg.Client({ connectionString, connectionTimeoutMillis: 3000 });
const b = new pg.Client({ connectionString, connectionTimeoutMillis: 3000 });
const schema = `inbox_receipt_retry_${randomBytes(8).toString('hex')}`;
let created = false;
let proof: Record<string, unknown> | undefined;
try {
  await a.connect(); await b.connect();
  for (const client of [a,b]) {
    const marker = await client.query('select current_database() as db, marker from inbox_t1.fixture_identity');
    assert.deepEqual(marker.rows, [{ db:'sandra_inbox_t1', marker:'sandra-inbox-stack-t1-owned-synthetic' }]);
    await client.query("set statement_timeout = '5s'");
    await client.query("set lock_timeout = '2s'");
  }
  await a.query(`create schema ${schema}`); created = true;
  await a.query(`create table ${schema}.receipt(id int primary key, revision int not null, status text not null, external_id text)`);
  await a.query(`insert into ${schema}.receipt values(1,0,'pending',null)`);
  let attempts = 0;
  const abortCodes: string[] = [];
  // Fake acceptance is deliberately outside the retry closure. No provider exists here.
  let simulatedProviderCalls = 0;
  const accept = () => { simulatedProviderCalls++; return 'owned-synthetic-receipt'; };
  const externalId = accept();
  const result = await retryReceiptTransaction(async () => {
    attempts++;
    await a.query('begin isolation level repeatable read');
    try {
      await a.query(`select revision from ${schema}.receipt where id=1`);
      if (attempts === 1) {
        // Commit a real concurrent update after A's snapshot. A must abort with
        // PostgreSQL's genuine serialization error; no RAISE or mocked code.
        await b.query(`update ${schema}.receipt set revision=revision+1 where id=1`);
      }
      const update = await a.query(`update ${schema}.receipt set status='sent', external_id=$1 where id=1 and status='pending' returning id`, [externalId]);
      await a.query('commit');
      return { error:null, rows:update.rows };
    } catch (error) {
      await a.query('rollback');
      const code = (error as {code?:string}).code;
      if (code !== '40001') throw error;
      abortCodes.push(code);
      return { error:{code}, rows:[] };
    }
  });
  assert.equal(result.error,null); assert.equal(attempts,2);
  assert.equal(simulatedProviderCalls,1); assert.deepEqual(abortCodes,['40001']);
  const persisted = (await b.query(`select * from ${schema}.receipt`)).rows;
  assert.deepEqual(persisted,[{id:1,revision:1,status:'sent',external_id:externalId}]);
  proof = { status:'passed', attempts, simulatedProviderCalls, abortCodes, persisted,
    limits:'Actual helper and PostgreSQL serialization rollback/retry. Fake provider, no sendSmsToContact or PostgREST integration; no deadlock/process-death proof.' };
} finally {
  try {
    if (created) {
      await a.query('rollback');
      await a.query(`drop schema ${schema} cascade`);
      const remaining = await a.query('select 1 from pg_namespace where nspname=$1',[schema]);
      assert.equal(remaining.rowCount,0);
    }
  } finally { await Promise.allSettled([a.end(),b.end()]); }
}
assert.ok(proof);
const hash = async (file: URL) => createHash('sha256').update(await readFile(file)).digest('hex');
await writeFile(new URL('./evidence.json',import.meta.url),JSON.stringify({...proof,cleanup:'verified schema absent',at:new Date().toISOString(),sourceHashes:{harness:await hash(new URL('./run.ts',import.meta.url)),helper:await hash(new URL('../../src/lib/messaging/receipt-persistence.ts',import.meta.url))}},null,2)+'\n');
console.log('PASS: real serialization abort, fresh transaction retry, one simulated acceptance, committed receipt and verified cleanup');
