import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Root review of f271492e (jev-root-cas-review.md, 2026-09-20): the
 * atomic-apply RPCs' compare-and-set only inspected the ONE column each
 * correction target cared about, missing every other way a decision's
 * context can go stale (a disposition-only check missing a status
 * change and vice versa, same-value ABA writes, new inbound activity,
 * appointments). Fixed with a decision_context_revision captured at
 * proposal time and re-synced on every successful correction/
 * confirmation — this file proves every regression scenario root
 * enumerated actually behaves correctly, against real Postgres, not a
 * mocked "begin RPC returns an error" stand-in.
 */
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const REVIEWER_ID = randomUUID();

async function setActor(client: Client, userId: string) {
  await client.query("set local role authenticated");
  await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
}

let orgId: string;
let contactId: string;

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
  // Unique per-test name: the two-connection test explicitly commits its
  // fixture mid-test (to make it visible to the second connection), so a
  // failure there can leave this row committed rather than rolled back —
  // a fixed literal name would then collide with the next run.
  await db.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `Decision context revision fixture ${orgId}`]);
  await db.query(
    `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`,
    [REVIEWER_ID, `reviewer-${REVIEWER_ID}@test.local`],
  );
  await db.query(
    `insert into public.memberships (org_id, user_id, role, access_status) values ($1, $2, 'owner', 'active')`,
    [orgId, REVIEWER_ID],
  );
  await db.query(
    `insert into public.contacts (id, org_id, first_name, phone_1, phone_1_type) values ($1, $2, 'Homeowner', '+15550001111', 'mobile')`,
    [contactId, orgId],
  );
});
afterEach(async () => {
  await db.query("rollback");
});

async function makeProperty(status: string, outreachDispo: string | null): Promise<string> {
  const propertyId = randomUUID();
  await db.query(
    `insert into public.properties (id, org_id, address, state, status, outreach_dispo, homeowner_contact_id)
     values ($1, $2, 'Fixture St', 'TX', $3, $4, $5)`,
    [propertyId, orgId, status, outreachDispo, contactId],
  );
  return propertyId;
}

async function makeInboundMessage(propertyId: string, conversationId: string, body = "hi"): Promise<string> {
  const messageId = randomUUID();
  await db.query(
    `insert into public.messages (id, org_id, property_id, conversation_id, channel, direction, body)
     values ($1, $2, $3, $4, 'sms', 'inbound', $5)`,
    [messageId, orgId, propertyId, conversationId, body],
  );
  return messageId;
}

async function makeAiDispositionReview(args: {
  propertyId: string;
  conversationId: string;
  sourceInboundMessageId: string;
  disposition: string;
}): Promise<string> {
  const reviewId = randomUUID();
  await db.query(
    `insert into public.ai_disposition_reviews
       (id, org_id, property_id, conversation_id, source_inbound_message_id, disposition, ai_reason, dispo_applied, status)
     values ($1, $2, $3, $4, $5, $6, 'fixture reason', true, 'pending')`,
    [reviewId, orgId, args.propertyId, args.conversationId, args.sourceInboundMessageId, args.disposition],
  );
  return reviewId;
}

async function makeJevLeadDecision(args: {
  propertyId: string;
  conversationId: string;
  sourceInboundMessageId: string;
  proposedOutcome: "new_lead" | "nurture";
}): Promise<string> {
  const classificationRunId = randomUUID();
  await db.query(
    `insert into public.sms_classification_runs
       (id, org_id, property_id, conversation_id, source_inbound_message_id, provider, model, schema_version, policy_version, state_hash, state_version, decision)
     values ($1, $2, $3, $4, $5, 'jev', 'jev-1.13.0', 2, '2026-09-20-new-lead-review', $6, 1, '{}'::jsonb)`,
    [classificationRunId, orgId, args.propertyId, args.conversationId, args.sourceInboundMessageId, randomUUID()],
  );
  const decisionId = randomUUID();
  await db.query(
    `insert into public.jev_lead_decisions
       (id, org_id, property_id, conversation_id, source_inbound_message_id, classification_run_id, proposed_outcome, status)
     values ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
    [decisionId, orgId, args.propertyId, args.conversationId, args.sourceInboundMessageId, classificationRunId, args.proposedOutcome],
  );
  return decisionId;
}

describe("jev decision_context_revision — root cas-review regressions", () => {
  it("blocks a stale new_lead promotion when a DIFFERENT writer changed outreach_dispo while status stayed 'prospect' (disposition-only update — root's exact example)", async () => {
    const propertyId = await makeProperty("prospect", null);
    const conversationId = randomUUID();
    const inboundId = await makeInboundMessage(propertyId, conversationId);
    const decisionId = await makeJevLeadDecision({
      propertyId,
      conversationId,
      sourceInboundMessageId: inboundId,
      proposedOutcome: "new_lead",
    });

    // A different writer changes outreach_dispo; status stays 'prospect'.
    await db.query("update public.properties set outreach_dispo = 'nurture' where id = $1", [propertyId]);

    await setActor(db, REVIEWER_ID);
    const { rows } = await db.query("select public.fn_confirm_jev_lead_decision($1) as result", [decisionId]);
    expect(rows[0].result).toMatchObject({ status: "superseded" });

    const property = (await db.query("select status from public.properties where id = $1", [propertyId])).rows[0];
    expect(property.status).toBe("prospect");
  });

  it("blocks a stale opted_out correction when a DIFFERENT writer advanced status while outreach_dispo stayed at the expected value (status-only update)", async () => {
    const propertyId = await makeProperty("prospect", "not_interested");
    const conversationId = randomUUID();
    const inboundId = await makeInboundMessage(propertyId, conversationId);
    const reviewId = await makeAiDispositionReview({
      propertyId,
      conversationId,
      sourceInboundMessageId: inboundId,
      disposition: "not_interested",
    });

    await db.query(
      "update public.properties set status = 'new_lead', qualified_at = now(), qualified_by = 'system:other' where id = $1",
      [propertyId],
    );

    await setActor(db, REVIEWER_ID);
    await db.query("savepoint rejected_correction");
    await expect(
      db.query("select public.fn_apply_and_record_ai_disposition_review_correction($1, 'opted_out', 'said stop') as result", [reviewId]),
    ).rejects.toMatchObject({ message: "STALE_STATE" });
    await db.query("rollback to savepoint rejected_correction");

    const property = (await db.query("select outreach_dispo, status from public.properties where id = $1", [propertyId])).rows[0];
    expect(property).toEqual({ outreach_dispo: "not_interested", status: "new_lead" });
    const events = await db.query(
      "select count(*)::int as n from public.lead_events where property_id = $1 and event_type = 'ai_disposition_review_corrected'",
      [propertyId],
    );
    expect(events.rows[0].n).toBe(0);
  });

  it("blocks a stale correction after a same-value ABA human edit (X -> Y -> X) that value equality alone cannot see", async () => {
    const propertyId = await makeProperty("prospect", "not_interested");
    const conversationId = randomUUID();
    const inboundId = await makeInboundMessage(propertyId, conversationId);
    const reviewId = await makeAiDispositionReview({
      propertyId,
      conversationId,
      sourceInboundMessageId: inboundId,
      disposition: "not_interested",
    });

    await db.query("update public.properties set outreach_dispo = 'nurture' where id = $1", [propertyId]);
    await db.query("update public.properties set outreach_dispo = 'not_interested' where id = $1", [propertyId]);

    await setActor(db, REVIEWER_ID);
    await expect(
      db.query("select public.fn_apply_and_record_ai_disposition_review_correction($1, 'opted_out', 'said stop') as result", [reviewId]),
    ).rejects.toMatchObject({ message: "STALE_STATE" });
  });

  it("blocks a stale correction after a NEW inbound message arrives, even though outreach_dispo/status never changed", async () => {
    const propertyId = await makeProperty("prospect", "not_interested");
    const conversationId = randomUUID();
    const inboundId = await makeInboundMessage(propertyId, conversationId);
    const reviewId = await makeAiDispositionReview({
      propertyId,
      conversationId,
      sourceInboundMessageId: inboundId,
      disposition: "not_interested",
    });

    await makeInboundMessage(propertyId, conversationId, "actually wait, call me");

    await setActor(db, REVIEWER_ID);
    await expect(
      db.query("select public.fn_apply_and_record_ai_disposition_review_correction($1, 'opted_out', 'said stop') as result", [reviewId]),
    ).rejects.toMatchObject({ message: "STALE_STATE" });
  });

  it("blocks a stale correction after an appointment is booked for the property, even though outreach_dispo/status never changed", async () => {
    const propertyId = await makeProperty("prospect", "not_interested");
    const conversationId = randomUUID();
    const inboundId = await makeInboundMessage(propertyId, conversationId);
    const reviewId = await makeAiDispositionReview({
      propertyId,
      conversationId,
      sourceInboundMessageId: inboundId,
      disposition: "not_interested",
    });

    await db.query(
      `insert into public.tasks (id, org_id, assignee_id, related_property_id, type, status, title, due_at, end_at, created_by, calendar_chain_id)
       values ($1, $2, $3, $4, 'appointment', 'open', 'Site visit', now() + interval '1 day', now() + interval '1 day 1 hour', $3, $5)`,
      [randomUUID(), orgId, REVIEWER_ID, propertyId, randomUUID()],
    );

    await setActor(db, REVIEWER_ID);
    await expect(
      db.query("select public.fn_apply_and_record_ai_disposition_review_correction($1, 'opted_out', 'said stop') as result", [reviewId]),
    ).rejects.toMatchObject({ message: "STALE_STATE" });
  });

  it("allows two genuinely different sequential corrections on the same row, then reports a THIRD identical resend as an explicit replay with no duplicate audit", async () => {
    const propertyId = await makeProperty("prospect", null);
    const conversationId = randomUUID();
    const inboundId = await makeInboundMessage(propertyId, conversationId);
    const decisionId = await makeJevLeadDecision({
      propertyId,
      conversationId,
      sourceInboundMessageId: inboundId,
      proposedOutcome: "new_lead",
    });

    await setActor(db, REVIEWER_ID);
    const first = await db.query(
      "select public.fn_correct_jev_lead_decision($1, 'nurture', 'not ready yet') as result",
      [decisionId],
    );
    expect(first.rows[0].result).toMatchObject({ status: "corrected", resolvedOutcome: "nurture" });

    const second = await db.query(
      "select public.fn_correct_jev_lead_decision($1, 'not_interested', 'changed mind') as result",
      [decisionId],
    );
    expect(second.rows[0].result).toMatchObject({ status: "corrected", resolvedOutcome: "not_interested" });

    const events = await db.query(
      "select count(*)::int as n from public.lead_events where property_id = $1 and event_type = 'jev_lead_decision_corrected'",
      [propertyId],
    );
    expect(events.rows[0].n).toBe(2);

    // Proper replay: identical resend of the SECOND correction.
    const replay = await db.query(
      "select public.fn_correct_jev_lead_decision($1, 'not_interested', 'changed mind') as result",
      [decisionId],
    );
    expect(replay.rows[0].result).toMatchObject({ status: "already_corrected", resolvedOutcome: "not_interested" });

    const eventsAfterReplay = await db.query(
      "select count(*)::int as n from public.lead_events where property_id = $1 and event_type = 'jev_lead_decision_corrected'",
      [propertyId],
    );
    expect(eventsAfterReplay.rows[0].n).toBe(2);
  });

  it("real two-connection interleaving: a concurrent write held mid-transaction is neither overwritten nor falsely audited by a competing correction", async () => {
    const propertyId = await makeProperty("prospect", "not_interested");
    const conversationId = randomUUID();
    const inboundId = await makeInboundMessage(propertyId, conversationId);
    const reviewId = await makeAiDispositionReview({
      propertyId,
      conversationId,
      sourceInboundMessageId: inboundId,
      disposition: "not_interested",
    });
    // Fixture must be visible to a second, independent connection.
    await db.query("commit");
    await db.query("begin");

    const other = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
    await other.connect();
    try {
      await other.query("begin");
      await other.query("update public.properties set outreach_dispo = 'wrong_number' where id = $1", [propertyId]);

      const holdPromise = other.query("select pg_sleep(2)").then(() => other.query("commit"));

      await new Promise((resolve) => setTimeout(resolve, 500));

      await setActor(db, REVIEWER_ID);
      await db.query("savepoint rejected_concurrent_correction");
      await expect(
        db.query("select public.fn_apply_and_record_ai_disposition_review_correction($1, 'opted_out', 'concurrent correction') as result", [
          reviewId,
        ]),
      ).rejects.toMatchObject({ message: "STALE_STATE" });
      await db.query("rollback to savepoint rejected_concurrent_correction");

      await holdPromise;

      const property = (await db.query("select outreach_dispo from public.properties where id = $1", [propertyId])).rows[0];
      expect(property.outreach_dispo).toBe("wrong_number");
      const events = await db.query(
        "select count(*)::int as n from public.lead_events where property_id = $1 and event_type = 'ai_disposition_review_corrected'",
        [propertyId],
      );
      expect(events.rows[0].n).toBe(0);
    } finally {
      await other.end();
      // This test explicitly committed its fixture (above) so it would be
      // visible to the second connection — afterEach's plain `rollback`
      // cannot undo that. Clean it up explicitly, in every outcome
      // (leaf tables first, no ON DELETE CASCADE from organizations),
      // then reopen a transaction so afterEach's rollback has something
      // valid to roll back (a no-op at that point). Also reset the role
      // `setActor` switched to — `authenticated` can't delete these
      // tables (RLS + grants are select-only for it), only the
      // superuser connection this test started as can.
      await db.query("reset role");
      await db.query("delete from public.lead_events where org_id = $1", [orgId]);
      await db.query("delete from public.ai_disposition_reviews where org_id = $1", [orgId]);
      await db.query("delete from public.jev_lead_decisions where org_id = $1", [orgId]);
      await db.query("delete from public.sms_classification_runs where org_id = $1", [orgId]);
      await db.query("delete from public.messages where org_id = $1", [orgId]);
      await db.query("delete from public.tasks where org_id = $1", [orgId]);
      await db.query("delete from public.properties where org_id = $1", [orgId]);
      await db.query("delete from public.contacts where org_id = $1", [orgId]);
      // memberships/organizations are deliberately left in place: a
      // FINAL_OWNER_GUARD trigger blocks deleting an org's last owner
      // membership, and the org row itself is harmless to leave behind
      // (its name embeds this test's own orgId, so it can never collide
      // with a later run).
      await db.query("begin");
    }
  });
});
