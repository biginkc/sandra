import test from 'node:test';
import assert from 'node:assert/strict';
import { assertEmbedding, assertExactIds, assertMetrics } from './contracts.mjs';
import { completePhaseInventory } from '../outbox-db-contract.mjs';

test('C01 rejects a broken embedded contact', () => {
  const base = { property: { id: 'p', address: '1 Lane', city: 'Kansas City', state: 'MO' }, contact: { id: 'c', first_name: 'A', last_name: 'B', entity_name: null, phone_1: '+18165550000' } };
  const message = { id: 'm', body: 'x', from_address: 'a', to_address: 'b', created_at: 'now', scheduled_for: 'later', property_id: 'p', contact_id: 'c', property: base.property, contact: { ...base.contact, first_name: 'WRONG' } };
  assert.throws(() => assertEmbedding(message, base), /deep-equal/);
});

test('C02 rejects a substituted row with the same cardinality', () => {
  assert.throws(() => assertExactIds([{ id: 'a' }, { id: 'substitute' }], [{ id: 'a' }, { id: 'b' }]), /deep-equal/);
});

test('C04 rejects wrong queued count and paused count', () => {
  assert.throws(() => assertMetrics({ queued: 8, paused: 1 }, 9), /8 !== 9/);
  assert.throws(() => assertMetrics({ queued: 9, paused: 2 }, 9), /2 !== 1/);
});

test('a missing phase item cannot seal PASS', () => {
  assert.equal(completePhaseInventory('pre', [], { versions: [], inboundHeadsPresent: false }, []), false);
});
