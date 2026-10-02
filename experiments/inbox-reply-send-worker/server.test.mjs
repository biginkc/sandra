import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createWorkerRequestHandler } from './server.mjs';

test('only the configured versioned Restate path reaches the reply endpoint', async () => {
  const digest = 'c'.repeat(64);
  const seen = [];
  const server = createServer(createWorkerRequestHandler({
    registrationPath: `/runtime/${digest}`,
    endpoint: async (req, res) => { seen.push(req.url); res.writeHead(200); res.end('handled'); },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const handled = await fetch(`http://127.0.0.1:${port}/runtime/${digest}/InboxReplySend/run/send`);
    const root = await fetch(`http://127.0.0.1:${port}/InboxReplySend/run/send`);
    const wrongGeneration = await fetch(`http://127.0.0.1:${port}/runtime/${'d'.repeat(64)}/InboxReplySend/run/send`);
    assert.equal(handled.status, 200);
    assert.equal(await handled.text(), 'handled');
    assert.equal(root.status, 404);
    assert.equal(wrongGeneration.status, 404);
    assert.deepEqual(seen, ['/InboxReplySend/run/send']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a worker with no successful dispatch reports not-ready', async () => {
  const digest = 'e'.repeat(64);
  const server = createServer(createWorkerRequestHandler({
    registrationPath: `/runtime/${digest}`,
    endpoint: async (_req, res) => { res.writeHead(200); res.end('handled'); },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ready: false });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
