import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";
const url = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres");
const strip = (text: string) => text.replace(/^\s*(begin|commit);\s*$/gim, "");
const migration = strip(readFileSync(path.join(__dirname, "20261030260000_routing_v2_live_decision_log.sql"), "utf8"));
const rollback = strip(readFileSync(path.join(__dirname, "../rollbacks/20261030260000_routing_v2_live_decision_log.sql"), "utf8"));
const db = new Client({ connectionString: url });
beforeAll(async () => { await db.connect(); });
afterAll(async () => { await db.end(); });
beforeEach(async () => { await db.query("begin"); await db.query(migration); });
afterEach(async () => { await db.query("rollback"); });
const insert = `insert into public.routing_v2_live_decisions (org_id, property_id, inbound_message_id, status, expected_revision)
 values ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','failed',7)`;
describe("routing v2 live evidence migration", () => {
  it("is idempotent and keeps service evidence append-only", async () => {
    await db.query(migration);
    const { rows: [row] } = await db.query(`select
      has_table_privilege('service_role','public.routing_v2_live_decisions','SELECT') as can_read,
      has_table_privilege('service_role','public.routing_v2_live_decisions','INSERT') as can_insert,
      has_table_privilege('service_role','public.routing_v2_live_decisions','UPDATE') as can_update,
      has_table_privilege('service_role','public.routing_v2_live_decisions','DELETE') as can_delete,
      has_table_privilege('authenticated','public.routing_v2_live_decisions','SELECT') as user_read,
      has_table_privilege('anon','public.routing_v2_live_decisions','SELECT') as anon_read,
      (select relrowsecurity from pg_class where oid='public.routing_v2_live_decisions'::regclass) as rls`);
    expect(row).toEqual({ can_read: true, can_insert: true, can_update: false, can_delete: false, user_read: false, anon_read: false, rls: true });
  });
  it("refuses a duplicate inbound, preserving the first decision", async () => {
    await db.query(insert); await db.query("savepoint duplicate");
    await expect(db.query(insert)).rejects.toMatchObject({ code: "23505" });
    await db.query("rollback to savepoint duplicate");
    expect((await db.query("select count(*)::int as n from public.routing_v2_live_decisions")).rows[0].n).toBe(1);
  });
  it("rolls back an empty table", async () => {
    await db.query(rollback);
    expect((await db.query("select to_regclass('public.routing_v2_live_decisions') as name")).rows[0].name).toBeNull();
  });
  it("refuses rollback once live evidence exists", async () => {
    await db.query(insert); await db.query("savepoint preserve");
    await expect(db.query(rollback)).rejects.toThrow("Live routing-v2 decisions exist");
    await db.query("rollback to savepoint preserve");
    expect((await db.query("select count(*)::int as n from public.routing_v2_live_decisions")).rows[0].n).toBe(1);
  });
});
