import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Messages v2 Phase 1 hold actions (20261008150100). Local-only: replays the
 * 20261008140000..20261008150100 chain inside a rolled-back transaction, then
 * checks fn_resolve_hold (Dismiss / Take over) and the draft bookkeeping
 * columns.
 */
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const CHAIN = readdirSync(__dirname)
  .filter((f) => /^20261008\d{6}_.*\.sql$/.test(f) && f >= "20261008140000" && f <= "20261008150100_zz")
  .sort()
  .map((f) =>
    readFileSync(path.join(__dirname, f), "utf8").replace(/^begin;$/m, "").replace(/^commit;$/m, ""),
  );

let orgId: string;
let otherOrgId: string;
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

beforeEach(async () => {
  await db.query("begin");
  for (const sql of CHAIN) await db.query(sql);
  orgId = randomUUID();
  otherOrgId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, $2), ($3, $4)", [
    orgId,
    `Holds ${orgId}`,
    otherOrgId,
    `Holds ${otherOrgId}`,
  ]);
  await db.query("set local session_replication_role = replica");
  await addMember("owner", "owner");
  await addMember("acq", "member", true);
  await addMember("plain", "member");
  propertyId = randomUUID();
  await db.query(
    `insert into public.properties (id, org_id, address, state, needs_human_attention, last_ai_escalation_reason, last_ai_escalation_at)
     values ($1, $2, '1 Test St', 'MO', true, 'draft_held', now())`,
    [propertyId, orgId],
  );
  await db.query(
    `insert into public.jev_lead_decisions
       (org_id, property_id, conversation_id, source_inbound_message_id, classification_run_id, proposed_outcome)
     values ($1, $2, $3, $4, $5, 'nurture')`,
    [orgId, propertyId, randomUUID(), randomUUID(), randomUUID()],
  );
  await db.query(
    `insert into public.ai_disposition_reviews
       (org_id, property_id, conversation_id, source_inbound_message_id, disposition, ai_reason)
     values ($1, $2, $3, $4, 'not_interested', 'r')`,
    [orgId, propertyId, randomUUID(), randomUUID()],
  );
  await db.query(
    `insert into public.ai_reply_drafts (org_id, property_id, body, source, status) values ($1, $2, 'draft', 'llm', 'pending')`,
    [orgId, propertyId],
  );
  // Stays `replica` for the test: rows inserted above skip FKs, and Postgres
  // re-checks an FK on UPDATE when the row was inserted in this transaction.
});
afterEach(async () => {
  await db.query("rollback");
});

const resolve = (user: string, action: string, reason: string | null, org = orgId) =>
  db.query("select public.fn_resolve_hold($1, $2, $3, $4, $5) as r", [org, propertyId, user, action, reason]);

/** A call expected to raise: isolated in a savepoint so the transaction survives. */
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

async function state() {
  const p = await db.query(
    `select needs_human_attention, last_ai_escalation_reason, ai_responder_disabled from public.properties where id = $1`,
    [propertyId],
  );
  const d = await db.query(`select status, superseded_reason from public.jev_lead_decisions where property_id = $1`, [propertyId]);
  const r = await db.query(`select status, superseded_reason from public.ai_disposition_reviews where property_id = $1`, [propertyId]);
  const x = await db.query(
    `select status, resolved_by, resolution_reason from public.ai_reply_drafts where property_id = $1`,
    [propertyId],
  );
  return { p: p.rows[0], d: d.rows[0], r: r.rows[0], x: x.rows[0] };
}

describe("fn_resolve_hold", () => {
  it("dismiss supersedes decisions and reviews, discards drafts and clears the flag, but leaves the responder on", async () => {
    const out = await resolve(users.acq, "dismiss", "handled by phone");
    expect(out.rows[0].r).toMatchObject({ decisionsSuperseded: 1, reviewsSuperseded: 1, draftsDiscarded: 1, wasFlagged: true });
    const s = await state();
    expect(s.p).toMatchObject({ needs_human_attention: false, last_ai_escalation_reason: null, ai_responder_disabled: false });
    expect(s.d).toMatchObject({ status: "superseded", superseded_reason: "hold_dismissed" });
    expect(s.r).toMatchObject({ status: "superseded", superseded_reason: "hold_dismissed" });
    expect(s.x).toMatchObject({ status: "discarded", resolved_by: users.acq });
    expect(s.x.resolution_reason).toBe("dismissed: handled by phone");
  });

  it("dismiss requires a reason", async () => {
    expect(await rejected(() => resolve(users.owner, "dismiss", "   "))).toMatch(/REASON_REQUIRED/);
    expect(await rejected(() => resolve(users.owner, "dismiss", null))).toMatch(/REASON_REQUIRED/);
  });

  it("take over also switches the AI responder off for the property", async () => {
    await resolve(users.owner, "take_over", null);
    const s = await state();
    expect(s.p).toMatchObject({ needs_human_attention: false, ai_responder_disabled: true });
    expect(s.d.superseded_reason).toBe("hold_taken_over");
    expect(s.x).toMatchObject({ status: "discarded", resolution_reason: "taken_over" });
  });

  it("a plain member and a user from another org are forbidden", async () => {
    expect(await rejected(() => resolve(users.plain, "dismiss", "x"))).toMatch(/FORBIDDEN/);
    expect(await rejected(() => resolve(users.owner, "dismiss", "x", otherOrgId))).toMatch(/FORBIDDEN/);
  });

  it("a property from another org is not found", async () => {
    expect(await rejected(() => db.query("select public.fn_resolve_hold($1, $2, $3, 'dismiss', 'x')", [orgId, randomUUID(), users.owner]))).toMatch(
      /PROPERTY_NOT_FOUND/,
    );
  });

  it("is idempotent: a second resolve changes nothing and does not fail", async () => {
    await resolve(users.owner, "dismiss", "done");
    const again = await resolve(users.owner, "dismiss", "done");
    expect(again.rows[0].r).toMatchObject({ decisionsSuperseded: 0, reviewsSuperseded: 0, draftsDiscarded: 0, wasFlagged: false });
  });

  it("is callable only by service_role", async () => {
    await db.query("set local role authenticated");
    const message = await rejected(() => resolve(users.owner, "dismiss", "x"));
    await db.query("reset role");
    expect(message).toMatch(/permission denied/);
  });
});
