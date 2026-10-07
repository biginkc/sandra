import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Astra production blocker 3 (20260921081409):
 *
 * fn_propose_deferred_ai_disposition_review and
 * fn_propose_ai_dnc_suppression_review used to insert ai_disposition_
 * reviews without ever setting classification_run_id, permanently
 * severing Review Jev's confidence/threshold/model provenance for every
 * below-threshold deferred proposal and Jev-driven dnc suppression.
 * Fixed with a required p_classification_run_id parameter, verified
 * against the cited run's own org/property/conversation/source message/
 * provider/outcome (same integrity check 20260921055215 already applies
 * to jev_lead_decisions) before it is ever linked.
 *
 * Real Postgres, no mocks.
 */
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });

let orgId: string;
let otherOrgId: string;
let contactId: string;

async function setServiceRole(client: Client) {
  await client.query("set local role service_role");
  await client.query("select set_config('request.jwt.claim.role', 'service_role', true)");
}

async function resetServiceRole(client: Client) {
  await client.query("select set_config('request.jwt.claim.role', '', true)");
  await client.query("reset role");
}

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});

beforeEach(async () => {
  await db.query("begin");
  orgId = randomUUID();
  otherOrgId = randomUUID();
  contactId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, $2), ($3, $4)", [
    orgId,
    `Classification-run fixture ${orgId}`,
    otherOrgId,
    `Other org fixture ${otherOrgId}`,
  ]);
  await db.query(
    `insert into public.contacts (id, org_id, first_name, phone_1, phone_1_type) values ($1, $2, 'Homeowner', '+15550004444', 'mobile')`,
    [contactId, orgId],
  );
});
afterEach(async () => {
  await db.query("rollback");
});

type Fixture = {
  propertyId: string;
  conversationId: string;
  messageId: string;
};

async function makeFixture(): Promise<Fixture> {
  const propertyId = randomUUID();
  const conversationId = randomUUID();
  const messageId = randomUUID();
  await db.query(
    `insert into public.properties (id, org_id, address, state, status, outreach_dispo, homeowner_contact_id)
     values ($1, $2, 'Fixture St', 'TX', 'new_lead', null, $3)`,
    [propertyId, orgId, contactId],
  );
  await db.query(
    `insert into public.message_threads (org_id, channel, contact_id, property_id, conversation_id)
     values ($1, 'sms', $2, $3, $4)`,
    [orgId, contactId, propertyId, conversationId],
  );
  await db.query(
    `insert into public.messages (id, org_id, property_id, conversation_id, contact_id, channel, direction, body)
     values ($1, $2, $3, $4, $5, 'sms', 'inbound', 'below-threshold fixture')`,
    [messageId, orgId, propertyId, conversationId, contactId],
  );
  return { propertyId, conversationId, messageId };
}

async function makeClassificationRun(
  fixture: Fixture,
  resolvedOutcome: string,
  overrides: Partial<{ orgId: string; propertyId: string; conversationId: string; messageId: string; provider: string }> = {},
): Promise<string> {
  const id = randomUUID();
  const provider = overrides.provider ?? "jev";
  const decision = {
    outcome: resolvedOutcome,
    provider,
    scope: "disposition",
    reason: "below_threshold",
    probabilities: { [resolvedOutcome]: 0.91 },
  };
  await db.query(
    `insert into public.sms_classification_runs
       (id, org_id, property_id, conversation_id, source_inbound_message_id, provider, model, schema_version, policy_version, state_hash, state_version, decision, resolved_outcome)
     values ($1, $2, $3, $4, $5, $6, 'jev-1.13.0', 2, '2026-09-21-blocker-3', $7, 1, $8, $9)`,
    [
      id,
      overrides.orgId ?? orgId,
      overrides.propertyId ?? fixture.propertyId,
      overrides.conversationId ?? fixture.conversationId,
      overrides.messageId ?? fixture.messageId,
      provider,
      randomUUID(),
      JSON.stringify(decision),
      resolvedOutcome,
    ],
  );
  return id;
}

async function currentRevision(propertyId: string): Promise<number> {
  const { rows } = await db.query("select decision_context_revision from public.properties where id = $1", [propertyId]);
  return rows[0].decision_context_revision;
}

async function proposeDeferred(fixture: Fixture, classificationRunId: string, disposition = "opted_out") {
  await setServiceRole(db);
  try {
    const expectedRevision = await currentRevision(fixture.propertyId);
    const { rows } = await db.query(
      `select public.fn_propose_deferred_ai_disposition_review($1, $2, $3, $4, $5, $6, $7) as result`,
      [fixture.propertyId, fixture.conversationId, fixture.messageId, classificationRunId, disposition, "Jev classified below threshold", expectedRevision],
    );
    return rows[0].result;
  } finally {
    await resetServiceRole(db).catch(() => {});
  }
}

async function proposeDnc(fixture: Fixture, classificationRunId: string) {
  await setServiceRole(db);
  try {
    const expectedRevision = await currentRevision(fixture.propertyId);
    const { rows } = await db.query(
      `select public.fn_propose_ai_dnc_suppression_review($1, $2, $3, $4, $5, $6) as result`,
      [fixture.propertyId, fixture.conversationId, fixture.messageId, classificationRunId, "Jev classified dnc", expectedRevision],
    );
    return rows[0].result;
  } finally {
    await resetServiceRole(db).catch(() => {});
  }
}

describe("Astra blocker 3 — deferred/dnc review provenance", () => {
  it("fn_propose_deferred_ai_disposition_review persists classification_run_id", async () => {
    const fixture = await makeFixture();
    const runId = await makeClassificationRun(fixture, "opted_out");

    const result = await proposeDeferred(fixture, runId, "opted_out");
    expect(result.status).toBe("proposed");

    const review = (await db.query("select classification_run_id from public.ai_disposition_reviews where id = $1", [result.reviewId])).rows[0];
    expect(review.classification_run_id).toBe(runId);
  });

  it("fn_propose_ai_dnc_suppression_review persists classification_run_id", async () => {
    const fixture = await makeFixture();
    const runId = await makeClassificationRun(fixture, "dnc");

    const result = await proposeDnc(fixture, runId);
    expect(result.status).toBe("proposed");

    const review = (await db.query("select classification_run_id from public.ai_disposition_reviews where id = $1", [result.reviewId])).rows[0];
    expect(review.classification_run_id).toBe(runId);
  });

  it("rejects a classification_run_id belonging to a different org (tenant mismatch cannot link)", async () => {
    const fixture = await makeFixture();
    const otherPropertyId = randomUUID();
    const otherConversationId = randomUUID();
    const otherMessageId = randomUUID();
    await db.query(
      `insert into public.properties (id, org_id, address, state, status) values ($1, $2, 'Other org fixture', 'TX', 'new_lead')`,
      [otherPropertyId, otherOrgId],
    );
    const otherContactId = randomUUID();
    await db.query(
      `insert into public.contacts (id, org_id, first_name, phone_1, phone_1_type) values ($1, $2, 'Homeowner', '+15550009999', 'mobile')`,
      [otherContactId, otherOrgId],
    );
    await db.query(
      `insert into public.messages (id, org_id, property_id, conversation_id, contact_id, channel, direction, body)
       values ($1, $2, $3, $4, $5, 'sms', 'inbound', 'other org fixture')`,
      [otherMessageId, otherOrgId, otherPropertyId, otherConversationId, otherContactId],
    );
    const foreignRunId = await makeClassificationRun(fixture, "opted_out", {
      orgId: otherOrgId,
      propertyId: otherPropertyId,
      conversationId: otherConversationId,
      messageId: otherMessageId,
    });

    await expect(proposeDeferred(fixture, foreignRunId, "opted_out")).rejects.toThrow(/classification_run_id does not match/);
  });

  it("rejects a classification_run_id whose resolved_outcome does not match the proposed disposition", async () => {
    const fixture = await makeFixture();
    const mismatchedRunId = await makeClassificationRun(fixture, "wrong_number");

    await expect(proposeDeferred(fixture, mismatchedRunId, "opted_out")).rejects.toThrow(/classification_run_id does not match/);
  });

  it("rejects a non-jev provider run even if org/property/conversation/outcome all match", async () => {
    const fixture = await makeFixture();
    const legacyRunId = await makeClassificationRun(fixture, "opted_out", { provider: "legacy" });

    await expect(proposeDeferred(fixture, legacyRunId, "opted_out")).rejects.toThrow(/classification_run_id does not match/);
  });
});
