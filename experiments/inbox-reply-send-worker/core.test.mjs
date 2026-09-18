import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchBatch, workerConfiguration, databaseConfiguration, createReadinessProbe } from './core.mjs';

const orgId = '11111111-1111-1111-1111-111111111111';
const opId = '22222222-2222-2222-2222-222222222222';
const eventId = '33333333-3333-3333-3333-333333333333';
const ingress = new URL('http://sandra-inbox-restate-owned:8080/');

function fakePool(entries, ackResults) {
  const acked = [];
  return {
    acked,
    query: async (statement) => {
      if (statement.includes('claim_dispatch_batch')) return { rows: [{ result: entries }] };
      if (statement.includes('ack_dispatch')) { const result = ackResults.shift(); acked.push(result); return { rows: [{ result }] }; }
      throw Error(`Unhandled: ${statement}`);
    },
  };
}

test('[Astra B4] dispatchBatch POSTs to /InboxReplySend/run/send, not the synchronous /run path', async () => {
  const entries = [{ org_id: orgId, operation_id: opId, event_id: eventId, generation: '1' }];
  const pool = fakePool(entries, [true]);
  let requestedUrl;
  const fetcher = async (url) => { requestedUrl = url; return { ok: true, body: streamOf({ status: 'Accepted', invocationId: 'inv_abc123' }) }; };
  const accepted = await dispatchBatch(pool, fetcher, ingress);
  assert.equal(accepted, 1);
  assert.equal(requestedUrl.pathname, '/InboxReplySend/run/send');
});

test('dispatchBatch does not ack when the outbox ack_dispatch call returns false (operation not yet complete)', async () => {
  const entries = [{ org_id: orgId, operation_id: opId, event_id: eventId, generation: '1' }];
  const pool = fakePool(entries, [false]);
  const fetcher = async () => ({ ok: true, body: streamOf({ status: 'Accepted', invocationId: 'inv_abc123' }) });
  const accepted = await dispatchBatch(pool, fetcher, ingress);
  assert.equal(accepted, 0, 'ack_dispatch=false must not count as accepted');
  assert.deepEqual(pool.acked, [false]);
});

test('dispatchBatch rejects a response missing the Accepted/PreviouslyAccepted envelope', async () => {
  const entries = [{ org_id: orgId, operation_id: opId, event_id: eventId, generation: '1' }];
  const pool = fakePool(entries, [true]);
  const fetcher = async () => ({ ok: true, body: streamOf({ status: 'Weird' }) });
  await assert.rejects(() => dispatchBatch(pool, fetcher, ingress), /Durable acceptance not confirmed/);
});

test('workerConfiguration rejects a non-approved ingress host', () => {
  assert.throws(() => workerConfiguration({ INBOX_RESTATE_INGRESS_URL: 'http://evil.example/', INBOX_RESTATE_IDENTITY_KEYS: '["publickeyv1_' + 'a'.repeat(45) + '"]' }), /Unapproved private Restate ingress/);
});

test('workerConfiguration accepts the approved production ingress host and validated keys', () => {
  const config = workerConfiguration({ INBOX_RESTATE_INGRESS_URL: 'http://sandra-inbox-restate-owned:8080/', INBOX_RESTATE_IDENTITY_KEYS: '["publickeyv1_' + 'a'.repeat(45) + '"]' });
  assert.equal(config.ingress.hostname, 'sandra-inbox-restate-owned');
  assert.equal(config.connections, 2);
});

test('workerConfiguration rejects a connection budget over two', () => {
  assert.throws(() => workerConfiguration({ INBOX_RESTATE_INGRESS_URL: 'http://sandra-inbox-restate-owned:8080/', INBOX_RESTATE_IDENTITY_KEYS: '["publickeyv1_' + 'a'.repeat(45) + '"]', INBOX_REPLY_SEND_CONNECTIONS: '3' }), /connection budget exceeds two/);
});

test('databaseConfiguration rejects a non-plaintext-fixture, non-supabase host', () => {
  assert.throws(() => databaseConfiguration({ INBOX_REPLY_SEND_DATABASE_URL: 'postgres://u:p@evil.example:5432/db' }), /Unapproved production database host/);
});

test('databaseConfiguration accepts only the marked release HTTP fixture with the constrained login', () => {
  const env = { NODE_ENV: 'test', INBOX_ACTION_LOCAL_FIXTURE: '1', INBOX_ACTION_FIXTURE_PROFILE: 'release-http', INBOX_REPLY_SEND_OWNED_FIXTURE_PLAINTEXT: 'true', INBOX_REPLY_SEND_FIXTURE_MARKER: 'sandra-inbox-http-owned-synthetic-20260917', INBOX_REPLY_SEND_FIXTURE_OWNER: 'release-infra', INBOX_REPLY_SEND_FIXTURE_PURPOSE: 'sandra-inbox-release-http', INBOX_REPLY_SEND_FIXTURE_LABELS_VERIFIED: 'true', INBOX_REPLY_SEND_DATABASE_URL: 'postgres://inbox_reply_send_worker:synthetic@127.0.0.1:54322/postgres' };
  const config = databaseConfiguration(env);
  assert.equal(config.port, 54322); assert.equal(config.ssl, false); assert.equal(config.user, 'inbox_reply_send_worker');
  for (const patch of [{ INBOX_REPLY_SEND_FIXTURE_MARKER: 'wrong' }, { INBOX_REPLY_SEND_FIXTURE_OWNER: 'postgres' }, { INBOX_REPLY_SEND_FIXTURE_PURPOSE: 'shared' }, { INBOX_REPLY_SEND_FIXTURE_LABELS_VERIFIED: 'false' }, { INBOX_REPLY_SEND_OWNED_FIXTURE_PLAINTEXT: 'false' }, { INBOX_REPLY_SEND_DATABASE_URL: 'postgres://inbox_reply_send_worker:synthetic@127.0.0.1:54321/postgres' }, { INBOX_REPLY_SEND_DATABASE_URL: 'postgres://inbox_reply_send_worker:synthetic@127.0.0.1:54322/other' }, { INBOX_REPLY_SEND_DATABASE_URL: 'postgres://postgres:synthetic@127.0.0.1:54322/postgres' }, { NODE_ENV: 'production' }, { INBOX_ACTION_LOCAL_FIXTURE: '0' }]) assert.throws(() => databaseConfiguration({ ...env, ...patch }));
});

test('createReadinessProbe caches a successful result for its TTL', async () => {
  let calls = 0;
  let now = 0;
  const probe = createReadinessProbe(async () => { calls++; return true; }, () => now);
  assert.equal(await probe.read(), true);
  assert.equal(calls, 1);
  now += 500; // still within the 2s cache window
  assert.equal(await probe.read(), true);
  assert.equal(calls, 1, 'cached result must not re-invoke the check');
  now += 2000; // past the cache window
  assert.equal(await probe.read(), true);
  assert.equal(calls, 2, 'an expired cache window must re-invoke the check');
});

test('createReadinessProbe.invalidate() marks not-ready immediately and holds that for a fresh cool-down window', async () => {
  let now = 0;
  const probe = createReadinessProbe(async () => true, () => now);
  assert.equal(await probe.read(), true);
  probe.invalidate();
  // invalidate() flips cached to false AND opens a fresh cool-down window, so
  // a read() immediately after returns false without re-running the check —
  // this is the dispatch-failure cool-down server.mjs relies on to avoid a
  // check storm right after a failure, not an "immediate fresh check".
  assert.equal(await probe.read(), false);
  now += 2000; // past the cool-down window
  assert.equal(await probe.read(), true);
});

function streamOf(json) {
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}
