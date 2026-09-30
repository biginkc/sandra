import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRunHandler } from './handler.mjs';
import { createInboxReplySendService, inboxReplySendServiceOptions } from './service.mjs';
import { createStallLogger, dispatchBatchWithStalls } from './core.mjs';

const ORG = '11111111-1111-1111-1111-111111111111';
const OPERATION = '22222222-2222-2222-2222-222222222222';
const EVENT = '33333333-3333-3333-3333-333333333333';

function fakePool(entry, acknowledgment = false) {
  return {
    async query(statement) {
      if (statement.includes('claim_dispatch_batch')) return { rows: [{ result: [entry] }] };
      if (statement.includes('ack_dispatch')) return { rows: [{ result: acknowledgment }] };
      throw Error(`unexpected SQL: ${statement}`);
    },
  };
}

function acceptedResponse() {
  const bytes = new TextEncoder().encode(JSON.stringify({ status: 'PreviouslyAccepted', invocationId: 'inv_stall1' }));
  return { ok: true, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
}

test('T-R1 LOCAL service manifest carries the approved retry policy and timeouts', () => {
  const service = createInboxReplySendService({ service: (definition) => definition }, async () => {});
  assert.equal(service.name, 'InboxReplySend');
  assert.deepEqual(service.options, {
    retryPolicy: { initialInterval: 500, exponentiationFactor: 2, maxInterval: 60_000, maxAttempts: 70, onMaxAttempts: 'pause' },
    inactivityTimeout: 180_000,
    abortTimeout: 600_000,
  });
});

test('T-R6 LOCAL stall logging uses the exact generation fence and 60-minute operation throttle', async () => {
  let now = 0;
  const lines = [];
  const stallLogger = createStallLogger(() => now, (line) => lines.push(line));
  const fetcher = async () => acceptedResponse();
  const entry = (generation) => ({ org_id: ORG, operation_id: OPERATION, event_id: EVENT, generation: String(generation) });

  await dispatchBatchWithStalls(fakePool(entry(149)), fetcher, new URL('http://sandra-inbox-restate-owned:8080/'), { stallLogger });
  assert.equal(lines.length, 0);
  await dispatchBatchWithStalls(fakePool(entry(150)), fetcher, new URL('http://sandra-inbox-restate-owned:8080/'), { stallLogger });
  assert.equal(lines.length, 1);
  await dispatchBatchWithStalls(fakePool(entry(150)), fetcher, new URL('http://sandra-inbox-restate-owned:8080/'), { stallLogger });
  assert.equal(lines.length, 1);
  now = 60 * 60_000 + 1;
  await dispatchBatchWithStalls(fakePool(entry(150)), fetcher, new URL('http://sandra-inbox-restate-owned:8080/'), { stallLogger });
  assert.equal(lines.length, 2);
  const parsed = JSON.parse(lines[0].slice('inbox_reply_send_stalled '.length));
  assert.deepEqual(Object.keys(parsed).sort(), ['event_id', 'generation', 'invocation_id', 'operation_id']);
  assert.equal(parsed.operation_id, OPERATION);
  assert.equal(parsed.event_id, EVENT);
  assert.equal(parsed.invocation_id, 'inv_stall1');
  assert.equal(parsed.generation, '150');
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
  let runs = 0;
  const ctx = { run(...args) { assert.equal(args.length, 2); runs += 1; return args[1](); } };
  const runner = { async operationAttempts() { return []; } };
  const handler = createRunHandler({ runner, pool: { async query() { return { rows: [{ ready: true }] }; } } });
  for (const input of [null, {}, { orgId: ORG }, { orgId: ORG, operationId: OPERATION, extra: true }]) {
    await assert.rejects(() => handler(ctx, input), (error) => error instanceof Error && error.constructor === Error && !('terminal' in error));
  }
  assert.equal(runs, 0);
  await handler(ctx, { orgId: ORG, operationId: OPERATION });
  assert.equal(runs, 2);
});

test('T-R8 LOCAL worker source contains no per-step terminal override', async () => {
  const forbiddenOptions = ['Run', 'Options'].join('');
  const forbiddenError = ['Terminal', 'Error'].join('');
  for (const name of ['server.mjs', 'handler.mjs', 'runner.mjs', 'core.mjs', 'service.mjs']) {
    const source = await readFile(new URL(`./${name}`, import.meta.url), 'utf8');
    assert.equal(source.includes(forbiddenOptions), false);
    assert.equal(source.includes(forbiddenError), false);
  }
});
