import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Hold alerts fire only for holds that start after alerts were enabled
 * (20261008210000). Local-only: replays the 20261008140000..20261008150300 chain
 * and then this migration inside a rolled-back transaction.
 */
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const read = (f: string) =>
  readFileSync(path.join(__dirname, f), "utf8").replace(/^begin;$/m, "").replace(/^commit;$/m, "");
const CHAIN = readdirSync(__dirname)
  .filter((f) => /^20261008\d{6}_.*\.sql$/.test(f) && f >= "20261008140000" && f <= "20261008150300_zz")
  .sort()
  .map(read);
const NEW_ONLY = read("20261008210000_hold_alerts_new_only.sql");

let orgId: string;
let ownerId: string;

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await db.query("begin");
  for (const sql of CHAIN) await db.query(sql);
  orgId = randomUUID();
  ownerId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `Org ${orgId}`]);
  await db.query("insert into auth.users (id, email) values ($1, $2)", [ownerId, `o-${ownerId}@test.local`]);
  await db.query(
    "insert into public.memberships (org_id, user_id, role, access_status) values ($1, $2, 'owner', 'active')",
    [orgId, ownerId],
  );
});
afterEach(async () => {
  await db.query("rollback");
});

async function property(flagged: boolean): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into public.properties (id, org_id, address, state, needs_human_attention) values ($1, $2, '1 Test St', 'MO', $3)`,
    [id, orgId, flagged],
  );
  return id;
}
async function row(id: string) {
  const r = await db.query(
    `select needs_human_attention as flag, needs_human_attention_since as since, decision_context_revision as rev
       from public.properties where id = $1`,
    [id],
  );
  return r.rows[0] as { flag: boolean; since: Date | null; rev: string };
}
async function delivery(propertyId: string | null, status: string, attempts = 0, key: string = randomUUID()) {
  await db.query(
    `insert into public.hold_alert_deliveries (org_id, property_id, hold_key, recipient_user_id, channel, stage, status, attempts)
     values ($1, $2, $3, $4, 'slack', 'first', $5, $6)`,
    [orgId, propertyId, key, ownerId, status, attempts],
  );
  return key;
}

describe("backlog holds (flagged before the migration)", () => {
  it("keep a NULL start and are never eligible; pending deliveries are discarded", async () => {
    const backlog = await property(true);
    const pendingKey = await delivery(backlog, "pending");
    const retryKey = await delivery(null, "failed", 1);
    const exhaustedKey = await delivery(null, "failed", 3);
    const sentKey = await delivery(null, "sent");
    await db.query(`update public.hold_alert_deliveries set sent_at = now() where hold_key = $1`, [sentKey]);

    await db.query(NEW_ONLY);

    expect((await row(backlog)).since).toBeNull();
    const status = async (k: string) =>
      (await db.query(`select status, last_error from public.hold_alert_deliveries where hold_key = $1`, [k])).rows[0];
    const discarded = async (k: string) =>
      (await db.query(
        `select status, last_error from public.hold_alert_deliveries where hold_key like $1`,
        [`${k}:closed:backlog_discarded:%`],
      )).rows[0];
    expect(await discarded(pendingKey)).toEqual({ status: "skipped", last_error: "backlog_discarded" });
    expect(await discarded(retryKey)).toEqual({ status: "skipped", last_error: "backlog_discarded" });
    expect(await status(pendingKey)).toBeUndefined();
    expect((await status(exhaustedKey)).status).toBe("failed");
    expect((await status(sentKey)).status).toBe("sent");
  });
});

describe("discarded backlog deliveries release their keys", () => {
  // Same insert ensure() runs: on conflict do nothing, then select by key.
  const ensure = async (propertyId: string, key: string) => {
    await db.query(
      `insert into public.hold_alert_deliveries (org_id, property_id, hold_key, recipient_user_id, channel, stage)
       values ($1, $2, $3, $4, 'slack', 'first')
       on conflict (hold_key, recipient_user_id, channel, stage) do nothing`,
      [orgId, propertyId, key, ownerId],
    );
    return (await db.query(
      `select id, status from public.hold_alert_deliveries
        where hold_key = $1 and recipient_user_id = $2 and channel = 'slack' and stage = 'first'`,
      [key, ownerId],
    )).rows;
  };

  it("a post-watermark seller text on the unchanged hold gets exactly one fresh pending first notification", async () => {
    const prop = await property(true);
    const key = `${prop}:seller_reply`;
    await delivery(prop, "pending", 0, key);
    await db.query(NEW_ONLY);

    const first = await ensure(prop, key);
    expect(first).toHaveLength(1);
    expect(first[0].status).toBe("pending");

    // Second cron run: same key, same row, no extra delivery.
    const second = await ensure(prop, key);
    expect(second).toEqual(first);
    const all = await db.query(`select status from public.hold_alert_deliveries where property_id = $1 order by status`, [prop]);
    expect(all.rows.map((r) => r.status)).toEqual(["pending", "skipped"]);
  });

  it("is idempotent: re-running the discard does not re-suffix already retired keys", async () => {
    const prop = await property(true);
    await delivery(prop, "pending", 0, `${prop}:x`);
    await db.query(NEW_ONLY);
    const keys = async () =>
      (await db.query(`select hold_key from public.hold_alert_deliveries where property_id = $1`, [prop])).rows;
    const before = await keys();
    await db.query(NEW_ONLY);
    expect(await keys()).toEqual(before);
  });
});

describe("needs_human_attention_since trigger", () => {
  beforeEach(async () => {
    await db.query(NEW_ONLY);
  });

  it("is set on insert of a flagged property, null otherwise", async () => {
    const flagged = await property(true);
    const clear = await property(false);
    expect((await row(flagged)).since).not.toBeNull();
    expect((await row(clear)).since).toBeNull();
  });

  it("is set when the flag flips false -> true and cleared when it flips back", async () => {
    const id = await property(false);
    await db.query("update public.properties set needs_human_attention = true where id = $1", [id]);
    const first = (await row(id)).since;
    expect(first).not.toBeNull();
    await db.query("update public.properties set needs_human_attention = false where id = $1", [id]);
    expect((await row(id)).since).toBeNull();
    await db.query("update public.properties set needs_human_attention = true where id = $1", [id]);
    expect((await row(id)).since).not.toBeNull();
  });

  it("does not move when the flag is re-set while already flagged, even if the statement tries to", async () => {
    const id = await property(false);
    await db.query("update public.properties set needs_human_attention = true where id = $1", [id]);
    const before = (await row(id)).since;
    await db.query("select pg_sleep(0.02)");
    await db.query("update public.properties set needs_human_attention = true, needs_human_attention_since = now() where id = $1", [id]);
    expect((await row(id)).since).toEqual(before);
  });

  it("never bumps decision_context_revision", async () => {
    const id = await property(false);
    const rev = (await row(id)).rev;
    await db.query("update public.properties set needs_human_attention = true where id = $1", [id]);
    await db.query("update public.properties set needs_human_attention = false where id = $1", [id]);
    expect((await row(id)).rev).toBe(rev);
  });
});

describe("org-wide inbound lookup index", () => {
  it("exists and is partial on inbound", async () => {
    await db.query(NEW_ONLY);
    const { rows } = await db.query(
      "select indexdef from pg_indexes where schemaname = 'public' and indexname = 'idx_messages_org_inbound_created'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/\(org_id, created_at DESC\)/);
    expect(rows[0].indexdef).toMatch(/direction/);
  });
});

describe("hold_alert_settings watermark", () => {
  beforeEach(async () => {
    await db.query(NEW_ONLY);
  });
  const init = (iso: string) =>
    db.query(
      `insert into public.hold_alert_settings (org_id, alerts_since) values ($1, $2)
       on conflict (org_id) do nothing returning alerts_since`,
      [orgId, iso],
    );

  it("first run inserts the watermark; a second run inserts nothing and keeps the first value", async () => {
    expect((await init("2026-10-08T12:00:00Z")).rowCount).toBe(1);
    expect((await init("2026-10-08T13:00:00Z")).rowCount).toBe(0);
    const r = await db.query("select alerts_since from public.hold_alert_settings where org_id = $1", [orgId]);
    expect(new Date(r.rows[0].alerts_since).toISOString()).toBe("2026-10-08T12:00:00.000Z");
  });

  it("a hold flagged after the watermark is later than it; the backlog is not", async () => {
    const backlog = await property(true);
    await db.query("update public.properties set needs_human_attention_since = null where id = $1", [backlog]);
    await init(new Date().toISOString());
    await db.query("select pg_sleep(0.02)");
    const fresh = await property(false);
    await db.query("update public.properties set needs_human_attention = true where id = $1", [fresh]);
    const eligible = await db.query(
      `select p.id from public.properties p, public.hold_alert_settings s
        where p.org_id = s.org_id and p.needs_human_attention
          and p.needs_human_attention_since >= s.alerts_since`,
    );
    expect(eligible.rows.map((r) => r.id)).toEqual([fresh]);
  });

  it("is readable by owners (RLS), writable only by service_role, and cleared by reset_tenant_tables", async () => {
    await init("2026-10-08T12:00:00Z");
    const priv = async (role: string, p: string) =>
      (await db.query("select has_table_privilege($1, 'public.hold_alert_settings', $2) as ok", [role, p])).rows[0].ok;
    expect(await priv("authenticated", "select")).toBe(true);
    expect(await priv("authenticated", "insert")).toBe(false);
    expect(await priv("authenticated", "update")).toBe(false);
    expect(await priv("anon", "select")).toBe(false);
    expect(await priv("service_role", "insert")).toBe(true);
    expect(await priv("service_role", "update")).toBe(true);
    const rls = await db.query("select relrowsecurity from pg_class where oid = 'public.hold_alert_settings'::regclass");
    expect(rls.rows[0].relrowsecurity).toBe(true);
    const def = await db.query("select pg_get_functiondef('public.reset_tenant_tables()'::regprocedure) as d");
    expect(def.rows[0].d).toContain("public.hold_alert_settings");
  });

  it("is idempotent: applying the migration twice does not duplicate the reset patch", async () => {
    await db.query(NEW_ONLY);
    const def = await db.query("select pg_get_functiondef('public.reset_tenant_tables()'::regprocedure) as d");
    expect((def.rows[0].d.match(/public\.hold_alert_settings/g) ?? []).length).toBe(1);
  });
});
