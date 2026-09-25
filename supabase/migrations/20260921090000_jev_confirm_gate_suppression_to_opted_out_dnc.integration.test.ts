import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Astra production blocker (20260921090000):
 *
 * fn_confirm_ai_disposition_review's unapplied-proposal branch
 * (dispo_applied = false) used to suppress the linked contact
 * unconditionally, for any deferred disposition. 20260921081409 added
 * not_interested and wrong_number to the deferred-review universe, so
 * confirming either of those was incorrectly flipping
 * contacts.sms_opted_out = true. Fixed to gate suppression to
 * v_review.disposition in ('opted_out', 'dnc') only.
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
  await db.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `Confirm-gate fixture ${orgId}`]);
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

async function makeProperty(status = "new_lead", extraContactId: string | null = null): Promise<string> {
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

async function proposeUnappliedReview(propertyId: string, disposition: string): Promise<string> {
  const reviewId = randomUUID();
  const conversationId = randomUUID();
  const messageId = await makeInboundMessage(propertyId, conversationId, "deferred fixture");
  await db.query(
    `insert into public.ai_disposition_reviews
       (id, org_id, property_id, conversation_id, source_inbound_message_id, disposition, ai_reason, status, dispo_applied, decision_context_revision)
     select $1, $2, $3, $4, $5, $6, 'test fixture', 'pending', false, decision_context_revision
     from public.properties where id = $3`,
    [reviewId, orgId, propertyId, conversationId, messageId, disposition],
  );
  return reviewId;
}

async function confirmReview(reviewId: string) {
  await setActor(db, userId);
  const { rows } = await db.query("select public.fn_confirm_ai_disposition_review($1) as result", [reviewId]);
  await db.query("reset role");
  return rows[0].result;
}

async function getContact(id: string) {
  const { rows } = await db.query("select do_not_contact, sms_opted_out, sms_opted_out_at from public.contacts where id = $1", [id]);
  return rows[0];
}

async function getProperty(id: string) {
  const { rows } = await db.query("select outreach_dispo from public.properties where id = $1", [id]);
  return rows[0];
}

async function getReview(id: string) {
  const { rows } = await db.query("select status, dispo_applied from public.ai_disposition_reviews where id = $1", [id]);
  return rows[0];
}

describe("Confirm gates contact suppression to opted_out/dnc only", () => {
  it("confirming a pending, unapplied not_interested review confirms the property disposition and the review, but leaves the contact untouched", async () => {
    const propertyId = await makeProperty("new_lead");
    const reviewId = await proposeUnappliedReview(propertyId, "not_interested");

    const before = await getContact(contactId);
    expect(before.sms_opted_out).toBe(false);
    expect(before.sms_opted_out_at).toBeNull();

    const result = await confirmReview(reviewId);
    expect(result.status).toBe("confirmed");

    const property = await getProperty(propertyId);
    expect(property.outreach_dispo).toBe("not_interested");

    const review = await getReview(reviewId);
    expect(review.status).toBe("confirmed");
    expect(review.dispo_applied).toBe(true);

    const after = await getContact(contactId);
    expect(after.sms_opted_out).toBe(false);
    expect(after.sms_opted_out_at).toBeNull();
    expect(after.do_not_contact).toBe(false);
  });

  it("confirming a pending, unapplied wrong_number review confirms the property disposition but does not globally suppress the contact/phone", async () => {
    const propertyId = await makeProperty("new_lead");
    const reviewId = await proposeUnappliedReview(propertyId, "wrong_number");

    const result = await confirmReview(reviewId);
    expect(result.status).toBe("confirmed");

    const property = await getProperty(propertyId);
    expect(property.outreach_dispo).toBe("wrong_number");

    const review = await getReview(reviewId);
    expect(review.status).toBe("confirmed");
    expect(review.dispo_applied).toBe(true);

    // This RPC is single-property, single-contact scoped — it has no
    // "all-scope" suppression path, so a shared contact on another
    // property is untouched regardless.
    const after = await getContact(contactId);
    expect(after.sms_opted_out).toBe(false);
    expect(after.sms_opted_out_at).toBeNull();
  });

  it("confirming a pending, unapplied opted_out review still suppresses the contact (regression guard)", async () => {
    const propertyId = await makeProperty("new_lead");
    const reviewId = await proposeUnappliedReview(propertyId, "opted_out");

    const result = await confirmReview(reviewId);
    expect(result.status).toBe("confirmed");

    const property = await getProperty(propertyId);
    expect(property.outreach_dispo).toBe("opted_out");

    const after = await getContact(contactId);
    expect(after.sms_opted_out).toBe(true);
    expect(after.sms_opted_out_at).not.toBeNull();
  });

  it("a second property sharing the same contact is unaffected by a not_interested confirm (shared-contact safety)", async () => {
    const propertyId = await makeProperty("new_lead");
    const sharedPropertyId = await makeProperty("new_lead");
    const reviewId = await proposeUnappliedReview(propertyId, "not_interested");

    await confirmReview(reviewId);

    const sharedContact = await getContact(contactId);
    expect(sharedContact.sms_opted_out).toBe(false);

    const sharedProperty = await getProperty(sharedPropertyId);
    expect(sharedProperty.outreach_dispo).toBeNull();
  });
});
