import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Astra production blockers 1 & 2 (20260921081408):
 *
 * 1. Confirming a below-threshold opted_out ai_disposition_review (the
 *    deferred, dispo_applied=false path) via fn_confirm_ai_disposition_
 *    review used to write only properties.outreach_dispo, never
 *    suppressing the linked contact — unlike the established correction
 *    path, which always suppresses. Fixed to run the same suppression.
 *
 * 2. fn_apply_and_record_ai_disposition_review_correction writes
 *    properties.outreach_dispo BEFORE resolving its own review row's
 *    status, so the property trigger that supersedes pending reviews on
 *    an outreach_dispo change used to catch the row being resolved too
 *    — leaving it "corrected" in content but 'superseded' in status,
 *    and a later correction on it raised STALE_STATE.
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
  await db.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `Confirm-suppression fixture ${orgId}`]);
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

async function makeProperty(status = "prospect", extraContactId: string | null = null): Promise<string> {
  const propertyId = randomUUID();
  await db.query(
    `insert into public.properties (id, org_id, address, state, status, outreach_dispo, homeowner_contact_id)
     values ($1, $2, 'Fixture St', 'TX', $3, null, $4)`,
    [propertyId, orgId, status, extraContactId ?? contactId],
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

async function proposeUnappliedReview(propertyId: string, disposition = "opted_out"): Promise<string> {
  const reviewId = randomUUID();
  const conversationId = randomUUID();
  const messageId = await makeInboundMessage(propertyId, conversationId, "below-threshold fixture");
  await db.query(
    `insert into public.ai_disposition_reviews
       (id, org_id, property_id, conversation_id, source_inbound_message_id, disposition, ai_reason, status, dispo_applied, decision_context_revision)
     select $1, $2, $3, $4, $5, $6, 'test fixture', 'pending', false, decision_context_revision
     from public.properties where id = $3`,
    [reviewId, orgId, propertyId, conversationId, messageId, disposition],
  );
  return reviewId;
}

async function proposeAppliedReview(propertyId: string): Promise<string> {
  const reviewId = randomUUID();
  const conversationId = randomUUID();
  const messageId = await makeInboundMessage(propertyId, conversationId, "applied-review fixture");
  await db.query(
    `insert into public.ai_disposition_reviews
       (id, org_id, property_id, conversation_id, source_inbound_message_id, disposition, ai_reason, status, dispo_applied, decision_context_revision)
     select $1, $2, $3, $4, $5, 'wrong_number', 'test fixture', 'pending', false, decision_context_revision
     from public.properties where id = $3`,
    [reviewId, orgId, propertyId, conversationId, messageId],
  );
  return reviewId;
}

async function confirmReview(reviewId: string) {
  await setActor(db, userId);
  const { rows } = await db.query("select public.fn_confirm_ai_disposition_review($1) as result", [reviewId]);
  await db.query("reset role");
  return rows[0].result;
}

async function correctReview(reviewId: string, corrected: string, reason = "test") {
  await setActor(db, userId);
  const { rows } = await db.query(
    "select public.fn_apply_and_record_ai_disposition_review_correction($1, $2, $3) as result",
    [reviewId, corrected, reason],
  );
  await db.query("reset role");
  return rows[0].result;
}

async function getContact(id: string) {
  const { rows } = await db.query("select do_not_contact, sms_opted_out from public.contacts where id = $1", [id]);
  return rows[0];
}

describe("Astra blocker 1 — Confirm on a below-threshold opted_out review suppresses the contact", () => {
  it("confirming a pending, unapplied opted_out review flips sms_opted_out on the linked contact", async () => {
    const propertyId = await makeProperty("new_lead");
    const reviewId = await proposeUnappliedReview(propertyId, "opted_out");

    const before = await getContact(contactId);
    expect(before.sms_opted_out).toBe(false);

    const result = await confirmReview(reviewId);
    expect(result.status).toBe("confirmed");

    const after = await getContact(contactId);
    expect(after.sms_opted_out).toBe(true);

    const property = (await db.query("select outreach_dispo from public.properties where id = $1", [propertyId])).rows[0];
    expect(property.outreach_dispo).toBe("opted_out");
  });

  it("fails closed on a property whose contact is already do_not_contact-locked, and leaves the lock intact", async () => {
    // A do_not_contact contact cascade-locks every property that names it
    // as homeowner (20260815190000) — on insert here, since the contact
    // is already locked before the property is created. So this is not a
    // "tolerate and skip suppression" case: the property itself is
    // is_dnc_locked, and fn_confirm_ai_disposition_review's own write to
    // properties.outreach_dispo must be rejected by that lock, same as
    // any other write to a locked property. Fail-closed, not tolerant.
    await db.query("update public.contacts set do_not_contact = true where id = $1", [contactId]);
    const propertyId = await makeProperty("new_lead");

    const property = (await db.query("select is_dnc_locked from public.properties where id = $1", [propertyId])).rows[0];
    expect(property.is_dnc_locked).toBe(true);

    const reviewId = await proposeUnappliedReview(propertyId, "opted_out");

    await db.query("savepoint before_confirm");
    await expect(confirmReview(reviewId)).rejects.toThrow(/DNC_LOCKED/);
    await db.query("rollback to savepoint before_confirm");

    const afterProperty = (await db.query("select is_dnc_locked, outreach_dispo from public.properties where id = $1", [propertyId])).rows[0];
    expect(afterProperty.is_dnc_locked).toBe(true);
    expect(afterProperty.outreach_dispo).toBeNull();

    const review = (await db.query("select status from public.ai_disposition_reviews where id = $1", [reviewId])).rows[0];
    expect(review.status).toBe("pending");

    const after = await getContact(contactId);
    expect(after.do_not_contact).toBe(true);
  });

  it("a second property sharing the same contact is unaffected by this confirm (shared-contact safety)", async () => {
    const sharedPropertyId = await makeProperty("new_lead");
    const otherPropertyId = await makeProperty("new_lead");
    const reviewId = await proposeUnappliedReview(sharedPropertyId, "opted_out");

    await confirmReview(reviewId);

    const other = (await db.query("select outreach_dispo from public.properties where id = $1", [otherPropertyId])).rows[0];
    expect(other.outreach_dispo).toBeNull();
  });
});

describe("Astra blocker 2 — a property-write review resolution does not self-supersede", () => {
  it("correcting a pending review to opted_out leaves it 'confirmed', not 'superseded'", async () => {
    const propertyId = await makeProperty("prospect");
    const reviewId = await proposeAppliedReview(propertyId);

    const result = await correctReview(reviewId, "opted_out");
    expect(result.status).toBe("corrected");

    const review = (await db.query("select status, corrected_disposition from public.ai_disposition_reviews where id = $1", [reviewId])).rows[0];
    expect(review.status).toBe("confirmed");
    expect(review.corrected_disposition).toBe("opted_out");
  });

  it("direct pending -> opted_out persists resolved/corrected status, then can correct to new_lead", async () => {
    const propertyId = await makeProperty("prospect");
    const reviewId = await proposeAppliedReview(propertyId);

    const first = await correctReview(reviewId, "opted_out");
    expect(first.status).toBe("corrected");

    let review = (await db.query("select status from public.ai_disposition_reviews where id = $1", [reviewId])).rows[0];
    expect(review.status).toBe("confirmed");

    const second = await correctReview(reviewId, "new_lead");
    expect(second.status).toBe("corrected");

    review = (await db.query("select status, corrected_disposition from public.ai_disposition_reviews where id = $1", [reviewId])).rows[0];
    expect(review.status).toBe("confirmed");
    expect(review.corrected_disposition).toBe("new_lead");

    const property = (await db.query("select status from public.properties where id = $1", [propertyId])).rows[0];
    expect(property.status).toBe("new_lead");
  });

  it("a sibling pending review on the same property is still superseded normally", async () => {
    const propertyId = await makeProperty("prospect");

    // Both inbound messages happen BEFORE either review is proposed, so
    // both reviews capture the same (already-final) decision_context_
    // revision. If the sibling's message arrived AFTER the target review
    // captured its revision, trg_messages_bump_decision_context_revision
    // (20260921022936) would legitimately bump the property's revision
    // and make the target review stale by design — a real "new context
    // arrived, re-evaluate" case, not the self-supersede bug this test
    // targets. Ordering messages first isolates the two concerns.
    const siblingConversationId = randomUUID();
    const siblingMessageId = await makeInboundMessage(propertyId, siblingConversationId, "sibling fixture");
    const reviewId = await proposeAppliedReview(propertyId);

    const siblingReviewId = randomUUID();
    await db.query(
      `insert into public.ai_disposition_reviews
         (id, org_id, property_id, conversation_id, source_inbound_message_id, disposition, ai_reason, status, dispo_applied, decision_context_revision)
       select $1, $2, $3, $4, $5, 'not_interested', 'sibling fixture', 'pending', false, decision_context_revision
       from public.properties where id = $3`,
      [siblingReviewId, orgId, propertyId, siblingConversationId, siblingMessageId],
    );

    const correction = await correctReview(reviewId, "opted_out");
    expect(correction.status).toBe("corrected");

    const sibling = (await db.query("select status, superseded_reason from public.ai_disposition_reviews where id = $1", [siblingReviewId])).rows[0];
    expect(sibling.status).toBe("superseded");
    expect(sibling.superseded_reason).toBe("property_outcome_changed");

    const resolved = (await db.query("select status, corrected_disposition from public.ai_disposition_reviews where id = $1", [reviewId])).rows[0];
    expect(resolved.status).toBe("confirmed");
    expect(resolved.corrected_disposition).toBe("opted_out");

    const property = (await db.query("select outreach_dispo from public.properties where id = $1", [propertyId])).rows[0];
    expect(property.outreach_dispo).toBe("opted_out");

    // A later re-correction on the target must still work — proves it was
    // truly left 'confirmed', not silently flipped to 'superseded'
    // underneath the returned "corrected" result (the exact STALE_STATE
    // regression blocker 2 fixes).
    const second = await correctReview(reviewId, "dnc");
    expect(second.status).toBe("corrected");
    const final = (await db.query("select status, corrected_disposition from public.ai_disposition_reviews where id = $1", [reviewId])).rows[0];
    expect(final.status).toBe("confirmed");
    expect(final.corrected_disposition).toBe("dnc");
  });
});
