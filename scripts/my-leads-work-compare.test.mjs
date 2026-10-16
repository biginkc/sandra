import assert from 'node:assert/strict';
import test from 'node:test';
import { oldPlacement, parseArgs, refuseProduction } from './my-leads-work-compare.mjs';

const ORG = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';

test('parseArgs requires uuids and rejects unknown flags', () => {
  assert.deepEqual(parseArgs(['--org', ORG, '--member', MEMBER]), { json: false, org: ORG, member: MEMBER });
  assert.equal(parseArgs(['--org', ORG, '--member', MEMBER, '--json']).json, true);
  assert.throws(() => parseArgs(['--org', 'x', '--member', MEMBER]), /--org/);
  assert.throws(() => parseArgs(['--org', ORG]), /--member/);
  assert.throws(() => parseArgs(['--org', ORG, '--member', MEMBER, '--at', 'nope']), /--at/);
  assert.throws(() => parseArgs(['--org', ORG, '--member', MEMBER, '--write']), /unknown argument/);
});

test('refuses a missing connection string and the production project', () => {
  assert.throws(() => refuseProduction(undefined), /COMPARE_DB_URL/);
  assert.throws(() => refuseProduction('postgresql://postgres:x@db.copflsklaefwzipsrjqz.supabase.co:5432/postgres'), /production/);
  assert.doesNotThrow(() => refuseProduction('postgresql://postgres:postgres@127.0.0.1:54329/postgres'));
});

test('oldPlacement names the top-ten slot, the drip section, or the stage section', () => {
  const top = new Set(['a', 'b']);
  assert.equal(oldPlacement({ property_id: 'b' }, false, top), 'Call next #2');
  assert.equal(oldPlacement({ property_id: 'z' }, false, top), 'stage section only');
  assert.equal(oldPlacement(undefined, true, top), 'drip section');
});
