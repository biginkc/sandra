import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Root review of f3ab9e1e (jev-root-round18-prelimit-dedup.md): the
 * eligibility view (20260921070948) moved promoted/reconciled filtering
 * before the limit, but left per-inbound "latest wins" dedup to
 * queries.ts AFTER limit(100) — so more than 100 eligible failed-retry
 * rows on ONE inbound could fill the entire DB result on their own,
 * and a genuinely distinct newer actionable inbound would never reach
 * the query at all. Fixed by returning at most one row per
 * source_inbound_message_id from the view itself (DISTINCT ON,
 * 20260921072107_jev_needs_decision_dedup_before_limit.sql). This
 * proves, against real Postgres, using the EXACT order+limit query
 * production runs (order by created_at asc, limit 100): a fixture with
 * MORE than 100 eligible retry rows for ONE inbound, plus one newer
 * distinct actionable inbound, surfaces the distinct event AND exactly
 * the latest retry for the crowded inbound — never more than one row
 * per inbound, and the distinct event is never starved out.
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
  await db.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `Dedup-before-limit fixture ${orgId}`]);
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [userId, `reviewer-${userId}@test.local`]);
  await db.query(`insert into public.memberships (org_id, user_id, role, access_status) values ($1, $2, 'owner', 'active')`, [orgId, userId]);
  await db.query(
    `insert into public.contacts (id, org_id, first_name, phone_1, phone_1_type) values ($1, $2, 'Homeowner', '+15550002222', 'mobile')`,
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

async function makeInboundMessage(propertyId: string, conversationId: string, body: string): Promise<string> {
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

async function queryProductionShape(): Promise<Array<{ id: string; source_inbound_message_id: string }>> {
  await setActor(db, userId);
  const { rows } = await db.query(
    "select id, source_inbound_message_id from public.jev_needs_decision_classifier_events order by created_at asc limit 100",
  );
  return rows;
}

describe("jev_needs_decision_classifier_events — dedup before limit (root review f3ab9e1e, round 18)", () => {
  it("MORE than 100 eligible retries on ONE inbound never crowd out a distinct newer inbound — production order+limit(100) query", async () => {
    const propertyId = await makeProperty();
    const conversationId = randomUUID();
    const crowdedConversationId = randomUUID();
    const crowdedMessageId = await makeInboundMessage(propertyId, crowdedConversationId, "one inbound, many retries");
    const baseTime = new Date("2026-01-01T00:00:00.000Z").getTime();

    // 105 eligible failed-retry rows for the SAME inbound — the exact
    // regression shape: if dedup ran after limit(100), these alone
    // would fill the whole result.
    let latestCrowdedRunId = "";
    for (let i = 0; i < 105; i++) {
      latestCrowdedRunId = await makeClassificationRun({
        propertyId,
        conversationId: crowdedConversationId,
        sourceInboundMessageId: crowdedMessageId,
        resolvedOutcome: null,
        fallbackReason: `retry_attempt_${i}`,
        createdAt: new Date(baseTime + i * 1000).toISOString(),
      });
    }

    // One genuinely distinct, newer actionable event on a DIFFERENT inbound.
    const distinctMessageId = await makeInboundMessage(propertyId, conversationId, "a different, newer inbound");
    const distinctRunId = await makeClassificationRun({
      propertyId,
      conversationId,
      sourceInboundMessageId: distinctMessageId,
      resolvedOutcome: "bad_number",
      createdAt: new Date(baseTime + 200 * 1000).toISOString(),
    });

    const rows = await queryProductionShape();

    // At most one row per inbound, even under production's exact
    // order+limit query.
    const bySourceMessage = new Map<string, string[]>();
    for (const row of rows) {
      const list = bySourceMessage.get(row.source_inbound_message_id) ?? [];
      list.push(row.id);
      bySourceMessage.set(row.source_inbound_message_id, list);
    }
    for (const [, ids] of bySourceMessage) {
      expect(ids).toHaveLength(1);
    }

    // The crowded inbound's ONLY surviving row is the deterministic
    // latest (highest created_at) retry.
    expect(bySourceMessage.get(crowdedMessageId)).toEqual([latestCrowdedRunId]);

    // The distinct, newer inbound's event is present — never starved
    // out by the 105 retries on the other inbound.
    expect(bySourceMessage.get(distinctMessageId)).toEqual([distinctRunId]);

    // Exactly 2 rows total: one per inbound, nothing more.
    expect(rows).toHaveLength(2);
  });

  it("picks the latest retry regardless of insertion/array order, with a stable id tie-break on an exact timestamp collision", async () => {
    const propertyId = await makeProperty();
    const conversationId = randomUUID();
    const messageId = await makeInboundMessage(propertyId, conversationId, "tie-break test");
    const sameInstant = new Date("2026-02-01T00:00:00.000Z").toISOString();

    const runA = await makeClassificationRun({
      propertyId,
      conversationId,
      sourceInboundMessageId: messageId,
      resolvedOutcome: null,
      fallbackReason: "attempt_a",
      createdAt: sameInstant,
    });
    const runB = await makeClassificationRun({
      propertyId,
      conversationId,
      sourceInboundMessageId: messageId,
      resolvedOutcome: null,
      fallbackReason: "attempt_b",
      createdAt: sameInstant,
    });
    const expectedWinner = [runA, runB].sort().reverse()[0]; // id desc tie-break, matching the view's ORDER BY

    const rows = await queryProductionShape();
    expect(rows.map((r) => r.id)).toEqual([expectedWinner]);
  });
});
