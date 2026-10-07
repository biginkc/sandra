import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Messages v2 Phase 1 hold resolve stale guard + alert sending (20261008150200). Local-only: replays the
 * 20261008140000..20261008150200 chain inside a rolled-back transaction, then
 * checks the version-aware fn_resolve_hold (Dismiss / Take over), its
 * lease against a concurrent Send, and the hold_alert_deliveries 'sending' status.
 */
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const CHAIN = readdirSync(__dirname)
  .filter((f) => /^20261008\d{6}_.*\.sql$/.test(f) && f >= "20261008140000" && f <= "20261008150200_zz")
  .sort()
  .map((f) =>
    readFileSync(path.join(__dirname, f), "utf8").replace(/^begin;$/m, "").replace(/^commit;$/m, ""),
  );

const T0 = "2026-10-07T12:00:00.123456+00";
const FLAG_AT = "2026-10-07T11:59:00.654321+00";

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
     values ($1, $2, '1 Test St', 'MO', true, 'draft_held', '${FLAG_AT}')`,
    [propertyId, orgId],
  );
  await db.query(
    `insert into public.jev_lead_decisions
       (org_id, property_id, conversation_id, source_inbound_message_id, classification_run_id, proposed_outcome, created_at)
     values ($1, $2, $3, $4, $5, 'nurture', '${T0}')`,
    [orgId, propertyId, randomUUID(), randomUUID(), randomUUID()],
  );
  await db.query(
    `insert into public.ai_disposition_reviews
       (org_id, property_id, conversation_id, source_inbound_message_id, disposition, ai_reason, created_at)
     values ($1, $2, $3, $4, 'not_interested', 'r', '${T0}')`,
    [orgId, propertyId, randomUUID(), randomUUID()],
  );
  await db.query(
    `insert into public.ai_reply_drafts (org_id, property_id, body, source, status, created_at) values ($1, $2, 'draft', 'llm', 'pending', '${T0}')`,
    [orgId, propertyId],
  );
  // Stays `replica` for the test: rows inserted above skip FKs, and Postgres
  // re-checks an FK on UPDATE when the row was inserted in this transaction.
});
afterEach(async () => {
  await db.query("rollback");
});

const resolve = (
  user: string,
  action: string,
  reason: string | null,
  seen: { through?: string | null; flagReason?: string | null; flagAt?: string | null } = {
    through: T0,
    flagReason: "draft_held",
    flagAt: FLAG_AT,
  },
  org = orgId,
) =>
  db.query("select public.fn_resolve_hold($1, $2, $3, $4, $5, $6, $7, $8) as r", [
    org,
    propertyId,
    user,
    action,
    reason,
    seen.through ?? null,
    seen.flagReason ?? null,
    seen.flagAt ?? null,
  ]);

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
  const d = await db.query(`select status, superseded_reason from public.jev_lead_decisions where property_id = $1 order by created_at`, [propertyId]);
  const r = await db.query(`select status, superseded_reason from public.ai_disposition_reviews where property_id = $1 order by created_at`, [propertyId]);
  const x = await db.query(
    `select status, resolved_by, resolution_reason from public.ai_reply_drafts where property_id = $1 order by created_at`,
    [propertyId],
  );
  return { p: p.rows[0], d: d.rows, r: r.rows, x: x.rows };
}

describe("fn_resolve_hold (version-aware)", () => {
  it("dismiss resolves what the card displayed, discards the draft and clears the flag, leaving the responder on", async () => {
    const out = await resolve(users.acq, "dismiss", "handled by phone");
    expect(out.rows[0].r).toMatchObject({
      status: "OK",
      decisionsSuperseded: 1,
      reviewsSuperseded: 1,
      draftsDiscarded: 1,
      wasFlagged: true,
      flagCleared: true,
      responderChanged: false,
    });
    const s = await state();
    expect(s.p).toMatchObject({ needs_human_attention: false, last_ai_escalation_reason: null, ai_responder_disabled: false });
    expect(s.d[0]).toMatchObject({ status: "superseded", superseded_reason: "hold_dismissed" });
    expect(s.r[0]).toMatchObject({ status: "superseded", superseded_reason: "hold_dismissed" });
    expect(s.x[0]).toMatchObject({ status: "discarded", resolved_by: users.acq, resolution_reason: "dismissed: handled by phone" });
  });

  it("returns STALE and changes nothing when a decision, review or draft was created after the card loaded", async () => {
    for (const table of ["decision", "review", "draft"] as const) {
      await db.query("savepoint s");
      if (table === "decision") {
        await db.query(
          `insert into public.jev_lead_decisions
             (org_id, property_id, conversation_id, source_inbound_message_id, classification_run_id, proposed_outcome, created_at)
           values ($1, $2, $3, $4, $5, 'nurture', '2026-10-07T12:05:00+00')`,
          [orgId, propertyId, randomUUID(), randomUUID(), randomUUID()],
        );
      } else if (table === "review") {
        await db.query(
          `insert into public.ai_disposition_reviews
             (org_id, property_id, conversation_id, source_inbound_message_id, disposition, ai_reason, created_at)
           values ($1, $2, $3, $4, 'not_interested', 'r', '2026-10-07T12:05:00+00')`,
          [orgId, propertyId, randomUUID(), randomUUID()],
        );
      } else {
        await db.query(
          `insert into public.ai_reply_drafts (org_id, property_id, body, source, status, created_at)
           values ($1, $2, 'newer', 'llm', 'pending', '2026-10-07T12:05:00+00')`,
          [orgId, propertyId],
        );
      }
      const out = await resolve(users.owner, "take_over", null);
      expect(out.rows[0].r).toMatchObject({ status: "STALE" });
      const s = await state();
      expect(s.p).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "draft_held", ai_responder_disabled: false });
      expect(s.d.every((r: { status: string }) => r.status === "pending")).toBe(true);
      expect(s.r.every((r: { status: string }) => r.status === "pending")).toBe(true);
      expect(s.x.every((r: { status: string }) => r.status === "pending")).toBe(true);
      await db.query("rollback to savepoint s");
    }
  });

  it("returns STALE and leaves everything alone when the flag changed after the card loaded", async () => {
    await db.query(
      `update public.properties set last_ai_escalation_reason = 'price_or_offer', last_ai_escalation_at = '2026-10-07T12:10:00+00' where id = $1`,
      [propertyId],
    );
    const out = await resolve(users.owner, "dismiss", "x");
    expect(out.rows[0].r).toMatchObject({ status: "STALE" });
    const s = await state();
    expect(s.p).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "price_or_offer" });
    expect(s.d[0].status).toBe("pending");
  });

  it("a card that displayed no pending rows (flag only) is STALE if rows exist", async () => {
    const out = await resolve(users.owner, "dismiss", "x", { through: null, flagReason: "draft_held", flagAt: FLAG_AT });
    expect(out.rows[0].r).toMatchObject({ status: "STALE" });
  });

  it("dismiss requires a reason", async () => {
    expect(await rejected(() => resolve(users.owner, "dismiss", "   "))).toMatch(/REASON_REQUIRED/);
    expect(await rejected(() => resolve(users.owner, "dismiss", null))).toMatch(/REASON_REQUIRED/);
  });

  it("take over also switches the AI responder off, and reports that it changed it only once", async () => {
    const first = await resolve(users.owner, "take_over", null);
    expect(first.rows[0].r).toMatchObject({ status: "OK", responderChanged: true, flagCleared: true });
    const s = await state();
    expect(s.p).toMatchObject({ needs_human_attention: false, ai_responder_disabled: true });
    expect(s.d[0].superseded_reason).toBe("hold_taken_over");
    expect(s.x[0]).toMatchObject({ status: "discarded", resolution_reason: "taken_over" });
    const second = await resolve(users.owner, "take_over", null);
    expect(second.rows[0].r).toMatchObject({ status: "OK", responderChanged: false, flagCleared: false });
  });

  it("a plain member and a user from another org are forbidden", async () => {
    expect(await rejected(() => resolve(users.plain, "dismiss", "x"))).toMatch(/FORBIDDEN/);
    expect(await rejected(() => resolve(users.owner, "dismiss", "x", undefined, otherOrgId))).toMatch(/FORBIDDEN/);
  });

  it("a property from another org is not found", async () => {
    expect(
      await rejected(() =>
        db.query("select public.fn_resolve_hold($1, $2, $3, 'dismiss', 'x')", [orgId, randomUUID(), users.owner]),
      ),
    ).toMatch(/PROPERTY_NOT_FOUND/);
  });

  it("is idempotent: a second resolve changes nothing and does not fail", async () => {
    await resolve(users.owner, "dismiss", "done");
    const again = await resolve(users.owner, "dismiss", "done");
    expect(again.rows[0].r).toMatchObject({ status: "OK", decisionsSuperseded: 0, reviewsSuperseded: 0, draftsDiscarded: 0, wasFlagged: false });
  });

  it("refuses with SEND_IN_PROGRESS while a send holds the property lease, and releases its own lease after", async () => {
    await db.query(
      `insert into public.ai_send_reservations (conversation_id, holder, expires_at) values ($1, 'hold-send:u', now() + interval '1 minute')`,
      [propertyId],
    );
    expect(await rejected(() => resolve(users.owner, "dismiss", "x"))).toMatch(/SEND_IN_PROGRESS/);
    await db.query(`delete from public.ai_send_reservations where conversation_id = $1`, [propertyId]);
    await resolve(users.owner, "dismiss", "x");
    const left = await db.query(`select 1 from public.ai_send_reservations where conversation_id = $1`, [propertyId]);
    expect(left.rowCount).toBe(0);
  });

  it("an expired send lease does not block", async () => {
    await db.query(
      `insert into public.ai_send_reservations (conversation_id, holder, expires_at) values ($1, 'hold-send:u', now() - interval '1 minute')`,
      [propertyId],
    );
    const out = await resolve(users.owner, "dismiss", "x");
    expect(out.rows[0].r).toMatchObject({ status: "OK" });
  });

  it("is callable only by service_role", async () => {
    await db.query("set local role authenticated");
    const message = await rejected(() => resolve(users.owner, "dismiss", "x"));
    await db.query("reset role");
    expect(message).toMatch(/permission denied/);
  });
});

describe("hold_alert_deliveries status", () => {
  it("accepts 'sending' (with sending_at) and still rejects unknown statuses", async () => {
    await db.query(
      `insert into public.hold_alert_deliveries (org_id, property_id, hold_key, recipient_user_id, channel, stage, status, sending_at)
       values ($1, $2, 'k', $3, 'slack', 'first', 'sending', now())`,
      [orgId, propertyId, users.owner],
    );
    expect(
      await rejected(() =>
        db.query(
          `insert into public.hold_alert_deliveries (org_id, property_id, hold_key, recipient_user_id, channel, stage, status)
           values ($1, $2, 'k2', $3, 'slack', 'first', 'bogus')`,
          [orgId, propertyId, users.owner],
        ),
      ),
    ).toMatch(/hold_alert_deliveries_status_check/);
  });
});
