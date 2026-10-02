import fs from "node:fs";
import { Client } from "pg";
import { expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";

const stripTx = (sql: string) => sql.replace(/^\s*(begin|commit);\s*$/gim, "");

it("installs the direct recording ledger, private bucket, and rollback atomically", async () => {
  const url = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres");
  const pg = new Client({ connectionString: url });
  await pg.connect();
  const migration = stripTx(fs.readFileSync("supabase/migrations/20261002005023_direct_recording_integration.sql", "utf8"));
  const directCalls = stripTx(fs.readFileSync("supabase/migrations/20261001200000_direct_calls.sql", "utf8"));
  const rollback = stripTx(fs.readFileSync("supabase/rollbacks/20261002005023_direct_recording_integration.sql", "utf8"));
  await pg.query("begin");
  try {
    await pg.query(directCalls);
    await pg.query(migration);
    await pg.query(migration);
    const columns = await pg.query(`select table_name, column_name from information_schema.columns where table_schema='public' and ((table_name='call_activities' and column_name='direct_call_id') or (table_name='call_recordings' and column_name='provider_recording_id')) order by table_name, column_name`);
    expect(columns.rows).toEqual([
      { table_name: "call_activities", column_name: "direct_call_id" },
      { table_name: "call_recordings", column_name: "provider_recording_id" },
    ]);
    expect((await pg.query("select relrowsecurity from pg_class where oid='public.direct_call_recordings'::regclass")).rows[0].relrowsecurity).toBe(true);
    expect((await pg.query("select public, file_size_limit::bigint from storage.buckets where id='sandra-direct-recordings'")).rows[0]).toEqual({ public: false, file_size_limit: "67108864" });
    await pg.query(rollback);
    expect((await pg.query("select to_regclass('public.direct_call_recordings') as table_name")).rows[0].table_name).toBeNull();
    expect((await pg.query("select 1 from information_schema.columns where table_schema='public' and table_name='call_activities' and column_name='direct_call_id'")).rowCount).toBe(0);
    expect((await pg.query("select public from storage.buckets where id='sandra-direct-recordings'")).rows[0].public).toBe(false);
  } finally {
    await pg.query("rollback").catch(() => undefined);
    await pg.end();
  }
});
