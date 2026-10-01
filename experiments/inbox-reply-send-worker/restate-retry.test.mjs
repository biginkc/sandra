import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRunner } from './runner.mjs';
import { createInboxReplySendService, inboxReplySendServiceOptions } from './service.mjs';
import { createProductionDispatchBatch, createStallLogger, dispatchBatchWithStalls } from './core.mjs';
import { createTestReplyTransport } from './vendor/test-transport.mjs';

const ORG = '11111111-1111-1111-1111-111111111111';
const OPERATION = '22222222-2222-2222-2222-222222222222';
const EVENT = '33333333-3333-3333-3333-333333333333';
const ATTEMPT = '33333333-3333-4333-8333-333333333333';
const TOKEN = '44444444-4444-4444-8444-444444444444';
const HUGE_OPERATION = '55555555-5555-4555-8555-555555555555';

function fakePool(entry, acknowledgment = false) {
  return {
    async query(statement) {
      if (statement.includes('claim_dispatch_batch')) return { rows: [{ result: [entry] }] };
      if (statement.includes('ack_dispatch')) return { rows: [{ result: acknowledgment }] };
      throw Error(`unexpected SQL: ${statement}`);
    },
  };
}

function acceptedResponse(status = 'PreviouslyAccepted', invocationId = 'inv_stall1') {
  const bytes = new TextEncoder().encode(JSON.stringify({ status, invocationId }));
  return { ok: true, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
}

async function loadRunHandler() {
  const modulePath = process.env.REPLY_PERSIST_T_R8_HANDLER_MODULE
    ?? fileURLToPath(new URL('./handler.mjs', import.meta.url));
  return (await import(`${pathToFileURL(modulePath).href}?tr8=${Date.now()}`)).createRunHandler;
}

test('T-R1 LOCAL SDK discovery exposes the approved retry policy and timeouts', async () => {
  const restate = await import('@restatedev/restate-sdk');
  const { createEndpointHandler } = await import('@restatedev/restate-sdk/node');
  const service = createInboxReplySendService(restate, async () => {});
  const endpoint = createEndpointHandler({ services: [service] });
  const server = http.createServer((request, response) => endpoint(request, response));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/discover`, {
      headers: { Accept: 'application/vnd.restate.endpointmanifest.v4+json' },
    });
    assert.equal(response.status, 200);
    const manifest = await response.json();
    const discovered = manifest.services?.find((candidate) => candidate.name === 'InboxReplySend');
    assert.ok(discovered, 'InboxReplySend is absent from the discovery manifest');
    assert.equal(discovered.retryPolicyMaxAttempts, 70);
    assert.equal(discovered.retryPolicyOnMaxAttempts, 'PAUSE');
    assert.equal(discovered.retryPolicyInitialInterval, 500);
    assert.equal(discovered.retryPolicyMaxInterval, 60_000);
    assert.equal(discovered.retryPolicyExponentiationFactor, 2);
    assert.equal(discovered.inactivityTimeout, 180_000);
    assert.equal(discovered.abortTimeout, 600_000);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('T-R6 LOCAL stall logging uses the exact generation fence and 60-minute operation throttle', async () => {
  let now = 0;
  const lines = [];
  const stallLogger = createStallLogger(() => now, (line) => lines.push(line));
  const fetcher = async () => acceptedResponse();
  const entry = (generation, operationId = OPERATION) => ({ org_id: ORG, operation_id: operationId, event_id: EVENT, generation: String(generation) });

  await dispatchBatchWithStalls(fakePool(entry(149)), fetcher, new URL('http://sandra-inbox-restate-owned:8080/'), { stallLogger });
  assert.equal(lines.length, 0);
  await dispatchBatchWithStalls(fakePool(entry(150)), () => acceptedResponse('Accepted', 'inv_firstattempt'), new URL('http://sandra-inbox-restate-owned:8080/'), { stallLogger });
  assert.equal(lines.length, 0);
  await dispatchBatchWithStalls(fakePool(entry(152)), fetcher, new URL('http://sandra-inbox-restate-owned:8080/'), { stallLogger });
  assert.equal(lines.length, 1);
  await dispatchBatchWithStalls(fakePool(entry(152)), fetcher, new URL('http://sandra-inbox-restate-owned:8080/'), { stallLogger });
  assert.equal(lines.length, 1);
  now = 60 * 60_000 + 1;
  await dispatchBatchWithStalls(fakePool(entry(152)), fetcher, new URL('http://sandra-inbox-restate-owned:8080/'), { stallLogger });
  assert.equal(lines.length, 2);
  const parsed = JSON.parse(lines[0].slice('inbox_reply_send_stalled '.length));
  assert.deepEqual(Object.keys(parsed).sort(), ['event_id', 'generation', 'invocation_id', 'operation_id']);
  assert.equal(parsed.operation_id, OPERATION);
  assert.equal(parsed.event_id, EVENT);
  assert.equal(parsed.invocation_id, 'inv_stall1');
  assert.equal(parsed.generation, '152');
  await dispatchBatchWithStalls(fakePool(entry('9223372036854775807', HUGE_OPERATION)), fetcher, new URL('http://sandra-inbox-restate-owned:8080/'), { stallLogger });
  assert.equal(lines.length, 3);
  const huge = JSON.parse(lines[2].slice('inbox_reply_send_stalled '.length));
  assert.equal(huge.generation, '9223372036854775807');
});

test('T-R14 PRODUCTION wiring reuses one stall throttle across dispatch passes', async () => {
  let now = 0;
  const lines = [];
  const dispatchBatch = createProductionDispatchBatch({ clock: () => now, write: (line) => lines.push(line) });
  const fetcher = async () => acceptedResponse();
  const entry = { org_id: ORG, operation_id: OPERATION, event_id: EVENT, generation: '150' };
  const ingress = new URL('http://sandra-inbox-restate-owned:8080/');

  await dispatchBatch(fakePool(entry), fetcher, ingress);
  now = 59 * 60_000 + 59_999;
  await dispatchBatch(fakePool(entry), fetcher, ingress);
  assert.equal(lines.length, 1, 'production dispatch passes must share the 60-minute operation throttle');

  now = 61 * 60_000;
  await dispatchBatch(fakePool(entry), fetcher, ingress);
  assert.equal(lines.length, 2, 'the same stalled operation may log again after 61 minutes');
});

test('T-R7 LOCAL every local worker import is included in the Docker image and bind is IPv6', async () => {
  const dockerfile = await readFile(new URL('./Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /INBOX_WORKER_BIND=::/);
  const copied = new Set();
  for (const line of dockerfile.split('\n').filter((value) => value.startsWith('COPY '))) {
    const tokens = line.split(/\s+/).slice(1).filter((value) => !value.startsWith('--'));
    for (const token of tokens.slice(0, -1)) if (token.endsWith('.mjs')) copied.add(token);
  }
  const seen = new Set();
  const stack = ['server.mjs', 'handler.mjs'];
  while (stack.length) {
    const name = stack.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    assert.ok(copied.has(name), `${name} is imported locally but not COPY'd`);
    const source = await readFile(new URL(`./${name}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/(?:from|import\()\s*["']\.\/([^"']+\.mjs)["']/g)) stack.push(match[1]);
  }
});

test('T-R8 LOCAL invalid input is a plain retryable Error and every ctx.run call has two arguments', async () => {
  let TerminalError;
  try { TerminalError = (await import('@restatedev/restate-sdk')).TerminalError; } catch (error) { if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  let runs = 0;
  const ctx = { run(...args) { assert.equal(args.length, 2); runs += 1; return args[1](); } };
  const runner = {
    async operationAttempts() { return [ATTEMPT]; },
    async dispatchAttempt() { return { kind: 'dispatched', token: TOKEN, result: { kind: 'accepted', externalId: 'ext-r8', status: 'sent' } }; },
    async persistAttempt() { return { kind: 'settled', state: 'provider_accepted' }; },
  };
  const pool = { async query() { return { rows: [{ ready: true }] }; } };
  const createRunHandler = await loadRunHandler();
  const handler = createRunHandler({ runner, pool });
  for (const input of [null, {}, { orgId: ORG }, { orgId: ORG, operationId: OPERATION, extra: true }]) {
    await assert.rejects(() => handler(ctx, input), (error) => error instanceof Error && error.constructor === Error && (!TerminalError || !(error instanceof TerminalError)));
  }
  assert.equal(runs, 0);
  const outcome = await handler(ctx, { orgId: ORG, operationId: OPERATION });
  assert.equal(outcome.complete, true);
  assert.equal(outcome.attempts[0].state, 'provider_accepted');
  assert.equal(runs, 4);

  const realRunner = createRunner({
    async query(statement) {
      assert.match(statement, /worker_persist_result/);
      return { rows: [{ result: { state: 'provider_accepted' } }] };
    },
  }, async () => { throw Error('not used'); });
  await assert.doesNotReject(async () => {
    assert.deepEqual(await realRunner.persistAttempt(ORG, OPERATION, ATTEMPT, {
      kind: 'dispatched',
      token: TOKEN,
      result: { kind: 'accepted', externalId: 'ext-r8', status: 'sent' },
    }), { kind: 'settled', state: 'provider_accepted' });
  });
});

test('T-R8 LOCAL worker source has no RunOptions-style ctx.run third argument or TerminalError', async () => {
  const workerFiles = ['core.mjs', 'runner.mjs', 'handler.mjs', 'server.mjs', 'service.mjs'];
  for (const name of workerFiles) {
    const source = await readFile(new URL(`./${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /ctx\.run\s*\(\s*[^,]+,\s*\{[^}]*\}\s*,/s, `${name} has a RunOptions-style ctx.run call`);
    assert.doesNotMatch(source, /\bTerminalError\b/, `${name} contains TerminalError`);
  }
});

test('T-R5c LOCAL fixture deadline maps a 16-second provider sleep to uncertain', async () => {
  const previousSleep = process.env.INBOX_REPLY_SEND_TEST_TRANSPORT_SLEEP_MS;
  delete process.env.INBOX_REPLY_SEND_TEST_TRANSPORT_COUNT_FILE;
  process.env.INBOX_REPLY_SEND_TEST_TRANSPORT_SLEEP_MS = '16000';
  let transportCalls = 0;
  try {
    const pool = {
      async connect() {
        return {
          async query(statement) {
            if (statement.includes('worker_claim')) return { rows: [{ result: { kind: 'claimed', generation: '1' } }] };
            if (statement.includes('worker_start_dispatch')) return { rows: [{ result: { kind: 'dispatch', token: TOKEN, from: '+12025550001', to: '+12025550002', body: 'fixture' } }] };
            throw Error(`unexpected SQL: ${statement}`);
          },
          release() {},
        };
      },
    };
    const transport = async (...args) => { transportCalls += 1; return createTestReplyTransport()(...args); };
    const runner = createRunner(pool, transport);
    const result = await runner.dispatchAttempt(ORG, OPERATION, ATTEMPT);
    assert.equal(result.kind, 'dispatched');
    assert.equal(result.result.kind, 'uncertain');
    assert.equal(transportCalls, 1);
  } finally {
    if (previousSleep === undefined) delete process.env.INBOX_REPLY_SEND_TEST_TRANSPORT_SLEEP_MS;
    else process.env.INBOX_REPLY_SEND_TEST_TRANSPORT_SLEEP_MS = previousSleep;
  }
});
