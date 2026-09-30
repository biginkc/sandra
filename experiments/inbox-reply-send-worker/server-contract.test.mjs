import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('T4 Restate journals dispatch and persist as separate durable steps', async () => {
  const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(source, /ctx\.run\(`dispatch:\$\{attemptId\}`/);
  assert.match(source, /ctx\.run\(`persist:\$\{attemptId\}`/);
  assert.match(source, /runner\.persistAttempt\(orgId, operationId, attemptId, dispatch\)/);
});
