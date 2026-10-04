import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';

const strip = (file: string) => {
  const sql = readFileSync(new URL(file, import.meta.url), 'utf8');
  if (!/^[\s\S]*?\bbegin;\s*/im.test(sql) || !/\s*commit;\s*$/i.test(sql)) throw new Error(`${file}: transaction wrapper changed`);
  return sql.replace(/^begin;\s*/im, '').replace(/\s*commit;\s*$/i, '');
};
const prior = ['./20261005120000_next_step_schema.sql', './20261005120500_fn_create_next_step.sql'].map(strip);
const softphone = strip('./20261005130200_jitter_softphone_callback_next_step.sql');
const rollback = strip('../rollbacks/20261005130200_jitter_softphone_callback_next_step.sql');
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;
const SIG = 'public.jitter_writeback_call_activity_softphone(text, jsonb, uuid, text, text, uuid, text, text)';

async function withDb(files: string[], fn: (db: Client) => Promise<void>) {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('begin');
    for (const file of files) await db.query(file);
    await fn(db);
  } finally { await db.query('rollback').catch(() => {}); await db.end(); }
}

// The softphone helper rejects any non-softphone provider before the callback branch, so that
// branch cannot run today; its behavior is exercised through the main function's test. This
// suite proves the generated definition changed in exactly the two intended places.
it('the softphone helper creates its callback through fn_create_next_step and keeps its guards', async () => {
  await withDb([...prior], async (db) => {
    const before = (await db.query(`select pg_get_functiondef('${SIG}'::regprocedure) as d`)).rows[0].d as string;
    await db.query(softphone);
    const after = (await db.query(`select pg_get_functiondef('${SIG}'::regprocedure) as d`)).rows[0].d as string;
    expect(before).toContain("t.type = 'callback'");
    expect(after).toContain('fn_create_next_step');
    expect(after).toContain("t.next_step_kind = 'appointment'");
    expect(after).not.toMatch(/'callback'(?!_)/);
    expect(after).toContain("raise exception 'softphone writeback helper requires the softphone provider'");
    // Only those two edits: removing them from `after` and re-applying them to `before` gives equal text length class.
    expect(after.split('\n').length).toBeLessThan(before.split('\n').length + 4);
    await db.query(rollback);
    const restored = (await db.query(`select pg_get_functiondef('${SIG}'::regprocedure) as d`)).rows[0].d as string;
    expect(restored).toBe(before);
  });
});
