import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Root review of 999feefb (jev-root-round11-review.md), finding 2: the
 * atomic-apply fix (20260921045438_jev_auto_apply_atomic.sql) had unit
 * tests exercising the TS caller against a mock, but no committed
 * integration test actually invoked fn_auto_apply_jev_lead_decision
 * against real Postgres. This file proves, with real SQL/RPC semantics
 * (real triggers, real locking, real unique constraints — no mock):
 *   - normal application mutates the property AND inserts the confirmed
 *     audit row in the SAME call, for both nurture and new_lead
 *   - stale/concurrent revision rejects with no effect and no audit row
 *   - DNC/training guards preserve no effect (and no audit row)
 *   - replay (the same source_inbound_message_id called again) is
 *     idempotent — returns the existing decision, no duplicate row, no
 *     re-application
 * It also covers finding 3's integrity hardening: a p_classification_run_id
 * that doesn't genuinely belong to this org/property/conversation/source
 * message, isn't provider 'jev', or whose resolved_outcome doesn't match
 * p_outcome must be rejected before any effect or audit insert.
 *
 * Run together with the existing decision-context-revision integration
 * tests (20260921022936_jev_decision_context_revision.integration.test.ts)
 * — same DB, same setup pattern (per-test transaction, rolled back in
 * afterEach — never a `supabase db reset`, and never touches another
 * agent's stack).
 */
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });

async function setServiceRole(client: Client): Promise<void> {
  await client.query("set local role service_role");
  await client.query("select set_config('request.jwt.claim.role', 'service_role', true)");
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
  // Fixture inserts include DNC-locked and training properties and inbound
  // messages against them, both of which are guarded to service_role only
  // (20260815190000_true_dnc_property_lock.sql, 20260908120000_training_lead_guards.sql).
  // Service role for the whole transaction matches what the real dispatch
  // call site runs as anyway.
  await setServiceRole(db);
  orgId = randomUUID();
  contactId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `Auto-apply atomic fixture ${orgId}`]);
  await db.query(
    `insert into public.contacts (id, org_id, first_name, phone_1, phone_1_type) values ($1, $2, 'Homeowner', '+15550002222', 'mobile')`,
    [contactId, orgId],
  );
});
afterEach(async () => {
  await db.query("rollback");
});

async function makeProperty(
  overrides: Partial<{ status: string; outreachDispo: string | null; isDncLocked: boolean; isTraining: boolean; homeownerContactId: string }> = {},
): Promise<string> {
  const propertyId = randomUUID();
  // is_dnc_locked=true on INSERT is itself guarded (20260815190000_true_dnc_property_lock.sql
  // requires outreach_dispo='dnc' to set the lock authoritatively) — callers
  // that need a locked property use lockPropertyForDnc() after fixtures that
  // depend on it (e.g. an inbound message) are already in place, since a
  // DNC-locked property rejects ALL further writes, including inbound
  // messages, even for service_role.
  await db.query(
    `insert into public.properties (id, org_id, address, state, status, outreach_dispo, homeowner_contact_id, is_dnc_locked, is_training)
     values ($1, $2, 'Fixture St', 'TX', $3, $4, $5, $6, $7)`,
    [
      propertyId,
      orgId,
      overrides.status ?? "prospect",
      overrides.outreachDispo ?? null,
      overrides.homeownerContactId ?? contactId,
      false,
      overrides.isTraining ?? false,
    ],
  );
  if (overrides.isDncLocked) {
    await lockPropertyForDnc(propertyId);
  }
  return propertyId;
}

async function lockPropertyForDnc(propertyId: string): Promise<void> {
  await db.query(
    "update public.properties set outreach_dispo = 'dnc', is_dnc_locked = true where id = $1",
    [propertyId],
  );
}

async function currentRevision(propertyId: string): Promise<number> {
  const { rows } = await db.query("select decision_context_revision from public.properties where id = $1", [propertyId]);
  return Number(rows[0].decision_context_revision);
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
  resolvedOutcome: string;
  provider?: string;
}): Promise<string> {
  const runId = randomUUID();
  await db.query(
    `insert into public.sms_classification_runs
       (id, org_id, property_id, conversation_id, source_inbound_message_id, state_hash, state_version, schema_version, policy_version, provider, model, decision, resolved_outcome)
     values ($1, $2, $3, $4, $5, $6, 1, 'v1', 'v1', $7, 'jev-1.13.0', '{}'::jsonb, $8)`,
    [runId, orgId, args.propertyId, args.conversationId, args.sourceInboundMessageId, randomUUID(), args.provider ?? "jev", args.resolvedOutcome],
  );
  return runId;
}

async function callAutoApply(args: {
  propertyId: string;
  conversationId: string;
  sourceInboundMessageId: string;
  classificationRunId: string;
  outcome: "new_lead" | "nurture";
  expectedRevision: number;
}) {
  await setServiceRole(db);
  const { rows } = await db.query(
    `select public.fn_auto_apply_jev_lead_decision($1, $2, $3, $4, $5, 0.9, 0.8, 1, $6) as result`,
    [args.propertyId, args.conversationId, args.sourceInboundMessageId, args.classificationRunId, args.outcome, args.expectedRevision],
  );
  return rows[0].result;
}

describe("fn_auto_apply_jev_lead_decision — atomic effect + revision guard + audit insert (root review 999feefb, finding 2)", () => {
  it("nurture: normal application mutates outreach_dispo AND inserts the confirmed audit row in the same call", async () => {
    const propertyId = await makeProperty();
    const conversationId = randomUUID();
    const inboundId = await makeInboundMessage(propertyId, conversationId, "not right now");
    const revision = await currentRevision(propertyId);
    const runId = await makeClassificationRun({ propertyId, conversationId, sourceInboundMessageId: inboundId, resolvedOutcome: "nurture" });

    const result = await callAutoApply({ propertyId, conversationId, sourceInboundMessageId: inboundId, classificationRunId: runId, outcome: "nurture", expectedRevision: revision });
    expect(result).toMatchObject({ status: "applied" });

    const property = (await db.query("select outreach_dispo from public.properties where id = $1", [propertyId])).rows[0];
    expect(property.outreach_dispo).toBe("nurture");
    const decision = (await db.query("select status, resolved_outcome, classification_run_id from public.jev_lead_decisions where property_id = $1", [propertyId])).rows[0];
    expect(decision).toMatchObject({ status: "confirmed", resolved_outcome: "nurture", classification_run_id: runId });
  });

  it("new_lead: normal application mutates status/qualified_by AND inserts the confirmed audit row in the same call", async () => {
    const propertyId = await makeProperty();
    const conversationId = randomUUID();
    const inboundId = await makeInboundMessage(propertyId, conversationId, "yes call me");
    const revision = await currentRevision(propertyId);
    const runId = await makeClassificationRun({ propertyId, conversationId, sourceInboundMessageId: inboundId, resolvedOutcome: "new_lead" });

    const result = await callAutoApply({ propertyId, conversationId, sourceInboundMessageId: inboundId, classificationRunId: runId, outcome: "new_lead", expectedRevision: revision });
    expect(result).toMatchObject({ status: "applied" });

    const property = (await db.query("select status, qualified_by from public.properties where id = $1", [propertyId])).rows[0];
    expect(property).toMatchObject({ status: "new_lead", qualified_by: "system:jev_auto_promote" });
    const decision = (await db.query("select status, resolved_outcome from public.jev_lead_decisions where property_id = $1", [propertyId])).rows[0];
    expect(decision).toMatchObject({ status: "confirmed", resolved_outcome: "new_lead" });
  });

  it("nurture: a concurrent write (another inbound arriving after the revision was captured) rejects with STALE_DECISION_CONTEXT — no effect, no audit row", async () => {
    const propertyId = await makeProperty();
    const conversationId = randomUUID();
    const inboundId = await makeInboundMessage(propertyId, conversationId, "not right now");
    const staleRevision = await currentRevision(propertyId);
    const runId = await makeClassificationRun({ propertyId, conversationId, sourceInboundMessageId: inboundId, resolvedOutcome: "nurture" });

    // Concurrent activity arrives AFTER the revision was captured.
    await makeInboundMessage(propertyId, conversationId, "wait actually never mind");

    await db.query("savepoint rejected_apply");
    await expect(
      callAutoApply({ propertyId, conversationId, sourceInboundMessageId: inboundId, classificationRunId: runId, outcome: "nurture", expectedRevision: staleRevision }),
    ).rejects.toMatchObject({ message: "STALE_DECISION_CONTEXT" });
    await db.query("rollback to savepoint rejected_apply");

    const property = (await db.query("select outreach_dispo from public.properties where id = $1", [propertyId])).rows[0];
    expect(property.outreach_dispo).toBeNull();
    const decisions = await db.query("select count(*)::int as n from public.jev_lead_decisions where property_id = $1", [propertyId]);
    expect(decisions.rows[0].n).toBe(0);
  });

  it("new_lead: a concurrent write rejects with STALE_DECISION_CONTEXT — no effect, no audit row", async () => {
    const propertyId = await makeProperty();
    const conversationId = randomUUID();
    const inboundId = await makeInboundMessage(propertyId, conversationId, "yes call me");
    const staleRevision = await currentRevision(propertyId);
    const runId = await makeClassificationRun({ propertyId, conversationId, sourceInboundMessageId: inboundId, resolvedOutcome: "new_lead" });

    await makeInboundMessage(propertyId, conversationId, "actually don't");

    await db.query("savepoint rejected_apply");
    await expect(
      callAutoApply({ propertyId, conversationId, sourceInboundMessageId: inboundId, classificationRunId: runId, outcome: "new_lead", expectedRevision: staleRevision }),
    ).rejects.toMatchObject({ message: "STALE_DECISION_CONTEXT" });
    await db.query("rollback to savepoint rejected_apply");

    const property = (await db.query("select status from public.properties where id = $1", [propertyId])).rows[0];
    expect(property.status).toBe("prospect");
    const decisions = await db.query("select count(*)::int as n from public.jev_lead_decisions where property_id = $1", [propertyId]);
    expect(decisions.rows[0].n).toBe(0);
  });

  it("new_lead: DNC-locked property preserves no effect and no audit row", async () => {
    const propertyId = await makeProperty();
    const conversationId = randomUUID();
    // A DNC-locked property rejects ALL further writes (even service_role),
    // so the inbound message and its classification run must exist BEFORE
    // the lock — matching the only order this can happen for real: Jev
    // classified this inbound while the lead was still open, and the
    // property was locked afterward, before the decision was ever applied.
    const inboundId = await makeInboundMessage(propertyId, conversationId, "yes call me");
    const runId = await makeClassificationRun({ propertyId, conversationId, sourceInboundMessageId: inboundId, resolvedOutcome: "new_lead" });
    await lockPropertyForDnc(propertyId);
    const revision = await currentRevision(propertyId);

    const result = await callAutoApply({ propertyId, conversationId, sourceInboundMessageId: inboundId, classificationRunId: runId, outcome: "new_lead", expectedRevision: revision });
    expect(result).toEqual({ status: "dnc_locked" });

    const property = (await db.query("select status from public.properties where id = $1", [propertyId])).rows[0];
    expect(property.status).toBe("prospect");
    const decisions = await db.query("select count(*)::int as n from public.jev_lead_decisions where property_id = $1", [propertyId]);
    expect(decisions.rows[0].n).toBe(0);
  });

  it("nurture: a training-target property preserves no effect and no audit row", async () => {
    // Training seeds are guarded (20260908120000_training_lead_guards.sql):
    // must be status='new_lead', outreach_dispo=null, is_dnc_locked=false,
    // and have a dedicated contact not shared with any other property.
    const trainingContactId = randomUUID();
    await db.query(
      `insert into public.contacts (id, org_id, first_name, phone_1, phone_1_type) values ($1, $2, 'Training Homeowner', '+15550003333', 'mobile')`,
      [trainingContactId, orgId],
    );
    const propertyId = await makeProperty({ isTraining: true, status: "new_lead", homeownerContactId: trainingContactId });
    const conversationId = randomUUID();
    const inboundId = await makeInboundMessage(propertyId, conversationId, "not right now");
    const revision = await currentRevision(propertyId);
    const runId = await makeClassificationRun({ propertyId, conversationId, sourceInboundMessageId: inboundId, resolvedOutcome: "nurture" });

    await db.query("savepoint rejected_training");
    await expect(
      callAutoApply({ propertyId, conversationId, sourceInboundMessageId: inboundId, classificationRunId: runId, outcome: "nurture", expectedRevision: revision }),
    ).rejects.toMatchObject({ message: expect.stringContaining("training lead") });
    await db.query("rollback to savepoint rejected_training");

    const property = (await db.query("select outreach_dispo from public.properties where id = $1", [propertyId])).rows[0];
    expect(property.outreach_dispo).toBeNull();
    const decisions = await db.query("select count(*)::int as n from public.jev_lead_decisions where property_id = $1", [propertyId]);
    expect(decisions.rows[0].n).toBe(0);
  });

  it("replay: calling again with the SAME source_inbound_message_id is idempotent — returns the existing decision, no duplicate row, no re-application", async () => {
    const propertyId = await makeProperty();
    const conversationId = randomUUID();
    const inboundId = await makeInboundMessage(propertyId, conversationId, "not right now");
    const revision = await currentRevision(propertyId);
    const runId = await makeClassificationRun({ propertyId, conversationId, sourceInboundMessageId: inboundId, resolvedOutcome: "nurture" });

    const first = await callAutoApply({ propertyId, conversationId, sourceInboundMessageId: inboundId, classificationRunId: runId, outcome: "nurture", expectedRevision: revision });
    expect(first).toMatchObject({ status: "applied" });

    // A retry after the effect already committed — SAME expectedRevision
    // as before would now be stale (the effect itself bumped it), but
    // replay is checked BEFORE the revision gate, so it still succeeds.
    const second = await callAutoApply({ propertyId, conversationId, sourceInboundMessageId: inboundId, classificationRunId: runId, outcome: "nurture", expectedRevision: revision });
    expect(second).toEqual({ status: "replayed", decisionId: first.decisionId });

    const decisions = await db.query("select count(*)::int as n from public.jev_lead_decisions where property_id = $1", [propertyId]);
    expect(decisions.rows[0].n).toBe(1);
  });

  // Root review of 999feefb, finding 3: integrity hardening.
  describe("classification_run_id integrity hardening (finding 3)", () => {
    it("rejects when the run belongs to a DIFFERENT property", async () => {
      const propertyId = await makeProperty();
      const otherPropertyId = await makeProperty();
      const conversationId = randomUUID();
      const inboundId = await makeInboundMessage(propertyId, conversationId, "not right now");
      const revision = await currentRevision(propertyId);
      const mismatchedRunId = await makeClassificationRun({
        propertyId: otherPropertyId,
        conversationId,
        sourceInboundMessageId: inboundId,
        resolvedOutcome: "nurture",
      });

      await db.query("savepoint rejected_mismatch");
      await expect(
        callAutoApply({ propertyId, conversationId, sourceInboundMessageId: inboundId, classificationRunId: mismatchedRunId, outcome: "nurture", expectedRevision: revision }),
      ).rejects.toMatchObject({ message: expect.stringContaining("classification_run_id does not match") });
      await db.query("rollback to savepoint rejected_mismatch");

      const property = (await db.query("select outreach_dispo from public.properties where id = $1", [propertyId])).rows[0];
      expect(property.outreach_dispo).toBeNull();
      const decisions = await db.query("select count(*)::int as n from public.jev_lead_decisions where property_id = $1", [propertyId]);
      expect(decisions.rows[0].n).toBe(0);
    });

    it("rejects when the run's own resolved_outcome does not match p_outcome", async () => {
      const propertyId = await makeProperty();
      const conversationId = randomUUID();
      const inboundId = await makeInboundMessage(propertyId, conversationId, "yes call me");
      const revision = await currentRevision(propertyId);
      // The run actually resolved to new_lead, but the call claims nurture.
      const runId = await makeClassificationRun({ propertyId, conversationId, sourceInboundMessageId: inboundId, resolvedOutcome: "new_lead" });

      await db.query("savepoint rejected_outcome_mismatch");
      await expect(
        callAutoApply({ propertyId, conversationId, sourceInboundMessageId: inboundId, classificationRunId: runId, outcome: "nurture", expectedRevision: revision }),
      ).rejects.toMatchObject({ message: expect.stringContaining("classification_run_id does not match") });
      await db.query("rollback to savepoint rejected_outcome_mismatch");

      const property = (await db.query("select outreach_dispo, status from public.properties where id = $1", [propertyId])).rows[0];
      expect(property).toEqual({ outreach_dispo: null, status: "prospect" });
    });

    it("rejects when the run's own provider is not 'jev'", async () => {
      const propertyId = await makeProperty();
      const conversationId = randomUUID();
      const inboundId = await makeInboundMessage(propertyId, conversationId, "not right now");
      const revision = await currentRevision(propertyId);
      const legacyRunId = await makeClassificationRun({
        propertyId,
        conversationId,
        sourceInboundMessageId: inboundId,
        resolvedOutcome: "nurture",
        provider: "legacy",
      });

      await db.query("savepoint rejected_provider_mismatch");
      await expect(
        callAutoApply({ propertyId, conversationId, sourceInboundMessageId: inboundId, classificationRunId: legacyRunId, outcome: "nurture", expectedRevision: revision }),
      ).rejects.toMatchObject({ message: expect.stringContaining("classification_run_id does not match") });
      await db.query("rollback to savepoint rejected_provider_mismatch");

      const decisions = await db.query("select count(*)::int as n from public.jev_lead_decisions where property_id = $1", [propertyId]);
      expect(decisions.rows[0].n).toBe(0);
    });

    it("rejects when p_classification_run_id doesn't exist at all", async () => {
      const propertyId = await makeProperty();
      const conversationId = randomUUID();
      const inboundId = await makeInboundMessage(propertyId, conversationId, "not right now");
      const revision = await currentRevision(propertyId);

      await db.query("savepoint rejected_missing_run");
      await expect(
        callAutoApply({ propertyId, conversationId, sourceInboundMessageId: inboundId, classificationRunId: randomUUID(), outcome: "nurture", expectedRevision: revision }),
      ).rejects.toMatchObject({ message: expect.stringContaining("classification_run_id does not match") });
      await db.query("rollback to savepoint rejected_missing_run");
    });
  });
});
