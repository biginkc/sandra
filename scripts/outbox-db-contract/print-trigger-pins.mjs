import { createHash } from 'node:crypto';
import pg from 'pg';
import { assertDisposableTarget } from './guards.mjs';
import { readTriggerPinRows, triggerDefinitionSha256 } from './privileges.mjs';

const dbUrl = process.argv[2] ?? process.env.E2E_CI_SUPABASE_DB_URL;
if (!dbUrl || process.argv.length > 3) {
  console.error('usage: node scripts/outbox-db-contract/print-trigger-pins.mjs [disposable-db-url]');
  process.exitCode = 2;
} else {
  try {
    assertDisposableTarget({
      apiUrl: process.env.TEST_SUPABASE_URL ?? 'http://127.0.0.1:55421',
      dbUrl,
      env: process.env,
    });
    const db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    try {
      const names = new Set(Object.keys(triggerDefinitionSha256));
      const rows = await readTriggerPinRows(db);
      const pins = Object.fromEntries(rows
        .filter(row => names.has(row.tgname))
        .map(row => [row.tgname, createHash('sha256').update(row.definition).digest('hex')])
        .sort(([left], [right]) => left.localeCompare(right)));
      if (Object.keys(pins).length !== names.size) throw new Error('Disposable catalog is missing one or more pinned Search message triggers');
      process.stdout.write(`${JSON.stringify(pins, null, 2)}\n`);
    } finally {
      await db.end();
    }
  } catch (error) {
    console.error(error.message ?? error);
    process.exitCode = 1;
  }
}
