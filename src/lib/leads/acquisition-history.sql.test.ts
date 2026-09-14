/** Opt-in against a disposable, fully migrated local database only. Never shared postgres. */
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
const connectionString = process.env.LEAD_HISTORY_TEST_DB_URL;
if (connectionString) {
  const url = new URL(connectionString);
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.port !== "58322" ||
    !url.pathname.startsWith("/lead_history_")
  )
    throw new Error(
      "History SQL tests require a disposable local lead_history_* database",
    );
}
const suite = connectionString ? describe : describe.skip;
suite("canonical history SQL authorization and paging", () => {
  let db: pg.Client;
  let org: string, other: string, user: string, property: string;
  beforeEach(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query("begin");
    org = randomUUID();
    other = randomUUID();
    user = randomUUID();
    property = randomUUID();
    await db.query("insert into organizations(id,name) values($1,$2),($3,$4)", [
      org,
      `history-${org}`,
      other,
      `history-${other}`,
    ]);
    await db.query("insert into auth.users(id,email) values($1,$2)", [
      user,
      `${user}@example.invalid`,
    ]);
    const owner = randomUUID();
    await db.query("insert into auth.users(id,email) values($1,$2)", [
      owner,
      `${owner}@example.invalid`,
    ]);
    await db.query(
      "insert into memberships(org_id,user_id,role,access_status) values($1,$2,'owner','active')",
      [org, owner],
    );
    await db.query(
      "insert into memberships(org_id,user_id,role,access_status) values($1,$2,'member','active')",
      [org, user],
    );
    await db.query(
      "insert into properties(id,org_id,address,state) values($1,$2,$3,'MO')",
      [property, org, "Synthetic history test"],
    );
    await db.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: user, role: "authenticated" }),
    ]);
  });
  afterEach(async () => {
    await db.query("rollback");
    await db.end();
  });
  async function call(args: unknown[] = [property, 50, null, null, null]) {
    await db.query("set local role authenticated");
    const result = (
      await db.query(
        "select fn_get_lead_acquisition_history($1,$2,$3,$4,$5) result",
        args,
      )
    ).rows[0].result;
    await db.query("reset role");
    return result;
  }
  async function denied(args: unknown[]) {
    await db.query("savepoint denial");
    try {
      await expect(call(args)).rejects.toThrow();
    } finally {
      await db.query("rollback to savepoint denial");
    }
  }
  it("permits same-org member but denies foreign, anonymous and expired access", async () => {
    expect((await call()).rows).toEqual([]);
    const foreign = randomUUID();
    await db.query(
      "insert into properties(id,org_id,address,state) values($1,$2,$3,'MO')",
      [foreign, other, "Foreign history"],
    );
    await denied([foreign, 50, null, null, null]);
    await db.query("select set_config('request.jwt.claims','{}',true)");
    await denied([property, 50, null, null, null]);
    await db.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: user, role: "authenticated" }),
    ]);
    await db.query(
      "update memberships set access_expires_at=now()-interval '1 hour' where org_id=$1 and user_id=$2",
      [org, user],
    );
    await denied([property, 50, null, null, null]);
  });
  it("does not grant table access, service execution or permit invalid cursors", async () => {
    const acl = (
      await db.query(
        "select has_function_privilege('authenticated','public.fn_get_lead_acquisition_history(uuid,integer,timestamptz,text,uuid)','execute') member,has_function_privilege('anon','public.fn_get_lead_acquisition_history(uuid,integer,timestamptz,text,uuid)','execute') anon,has_function_privilege('service_role','public.fn_get_lead_acquisition_history(uuid,integer,timestamptz,text,uuid)','execute') service,has_table_privilege('authenticated','public.acquisition_attempts','select') direct",
      )
    ).rows[0];
    expect(acl).toEqual({
      member: true,
      anon: false,
      service: false,
      direct: false,
    });
    for (const args of [
      [property, 0, null, null, null],
      [property, 101, null, null, null],
      [property, 50, "2026-01-01", "attempt", null],
      [property, 50, "infinity", "attempt", randomUUID()],
      [property, 50, "2026-01-01", "invalid", randomUUID()],
    ])
      await denied(args);
  });
  it("paginates ties without duplicate facts and preserves exact cents and original times", async () => {
    const at = "2026-01-01T10:00:00.123456Z";
    for (let n = 0; n < 3; n++)
      await db.query(
        "insert into acquisition_attempts(org_id,property_id,actor_user_id,attempt_kind,source,outcome,occurred_at,idempotency_key,note) values($1,$2,$3,'outreach','manual','no_answer',$4,$5,'Original note')",
        [org, property, user, at, randomUUID()],
      );
    await db.query(
      "insert into acquisition_offers(org_id,property_id,actor_user_id,amount_cents,sent_via,sent_at,follow_up_at,idempotency_key) values($1,$2,$3,12500050,'verbal',$4,$4::timestamptz+interval '1 day',$5)",
      [org, property, user, at, randomUUID()],
    );
    const first = await call([property, 2, null, null, null]);
    expect(first.hasMore).toBe(true);
    expect(first.rows).toHaveLength(2);
    const second = await call([
      property,
      2,
      first.cursor.at,
      first.cursor.kind,
      first.cursor.id,
    ]);
    expect(second.hasMore).toBe(false);
    const rows = [...first.rows, ...second.rows];
    expect(new Set(rows.map((x) => x.kind + x.id)).size).toBe(4);
    expect(rows.find((x) => x.kind === "offer").amountCents).toBe("12500050");
    expect(rows.every((x) => x.actorId === user)).toBe(true);
    expect(rows.every((x) => x.at.includes("10:00:00.123456"))).toBe(true);
  });
});
