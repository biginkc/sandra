import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

/**
 * 20261008300200: confirming a wrong_number review scoped to all records the
 * durable phone-suppression obligation (ledger row + hold pointer), in both the
 * deferred and the already-applied branch; this_property records nothing; the
 * sweeper feed includes it. Local-only, rolled-back transaction per test, on a
 * DB with the chain through 20261008300100 applied.
 */
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const strip = (s: string) => s.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");
const MIGRATION = strip(readFileSync(path.join(__dirname, "20261008300200_wrong_number_all_confirm_suppresses.sql"), "utf8"));
const ROLLBACK = strip(
  readFileSync(path.join(__dirname, "../rollbacks/20261008300200_wrong_number_all_confirm_suppresses.sql"), "utf8"),
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

describe("scope is written by the review-creating RPC itself (no window to confirm first)", () => {
  async function thread() {
    const contactId = randomUUID();
    const propertyId = randomUUID();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    await db.query(
      `insert into public.contacts (id, org_id, first_name, phone_1, phone_1_type) values ($1, $2, 'Home', $3, 'mobile')`,
      [contactId, orgId, `+1555${Math.floor(1000000 + Math.random() * 8999999)}`],
    );
    await db.query(
      `insert into public.properties (id, org_id, address, state, status, outreach_dispo, homeowner_contact_id)
       values ($1, $2, 'RPC St', 'TX', 'new_lead', null, $3)`,
      [propertyId, orgId, contactId],
    );
    await db.query(
      `insert into public.message_threads (org_id, channel, contact_id, property_id, conversation_id) values ($1, 'sms', $2, $3, $4)`,
      [orgId, contactId, propertyId, conversationId],
    );
    await db.query(
      `insert into public.messages (id, org_id, property_id, conversation_id, contact_id, channel, direction, body)
       values ($1, $2, $3, $4, $5, 'sms', 'inbound', 'wrong number')`,
      [messageId, orgId, propertyId, conversationId, contactId],
    );
    const runId = randomUUID();
    await db.query(
      `insert into public.sms_classification_runs
         (id, org_id, property_id, conversation_id, source_inbound_message_id, provider, model, schema_version, policy_version, state_hash, state_version, decision, resolved_outcome)
       values ($1, $2, $3, $4, $5, 'jev', 'jev-1.13.0', 2, 'p', $6, 1, '{}'::jsonb, 'wrong_number')`,
      [runId, orgId, propertyId, conversationId, messageId, randomUUID()],
    );
    return { propertyId, conversationId, messageId, runId };
  }
  const asService = async <T,>(fn: () => Promise<T>) => {
    await db.query("set local role service_role");
    await db.query("select set_config('request.jwt.claim.role', 'service_role', true)");
    try {
      return await fn();
    } finally {
      await db.query("select set_config('request.jwt.claim.role', '', true)");
      await db.query("reset role");
    }
  };
  const revision = async (propertyId: string) =>
    (await db.query("select decision_context_revision from public.properties where id = $1", [propertyId])).rows[0]
      .decision_context_revision;
  const reviewFor = async (messageId: string) =>
    (await db.query("select id, wrong_scope, dispo_applied from public.ai_disposition_reviews where source_inbound_message_id = $1", [messageId])).rows[0];

  it("fn_apply_ai_disposition_with_review stores the scope on the new review, and the review is confirmable only with it already set", async () => {
    const t = await thread();
    await asService(async () =>
      db.query(`select public.fn_apply_ai_disposition_with_review($1, $2, $3, 'wrong_number', 'model:wrong_number', $4, 'all')`, [
        t.propertyId, t.conversationId, t.messageId, await revision(t.propertyId),
      ]),
    );
    const r = await reviewFor(t.messageId);
    expect(r.wrong_scope).toBe("all");
    await confirm(r.id);
    expect(await ledger(r.id)).toBe(1);
  });

  it("fn_propose_deferred_ai_disposition_review stores the scope on the new pending review", async () => {
    const t = await thread();
    await asService(async () =>
      db.query(`select public.fn_propose_deferred_ai_disposition_review($1, $2, $3, $4, 'wrong_number', 'model:wrong_number', $5, 'all')`, [
        t.propertyId, t.conversationId, t.messageId, t.runId, await revision(t.propertyId),
      ]),
    );
    const r = await reviewFor(t.messageId);
    expect(r).toMatchObject({ wrong_scope: "all", dispo_applied: false });
    await confirm(r.id);
    expect(await ledger(r.id)).toBe(1);
  });

  it("omitting the scope leaves it null, a non-wrong_number disposition ignores it, and a bad value is rejected", async () => {
    const a = await thread();
    await asService(async () =>
      db.query(`select public.fn_apply_ai_disposition_with_review($1, $2, $3, 'wrong_number', 'x', $4)`, [
        a.propertyId, a.conversationId, a.messageId, await revision(a.propertyId),
      ]),
    );
    expect((await reviewFor(a.messageId)).wrong_scope).toBeNull();
    const b = await thread();
    await asService(async () =>
      db.query(`select public.fn_apply_ai_disposition_with_review($1, $2, $3, 'not_interested', 'x', $4, 'all')`, [
        b.propertyId, b.conversationId, b.messageId, await revision(b.propertyId),
      ]),
    );
    expect((await reviewFor(b.messageId)).wrong_scope).toBeNull();
    const c = await thread();
    const rev = await revision(c.propertyId);
    let message = "";
    await asService(async () => {
      await db.query("savepoint bad");
      try {
        await db.query(`select public.fn_apply_ai_disposition_with_review($1, $2, $3, 'wrong_number', 'x', $4, 'everything')`, [
          c.propertyId, c.conversationId, c.messageId, rev,
        ]);
      } catch (e) {
        message = (e as Error).message;
      }
      await db.query("rollback to savepoint bad");
    });
    expect(message).toMatch(/invalid wrong scope/);
  });

  it("superseding the only pending review clears a stuck needs-confirm hold, but not a suppression pointer, and not while another review is pending", async () => {
    const a = await review({ scope: "all", applied: false, hold: "jev_wrong_number_all_needs_confirm" });
    await db.query(`update public.ai_disposition_reviews set status = 'superseded', resolved_at = now(), superseded_reason = 'x' where id = $1`, [a.reviewId]);
    expect(await prop(a.propertyId)).toMatchObject({ needs_human_attention: false, last_ai_escalation_reason: null });

    const b = await review({ scope: "all", applied: false, hold: `suppression_incomplete:${randomUUID()}` });
    await db.query(`update public.ai_disposition_reviews set status = 'superseded', resolved_at = now(), superseded_reason = 'x' where id = $1`, [b.reviewId]);
    expect((await prop(b.propertyId)).needs_human_attention).toBe(true);

    const c = await review({ scope: "all", applied: false, hold: "jev_dnc_needs_confirm" });
    await db.query("set local session_replication_role = replica");
    await db.query(
      `insert into public.ai_disposition_reviews (org_id, property_id, conversation_id, source_inbound_message_id, disposition, ai_reason, status)
       values ($1, $2, $3, $4, 'dnc', 'x', 'pending')`,
      [orgId, c.propertyId, randomUUID(), (await db.query(`insert into public.messages (id, org_id, property_id, conversation_id, channel, direction, body) values (gen_random_uuid(), $1, $2, gen_random_uuid(), 'sms', 'inbound', 'x') returning id`, [orgId, c.propertyId])).rows[0].id],
    );
    await db.query("set local session_replication_role = origin");
    await db.query(`update public.ai_disposition_reviews set status = 'superseded', resolved_at = now(), superseded_reason = 'x' where id = $1`, [c.reviewId]);
    expect(await prop(c.propertyId)).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "jev_dnc_needs_confirm" });
  });
});
