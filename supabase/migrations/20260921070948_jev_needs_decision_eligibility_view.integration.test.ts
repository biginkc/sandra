import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Fable re-review of e5d001bb (fable-final-review-e5d001bb.json,
 * jev-root-round17-fable2-fixes.md), finding 2 — P2 Needs-a-decision
 * starvation: queries.ts used to fetch the 100 OLDEST matching
 * sms_classification_runs rows, then filter promoted/reconciled ones in
 * application code — once the 100 oldest were all promoted/reconciled,
 * a genuinely newer actionable event could never reach the limit
 * window. jev_needs_decision_classifier_events
 * (20260921070948_jev_needs_decision_eligibility_view.sql) excludes
 * promoted/reconciled rows BEFORE any limit applies. This proves, against
 * real Postgres: a fixture with MORE than 100 old resolved (promoted)
 * events plus one newer actionable event — the view still surfaces the
 * newer event within a limit(100) query. Also proves the view still
 * excludes reconciled (failure->success) rows and already-promoted rows
 * individually, and that org-scoped access still applies (unauthenticated
 * caller sees nothing).
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
  await db.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `Needs-decision eligibility fixture ${orgId}`]);
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [userId, `reviewer-${userId}@test.local`]);
  await db.query(`insert into public.memberships (org_id, user_id, role, access_status) values ($1, $2, 'owner', 'active')`, [orgId, userId]);
  await db.query(
    `insert into public.contacts (id, org_id, first_name, phone_1, phone_1_type) values ($1, $2, 'Homeowner', '+15550001111', 'mobile')`,
    [contactId, orgId],
  );
});
afterEach(async () => {
  await db.query("rollback");
});

async function makeProperty(): Promise<string> {
  const propertyId = randomUUID();
  await db.query(
    `insert into public.properties (id, org_id, address, state, status, outreach_dispo, homeowner_contact_id)
     values ($1, $2, 'Fixture St', 'TX', 'prospect', null, $3)`,
    [propertyId, orgId, contactId],
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
  createdAt: string;
}): Promise<string> {
  const runId = randomUUID();
  await db.query(
    `insert into public.sms_classification_runs
       (id, org_id, property_id, conversation_id, source_inbound_message_id, state_hash, state_version, schema_version, policy_version, provider, model, decision, resolved_outcome, fallback_reason, created_at)
     values ($1, $2, $3, $4, $5, $6, 1, 'v1', 'v1', 'jev', 'jev-1.13.0', '{}'::jsonb, $7, $8, $9)`,
    [runId, orgId, args.propertyId, args.conversationId, args.sourceInboundMessageId, randomUUID(), args.resolvedOutcome, args.fallbackReason ?? null, args.createdAt],
  );
  return runId;
}

async function queryEligible(): Promise<Array<{ id: string; created_at: Date }>> {
  await setActor(db, userId);
  const { rows } = await db.query(
    "select id, created_at from public.jev_needs_decision_classifier_events order by created_at asc limit 100",
  );
  return rows;
}

describe("jev_needs_decision_classifier_events — eligibility filtered before the limit (fable re-review e5d001bb, finding 2)", () => {
  it("a newer actionable event is NOT starved by 105 older, already-promoted events", async () => {
    const propertyId = await makeProperty();
    const conversationId = randomUUID();
    const baseTime = new Date("2026-01-01T00:00:00.000Z").getTime();

    // 105 OLD, already-promoted classifier events — immutable, but no
    // longer "eligible" since each has a real jev_lead_decisions row.
    for (let i = 0; i < 105; i++) {
      const messageId = await makeInboundMessage(propertyId, conversationId, `old message ${i}`);
      const runId = await makeClassificationRun({
        propertyId,
        conversationId,
        sourceInboundMessageId: messageId,
        resolvedOutcome: "unclear",
        createdAt: new Date(baseTime + i * 1000).toISOString(),
      });
      await db.query(
        `insert into public.jev_lead_decisions (id, org_id, property_id, conversation_id, source_inbound_message_id, classification_run_id, proposed_outcome, status)
         values ($1, $2, $3, $4, $5, $6, 'unclear', 'pending')`,
        [randomUUID(), orgId, propertyId, conversationId, messageId, runId],
      );
    }

    // One genuinely newer, still-eligible event.
    const newMessageId = await makeInboundMessage(propertyId, conversationId, "the newer actionable one");
    const newRunId = await makeClassificationRun({
      propertyId,
      conversationId,
      sourceInboundMessageId: newMessageId,
      resolvedOutcome: "bad_number",
      createdAt: new Date(baseTime + 200 * 1000).toISOString(),
    });

    const eligible = await queryEligible();
    expect(eligible.map((r) => r.id)).toContain(newRunId);
    // Every OLD promoted event must be excluded — the eligible set here
    // must be exactly the one new event, proving eligibility was applied
    // before, not after, the limit.
    expect(eligible).toHaveLength(1);
    expect(eligible[0].id).toBe(newRunId);
  });

  it("excludes an already-promoted event (has a real jev_lead_decisions row)", async () => {
    const propertyId = await makeProperty();
    const conversationId = randomUUID();
    const messageId = await makeInboundMessage(propertyId, conversationId);
    const runId = await makeClassificationRun({
      propertyId,
      conversationId,
      sourceInboundMessageId: messageId,
      resolvedOutcome: "unclear",
      createdAt: new Date().toISOString(),
    });
    await db.query(
      `insert into public.jev_lead_decisions (id, org_id, property_id, conversation_id, source_inbound_message_id, classification_run_id, proposed_outcome, status)
       values ($1, $2, $3, $4, $5, $6, 'unclear', 'pending')`,
      [randomUUID(), orgId, propertyId, conversationId, messageId, runId],
    );

    const eligible = await queryEligible();
    expect(eligible.map((r) => r.id)).not.toContain(runId);
  });

  it("excludes a failed event once a later successful retry on the SAME inbound exists (reconciliation)", async () => {
    const propertyId = await makeProperty();
    const conversationId = randomUUID();
    const messageId = await makeInboundMessage(propertyId, conversationId);
    const failedRunId = await makeClassificationRun({
      propertyId,
      conversationId,
      sourceInboundMessageId: messageId,
      resolvedOutcome: null,
      fallbackReason: "provider_timeout",
      createdAt: new Date().toISOString(),
    });
    // A successful retry for the SAME inbound.
    await makeClassificationRun({
      propertyId,
      conversationId,
      sourceInboundMessageId: messageId,
      resolvedOutcome: "new_lead",
      createdAt: new Date(Date.now() + 1000).toISOString(),
    });

    const eligible = await queryEligible();
    expect(eligible.map((r) => r.id)).not.toContain(failedRunId);
  });

  it("still surfaces a failed event when no successful retry exists yet", async () => {
    const propertyId = await makeProperty();
    const conversationId = randomUUID();
    const messageId = await makeInboundMessage(propertyId, conversationId);
    const failedRunId = await makeClassificationRun({
      propertyId,
      conversationId,
      sourceInboundMessageId: messageId,
      resolvedOutcome: null,
      fallbackReason: "provider_timeout",
      createdAt: new Date().toISOString(),
    });

    const eligible = await queryEligible();
    expect(eligible.map((r) => r.id)).toContain(failedRunId);
  });

  it("org-scoped RLS still applies — a caller with no membership in the org sees nothing", async () => {
    const propertyId = await makeProperty();
    const conversationId = randomUUID();
    const messageId = await makeInboundMessage(propertyId, conversationId);
    await makeClassificationRun({
      propertyId,
      conversationId,
      sourceInboundMessageId: messageId,
      resolvedOutcome: "unclear",
      createdAt: new Date().toISOString(),
    });

    const outsiderId = randomUUID();
    await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [outsiderId, `outsider-${outsiderId}@test.local`]);
    await setActor(db, outsiderId);
    const { rows } = await db.query("select id from public.jev_needs_decision_classifier_events");
    expect(rows).toHaveLength(0);
  });
});
