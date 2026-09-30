import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createRunner } from './runner.mjs';

const ORG = '11111111-1111-1111-1111-111111111111';
const OPERATION = '22222222-2222-2222-2222-222222222222';
const ATTEMPT = '33333333-3333-3333-3333-333333333333';
const TOKEN = '44444444-4444-4444-4444-444444444444';

class FakePool {
  constructor() {
    this.claimCalls = 0;
    this.persistCalls = 0;
    this.persistInputs = [];
  }

  async connect() {
    return { query: (...args) => this.query(...args), release() {} };
  }

  async query(sql, params = []) {
    if (sql.includes('operation_attempts')) return { rows: [{ operation_attempts: ATTEMPT }] };
    if (sql.includes('worker_claim')) {
      this.claimCalls += 1;
      return { rows: [{ result: this.claimCalls === 1 ? { kind: 'claimed', generation: '1' } : { kind: 'existing', state: 'uncertain' } }] };
    }
    if (sql.includes('worker_start_dispatch')) {
      return { rows: [{ result: { kind: 'dispatch', token: TOKEN, from: '+12025550001', to: '+12025550002', body: 'approved reply' } }] };
    }
    if (sql.includes('worker_persist_result')) {
      this.persistCalls += 1;
      this.persistInputs.push(JSON.parse(params[3]));
      if (this.persistCalls === 1) throw Error('injected persist rollback');
      return { rows: [{ result: { state: 'provider_accepted', receipt_version: '2' } }] };
    }
    if (sql.includes('operation_dispatch_complete')) return { rows: [{ ready: true }] };
    throw Error(`unexpected fake SQL: ${sql}`);
  }
}

function journalContext() {
  const journal = new Map();
  return {
    async run(name, fn) {
      if (journal.has(name)) return journal.get(name);
      const value = await fn();
      journal.set(name, value);
      return value;
    },
  };
}

async function loadHandler() {
  const moduleUrl = process.env.REPLY_PERSIST_T4_HANDLER_MODULE
    ? pathToFileURL(process.env.REPLY_PERSIST_T4_HANDLER_MODULE).href
    : new URL('./handler.mjs', import.meta.url).href;
  return (await import(`${moduleUrl}?t4=${Date.now()}`)).createRunHandler;
}

async function runWithRestateRetry(handler, ctx, input) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try { return await handler(ctx, input); } catch (error) { lastError = error; }
  }
  throw lastError;
}

test('T4 separate journaled steps retry persist with one transport call', async () => {
  const pool = new FakePool();
  let transportCalls = 0;
  const runner = createRunner(pool, async () => {
    transportCalls += 1;
    return { kind: 'accepted', externalId: 'ext-1', providerStatus: 'sent' };
  });
  const handler = await loadHandler();
  const outcome = await runWithRestateRetry(handler({ runner, pool }), journalContext(), { orgId: ORG, operationId: OPERATION });

  assert.equal(transportCalls, 1);
  assert.equal(pool.persistCalls, 2);
  assert.deepEqual(pool.persistInputs[1], { kind: 'accepted', externalId: 'ext-1', status: 'sent' });
  assert.equal(outcome.attempts[0].state, 'provider_accepted');
  assert.equal(outcome.complete, true);
});
