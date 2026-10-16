import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Messages v2 hardening (20261008143200). Local-only: replays the whole
 * 20261008140000..20261008143200 chain inside a rolled-back transaction, then
 * checks (a) automation_enabled defaults and the RPC param, (b) owner||
 * acquisitions access parity on jev_lead_decisions / ai_reply_drafts and the
 * decision RPCs, (c) outbound_mode column.
 */
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const CHAIN = readdirSync(__dirname)
  .filter((f) => /^20261008\d{6}_.*\.sql$/.test(f) && f >= "20261008140000" && f <= "20261008143200_zz")
  .sort()
  .map((f) =>
    readFileSync(path.join(__dirname, f), "utf8").replace(/^begin;$/m, "").replace(/^commit;$/m, ""),
  );

let orgId: string;
let decisionId: string;
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

beforeEach(async () => {
  await db.query("begin");
  for (const sql of CHAIN) await db.query(sql);
  orgId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `Hardening ${orgId}`]);
  await db.query("set local session_replication_role = replica");
  await addMember("owner", "owner");
  await addMember("acq", "member", true);
  await addMember("plain", "member");
  decisionId = randomUUID();
  await db.query(
    `insert into public.jev_lead_decisions
       (id, org_id, property_id, conversation_id, source_inbound_message_id, classification_run_id, proposed_outcome)
     values ($1, $2, $3, $4, $5, $6, 'new_lead')`,
    [decisionId, orgId, randomUUID(), randomUUID(), randomUUID(), randomUUID()],
  );
  await db.query(
    `insert into public.ai_reply_drafts (org_id, body, source) values ($1, 'draft', 'llm')`,
    [orgId],
  );
  await db.query("set local session_replication_role = origin");
});
afterEach(async () => {
  await db.query("rollback");
});

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

const count = (table: string) => async () =>
  (await db.query(`select id from public.${table}`)).rows.length;

describe("access parity (owner || acquisitions)", () => {
  for (const table of ["jev_lead_decisions", "ai_reply_drafts"]) {
    it(`${table}: owner and acquisitions read, plain member does not`, async () => {
      expect(await asUser(users.owner, count(table))).toBe(1);
      expect(await asUser(users.acq, count(table))).toBe(1);
      expect(await asUser(users.plain, count(table))).toBe(0);
    });
  }

  it("ai_reply_drafts: authenticated cannot insert", async () => {
    await expect(
      asUser(users.owner, () =>
        db.query(`insert into public.ai_reply_drafts (org_id, body, source) values ($1, 'x', 'llm')`, [orgId]),
      ),
    ).rejects.toThrow();
  });

  it("confirm and correct RPCs reject a plain active member with FORBIDDEN", async () => {
    await expect(
      asUser(users.plain, () => db.query("select public.fn_confirm_jev_lead_decision($1)", [decisionId])),
    ).rejects.toThrow(/FORBIDDEN/);
    await expect(
      asUser(users.plain, () =>
        db.query("select public.fn_correct_jev_lead_decision($1, 'nurture', 'r')", [decisionId]),
      ),
    ).rejects.toThrow(/FORBIDDEN/);
  });

  it("confirm RPC passes the access check for an Acquisitions member", async () => {
    let message = "";
    try {
      await asUser(users.acq, () => db.query("select public.fn_confirm_jev_lead_decision($1)", [decisionId]));
    } catch (e) {
      message = String((e as Error).message);
    }
    expect(message).not.toMatch(/FORBIDDEN/);
  });
});

describe("automation_enabled", () => {
  const set = (outcome: string, enabled: boolean | null) => () =>
    db.query(
      `select public.fn_set_jev_outcome_threshold($1, $2, 0.9, 0, $3, $4) as r`,
      [orgId, outcome, randomUUID(), enabled],
    );

  it("a new new_lead row defaults to held; the other outcomes default to on", async () => {
    const lead = await asUser(users.owner, set("new_lead", null));
    expect(lead.rows[0].r.automationEnabled).toBe(false);
    const ni = await asUser(users.owner, set("not_interested", null));
    expect(ni.rows[0].r.automationEnabled).toBe(true);
  });

  it("an explicit value is stored and recorded in history", async () => {
    await asUser(users.owner, set("new_lead", true));
    const row = await db.query(
      `select t.automation_enabled, h.new_automation_enabled
         from public.jev_outcome_thresholds t
         join public.jev_outcome_threshold_history h on h.threshold_id = t.id
        where t.org_id = $1 and t.outcome = 'new_lead'`,
      [orgId],
    );
    expect(row.rows[0]).toEqual({ automation_enabled: true, new_automation_enabled: true });
  });

  it("only an owner may change it", async () => {
    await expect(asUser(users.acq, set("new_lead", true))).rejects.toThrow(/FORBIDDEN/);
  });
});

describe("outbound_mode", () => {
  it("defaults to send and rejects other values", async () => {
    const col = await db.query(
      `select column_default from information_schema.columns
        where table_name = 'ai_responder_configs' and column_name = 'outbound_mode'`,
    );
    expect(col.rows[0].column_default).toContain("send");
    const con = await db.query(
      `select 1 from pg_constraint where conname = 'ai_responder_configs_outbound_mode_check'`,
    );
    expect(con.rows).toHaveLength(1);
  });
});

describe("pipeline_runs_latest_for_properties", () => {
  it("returns exactly the newest run per property, nothing outside the org, and respects RLS", async () => {
    const propA = randomUUID();
    const propB = randomUUID();
    const otherOrg = randomUUID();
    await db.query("insert into public.organizations (id, name) values ($1, 'other')", [otherOrg]);
    await db.query("set local session_replication_role = replica");
    const mk = async (org: string, prop: string, startedAt: string) =>
      db.query(
        `insert into public.pipeline_runs (org_id, inbound_message_id, property_id, started_at)
         values ($1, $2, $3, $4) returning id`,
        [org, randomUUID(), prop, startedAt],
      );
    await mk(orgId, propA, "2026-01-01T00:00:00Z");
    const newestA = (await mk(orgId, propA, "2026-01-03T00:00:00Z")).rows[0].id;
    await mk(orgId, propA, "2026-01-02T00:00:00Z");
    const onlyB = (await mk(orgId, propB, "2026-01-01T00:00:00Z")).rows[0].id;
    const foreign = propB; // same property id, different org: must not leak
    await mk(otherOrg, foreign, "2026-02-01T00:00:00Z");
    await db.query("set local session_replication_role = origin");

    const call = () =>
      db.query("select id, property_id from public.pipeline_runs_latest_for_properties($1, $2)", [
        orgId,
        [propA, propB],
      ]);
    const asOwner = await asUser(users.owner, call);
    expect(asOwner.rows.map((r) => r.id).sort()).toEqual([newestA, onlyB].sort());
    expect(new Set(asOwner.rows.map((r) => r.property_id)).size).toBe(2);

    const asPlain = await asUser(users.plain, call);
    expect(asPlain.rows).toHaveLength(0);
  });
});
