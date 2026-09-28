import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Three Astra production blockers (20260921073917):
 *
 * 1. Both jev correction RPCs rejected every pending-decision correction
 *    once the property was already qualified (new_lead) via an EARLIER,
 *    unrelated decision — the pending branch required status =
 *    'prospect' exactly.
 * 2. Both ai_disposition_review correction RPCs compared property.
 *    outreach_dispo against a 'new_lead' expected disposition — which is
 *    recorded via property.status, never outreach_dispo — so any
 *    correction AFTER a 'new_lead' one always raised STALE_STATE.
 * 3. jev_needs_decision_classifier_events excluded a run only when a
 *    decision existed with the SAME classification_run_id, not the same
 *    source_inbound_message_id — promoting the later of two failed runs
 *    on one inbound let the earlier one reappear in the queue forever.
 *
 * Real Postgres, no mocks.
 */
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });

async function setActor(client: Client, userId: string) {
  await client.query("set local role authenticated");
  await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
}

let orgId: string;
let contactId: string;
let userId: string;

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});

beforeEach(async () => {
  await db.query("begin");
  orgId = randomUUID();
  contactId = randomUUID();
  userId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `Qualified-correction fixture ${orgId}`]);
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [userId, `reviewer-${userId}@test.local`]);
  await db.query(`insert into public.memberships (org_id, user_id, role, access_status) values ($1, $2, 'owner', 'active')`, [orgId, userId]);
  await db.query(
    `insert into public.contacts (id, org_id, first_name, phone_1, phone_1_type) values ($1, $2, 'Homeowner', '+15550003333', 'mobile')`,
    [contactId, orgId],
  );
});
afterEach(async () => {
  await db.query("rollback");
});

async function makeProperty(status = "prospect"): Promise<string> {
  const propertyId = randomUUID();
  await db.query(
    `insert into public.properties (id, org_id, address, state, status, outreach_dispo, homeowner_contact_id)
     values ($1, $2, 'Fixture St', 'TX', $3, null, $4)`,
    [propertyId, orgId, status, contactId],
  );
  return propertyId;
}

async function makeInboundMessage(propertyId: string, conversationId: string, body = "hi"): Promise<string> {
  const messageId = randomUUID();
  await db.query(
    `insert into public.messages (id, org_id, property_id, conversation_id, contact_id, channel, direction, body)
     values ($1, $2, $3, $4, $5, 'sms', 'inbound', $6)`,
    [messageId, orgId, propertyId, conversationId, contactId, body],
  );
  return messageId;
}

async function makeClassificationRun(args: {
  propertyId: string;
  conversationId: string;
  sourceInboundMessageId: string;
  resolvedOutcome: string | null;
  fallbackReason?: string | null;
  createdAt?: string;
}): Promise<string> {
  const runId = randomUUID();
  await db.query(
    `insert into public.sms_classification_runs
       (id, org_id, property_id, conversation_id, source_inbound_message_id, state_hash, state_version, schema_version, policy_version, provider, model, decision, resolved_outcome, fallback_reason, created_at)
     values ($1, $2, $3, $4, $5, $6, 1, 'v1', 'v1', 'jev', 'jev-1.13.0', '{}'::jsonb, $7, $8, coalesce($9, now()))`,
    [runId, orgId, args.propertyId, args.conversationId, args.sourceInboundMessageId, randomUUID(), args.resolvedOutcome, args.fallbackReason ?? null, args.createdAt ?? null],
  );
  return runId;
}

async function promote(runId: string) {
  await setActor(db, userId);
  const { rows } = await db.query("select public.fn_promote_classifier_event_to_decision($1) as result", [runId]);
  await db.query("reset role");
  return rows[0].result;
}

async function correctDecision(decisionId: string, outcome: string, reason = "test") {
  await setActor(db, userId);
  const { rows } = await db.query("select public.fn_correct_jev_lead_decision($1, $2, $3) as result", [decisionId, outcome, reason]);
  await db.query("reset role");
  return rows[0].result;
}

async function proposeAiDispositionReview(propertyId: string): Promise<string> {
  const reviewId = randomUUID();
  const conversationId = randomUUID();
  const messageId = await makeInboundMessage(propertyId, conversationId, "ai disposition review fixture");
  await db.query(
    `insert into public.ai_disposition_reviews
       (id, org_id, property_id, conversation_id, source_inbound_message_id, disposition, ai_reason, status, dispo_applied, decision_context_revision)
     select $1, $2, $3, $4, $5, 'wrong_number', 'test fixture', 'pending', false, decision_context_revision
     from public.properties where id = $3`,
    [reviewId, orgId, propertyId, conversationId, messageId],
  );
  return reviewId;
}

async function correctAiDispositionReview(reviewId: string, corrected: string, reason = "test") {
  await setActor(db, userId);
  const { rows } = await db.query(
    "select public.fn_apply_and_record_ai_disposition_review_correction($1, $2, $3) as result",
    [reviewId, corrected, reason],
  );
  await db.query("reset role");
  return rows[0].result;
}

describe("blocker 1 — qualified property can resolve a promoted unsupported classifier event", () => {
  it("fn_correct_jev_lead_decision: a NEW pending decision on an already-new_lead property is correctable, not STALE_STATE", async () => {
    const propertyId = await makeProperty("new_lead");
    const conversationId = randomUUID();
    const messageId = await makeInboundMessage(propertyId, conversationId);
    const runId = await makeClassificationRun({ propertyId, conversationId, sourceInboundMessageId: messageId, resolvedOutcome: "unclear" });

    const promoted = await promote(runId);
    expect(promoted.status).toBe("promoted");

    const corrected = await correctDecision(promoted.decisionId, "nurture");
    expect(corrected.status).toBe("corrected");
    expect(corrected.resolvedOutcome).toBe("nurture");

    const row = (await db.query("select status, outreach_dispo from public.properties where id = $1", [propertyId])).rows[0];
    expect(row.status).toBe("new_lead");
    expect(row.outreach_dispo).toBe("nurture");
  });

  it("fn_apply_and_record_jev_lead_decision_correction: same qualified-property path resolves cleanly via the opted_out/dnc RPC", async () => {
    const propertyId = await makeProperty("new_lead");
    const conversationId = randomUUID();
    const messageId = await makeInboundMessage(propertyId, conversationId);
    const runId = await makeClassificationRun({ propertyId, conversationId, sourceInboundMessageId: messageId, resolvedOutcome: "bad_number" });

    const promoted = await promote(runId);
    expect(promoted.status).toBe("promoted");

    await setActor(db, userId);
    const { rows } = await db.query(
      "select public.fn_apply_and_record_jev_lead_decision_correction($1, $2, $3) as result",
      [promoted.decisionId, "opted_out", "test"],
    );
    await db.query("reset role");

    expect(rows[0].result.status).toBe("corrected");
    const row = (await db.query("select status, outreach_dispo from public.properties where id = $1", [propertyId])).rows[0];
    expect(row.status).toBe("new_lead");
    expect(row.outreach_dispo).toBe("opted_out");
  });

  it("still rejects a truly stale pending decision (property left prospect/new_lead entirely, e.g. wrong_number)", async () => {
    const propertyId = await makeProperty("prospect");
    const conversationId = randomUUID();
    const messageId = await makeInboundMessage(propertyId, conversationId);
    const runId = await makeClassificationRun({ propertyId, conversationId, sourceInboundMessageId: messageId, resolvedOutcome: "unclear" });
    const promoted = await promote(runId);

    // Property leaves prospect/new_lead via an unrelated wrong_number dispo.
    await db.query(
      "update public.properties set outreach_dispo = 'wrong_number', updated_at = now() where id = $1",
      [propertyId],
    );

    await db.query("savepoint stale_pending");
    await expect(correctDecision(promoted.decisionId, "nurture")).rejects.toMatchObject({
      message: expect.stringContaining("STALE_STATE"),
    });
    await db.query("rollback to savepoint stale_pending");
  });
});

describe("blocker 2 — choosing new_lead does not lock out subsequent corrections", () => {
  it("fn_apply_and_record_ai_disposition_review_correction: correcting to new_lead, then correcting AGAIN to opted_out, both succeed", async () => {
    const propertyId = await makeProperty("prospect");
    const reviewId = await proposeAiDispositionReview(propertyId);

    const first = await correctAiDispositionReview(reviewId, "new_lead");
    expect(first.status).toBe("corrected");
    expect(first.correctedDisposition).toBe("new_lead");

    let row = (await db.query("select status, outreach_dispo from public.properties where id = $1", [propertyId])).rows[0];
    expect(row.status).toBe("new_lead");
    expect(row.outreach_dispo).toBeNull();

    // Second, different correction after new_lead: must not raise STALE_STATE.
    const second = await correctAiDispositionReview(reviewId, "opted_out");
    expect(second.status).toBe("corrected");
    expect(second.correctedDisposition).toBe("opted_out");

    row = (await db.query("select status, outreach_dispo from public.properties where id = $1", [propertyId])).rows[0];
    expect(row.status).toBe("new_lead");
    expect(row.outreach_dispo).toBe("opted_out");
  });

  it("fn_correct_ai_disposition_review: a review previously corrected to new_lead can still be corrected to nurture", async () => {
    const propertyId = await makeProperty("prospect");
    const reviewId = await proposeAiDispositionReview(propertyId);

    const first = await correctAiDispositionReview(reviewId, "new_lead");
    expect(first.status).toBe("corrected");

    await setActor(db, userId);
    const { rows } = await db.query(
      "select public.fn_correct_ai_disposition_review($1, $2, $3) as result",
      [reviewId, "nurture", "test"],
    );
    await db.query("reset role");

    expect(rows[0].result.status).toBe("corrected");
    expect(rows[0].result.correctedDisposition).toBe("nurture");
    const row = (await db.query("select status, outreach_dispo from public.properties where id = $1", [propertyId])).rows[0];
    expect(row.status).toBe("new_lead");
    expect(row.outreach_dispo).toBe("nurture");
  });
});

describe("blocker 3 — promoting the later of two failed runs on one inbound excludes both from the queue", () => {
  it("two failed classification runs (A, B) on the SAME inbound: promoting B prevents A from ever reappearing", async () => {
    const propertyId = await makeProperty("prospect");
    const conversationId = randomUUID();
    const messageId = await makeInboundMessage(propertyId, conversationId);

    const runA = await makeClassificationRun({
      propertyId, conversationId, sourceInboundMessageId: messageId,
      resolvedOutcome: null, fallbackReason: "attempt_a",
      createdAt: "2026-03-01T00:00:00.000Z",
    });
    const runB = await makeClassificationRun({
      propertyId, conversationId, sourceInboundMessageId: messageId,
      resolvedOutcome: "unclear", fallbackReason: null,
      createdAt: "2026-03-01T00:01:00.000Z",
    });

    // Sanity: before any promotion, the view surfaces exactly the
    // deterministic latest candidate (run B) for this inbound.
    await setActor(db, userId);
    let rows = (await db.query("select id from public.jev_needs_decision_classifier_events where source_inbound_message_id = $1", [messageId])).rows;
    await db.query("reset role");
    expect(rows.map((r) => r.id)).toEqual([runB]);

    const promoted = await promote(runB);
    expect(promoted.status).toBe("promoted");

    await setActor(db, userId);
    rows = (await db.query("select id from public.jev_needs_decision_classifier_events where source_inbound_message_id = $1", [messageId])).rows;
    await db.query("reset role");

    // Neither A nor B reappears — the inbound is fully excluded, not
    // just the exact promoted run id.
    expect(rows).toEqual([]);
  });

  it(">=100 stale promoted-retry groups cannot starve a distinct actionable event, using the production order+limit(100) query", async () => {
    const distinctPropertyId = await makeProperty("prospect");
    const distinctConversationId = randomUUID();
    const distinctMessageId = await makeInboundMessage(distinctPropertyId, distinctConversationId, "distinct newer inbound");
    const distinctRunId = await makeClassificationRun({
      propertyId: distinctPropertyId, conversationId: distinctConversationId, sourceInboundMessageId: distinctMessageId,
      resolvedOutcome: "bad_number",
      createdAt: "2026-03-05T00:00:00.000Z",
    });

    // 100 distinct inbounds, each with a failed run A promoted-away by a
    // later run B on the SAME inbound — the exact starvation shape:
    // formerly, run A on each of these would still satisfy the
    // classification_run_id-only exclusion and crowd the oldest-first
    // limit(100) window.
    for (let i = 0; i < 100; i++) {
      const propertyId = await makeProperty("prospect");
      const conversationId = randomUUID();
      const messageId = await makeInboundMessage(propertyId, conversationId, `retry group ${i}`);
      const runA = await makeClassificationRun({
        propertyId, conversationId, sourceInboundMessageId: messageId,
        resolvedOutcome: null, fallbackReason: `attempt_a_${i}`,
        createdAt: new Date(new Date("2026-01-01T00:00:00.000Z").getTime() + i * 1000).toISOString(),
      });
      const runB = await makeClassificationRun({
        propertyId, conversationId, sourceInboundMessageId: messageId,
        resolvedOutcome: "unclear", fallbackReason: null,
        createdAt: new Date(new Date("2026-01-01T00:00:00.000Z").getTime() + i * 1000 + 500).toISOString(),
      });
      const promoted = await promote(runB);
      expect(promoted.status).toBe("promoted");
      void runA;
    }

    await setActor(db, userId);
    const { rows } = await db.query(
      "select id, source_inbound_message_id from public.jev_needs_decision_classifier_events order by created_at asc limit 100",
    );
    await db.query("reset role");

    // The 100 promoted retry groups contribute nothing to the queue —
    // the only row present is the one genuinely distinct actionable
    // event, which is never starved out.
    expect(rows).toEqual([{ id: distinctRunId, source_inbound_message_id: distinctMessageId }]);
  });
});
