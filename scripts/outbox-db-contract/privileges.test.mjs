import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertFunctionPin, checkPrivileges } from './privileges.mjs';

const expected = JSON.parse(readFileSync(new URL('./expected/privileges.post.json', import.meta.url), 'utf8'));
test('P0b-8 pins the revision guard as invoker and the capture functions as definer', () => {
  assert.equal(expected.functions['public.inbox_guard_inbound_revision'].secdef, false);
  for (const name of ['public.inbox_capture_inbound_head', 'inbox_message_capture.capture', 'inbox_maintained.enqueue_dirty']) assert.equal(expected.functions[name].secdef, true, name);
});
test('retired shared-write capability is absent', () => {
  assert(!Object.keys(expected.functions).some(name => name.startsWith('outbox_contract.')));
});

test('PIN_FUNCTIONS rejects RESET search_path on a pinned definer', async () => {
  const functions = Object.entries(expected.functions).map(([name, pin]) => ({
    name, signature: name, secdef: pin.secdef, owner: pin.owner,
  }));
  const db = { query: async (sql, params = []) => {
    if (sql.includes('from pg_proc p')) return { rows: functions.map(fn => ({ ...fn,
      search_path: fn.name === 'inbox_message_capture.capture' && !sql.includes('coalesce(') ? null : expected.functions[fn.name].search_path,
    })) };
    if (sql.includes('has_function_privilege(role,$1')) {
      const allowed = expected.functions[params[0]].execute;
      return { rows: ['anon', 'authenticated', 'service_role'].map(role => ({ role, allowed: allowed.includes(role) })) };
    }
    return { rows: [] };
  } };
  const result = await checkPrivileges(db, 'post');
  const check = result.find(item => item.id === 'PIN_FUNCTIONS');
  assert.equal(check.verdict, 'FAIL');
  assert.match(check.error, /inbox_message_capture\.capture/);
  assert.doesNotMatch(check.error, /Cannot read properties/);
});

test('post catalog generator must distinguish absent from explicit empty search_path', () => {
  const source = readFileSync(new URL('./gen-post-catalog.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /coalesce\(\(select regexp_replace\(x,'\^search_path='/i);
  assert.match(source, /assertFunctionPin\(\{ \.\.\.fn, execute: allowed \}, current\)/);
  const pin = expected.functions['inbox_message_capture.capture'];
  assert.throws(() => assertFunctionPin({ name: 'inbox_message_capture.capture', ...pin, search_path: null }, pin));
});
