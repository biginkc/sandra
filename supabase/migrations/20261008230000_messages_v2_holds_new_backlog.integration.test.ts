import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Messages v2 Holds New / Backlog split (20261008230000). Local-only: replays
 * the 20261008140000..20261008230000 chain inside a rolled-back transaction,
 * then checks the messages_v2_settings seed + RLS and the bucket classifier.
 */
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const CHAIN = readdirSync(__dirname)
  .filter((f) => /^20261008\d{6}_.*\.sql$/.test(f) && f >= "20261008140000" && f <= "20261008230000_zz")
  .sort()
  .map((f) =>
    readFileSync(path.join(__dirname, f), "utf8").replace(/^begin;$/m, "").replace(/^commit;$/m, ""),
  );

const CUTOVER = "2026-10-08T12:00:00Z";
const BEFORE = "2026-05-01T00:00:00Z";
const AFTER = "2026-10-08T15:00:00Z";

let orgId: string;
let otherOrgId: string;
const users = {} as Record<"owner" | "acq" | "plain" | "otherOwner", string>;

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});

async function addMember(key: keyof typeof users, org: string, role: "owner" | "member", acq = false) {
  const id = randomUUID();
  users[key] = id;
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${key}-${id}@test.local`]);
  await db.query(
    `insert into public.memberships (org_id, user_id, role, access_status, acquisitions_enabled)
     values ($1, $2, $3, 'active', $4)`,
    [org, id, role, acq],
  );
}

beforeEach(async () => {
  await db.query("begin");
  for (const sql of CHAIN) await db.query(sql);
  orgId = randomUUID();
  otherOrgId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, $2), ($3, $4)", [
    orgId,
    `Split ${orgId}`,
    otherOrgId,
    `Split ${otherOrgId}`,
  ]);
  await db.query("set local session_replication_role = replica");
  await addMember("owner", orgId, "owner");
  await addMember("acq", orgId, "member", true);
  await addMember("plain", orgId, "member");
  await addMember("otherOwner", otherOrgId, "owner");
});
afterEach(async () => {
  await db.query("rollback");
});

async function seed(org = orgId, at = CUTOVER) {
  await db.query(`insert into public.messages_v2_settings (org_id, backlog_before) values ($1, $2)`, [org, at]);
}
async function flagged(escalatedAt: string | null, org = orgId): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into public.properties (id, org_id, address, state, needs_human_attention, last_ai_escalation_reason, last_ai_escalation_at)
     values ($1, $2, '1 Test St', 'MO', true, 'provider_billing', $3)`,
    [id, org, escalatedAt],
  );
  return id;
}
async function inbound(propertyId: string, at: string, direction = "inbound") {
  await db.query(
    `insert into public.messages (org_id, channel, direction, property_id, body, created_at)
     values ($1, 'sms', $2, $3, 'hi', $4)`,
    [orgId, direction, propertyId, at],
  );
}
async function buckets(bucket: "new" | "backlog", limit = 300, offset = 0, org = orgId) {
  const r = await db.query(`select public.messages_v2_hold_buckets($1, $2, $3, $4) as r`, [org, bucket, limit, offset]);
  return r.rows[0].r as {
    cutover: string;
    new_total: number;
    backlog_total: number;
    rows: Array<{ property_id: string; effective_start: string | null }>;
  };
}
const ids = (b: { rows: Array<{ property_id: string }> }) => b.rows.map((r) => r.property_id);

async function rejected(run: () => Promise<unknown>): Promise<string> {
  await db.query("savepoint expect_error");
  try {
    await run();
    await db.query("release savepoint expect_error");
    return "";
  } catch (e) {
    await db.query("rollback to savepoint expect_error");
    return String((e as Error).message);
  }
}
async function asUser<T>(userId: string, run: () => Promise<T>): Promise<T> {
  await db.query("savepoint as_user");
  await db.query("set local role authenticated");
  await db.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`, [
    userId,
    JSON.stringify({ sub: userId, role: "authenticated" }),
  ]);
  try {
    return await run();
  } finally {
    await db.query("reset role");
    await db.query("rollback to savepoint as_user");
  }
}

describe("messages_v2_settings seed", () => {
  it("insert ... on conflict do nothing keeps the first cutover", async () => {
    await seed(orgId, CUTOVER);
    await db.query(
      `insert into public.messages_v2_settings (org_id, backlog_before) values ($1, now()) on conflict (org_id) do nothing`,
      [orgId],
    );
    const r = await db.query(`select backlog_before from public.messages_v2_settings where org_id = $1`, [orgId]);
    expect(new Date(r.rows[0].backlog_before).toISOString()).toBe("2026-10-08T12:00:00.000Z");
  });

  it("is one row per org and cascades with the organization (FK on delete cascade)", async () => {
    await seed();
    expect(await rejected(() => seed())).toMatch(/duplicate key|messages_v2_settings_pkey/);
    const fk = await db.query(
      `select confdeltype from pg_constraint
        where conrelid = 'public.messages_v2_settings'::regclass and contype = 'f'`,
    );
    expect(fk.rows).toEqual([{ confdeltype: "c" }]);
  });
});

describe("messages_v2_settings RLS", () => {
  beforeEach(async () => {
    await seed();
    await seed(otherOrgId);
  });

  it("owner and acquisitions read their org only; a plain member and other orgs read nothing", async () => {
    for (const u of ["owner", "acq"] as const) {
      const n = await asUser(users[u], async () => (await db.query(`select org_id from public.messages_v2_settings`)).rows);
      expect(n.map((r) => r.org_id)).toEqual([orgId]);
    }
    const plain = await asUser(users.plain, async () => (await db.query(`select 1 from public.messages_v2_settings`)).rowCount);
    expect(plain).toBe(0);
    const other = await asUser(users.otherOwner, async () => (await db.query(`select org_id from public.messages_v2_settings`)).rows);
    expect(other.map((r) => r.org_id)).toEqual([otherOrgId]);
  });

  it("an owner can move the cutover; acquisitions and plain members cannot", async () => {
    const upd = (u: string) =>
      asUser(u, async () =>
        (await db.query(`update public.messages_v2_settings set backlog_before = $2 where org_id = $1`, [orgId, AFTER])).rowCount,
      );
    expect(await upd(users.owner)).toBe(1);
    expect(await upd(users.acq)).toBe(0);
    expect(await upd(users.plain)).toBe(0);
    expect(await upd(users.otherOwner)).toBe(0);
  });

  it("only an owner of the org can insert its row", async () => {
    await db.query(`delete from public.messages_v2_settings where org_id = $1`, [orgId]);
    const ins = (u: string) =>
      asUser(u, () =>
        rejected(() =>
          db.query(`insert into public.messages_v2_settings (org_id, backlog_before) values ($1, now())`, [orgId]),
        ),
      );
    expect(await ins(users.acq)).toMatch(/row-level security/);
    expect(await ins(users.otherOwner)).toMatch(/row-level security/);
    expect(await ins(users.owner)).toBe("");
  });
});

describe("messages_v2_hold_buckets", () => {
  it("fails loudly when the org has no cutover yet", async () => {
    expect(await rejected(() => buckets("new"))).toMatch(/messages_v2_settings missing/);
  });

  it("rejects an unknown bucket", async () => {
    await seed();
    expect(await rejected(() => buckets("other" as "new"))).toMatch(/bucket must be new or backlog/);
  });

  it("an old flagged lead is Backlog; one escalated after the cutover is New", async () => {
    await seed();
    const old = await flagged(BEFORE);
    const fresh = await flagged(AFTER);
    const nb = await buckets("new");
    const bb = await buckets("backlog");
    expect(ids(nb)).toEqual([fresh]);
    expect(ids(bb)).toEqual([old]);
    expect(nb.new_total).toBe(1);
    expect(nb.backlog_total).toBe(1);
  });

  it("an old flagged lead with a NEW inbound seller message after the cutover is New", async () => {
    await seed();
    const reopened = await flagged(BEFORE);
    const stale = await flagged(BEFORE);
    await inbound(reopened, AFTER);
    await inbound(stale, BEFORE);
    const nb = await buckets("new");
    expect(ids(nb)).toEqual([reopened]);
    expect(nb.rows[0].effective_start && new Date(nb.rows[0].effective_start).toISOString()).toBe("2026-10-08T15:00:00.000Z");
    expect(ids(await buckets("backlog"))).toEqual([stale]);
  });

  it("an outbound message after the cutover does not make a lead New", async () => {
    await seed();
    const p = await flagged(BEFORE);
    await inbound(p, AFTER, "outbound");
    expect(ids(await buckets("new"))).toEqual([]);
    expect(ids(await buckets("backlog"))).toEqual([p]);
  });

  it("a flagged lead with no escalation time and no activity is Backlog", async () => {
    await seed();
    const p = await flagged(null);
    expect(ids(await buckets("backlog"))).toEqual([p]);
    expect((await buckets("new")).new_total).toBe(0);
  });

  it("a pending decision / review / draft after the cutover makes the property New, before it does not", async () => {
    await seed();
    const dec = await flagged(BEFORE);
    const rev = await flagged(BEFORE);
    const dra = await flagged(BEFORE);
    const oldPending = await flagged(BEFORE);
    await db.query(
      `insert into public.jev_lead_decisions (org_id, property_id, conversation_id, source_inbound_message_id, classification_run_id, proposed_outcome, created_at)
       values ($1, $2, $3, $4, $5, 'nurture', $6), ($1, $7, $3, $8, $5, 'nurture', $9)`,
      [orgId, dec, randomUUID(), randomUUID(), randomUUID(), AFTER, oldPending, randomUUID(), BEFORE],
    );
    await db.query(
      `insert into public.ai_disposition_reviews (org_id, property_id, conversation_id, source_inbound_message_id, disposition, ai_reason, created_at)
       values ($1, $2, $3, $4, 'not_interested', 'r', $5)`,
      [orgId, rev, randomUUID(), randomUUID(), AFTER],
    );
    await db.query(
      `insert into public.ai_reply_drafts (org_id, property_id, body, source, status, created_at)
       values ($1, $2, 'd', 'llm', 'pending', $3)`,
      [orgId, dra, AFTER],
    );
    expect(ids(await buckets("new")).sort()).toEqual([dec, rev, dra].sort());
    expect(ids(await buckets("backlog"))).toEqual([oldPending]);
  });

  it("an unflagged property with only a pending row is still a hold (and a resolved row is not)", async () => {
    await seed();
    const p = randomUUID();
    await db.query(
      `insert into public.properties (id, org_id, address, state, needs_human_attention) values ($1, $2, '2 Test St', 'MO', false)`,
      [p, orgId],
    );
    await db.query(
      `insert into public.ai_reply_drafts (org_id, property_id, body, source, status, created_at) values ($1, $2, 'd', 'llm', 'pending', $3), ($1, $2, 'e', 'llm', 'discarded', $3)`,
      [orgId, p, AFTER],
    );
    expect(ids(await buckets("new"))).toEqual([p]);
  });

  it("orders oldest first and pages with limit/offset; counts stay exact", async () => {
    await seed();
    const a = await flagged("2026-10-09T01:00:00Z");
    const b = await flagged("2026-10-09T02:00:00Z");
    const c = await flagged("2026-10-09T03:00:00Z");
    const first = await buckets("new", 2, 0);
    const rest = await buckets("new", 2, 2);
    expect(ids(first)).toEqual([a, b]);
    expect(ids(rest)).toEqual([c]);
    expect(first.new_total).toBe(3);
    const countsOnly = await buckets("new", 0, 0);
    expect(countsOnly.rows).toEqual([]);
    expect(countsOnly.new_total).toBe(3);
    expect(countsOnly.backlog_total).toBe(0);
  });

  it("only counts its own org", async () => {
    await seed();
    await seed(otherOrgId);
    await flagged(AFTER, otherOrgId);
    const own = await flagged(AFTER);
    expect(ids(await buckets("new"))).toEqual([own]);
    expect((await buckets("new")).new_total).toBe(1);
  });

  it("runs under the caller's RLS: acquisitions sees holds, a plain member sees none", async () => {
    await seed();
    await flagged(AFTER);
    const acq = await asUser(users.acq, () => buckets("new"));
    expect(acq.new_total).toBe(1);
    const plain = await asUser(users.plain, () => rejected(() => buckets("new")));
    expect(plain).toMatch(/messages_v2_settings missing/);
  });
});

describe("rollback", () => {
  it("drops the function and table", async () => {
    const rb = readFileSync(
      path.join(__dirname, "../rollbacks/20261008230000_messages_v2_holds_new_backlog.sql"),
      "utf8",
    ).replace(/^begin;$/m, "").replace(/^commit;$/m, "");
    await db.query(rb);
    const r = await db.query(
      `select to_regclass('public.messages_v2_settings') as t, to_regproc('public.messages_v2_hold_buckets') as f`,
    );
    expect(r.rows[0]).toEqual({ t: null, f: null });
  });
});
