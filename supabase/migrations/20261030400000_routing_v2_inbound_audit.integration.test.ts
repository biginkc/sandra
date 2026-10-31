import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

const db = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
const sql = (name: string, dir = __dirname) => readFileSync(path.join(dir, name), "utf8").replace(/^\s*(begin|commit);\s*$/gim, "");
const M = "20261030400000_routing_v2_inbound_audit.sql";
const row = (status: string) => db.query("insert into routing_v2_live_decisions(org_id,property_id,inbound_message_id,status,failure_reason,expected_revision) values($1,$2,$3,$4,'stop_keyword:x',0)", [randomUUID(), randomUUID(), randomUUID(), status]);

beforeAll(() => db.connect());
afterAll(() => db.end());
beforeEach(async () => { await db.query("begin"); await db.query(sql("20261030260000_routing_v2_live_decision_log.sql")); await db.query(sql(M)); });
afterEach(() => db.query("rollback"));

describe("v2 inbound audit status", () => {
  it("accepts not_routed beside decided / failed; nothing else", async () => {
    await row("not_routed");
    await db.query("savepoint s");
    await expect(row("bogus")).rejects.toMatchObject({ code: "23514" });
    await db.query("rollback to savepoint s");
  });
  it("one row per inbound (the unique key makes the audit a no-op once the engine decided)", async () => {
    const inbound = randomUUID();
    await db.query("insert into routing_v2_live_decisions(org_id,property_id,inbound_message_id,status,expected_revision) values($1,$2,$3,'failed',0)", [randomUUID(), randomUUID(), inbound]);
    await db.query("savepoint s");
    await expect(db.query("insert into routing_v2_live_decisions(org_id,property_id,inbound_message_id,status,expected_revision) values($1,$2,$3,'not_routed',0)", [randomUUID(), randomUUID(), inbound])).rejects.toMatchObject({ code: "23505" });
    await db.query("rollback to savepoint s");
  });
  it("is idempotent; rollback refuses while audit rows exist", async () => {
    await db.query(sql(M));
    await row("not_routed");
    await db.query("savepoint s");
    await expect(db.query(sql("20261030400000_routing_v2_inbound_audit.sql", path.join(__dirname, "../rollbacks")))).rejects.toThrow(/not_routed audit rows exist/);
    await db.query("rollback to savepoint s");
  });
});
