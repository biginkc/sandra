import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const expected = JSON.parse(readFileSync(new URL('./expected/privileges.post.json', import.meta.url), 'utf8'));
test('P0b-8 pins the revision guard as invoker and the capture functions as definer', () => {
  assert.equal(expected.functions['public.inbox_guard_inbound_revision'].secdef, false);
  for (const name of ['public.inbox_capture_inbound_head', 'inbox_message_capture.capture', 'inbox_maintained.enqueue_dirty']) assert.equal(expected.functions[name].secdef, true, name);
});
test('retired shared-write capability is absent', () => {
  assert(!Object.keys(expected.functions).some(name => name.startsWith('outbox_contract.')));
});
