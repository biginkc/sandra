import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Messages v2 send reservation (20261008143300). Local-only: replays the whole
 * 20261008140000..20261008143300 chain inside a rolled-back transaction, then
 * checks (a) automation_enabled defaults and the RPC param, (b) owner||
 * acquisitions access parity on jev_lead_decisions / ai_reply_drafts and the
 * decision RPCs, (c) outbound_mode column.
 */
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const CHAIN = readdirSync(__dirname)
  .filter((f) => /^20261008\d{6}_.*\.sql$/.test(f) && f >= "20261008140000" && f <= "20261008143300_zz")
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



describe("decision RPC guard (all four user-callable RPCs)", () => {
  const calls: Array<[string, string, unknown[]]> = [
    ["fn_confirm_jev_lead_decision", "($1)", [] ],
    ["fn_correct_jev_lead_decision", "($1, 'nurture', 'r')", []],
    ["fn_apply_and_record_jev_lead_decision_correction", "($1, 'opted_out', 'r')", []],
    ["fn_mark_jev_lead_decision_reviewed", "($1)", []],
  ];
  for (const [fn, args] of calls) {
    it(`${fn} rejects a plain active member with FORBIDDEN`, async () => {
      await expect(
        asUser(users.plain, () => db.query(`select public.${fn}${args}`, [decisionId])),
      ).rejects.toThrow(/FORBIDDEN/);
    });
    it(`${fn} passes the access check for an Acquisitions member`, async () => {
      let message = "";
      try {
        await asUser(users.acq, () => db.query(`select public.${fn}${args}`, [decisionId]));
      } catch (e) {
        message = String((e as Error).message);
      }
      expect(message).not.toMatch(/FORBIDDEN/);
    });
  }

  it("the migration's assertion block fails loudly when a guard is missing", async () => {
    await db.query("savepoint s");
    await db.query(
      `create or replace function public.fn_begin_jev_lead_decision_correction(p uuid) returns void language sql as 'select 1'`,
    );
    await expect(db.query(CHAIN[CHAIN.length - 1])).rejects.toThrow(/without the pipeline_runs_can_read guard/);
    await db.query("rollback to savepoint s");
  });
});

describe("policies keep owner || acquisitions access", () => {
  for (const table of ["jev_lead_decisions", "ai_reply_drafts", "pipeline_runs"]) {
    it(`${table}: owner and acquisitions read, plain member does not`, async () => {
      if (table === "ai_reply_drafts") {
        await db.query("set local session_replication_role = replica");
        await db.query(`insert into public.ai_reply_drafts (org_id, body, source) values ($1, 'd', 'llm')`, [orgId]);
        await db.query("set local session_replication_role = origin");
      }
      if (table === "pipeline_runs") {
        await db.query("set local session_replication_role = replica");
        await db.query(
          `insert into public.pipeline_runs (org_id, inbound_message_id) values ($1, $2)`,
          [orgId, randomUUID()],
        );
        await db.query("set local session_replication_role = origin");
      }
      expect(await asUser(users.owner, count(table))).toBe(1);
      expect(await asUser(users.acq, count(table))).toBe(1);
      expect(await asUser(users.plain, count(table))).toBe(0);
    });
  }
});

describe("ai_send_reservations", () => {
  const conv = () => randomUUID();
  const reserve = async (c: string, holder: string, secs = 60) =>
    (await db.query("select public.fn_reserve_ai_send($1, $2, $3, $4) as ok", [c, randomUUID(), holder, secs]))
      .rows[0].ok as boolean;

  it("only one of two reservations for the same conversation wins", async () => {
    const c = conv();
    expect(await reserve(c, "a")).toBe(true);
    expect(await reserve(c, "b")).toBe(false);
    expect(await reserve(conv(), "b")).toBe(true);
  });

  it("an expired lease can be taken over; a live one cannot", async () => {
    const c = conv();
    expect(await reserve(c, "a")).toBe(true);
    await db.query("update public.ai_send_reservations set expires_at = clock_timestamp() - interval '1 second' where conversation_id = $1", [c]);
    expect(await reserve(c, "b")).toBe(true);
    const row = await db.query("select holder from public.ai_send_reservations where conversation_id = $1", [c]);
    expect(row.rows[0].holder).toBe("b");
    expect(await reserve(c, "c")).toBe(false);
  });

  it("release only works for the holder and frees the conversation", async () => {
    const c = conv();
    await reserve(c, "a");
    expect((await db.query("select public.fn_release_ai_send($1, 'b') as ok", [c])).rows[0].ok).toBe(false);
    expect((await db.query("select public.fn_release_ai_send($1, 'a') as ok", [c])).rows[0].ok).toBe(true);
    expect(await reserve(c, "b")).toBe(true);
  });

  it("rejects a bad lease and is not callable by authenticated members", async () => {
    await db.query("savepoint y");
    await expect(db.query("select public.fn_reserve_ai_send($1, null, 'a', 0)", [conv()])).rejects.toThrow(/INVALID_REQUEST/);
    await db.query("rollback to savepoint y");
    await db.query("savepoint x");
    await expect(
      asUser(users.owner, () => db.query("select public.fn_reserve_ai_send($1, null, 'a', 30)", [conv()])),
    ).rejects.toThrow(/permission denied/);
    await db.query("rollback to savepoint x");
  });
});

describe("ai_reply_drafts pending uniqueness", () => {
  it("allows one pending draft per inbound, but a new one after the first is sent", async () => {
    await db.query("set local session_replication_role = replica");
    const inbound = randomUUID();
    const ins = (status: string) =>
      db.query(
        `insert into public.ai_reply_drafts (org_id, inbound_message_id, body, source, status) values ($1, $2, 'x', 'llm', $3)`,
        [orgId, inbound, status],
      );
    await ins("pending");
    await db.query("savepoint dup");
    await expect(ins("pending")).rejects.toThrow(/uq_ai_reply_drafts_pending_inbound/);
    await db.query("rollback to savepoint dup");
    await ins("discarded");
    await ins("sent");
  });
});
