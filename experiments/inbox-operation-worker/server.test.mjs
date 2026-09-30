import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createWorkerRequestHandler } from './server.mjs';

test('only the configured versioned Restate path reaches the operation endpoint', async () => {
  const digest = 'a'.repeat(64);
  const seen = [];
  const server = createServer(createWorkerRequestHandler({
    registrationPath: `/runtime/${digest}`,
    endpoint: async (req, res) => { seen.push(req.url); res.writeHead(200); res.end('handled'); },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const handled = await fetch(`http://127.0.0.1:${port}/runtime/${digest}/InboxMetadataOperation/run/send`);
    const root = await fetch(`http://127.0.0.1:${port}/InboxMetadataOperation/run/send`);
    const wrongGeneration = await fetch(`http://127.0.0.1:${port}/runtime/${'b'.repeat(64)}/InboxMetadataOperation/run/send`);
    assert.equal(handled.status, 200);
    assert.equal(await handled.text(), 'handled');
    assert.equal(root.status, 404);
    assert.equal(wrongGeneration.status, 404);
    assert.deepEqual(seen, ['/InboxMetadataOperation/run/send']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
