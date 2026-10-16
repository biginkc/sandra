import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Hold alert deliveries (20261008150000). Local-only: replays the
 * 20261008140000..20261008150000 chain inside a rolled-back transaction, then
 * checks the unique key, the check constraints, and owner||acquisitions RLS.
 */
const dir = __dirname;
const CHAIN = readdirSync(dir)
  .filter((f) => /^20261008\d{6}_.*\.sql$/.test(f) && f >= "20261008140000" && f <= "20261008150000_zz")
  .sort()
  .map((f) => readFileSync(path.join(dir, f), "utf8").replace(/^begin;$/m, "").replace(/^commit;$/m, ""));

const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
let orgId: string;
let propertyId: string;
const users = {} as Record<"owner" | "acq" | "plain", string>;

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});

async function addMember(key: keyof typeof users, role: "owner" | "member", acq = false) {
  const id = randomUUID();
  users[key] = id;
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${key}-${id}@test.local`]);
  await db.query(
    `insert into public.memberships (org_id, user_id, role, access_status, acquisitions_enabled)
     values ($1, $2, $3, 'active', $4)`,
    [orgId, id, role, acq],
  );
}

async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  await db.query("savepoint as_user");
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
  try {
    const out = await fn();
    await db.query("reset role");
    await db.query("release savepoint as_user");
    return out;
  } catch (e) {
    await db.query("rollback to savepoint as_user");
    await db.query("reset role");
    throw e;
  }
}

const insert = (over: Partial<Record<string, string | number>> = {}) => {
  const row = {
    hold_key: `${propertyId}:2026-10-08T10:00:00Z`,
    recipient_user_id: users.owner,
    channel: "slack",
    stage: "first",
    ...over,
  };
  return db.query(
    `insert into public.hold_alert_deliveries (org_id, property_id, hold_key, recipient_user_id, channel, stage)
     values ($1, $2, $3, $4, $5, $6) returning id, status, attempts`,
    [orgId, propertyId, row.hold_key, row.recipient_user_id, row.channel, row.stage],
  );
};

async function expectRejects(fn: () => Promise<unknown>, pattern: RegExp) {
  await db.query("savepoint rej");
  await expect(fn()).rejects.toThrow(pattern);
  await db.query("rollback to savepoint rej");
}

beforeEach(async () => {
  await db.query("begin");
  for (const sql of CHAIN) await db.query(sql);
  orgId = randomUUID();
  propertyId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `Alerts ${orgId}`]);
  await db.query("set local session_replication_role = replica");
  await addMember("owner", "owner");
  await addMember("acq", "member", true);
  await addMember("plain", "member");
  await db.query(
    `insert into public.properties (id, org_id, address, state, status) values ($1, $2, '1 Main St', 'MO', 'new_lead')`,
    [propertyId, orgId],
  );
  await db.query("set local session_replication_role = origin");
});
afterEach(async () => {
  await db.query("rollback");
});

describe("hold_alert_deliveries", () => {
  it("defaults to pending with zero attempts", async () => {
    const res = await insert();
    expect(res.rows[0]).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("rejects a duplicate (hold_key, recipient, channel, stage)", async () => {
    await insert();
    await expectRejects(() => insert(), /hold_alert_deliveries_unique_key|duplicate key/);
  });

  it("allows the same hold for a different recipient, channel or stage", async () => {
    await insert();
    await insert({ recipient_user_id: users.acq });
    await insert({ channel: "sms" });
    await insert({ stage: "nudge_1h" });
  });

  it("enforces the channel, stage and status check constraints", async () => {
    await expectRejects(() => insert({ channel: "pigeon" }), /check constraint/);
    await expectRejects(() => insert({ stage: "second" }), /check constraint/);
    const ok = await insert();
    await expectRejects(
      () => db.query("update public.hold_alert_deliveries set status = 'lost' where id = $1", [ok.rows[0].id]),
      /check constraint/,
    );
  });

  it("owner and acquisitions members read; a plain member does not", async () => {
    await insert();
    const count = async () => (await db.query("select id from public.hold_alert_deliveries")).rows.length;
    expect(await asUser(users.owner, count)).toBe(1);
    expect(await asUser(users.acq, count)).toBe(1);
    expect(await asUser(users.plain, count)).toBe(0);
  });

  it("authenticated users cannot insert or update", async () => {
    const row = await insert();
    await expectRejects(
      () => asUser(users.owner, () => insert({ stage: "nudge_1h" })),
      /permission denied|row-level security/,
    );
    await expectRejects(
      () =>
        asUser(users.owner, () =>
          db.query("update public.hold_alert_deliveries set status = 'sent' where id = $1", [row.rows[0].id]),
        ),
      /permission denied|row-level security/,
    );
  });

  it("service_role can select, insert and update", async () => {
    await db.query("set local role service_role");
    const row = await insert({ stage: "digest", hold_key: `digest:${orgId}:2026-10-08T10` });
    await db.query("update public.hold_alert_deliveries set status = 'sent', sent_at = now() where id = $1", [
      row.rows[0].id,
    ]);
    const read = await db.query("select status from public.hold_alert_deliveries where id = $1", [row.rows[0].id]);
    await db.query("reset role");
    expect(read.rows[0].status).toBe("sent");
  });
});
