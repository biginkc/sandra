// node:test unit tests for runner.mjs's dispatchAttempt control flow, against
// a fake pg pool (no real database — the real SQL guards are proven against
// the actually-installed Postgres functions in proof.py). These check that
// the JS layer calls the right statements in the right order and never
// touches the provider transport unless start_dispatch returned an
// unambiguous {kind:'dispatch'}.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunner } from './runner.mjs';

const orgId = '11111111-1111-1111-1111-111111111111';
const opId = '22222222-2222-2222-2222-222222222222';
const attemptId = '33333333-3333-3333-3333-333333333333';
const token = '44444444-4444-4444-4444-444444444444';

function fakePool(handlers) {
  const calls = [];
  const client = {
    query: async (statement, params) => {
      for (const [needle, handler] of Object.entries(handlers)) {
        if (statement.includes(needle)) {
          calls.push(needle);
          const result = handler(params);
          if (result instanceof Error) throw result;
          return { rows: [{ result }] };
        }
      }
      throw Error(`Unhandled statement: ${statement}`);
    },
    release: () => { calls.push('release'); },
  };
  return {
    calls,
    connect: async () => client,
    query: (statement, params) => client.query(statement, params),
  };
}

test('T4 durable dispatch and persist steps keep one provider call across a persist retry', async () => {
  let releasedBeforeTransport = false;
  let persistCalls = 0;
  const pool = fakePool({
    worker_claim: () => ({ kind: 'claimed', generation: '1' }),
    worker_start_dispatch: () => ({ kind: 'dispatch', token, from: '+18165550001', to: '+18165550002', body: 'hi' }),
    worker_persist_result: () => { persistCalls += 1; if (persistCalls === 1) return Error('injected persist rollback'); return { state: 'provider_accepted' }; },
  });
  const transport = async () => { releasedBeforeTransport = pool.calls.includes('release'); return { kind: 'accepted', externalId: 'ext-1', providerStatus: 'sent' }; };
  const runner = createRunner(pool, transport);
  const dispatch = await runner.dispatchAttempt(orgId, opId, attemptId);
  assert.deepEqual(dispatch, { kind: 'dispatched', token, result: { kind: 'accepted', externalId: 'ext-1', status: 'sent' } });
  await assert.rejects(() => runner.persistAttempt(orgId, opId, attemptId, dispatch), /injected persist rollback/);
  const result = await runner.persistAttempt(orgId, opId, attemptId, dispatch);
  assert.deepEqual(result, { kind: 'settled', state: 'provider_accepted' });
  assert.equal(releasedBeforeTransport, true, 'connection must be released before the provider call');
  assert.deepEqual(pool.calls.filter(c => c !== 'release'), ['worker_claim', 'worker_start_dispatch', 'worker_persist_result', 'worker_persist_result']);
  assert.equal(persistCalls, 2);
});

test('a busy claim defers without ever calling start_dispatch', async () => {
  const pool = fakePool({ worker_claim: () => ({ kind: 'busy' }) });
  let transportCalled = false;
  const runner = createRunner(pool, async () => { transportCalled = true; return { kind: 'accepted', externalId: 'x', providerStatus: 'sent' }; });
  const result = await runner.dispatchAttempt(orgId, opId, attemptId);
  assert.deepEqual(result, { kind: 'deferred' });
  assert.equal(transportCalled, false);
});

test('an existing/settled claim never calls start_dispatch or the provider', async () => {
  const pool = fakePool({ worker_claim: () => ({ kind: 'existing', state: 'uncertain' }) });
  let transportCalled = false;
  const runner = createRunner(pool, async () => { transportCalled = true; return { kind: 'accepted', externalId: 'x', providerStatus: 'sent' }; });
  const result = await runner.dispatchAttempt(orgId, opId, attemptId);
  assert.deepEqual(result, { kind: 'settled', state: 'uncertain' });
  assert.equal(transportCalled, false);
});

test('SENDER_BUSY from start_dispatch maps to deferred, not not_sent, and never calls the provider', async () => {
  const pool = fakePool({
    worker_claim: () => ({ kind: 'claimed', generation: '1' }),
    worker_start_dispatch: () => Error('ERROR:  INBOX_REPLY_SENDER_BUSY'),
  });
  let transportCalled = false;
  const runner = createRunner(pool, async () => { transportCalled = true; return { kind: 'accepted', externalId: 'x', providerStatus: 'sent' }; });
  const result = await runner.dispatchAttempt(orgId, opId, attemptId);
  assert.deepEqual(result, { kind: 'deferred' });
  assert.equal(transportCalled, false);
});

test('an unauthorized-requester start_dispatch failure maps to not_sent and never calls the provider', async () => {
  const pool = fakePool({
    worker_claim: () => ({ kind: 'claimed', generation: '1' }),
    worker_start_dispatch: () => Error('ERROR:  INBOX_REPLY_REQUESTER_UNAUTHORIZED'),
  });
  let transportCalled = false;
  const runner = createRunner(pool, async () => { transportCalled = true; return { kind: 'accepted', externalId: 'x', providerStatus: 'sent' }; });
  const result = await runner.dispatchAttempt(orgId, opId, attemptId);
  assert.deepEqual(result, { kind: 'not_sent', reason: 'INBOX_REPLY_REQUESTER_UNAUTHORIZED' });
  assert.equal(transportCalled, false);
});

test('skipped_ineligible from start_dispatch is settled and never calls the provider', async () => {
  const pool = fakePool({
    worker_claim: () => ({ kind: 'claimed', generation: '1' }),
    worker_start_dispatch: () => ({ kind: 'skipped', reason: 'conversation_window_expired' }),
  });
  let transportCalled = false;
  const runner = createRunner(pool, async () => { transportCalled = true; return { kind: 'accepted', externalId: 'x', providerStatus: 'sent' }; });
  const result = await runner.dispatchAttempt(orgId, opId, attemptId);
  assert.deepEqual(result, { kind: 'settled', state: 'skipped_ineligible' });
  assert.equal(transportCalled, false);
});

test('T2 a thrown transport is journaled as uncertain and never retried in dispatch', async () => {
  const pool = fakePool({
    worker_claim: () => ({ kind: 'claimed', generation: '1' }),
    worker_start_dispatch: () => ({ kind: 'dispatch', token, from: '+18165550001', to: '+18165550002', body: 'hi' }),
    worker_persist_result: (params) => { assert.equal(JSON.parse(params[3]).kind, 'uncertain'); return { state: 'uncertain' }; },
  });
  const runner = createRunner(pool, async () => { throw Error('transport lost'); });
  const dispatch = await runner.dispatchAttempt(orgId, opId, attemptId);
  assert.equal(dispatch.kind, 'dispatched');
  const result = await runner.persistAttempt(orgId, opId, attemptId, dispatch);
  assert.deepEqual(result, { kind: 'settled', state: 'uncertain' });
});

test('T3 a persist-step retry uses worker_persist_result rather than worker_persist directly', async () => {
  let calls = 0;
  const pool = fakePool({
    worker_persist_result: () => { calls += 1; if (calls === 1) return Error('serialization failure'); return { state: 'confirmed_not_submitted' }; },
  });
  const runner = createRunner(pool, async () => { throw Error('not used'); });
  const dispatch = { kind: 'dispatched', token, result: { kind: 'not_attempted', reason: 'invalid_input' } };
  await assert.rejects(() => runner.persistAttempt(orgId, opId, attemptId, dispatch), /serialization failure/);
  await assert.doesNotReject(async () => {
    assert.deepEqual(await runner.persistAttempt(orgId, opId, attemptId, dispatch), { kind: 'settled', state: 'confirmed_not_submitted' });
  });
  assert.equal(calls, 2);
});

test('T5 an uncertain re-entry can persist a not_attempted result without raising', async () => {
  const pool = fakePool({ worker_persist_result: (params) => { assert.equal(JSON.parse(params[3]).kind, 'not_attempted'); return { state: 'uncertain' }; } });
  const runner = createRunner(pool, async () => { throw Error('not used'); });
  await assert.doesNotReject(async () => {
    assert.deepEqual(await runner.persistAttempt(orgId, opId, attemptId, { kind: 'dispatched', token, result: { kind: 'not_attempted', reason: 'cancelled_before_dispatch' } }), { kind: 'settled', state: 'uncertain' });
  });
});

test('unmapped persisted state throws rather than silently passing through', async () => {
  const pool = fakePool({
    worker_persist_result: () => ({ state: 'made_up_state' }),
  });
  const runner = createRunner(pool, async () => ({ kind: 'accepted', externalId: 'x', providerStatus: 'sent' }));
  await assert.rejects(() => runner.persistAttempt(orgId, opId, attemptId, { kind: 'dispatched', token, result: { kind: 'accepted', externalId: 'x', status: 'sent' } }), /Unmapped reply attempt state/);
});

test('operationAttempts maps the SETOF uuid rows to a plain array', async () => {
  const pool = { query: async () => ({ rows: [{ operation_attempts: attemptId }] }) };
  const runner = createRunner(pool, async () => { throw Error('not used'); });
  const ids = await runner.operationAttempts(orgId, opId);
  assert.deepEqual(ids, [attemptId]);
});
