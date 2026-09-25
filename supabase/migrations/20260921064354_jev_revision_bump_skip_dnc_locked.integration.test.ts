import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Fable review of 9cd4ec2b (fable-final-review-9cd4ec2b.json,
 * jev-root-round15-fable-fixes.md), finding 1 — P1 data loss:
 * trg_messages_bump_decision_context_revision (and the analogous tasks/
 * appointment trigger) ran an unconditional UPDATE on properties as a
 * side effect of inserting a message/task, which was itself rejected by
 * properties_true_dnc_lock_guard on a DNC-locked property — aborting the
 * message/task insert entirely. This proves, against real Postgres, that
 * inbound (including a repeat STOP-equivalent SMS) and outbound SMS rows
 * now persist for a locked property, and states the explicit chosen
 * revision behavior: the bump is skipped (not forced) for a locked
 * property — decision_context_revision never advances there again, since
 * no automatic Jev decision will ever be applied to a locked property.
 */
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });

let orgId: string;
let contactId: string;
let propertyId: string;

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
  propertyId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `DNC revision-bump fixture ${orgId}`]);
  await db.query(
    `insert into public.contacts (id, org_id, first_name, phone_1, phone_1_type, do_not_contact) values ($1, $2, 'Homeowner', '+15550001234', 'mobile', false)`,
    [contactId, orgId],
  );
  await db.query(
    `insert into public.properties (id, org_id, address, state, status, outreach_dispo, homeowner_contact_id)
     values ($1, $2, '1 DNC Lock Ln', 'TX', 'prospect', 'dnc', $3)`,
    [propertyId, orgId, contactId],
  );
});
afterEach(async () => {
  await db.query("rollback");
});

async function currentRevision(): Promise<number> {
  const { rows } = await db.query("select decision_context_revision, is_dnc_locked from public.properties where id = $1", [propertyId]);
  return Number(rows[0].decision_context_revision);
}

describe("message/task revision-bump triggers skip DNC-locked properties (fable review 9cd4ec2b, finding 1)", () => {
  it("the property is actually locked by the fixture (precondition)", async () => {
    const { rows } = await db.query("select is_dnc_locked from public.properties where id = $1", [propertyId]);
    expect(rows[0].is_dnc_locked).toBe(true);
  });

  it("an inbound SMS row persists on a locked property, and the revision does not advance", async () => {
    const revisionBefore = await currentRevision();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    await db.query(
      `insert into public.messages (id, org_id, property_id, conversation_id, contact_id, channel, direction, body)
       values ($1, $2, $3, $4, $5, 'sms', 'inbound', 'stop')`,
      [messageId, orgId, propertyId, conversationId, contactId],
    );
    const { rows } = await db.query("select id from public.messages where id = $1", [messageId]);
    expect(rows).toHaveLength(1);
    expect(await currentRevision()).toBe(revisionBefore);
  });

  it("a REPEAT STOP-equivalent inbound SMS also persists (the exact regression scenario)", async () => {
    const conversationId = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    await db.query(
      `insert into public.messages (id, org_id, property_id, conversation_id, contact_id, channel, direction, body)
       values ($1, $2, $3, $4, $5, 'sms', 'inbound', 'STOP')`,
      [first, orgId, propertyId, conversationId, contactId],
    );
    await db.query(
      `insert into public.messages (id, org_id, property_id, conversation_id, contact_id, channel, direction, body)
       values ($1, $2, $3, $4, $5, 'sms', 'inbound', 'STOP')`,
      [second, orgId, propertyId, conversationId, contactId],
    );
    const { rows } = await db.query("select count(*)::int as n from public.messages where property_id = $1", [propertyId]);
    expect(rows[0].n).toBe(2);
  });

  it("an outbound SMS row persists on a locked property, and the revision does not advance", async () => {
    const revisionBefore = await currentRevision();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    await db.query(
      `insert into public.messages (id, org_id, property_id, conversation_id, contact_id, channel, direction, body)
       values ($1, $2, $3, $4, $5, 'sms', 'outbound', 'automated compliance confirmation')`,
      [messageId, orgId, propertyId, conversationId, contactId],
    );
    const { rows } = await db.query("select id from public.messages where id = $1", [messageId]);
    expect(rows).toHaveLength(1);
    expect(await currentRevision()).toBe(revisionBefore);
  });

  it("an inbound SMS on an UNLOCKED property still bumps the revision (control — the skip is scoped to locked rows only)", async () => {
    const unlockedPropertyId = randomUUID();
    const unlockedContactId = randomUUID();
    await db.query(
      `insert into public.contacts (id, org_id, first_name, phone_1, phone_1_type) values ($1, $2, 'Other Homeowner', '+15550005678', 'mobile')`,
      [unlockedContactId, orgId],
    );
    await db.query(
      `insert into public.properties (id, org_id, address, state, status, outreach_dispo, homeowner_contact_id)
       values ($1, $2, '2 Unlocked Ln', 'TX', 'prospect', null, $3)`,
      [unlockedPropertyId, orgId, unlockedContactId],
    );
    const { rows: before } = await db.query("select decision_context_revision from public.properties where id = $1", [unlockedPropertyId]);
    const conversationId = randomUUID();
    await db.query(
      `insert into public.messages (id, org_id, property_id, conversation_id, contact_id, channel, direction, body)
       values ($1, $2, $3, $4, $5, 'sms', 'inbound', 'hi')`,
      [randomUUID(), orgId, unlockedPropertyId, conversationId, unlockedContactId],
    );
    const { rows: after } = await db.query("select decision_context_revision from public.properties where id = $1", [unlockedPropertyId]);
    expect(Number(after[0].decision_context_revision)).toBe(Number(before[0].decision_context_revision) + 1);
  });
});
