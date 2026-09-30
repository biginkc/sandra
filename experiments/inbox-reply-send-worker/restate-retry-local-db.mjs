import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const MIGRATION = new URL('../../supabase/migrations/20260930040200_inbox_backend_operation_reply.sql', import.meta.url);
const DEFAULT_HOST = '/tmp/sandra-reply-persist-pg.pPmk5e/socket';
const DEFAULT_PORT = '55436';

function ids(n) {
  const tail = n.toString(16).padStart(2, '0');
  const uuid = (prefix) => `${prefix}-0000-4000-8000-0000000000${tail}`;
  return { o: uuid('11111111'), c: uuid('22222222'), p: uuid('33333333'), i: uuid('44444444'), prep: uuid('55555555'), op: uuid('66666666'), a: uuid('77777777'), conv: uuid('88888888'), token: uuid('99999999') };
}

function secondIds(n) {
  const x = ids(n);
  const y = ids(n + 1);
  return { ...x, i: y.i, a: y.a, conv: y.conv, token: y.token };
}

function itemValue(n, offset = 0) {
  const x = ids(n + offset);
  const owner = ids(n);
  const to = offset === 0 ? '+12025550101' : `+1202555${String(n + offset).padStart(4, '0')}`;
  return `jsonb_build_object('id','${x.i}'::uuid,'target',jsonb_build_object('kind','conversation','id','${x.conv}'::uuid),'recipient',jsonb_build_object('contactId','${owner.c}'::uuid,'from','+12025550001','to','${to}','propertyId','${owner.p}'::uuid,'renderedBody','hello-${n}'),'validUntil','2999-01-01T00:00:00Z','state','MO','dependencies',jsonb_build_object('head',1))`;
}

function attemptSql(n, second = false) {
  const x = ids(n);
  const y = second ? secondIds(n) : x;
  const to = second ? `+1202555${String(n + 1).padStart(4, '0')}` : '+12025550101';
  return `INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state) VALUES('${x.o}','${y.a}','${x.op}','${x.prep}','${y.i}',1,'${x.c}','+12025550001','${to}',inbox_reply_send.body_hash('hello-${n}','+12025550001','${to}'),'approved');`;
}

function poolConfig() {
  return {
    host: process.env.PROJECTION_PGHOST ?? DEFAULT_HOST,
    port: Number(process.env.PROJECTION_PGPORT ?? DEFAULT_PORT),
    user: process.env.PROJECTION_PGUSER ?? 'postgres',
    database: process.env.PROJECTION_PGDATABASE ?? 'postgres',
    password: process.env.PROJECTION_PGPASSWORD,
    max: 4,
    statement_timeout: 15_000,
    query_timeout: 20_000,
    application_name: 'restate-retry-local-db-r5',
  };
}

class JournalingContext {
  #journal = new Map();

  async run(name, closure) {
    if (this.#journal.has(name)) return this.#journal.get(name);
    try {
      const value = await closure();
      this.#journal.set(name, value);
      return value;
    } catch (error) {
      throw error;
    }
  }
}

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitPastLease(pool, n) {
  const x = ids(n);
  const result = await pool.query('SELECT lease_until FROM inbox_reply_send.attempts WHERE org_id=$1 AND id=$2', [x.o, x.a]);
  const lease = result.rows[0]?.lease_until;
  if (lease) await sleep(Math.max(0, new Date(lease).getTime() - Date.now() + 250));
}

async function withClient(pool, callback) {
  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

async function seed(pool, n, { items = 1, validUntilSeconds = 30, markerFault = false, markerSleep = false, secondAttempt = false, revoked = false } = {}) {
  const x = ids(n);
  const y = ids(n + 1);
  const trigger = markerFault ? `
CREATE SEQUENCE inbox_reply_test.restate_r12_fault;
CREATE OR REPLACE FUNCTION inbox_reply_test.restate_r12_marker_fault() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state='claimed' AND NEW.state='dispatch_started' AND nextval('inbox_reply_test.restate_r12_fault')=1 THEN
  RAISE EXCEPTION 'INBOX_REPLY_WINDOW_EXPIRED_AT_MARKER';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zzz_restate_r12_marker_fault BEFORE UPDATE OF state ON inbox_reply_send.attempts FOR EACH ROW EXECUTE FUNCTION inbox_reply_test.restate_r12_marker_fault();` : '';
  const sleepTrigger = markerSleep ? `
CREATE OR REPLACE FUNCTION inbox_reply_test.restate_r12b_marker_sleep() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expires timestamptz;
BEGIN
 IF OLD.state='claimed' AND NEW.state='dispatch_started' THEN
  SELECT (value->>'validUntil')::timestamptz INTO expires FROM inbox_reply_review.preparations p,jsonb_array_elements(p.items) value WHERE p.id=NEW.preparation_id AND (value->>'id')::uuid=NEW.item_id;
  WHILE clock_timestamp() <= expires + interval '1 second' LOOP PERFORM pg_sleep(0.25); END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zzz_restate_r12b_marker_sleep BEFORE UPDATE OF state ON inbox_reply_send.attempts FOR EACH ROW EXECUTE FUNCTION inbox_reply_test.restate_r12b_marker_sleep();` : '';
  const itemList = Array.from({ length: items }, (_, offset) => itemValue(n, offset)).join(',');
  const secondOwner = secondAttempt ? `
INSERT INTO auth.users(id,email) VALUES('${y.c}','restate-local-db-${n}-second-owner@example.invalid');
INSERT INTO memberships(user_id,org_id,role,access_status) VALUES('${y.c}','${x.o}','owner','active');` : '';
  const attempts = `${attemptSql(n)}${secondAttempt ? attemptSql(n, true) : ''}`;
  const outbox = `INSERT INTO inbox_reply_send.dispatch_outbox(org_id,operation_id) VALUES('${x.o}','${x.op}');`;
  const revoke = revoked ? `UPDATE memberships SET access_status='revoked' WHERE user_id='${x.c}' AND org_id='${x.o}';` : '';
  const validity = `ALTER TABLE inbox_reply_review.preparations DISABLE TRIGGER immutable_reply_preparation;
UPDATE inbox_reply_review.preparations SET items=(SELECT jsonb_agg(jsonb_set(value,'{validUntil}',to_jsonb((clock_timestamp()+interval '${validUntilSeconds} seconds')::text))) FROM jsonb_array_elements(items) value) WHERE id='${x.prep}';
ALTER TABLE inbox_reply_review.preparations ENABLE TRIGGER immutable_reply_preparation;`;
  await withClient(pool, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(`
INSERT INTO organizations(id,name) VALUES('${x.o}','projection-test-${n}');
INSERT INTO contacts(id,org_id,first_name,phone_1,phone_1_type) VALUES('${x.c}','${x.o}','Projection','+12025550101','mobile');
INSERT INTO consent_events(contact_id,channel,event_type,source) VALUES('${x.c}','sms','opt_in_marketing_written','projection-test');
INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES('${x.p}','${x.o}','Projection Test ${n}','MO','${x.c}');
INSERT INTO auth.users(id,email) VALUES('${x.c}','restate-local-db-${n}@example.invalid');
INSERT INTO memberships(user_id,org_id,role,access_status) VALUES('${x.c}','${x.o}','owner','active');
${secondOwner}
INSERT INTO inbox_reply_review.preparations(id,org_id,requester_id,request_key,input_hash,canonical_input,items,expires_at) VALUES('${x.prep}','${x.o}','${x.c}',gen_random_uuid(),'x','{}','[${itemList}]'::jsonb,clock_timestamp()+interval '1 hour');
INSERT INTO inbox_reply_send.operations(org_id,id,requester_id,preparation_id,idempotency_key) VALUES('${x.o}','${x.op}','${x.c}','${x.prep}',gen_random_uuid());
INSERT INTO provider_sender_numbers(id,org_id,provider,phone_e164,provider_number_id,status,messaging_status) VALUES('${x.token}','${x.o}','sendillo','+12025550001','restate-local-db-${n}','active','active');
INSERT INTO inbox_inbound_heads(org_id,conversation_id,revision) VALUES('${x.o}','${x.conv}',1);
CREATE SCHEMA IF NOT EXISTS inbox_reply_test;
UPDATE inbox_reply_review.admission SET enabled=true;
${trigger}
${sleepTrigger}
${validity}
${attempts}
${outbox}
${revoke}
`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

async function cleanup(pool, n) {
  const x = ids(n);
  const extra = n === 13 ? `DELETE FROM auth.users WHERE id='${ids(n + 1).c}';` : '';
  await withClient(pool, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL session_replication_role='replica';
DROP SCHEMA IF EXISTS inbox_reply_test CASCADE;
DELETE FROM inbox_reply_send.message_projection_backlog WHERE org_id='${x.o}';
DELETE FROM inbox_reply_send.dispatch_outbox WHERE org_id='${x.o}';
DELETE FROM inbox_reply_send.callback_receipts WHERE org_id='${x.o}';
DELETE FROM inbox_reply_send.unmatched_callbacks WHERE provider='sendillo' AND (provider_reference LIKE 'ext-${n}-%' OR provider_reference='ext-${n}');
DELETE FROM inbox_reply_send.attempts WHERE org_id='${x.o}';
DELETE FROM inbox_reply_send.operations WHERE org_id='${x.o}';
DELETE FROM inbox_reply_review.preparations WHERE org_id='${x.o}';
DELETE FROM inbox_inbound_heads WHERE org_id='${x.o}';
DELETE FROM public.messages WHERE org_id='${x.o}';
DELETE FROM public.memberships WHERE org_id='${x.o}';
DELETE FROM provider_sender_numbers WHERE org_id='${x.o}';
DELETE FROM public.properties WHERE org_id='${x.o}';
DELETE FROM consent_events WHERE contact_id='${x.c}';
DELETE FROM public.contacts WHERE org_id='${x.o}';
DELETE FROM organizations WHERE id='${x.o}';
DELETE FROM auth.users WHERE id='${x.c}';
${extra}`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

async function ledger(pool, n) {
  const x = ids(n);
  return (await pool.query('SELECT state,generation,dispatch_started_at,dispatch_token,lease_until,evidence FROM inbox_reply_send.attempts WHERE org_id=$1 AND id=$2', [x.o, x.a])).rows[0];
}

async function expectPlainNotSettled(action, reason) {
  await assert.rejects(action, (error) => {
    assert.equal(error?.constructor, Error);
    assert.match(error.message, /not yet settled/);
    if (reason) assert.match(error.message, new RegExp(reason));
    return true;
  });
}

async function freshAck(pool, n, expected) {
  const x = ids(n);
  const existing = (await pool.query('SELECT lease_until FROM inbox_reply_send.dispatch_outbox WHERE org_id=$1 AND operation_id=$2', [x.o, x.op])).rows[0]?.lease_until;
  if (existing && new Date(existing).getTime() > Date.now()) await sleep(new Date(existing).getTime() - Date.now() + 250);
  const claim = (await pool.query('SELECT inbox_reply_send.claim_dispatch_batch(20) AS result')).rows[0]?.result;
  const entry = Array.isArray(claim) ? claim.find((candidate) => candidate.operation_id === x.op) : undefined;
  assert.ok(entry, `H3 did not claim operation ${x.op}`);
  const live = (await pool.query('SELECT lease_until > clock_timestamp() AS live FROM inbox_reply_send.dispatch_outbox WHERE org_id=$1 AND operation_id=$2', [x.o, x.op])).rows[0]?.live;
  assert.equal(live, true, 'H3 ack was not attempted while g lease was live');
  const ack = (await pool.query('SELECT inbox_reply_send.ack_dispatch($1,$2,$3) AS result', [x.o, x.op, entry.generation])).rows[0]?.result;
  assert.equal(ack, expected);
  return { generation: entry.generation, leaseLive: live, ack };
}

async function loadWorker() {
  const runnerPath = process.env.REPLY_PERSIST_RUNNER_MODULE ?? fileURLToPath(new URL('./runner.mjs', import.meta.url));
  const handlerPath = process.env.REPLY_PERSIST_LOCAL_DB_HANDLER_MODULE ?? fileURLToPath(new URL('./handler.mjs', import.meta.url));
  const suffix = `?localdb=${Date.now()}`;
  const [{ createRunner }, { createRunHandler }] = await Promise.all([
    import(`${pathToFileURL(runnerPath).href}${suffix}`),
    import(`${pathToFileURL(handlerPath).href}${suffix}`),
  ]);
  return { createRunner, createRunHandler };
}

async function runT12(pool) {
  const n = 12;
  const x = ids(n);
  let transportCalls = 0;
  const { createRunner, createRunHandler } = await loadWorker();
  const runner = createRunner(pool, async () => { transportCalls += 1; return { kind: 'accepted', externalId: 'unused', providerStatus: 'sent' }; });
  const handler = createRunHandler({ runner, pool });
  const ctx = new JournalingContext();
  const input = { orgId: x.o, operationId: x.op };
  await seed(pool, n, { validUntilSeconds: 30, markerFault: true });
  try {
    await expectPlainNotSettled(() => handler(ctx, input), 'INBOX_REPLY_WINDOW_EXPIRED_AT_MARKER');
    const first = await ledger(pool, n);
    assert.equal(first.state, 'claimed');
    assert.equal(first.generation, '1');
    assert.equal(first.dispatch_started_at, null);
    assert.equal(first.dispatch_token, null);
    assert.equal((await pool.query('SELECT last_value FROM inbox_reply_test.restate_r12_fault')).rows[0].last_value, '1');
    assert.equal(transportCalls, 0);

    await sleep(10_000);
    const insideLease = await ledger(pool, n);
    await expectPlainNotSettled(() => handler(ctx, input), 'deferred');
    assert.deepEqual(await ledger(pool, n), insideLease);

    await waitPastLease(pool, n);
    const result = await handler(ctx, input);
    assert.equal(result.attempts[0].state, 'skipped_ineligible');
    assert.equal(result.complete, true);
    const finished = await ledger(pool, n);
    assert.equal(finished.state, 'skipped_ineligible');
    assert.equal(finished.evidence, 'conversation_window_expired');
    assert.equal(transportCalls, 0);
    assert.equal((await pool.query('SELECT inbox_reply_send.operation_dispatch_complete($1,$2) AS ready', [x.o, x.op])).rows[0].ready, true);
    const ack = await freshAck(pool, n, true);
    assert.equal(ack.leaseLive, true);
    return 'T-R12 PASS not_sent retried; H2 deferred inside g1; g2 skipped expired item; H3 lease live and ack true';
  } finally {
    await cleanup(pool, n);
  }
}

async function runT12b(pool) {
  const n = 120;
  const x = ids(n);
  let transportCalls = 0;
  const { createRunner, createRunHandler } = await loadWorker();
  const runner = createRunner(pool, async () => { transportCalls += 1; return { kind: 'accepted', externalId: 'mutant-only', providerStatus: 'sent' }; });
  const handler = createRunHandler({ runner, pool });
  const ctx = new JournalingContext();
  const input = { orgId: x.o, operationId: x.op };
  await seed(pool, n, { validUntilSeconds: 5, markerSleep: true });
  const source = await readFile(MIGRATION, 'utf8');
  const match = source.match(/CREATE FUNCTION inbox_reply_send\.start_dispatch\(.*?END \$\$;/s);
  assert.ok(match, 'start_dispatch fixture copy was not found');
  const original = match[0].replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
  const replacement = original.replace("  ev:=inbox_reply_send.item_current(o,frozen);\n  IF ev IS NOT NULL THEN RAISE EXCEPTION 'stale after marker' USING ERRCODE='IR001';END IF;\n", '', 1);
  assert.notEqual(replacement, original);
  const fixtureMutation = process.env.RESTATE_LOCAL_DB_FIXTURE_VARIANT === 'T-R12b-drop-post-marker';
  try {
    if (fixtureMutation) await pool.query(replacement);
    const result = await handler(ctx, input);
    assert.equal(result.attempts[0].state, 'skipped_ineligible');
    assert.equal(result.complete, true);
    const row = await ledger(pool, n);
    assert.equal(row.state, 'skipped_ineligible');
    assert.equal(row.evidence, 'conversation_window_expired');
    assert.equal(row.dispatch_started_at, null);
    assert.equal(transportCalls, 0);
    const ack = await freshAck(pool, n, true);
    assert.equal(ack.leaseLive, true);
    return 'T-R12b PASS post-marker expiry rechecked with no transport; H3 lease live and ack true';
  } finally {
    if (fixtureMutation) await pool.query(original);
    await cleanup(pool, n);
  }
}

async function runT13(pool) {
  const n = 13;
  const x = ids(n);
  const second = secondIds(n);
  let transportCalls = 0;
  const { createRunner, createRunHandler } = await loadWorker();
  const runner = createRunner(pool, async () => { transportCalls += 1; return { kind: 'accepted', externalId: 'unused', providerStatus: 'sent' }; });
  const handler = createRunHandler({ runner, pool });
  const ctx = new JournalingContext();
  const input = { orgId: x.o, operationId: x.op };
  await seed(pool, n, { validUntilSeconds: 600, secondAttempt: true, revoked: true });
  try {
    await expectPlainNotSettled(() => handler(ctx, input), 'INBOX_REPLY_REQUESTER_UNAUTHORIZED');
    assert.equal((await ledger(pool, n)).state, 'claimed');
    assert.equal((await pool.query('SELECT state FROM inbox_reply_send.attempts WHERE org_id=$1 AND id=$2', [x.o, second.a])).rows[0].state, 'approved');
    assert.equal(transportCalls, 0);

    await sleep(10_000);
    const beforeDeferred = await ledger(pool, n);
    await expectPlainNotSettled(() => handler(ctx, input), 'deferred');
    assert.deepEqual(await ledger(pool, n), beforeDeferred);
    assert.equal((await pool.query('SELECT state FROM inbox_reply_send.attempts WHERE org_id=$1 AND id=$2', [x.o, second.a])).rows[0].state, 'approved');

    await waitPastLease(pool, n);
    await expectPlainNotSettled(() => handler(ctx, input), 'INBOX_REPLY_REQUESTER_UNAUTHORIZED');
    const secondPass = await ledger(pool, n);
    assert.equal(secondPass.state, 'claimed');
    assert.equal(secondPass.generation, '2');
    assert.equal((await pool.query('SELECT state FROM inbox_reply_send.attempts WHERE org_id=$1 AND id=$2', [x.o, second.a])).rows[0].state, 'approved');

    await sleep(10_000);
    const beforeSecondDeferred = await ledger(pool, n);
    await expectPlainNotSettled(() => handler(ctx, input), 'deferred');
    assert.deepEqual(await ledger(pool, n), beforeSecondDeferred);
    assert.equal(transportCalls, 0);
    assert.equal((await pool.query('SELECT inbox_reply_send.operation_dispatch_complete($1,$2) AS ready', [x.o, x.op])).rows[0].ready, false);
    const ack = await freshAck(pool, n, false);
    assert.equal(ack.leaseLive, true);
    return 'T-R13 PASS unauthorized is not_sent; H2 deferred twice; attempt 2 approved; handler never completes; H3 lease live and ack false';
  } finally {
    await cleanup(pool, n);
  }
}

async function prerequisite(pool) {
  const result = await pool.query(`SELECT to_regprocedure('inbox_reply_send.worker_start_dispatch(uuid,uuid,bigint)') IS NOT NULL AS start_dispatch,
    to_regprocedure('inbox_reply_send.claim_dispatch_batch(integer)') IS NOT NULL AS claim_batch,
    to_regclass('inbox_reply_send.attempts') IS NOT NULL AS attempts,
    to_regclass('inbox_reply_review.preparations') IS NOT NULL AS preparations`);
  const row = result.rows[0];
  if (!row.start_dispatch || !row.claim_batch || !row.attempts || !row.preparations) throw Error('reply worker fixture is unavailable');
}

async function main() {
  const name = process.argv.find((value) => /^T-R(12b|12|13)$/.test(value));
  if (!name) throw Error('one of T-R12, T-R12b or T-R13 is required');
  const pool = new Pool(poolConfig());
  try {
    try {
      await prerequisite(pool);
    } catch (error) {
      console.log(`NOT RUN: disposable local Postgres reply-worker fixture is unavailable (${error.message})`);
      return 2;
    }
    const message = name === 'T-R12' ? await runT12(pool) : name === 'T-R12b' ? await runT12b(pool) : await runT13(pool);
    console.log(message);
    return 0;
  } finally {
    await pool.end();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
}
