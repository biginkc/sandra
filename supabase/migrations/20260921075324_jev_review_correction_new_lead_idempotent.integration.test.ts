import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Fable production blocker (20260921075324):
 *
 * fn_apply_and_record_ai_disposition_review_correction's new_lead write
 * unconditionally required property.status = 'prospect'. On a property
 * already status = 'new_lead' with a pending review (dispo_applied =
 * false), correcting the review to new_lead updated zero rows and
 * raised STALE_STATE. Same failure recurs after a
 * new_lead -> opted_out -> new_lead chain. Fixed to match
 * fn_correct_jev_lead_decision's existing idempotent handling: skip the
 * status write (and reuse the current revision) when the property is
 * already new_lead, while still refusing any other status.
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
  await db.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `New-lead re-correction fixture ${orgId}`]);
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [userId, `reviewer-${userId}@test.local`]);
  await db.query(`insert into public.memberships (org_id, user_id, role, access_status) values ($1, $2, 'owner', 'active')`, [orgId, userId]);
  await db.query(
    `insert into public.contacts (id, org_id, first_name, phone_1, phone_1_type) values ($1, $2, 'Homeowner', '+15550004444', 'mobile')`,
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

describe("Fable blocker — new_lead review correction on an already-new_lead property is idempotent, not STALE_STATE", () => {
  it("property already new_lead, pending review (dispo_applied=false): correcting to new_lead succeeds without re-writing qualified_at", async () => {
    const propertyId = await makeProperty("new_lead");
    await db.query(
      "update public.properties set qualified_at = '2026-01-01T00:00:00Z', qualified_by = null where id = $1",
      [propertyId],
    );
    const before = (await db.query("select qualified_at, decision_context_revision from public.properties where id = $1", [propertyId])).rows[0];

    const reviewId = await proposeAiDispositionReview(propertyId);

    const result = await correctAiDispositionReview(reviewId, "new_lead");
    expect(result.status).toBe("corrected");
    expect(result.correctedDisposition).toBe("new_lead");

    const after = (await db.query("select status, outreach_dispo, qualified_at, decision_context_revision from public.properties where id = $1", [propertyId])).rows[0];
    expect(after.status).toBe("new_lead");
    expect(after.outreach_dispo).toBeNull();
    // Idempotent: no promotion write happened, so qualified_at is untouched.
    expect(after.qualified_at.toISOString()).toBe(before.qualified_at.toISOString());

    const review = (await db.query("select status, corrected_disposition, decision_context_revision from public.ai_disposition_reviews where id = $1", [reviewId])).rows[0];
    expect(review.status).toBe("confirmed");
    expect(review.corrected_disposition).toBe("new_lead");
    expect(review.decision_context_revision).toBe(after.decision_context_revision);
  });

  it("new_lead -> opted_out -> new_lead chain, same review re-corrected twice: the final new_lead correction succeeds", async () => {
    const propertyId = await makeProperty("prospect");
    const reviewId = await proposeAiDispositionReview(propertyId);

    const first = await correctAiDispositionReview(reviewId, "new_lead");
    expect(first.status).toBe("corrected");
    let row = (await db.query("select status, outreach_dispo from public.properties where id = $1", [propertyId])).rows[0];
    expect(row.status).toBe("new_lead");
    expect(row.outreach_dispo).toBeNull();

    const second = await correctAiDispositionReview(reviewId, "opted_out");
    expect(second.status).toBe("corrected");
    row = (await db.query("select status, outreach_dispo from public.properties where id = $1", [propertyId])).rows[0];
    expect(row.status).toBe("new_lead");
    expect(row.outreach_dispo).toBe("opted_out");

    // Same review, re-corrected a third time back to new_lead: property
    // is already new_lead (never left it), so this must not raise
    // STALE_STATE from an unconditional status = 'prospect' write.
    const third = await correctAiDispositionReview(reviewId, "new_lead");
    expect(third.status).toBe("corrected");
    expect(third.correctedDisposition).toBe("new_lead");

    row = (await db.query("select status, outreach_dispo from public.properties where id = $1", [propertyId])).rows[0];
    expect(row.status).toBe("new_lead");
  });

  it("still performs the real qualification write when status=prospect", async () => {
    const propertyId = await makeProperty("prospect");
    const reviewId = await proposeAiDispositionReview(propertyId);

    const result = await correctAiDispositionReview(reviewId, "new_lead");
    expect(result.status).toBe("corrected");

    const row = (await db.query("select status, qualified_at, qualified_by from public.properties where id = $1", [propertyId])).rows[0];
    expect(row.status).toBe("new_lead");
    expect(row.qualified_at).not.toBeNull();
    expect(row.qualified_by).toBe(userId);
  });

  it("still rejects a new_lead correction when the property is in an unrelated/stale status", async () => {
    const propertyId = await makeProperty("prospect");
    const reviewId = await proposeAiDispositionReview(propertyId);

    // Property leaves prospect/new_lead entirely via an unrelated dispo.
    await db.query(
      "update public.properties set outreach_dispo = 'wrong_number', updated_at = now() where id = $1",
      [propertyId],
    );

    await db.query("savepoint stale_status");
    await expect(correctAiDispositionReview(reviewId, "new_lead")).rejects.toMatchObject({
      message: expect.stringContaining("STALE_STATE"),
    });
    await db.query("rollback to savepoint stale_status");
  });

  it("records applied_via=qualifyProperty for new_lead corrections and setOutreachDispo for others", async () => {
    const propertyId = await makeProperty("prospect");
    const reviewId = await proposeAiDispositionReview(propertyId);

    await correctAiDispositionReview(reviewId, "new_lead");
    const newLeadEvent = (
      await db.query(
        "select payload from public.lead_events where property_id = $1 and event_type = 'ai_disposition_review_corrected' and payload->>'corrected_disposition' = 'new_lead'",
        [propertyId],
      )
    ).rows[0];
    expect(newLeadEvent.payload.applied_via).toBe("qualifyProperty");

    await correctAiDispositionReview(reviewId, "opted_out");
    const optedOutEvent = (
      await db.query(
        "select payload from public.lead_events where property_id = $1 and event_type = 'ai_disposition_review_corrected' and payload->>'corrected_disposition' = 'opted_out'",
        [propertyId],
      )
    ).rows[0];
    expect(optedOutEvent.payload.applied_via).toBe("setOutreachDispo");
  });

  it("still rejects DNC-locked properties even when already new_lead", async () => {
    const propertyId = await makeProperty("new_lead");
    const reviewId = await proposeAiDispositionReview(propertyId);
    await db.query("update public.properties set is_dnc_locked = true where id = $1", [propertyId]);

    await db.query("savepoint dnc_locked");
    await expect(correctAiDispositionReview(reviewId, "new_lead")).rejects.toMatchObject({
      message: expect.stringContaining("DNC_LOCKED"),
    });
    await db.query("rollback to savepoint dnc_locked");
  });
});
