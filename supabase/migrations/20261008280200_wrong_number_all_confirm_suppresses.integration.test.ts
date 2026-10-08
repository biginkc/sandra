import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

/**
 * 20261008280200: confirming a wrong_number review scoped to all records the
 * durable phone-suppression obligation (ledger row + hold pointer), in both the
 * deferred and the already-applied branch; this_property records nothing; the
 * sweeper feed includes it. Local-only, rolled-back transaction per test, on a
 * DB with the chain through 20261008280100 applied.
 */
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const strip = (s: string) => s.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");
const MIGRATION = strip(readFileSync(path.join(__dirname, "20261008280200_wrong_number_all_confirm_suppresses.sql"), "utf8"));
const ROLLBACK = strip(
  readFileSync(path.join(__dirname, "../rollbacks/20261008280200_wrong_number_all_confirm_suppresses.sql"), "utf8"),
);

const db = new Client({ connectionString: url });
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
  await db.query(MIGRATION);
  orgId = randomUUID();
  ownerId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, 'wn-all')", [orgId]);
  await db.query("set local session_replication_role = replica");
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [ownerId, `o-${ownerId}@test.local`]);
  await db.query(
    `insert into public.memberships (org_id, user_id, role, access_status) values ($1, $2, 'owner', 'active')`,
    [orgId, ownerId],
  );
  await db.query("set local session_replication_role = origin");
});
afterEach(async () => {
  await db.query("rollback");
});

async function review(opts: { scope: "all" | "this_property" | null; applied: boolean; hold?: string | null }) {
  const propertyId = randomUUID();
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const reviewId = randomUUID();
  await db.query("set local session_replication_role = replica");
  await db.query(
    `insert into public.properties (id, org_id, address, state, status, outreach_dispo, needs_human_attention, last_ai_escalation_reason)
     values ($1, $2, 'WN St', 'TX', 'prospect', $3, true, $4)`,
    [propertyId, orgId, opts.applied ? "wrong_number" : null, opts.hold ?? null],
  );
  await db.query(
    `insert into public.messages (id, org_id, property_id, conversation_id, channel, direction, body)
     values ($1, $2, $3, $4, 'sms', 'inbound', 'wrong number')`,
    [messageId, orgId, propertyId, conversationId],
  );
  await db.query(
    `insert into public.ai_disposition_reviews
       (id, org_id, property_id, conversation_id, source_inbound_message_id, disposition, ai_reason, status, dispo_applied, wrong_scope)
     values ($1, $2, $3, $4, $5, 'wrong_number', 'model:wrong_number', 'pending', $6, $7)`,
    [reviewId, orgId, propertyId, conversationId, messageId, opts.applied, opts.scope],
  );
  await db.query("set local session_replication_role = origin");
  return { propertyId, reviewId };
}

async function confirm(reviewId: string) {
  await db.query("savepoint c");
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claim.sub', $1, true)", [ownerId]);
  try {
    const r = (await db.query(`select public.fn_confirm_ai_disposition_review($1) as r`, [reviewId])).rows[0].r;
    await db.query("reset role");
    await db.query("release savepoint c");
    return r;
  } catch (e) {
    await db.query("rollback to savepoint c");
    await db.query("reset role");
    throw e;
  }
}

const ledger = async (reviewId: string) =>
  (
    await db.query(
      `select 1 from public.lead_events where event_type = 'suppression_incomplete' and source_type = 'ai_disposition_reviews' and source_id = $1`,
      [reviewId],
    )
  ).rowCount;
const prop = async (id: string) =>
  (await db.query(`select outreach_dispo, needs_human_attention, last_ai_escalation_reason from public.properties where id = $1`, [id])).rows[0];

describe("fn_confirm_ai_disposition_review for wrong_number", () => {
  for (const applied of [false, true]) {
    it(`scope all (${applied ? "already applied" : "deferred"}): records the obligation and replaces the hold with the suppression pointer`, async () => {
      const { propertyId, reviewId } = await review({ scope: "all", applied, hold: "jev_wrong_number_all_needs_confirm" });
      expect((await confirm(reviewId)).status).toBe("confirmed");
      expect(await ledger(reviewId)).toBe(1);
      const p = await prop(propertyId);
      expect(p.outreach_dispo).toBe("wrong_number");
      expect(p.needs_human_attention).toBe(true);
      expect(p.last_ai_escalation_reason).toBe(`suppression_incomplete:${reviewId}`);
    });

    it(`scope this_property (${applied ? "already applied" : "deferred"}): no obligation, no suppression pointer`, async () => {
      const { propertyId, reviewId } = await review({ scope: "this_property", applied });
      await confirm(reviewId);
      expect(await ledger(reviewId)).toBe(0);
      expect((await prop(propertyId)).last_ai_escalation_reason ?? "").not.toMatch(/^suppression_incomplete/);
    });
  }

  it("a review that was never confirmed (dismissed/left pending) records nothing", async () => {
    const { reviewId } = await review({ scope: "all", applied: true });
    expect(await ledger(reviewId)).toBe(0);
  });

  it("the sweeper feed lists the confirmed scope=all review once its ledger row is old enough, and not a this_property one", async () => {
    const a = await review({ scope: "all", applied: true });
    const b = await review({ scope: "this_property", applied: true });
    await confirm(a.reviewId);
    await confirm(b.reviewId);
    await db.query(`update public.lead_events set created_at = now() - interval '1 hour' where source_id = $1`, [a.reviewId]);
    const rows = (await db.query(`select review_id from public.fn_list_outstanding_suppression_obligations(0, 50)`)).rows;
    expect(rows.map((r) => r.review_id)).toContain(a.reviewId);
    expect(rows.map((r) => r.review_id)).not.toContain(b.reviewId);
  });

  it("the CHECK refuses a wrong_scope on a non-wrong_number review, and rollback drops the column", async () => {
    await expect(
      db.query(
        `insert into public.ai_disposition_reviews
           (org_id, property_id, conversation_id, source_inbound_message_id, disposition, ai_reason, wrong_scope)
         values ($1, $2, $3, $4, 'dnc', 'x', 'all')`,
        [orgId, randomUUID(), randomUUID(), randomUUID()],
      ),
    ).rejects.toThrow();
    await db.query("rollback");
    await db.query("begin");
    await db.query(MIGRATION);
    await db.query(ROLLBACK);
    const col = await db.query(
      `select 1 from information_schema.columns where table_name = 'ai_disposition_reviews' and column_name = 'wrong_scope'`,
    );
    expect(col.rowCount).toBe(0);
  });
});
