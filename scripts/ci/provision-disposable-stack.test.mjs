import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, excluded } from './provision-disposable-stack.mjs';
import { filename, readManifest } from '../inbox-ci/inbox-migrations.mjs';
const inboxFile = filename(readManifest()[0]);
test('provisioner accepts upstream ports and migration exclusion', () => {
  assert.deepEqual(parseArgs(['--api-port','55421','--db-port','55422','--exclude-migrations', inboxFile]).excludeMigrations, [inboxFile]);
  assert.equal(excluded(inboxFile, [inboxFile]), true);
  assert.equal(excluded(`${readManifest()[0].version}_other.sql`, [inboxFile]), false);
});
for (const args of [['--api-port','54321'],['--db-port','54322'],['--api-port','55422','--db-port','55422'],['--api-port','bad'],['--exclude-migrations']]) {
  test(`mutation-first provisioner rejects ${args.join(' ')}`, () => assert.throws(() => parseArgs(args)));
}
