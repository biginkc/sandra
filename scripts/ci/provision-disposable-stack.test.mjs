import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, excluded } from './provision-disposable-stack.mjs';
test('provisioner accepts upstream ports and migration exclusion', () => {
  assert.deepEqual(parseArgs(['--api-port','55421','--db-port','55422','--exclude-migrations','2026092900*']).excludeMigrations, ['2026092900*']);
  assert.equal(excluded('20260929000000_inbox.sql', ['2026092900*']), true);
  assert.equal(excluded('054_old.sql', ['2026092900*']), false);
});
for (const args of [['--api-port','54321'],['--db-port','54322'],['--api-port','55422','--db-port','55422'],['--api-port','bad'],['--exclude-migrations']]) {
  test(`mutation-first provisioner rejects ${args.join(' ')}`, () => assert.throws(() => parseArgs(args)));
}
