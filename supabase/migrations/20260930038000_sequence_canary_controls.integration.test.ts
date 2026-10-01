import fs from "node:fs";
import { Client } from "pg";
import { expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";

it("applies twice on the local old schema, denies anon/authenticated, and rolls back", async () => {
  const url = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres");
  const pg = new Client({ connectionString: url });
  await pg.connect();
  const migration = fs.readFileSync("supabase/migrations/20260930038000_sequence_canary_controls.sql", "utf8");
  await pg.query("begin");
  try {
    await pg.query(migration);
    await pg.query(migration);
    await pg.query("select public.set_sequence_canary_control($1,$2,$3)", ["SEQUENCE_CANARY_SCHEDULE_ENABLED", "false", "local-test"]);
    const row = await pg.query("select value, changed_by, changed_at from public.sequence_canary_controls where key=$1", ["SEQUENCE_CANARY_SCHEDULE_ENABLED"]);
    expect(row.rows[0]).toMatchObject({ value: "false", changed_by: "local-test" });
    expect(row.rows[0].changed_at).toBeTruthy();
    await pg.query("savepoint service_check");
    try {
      await pg.query("set local role service_role");
      const serviceRead = await pg.query("select value from public.sequence_canary_controls where key=$1", ["SEQUENCE_CANARY_SCHEDULE_ENABLED"]);
      expect(serviceRead.rows[0].value).toBe("false");
      await expect(pg.query("update public.sequence_canary_controls set value='true' where key='SEQUENCE_CANARY_SCHEDULE_ENABLED'"))
        .rejects.toMatchObject({ code: "42501" });
    } finally { await pg.query("rollback to savepoint service_check"); }
    await pg.query("savepoint service_setter");
    try {
      await pg.query("set local role service_role");
      await pg.query("select public.set_sequence_canary_control($1,$2,$3)", ["SEQUENCE_CANARY_SCHEDULE_ENABLED", "true", "service-test"]);
      const changed = await pg.query("select value, changed_by from public.sequence_canary_controls where key=$1", ["SEQUENCE_CANARY_SCHEDULE_ENABLED"]);
      expect(changed.rows[0]).toMatchObject({ value: "true", changed_by: "service-test" });
    } finally { await pg.query("rollback to savepoint service_setter"); }
    for (const role of ["anon", "authenticated"]) {
      await pg.query("savepoint denied");
      try {
        await pg.query(`set local role ${role}`);
        await expect(pg.query("select * from public.sequence_canary_controls")).rejects.toMatchObject({ code: "42501" });
      } finally {
        await pg.query("rollback to savepoint denied");
      }
    }
    await pg.query("savepoint denied_setter");
    try {
      await pg.query("set local role authenticated");
      await expect(pg.query("select public.set_sequence_canary_control($1,$2,$3)", ["SEQUENCE_CANARY_SCHEDULE_ENABLED", "true", "test"]))
        .rejects.toMatchObject({ code: "42501" });
    } finally { await pg.query("rollback to savepoint denied_setter"); }
  } finally {
    await pg.query("rollback");
    await pg.end();
  }
});
