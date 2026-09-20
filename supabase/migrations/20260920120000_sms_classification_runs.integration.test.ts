import { readFileSync } from "node:fs";

import { Client } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { createTestClient } from "@tests/integration/client";
import { loadTestEnv } from "@tests/integration/env";

/**
 * Real-Postgres coverage for the Jev SMS-classification adapter's
 * deferred-DNC-confirm path (biginkc/sandra#645, #646). Both PR
 * reviewers (Fable and Astra/Codex) called this a hard precondition
 * before any org's classifier_mode flips to automatic: the trigger-
 * collision bug in fn_confirm_ai_disposition_review's new
 * dispo_applied=false branch was found only by manual SQL/trigger
 * tracing, not by any test — this file exists so a regression of that
 * fix, or a similar one, fails a real test run instead of needing
 * another manual read.
 *
 * Self-contained fixtures (own org, own owner membership) rather than
 * reusing tests/integration/fixtures/multi-user.ts's createOrgUser —
 * that helper's membership insert trips FINAL_OWNER_GUARD
 * (20260727150000_hugo_access_provisioner.sql) on a fresh local
 * database with no pre-existing owner for BMH_ORG_ID, which only the
 * hosted sandra-crm-test project's accumulated state normally avoids.
 * Seeding this file's own org with an owner membership first sidesteps
 * that pre-existing fixture-environment gap entirely.
 */

const serviceClient = createTestClient();
const migrationSql = readFileSync(
  "supabase/migrations/20260920120000_sms_classification_runs.sql",
  "utf8",
)
  .replace(/\nbegin;\s*/i, "\n")
  .replace(/\s*commit;\s*$/i, "");

let pg: Client;
const TEST_ORG_ID = crypto.randomUUID();
let ownerUserId = "";

function testDbUrl(): string {
  const env = loadTestEnv();
  const url = process.env.TEST_SUPABASE_DB_URL ?? env.TEST_SUPABASE_DB_URL;
  if (!url) {
    throw new Error(
      "Missing TEST_SUPABASE_DB_URL in .env.test.local — see tests/integration/README.md.",
    );
  }
  return url;
}

async function setRequestRole(
  role: "service_role" | "authenticated",
  userId?: string,
): Promise<void> {
  await pg.query(`set local role ${role}`);
  await pg.query("select set_config('request.jwt.claim.role', $1, true)", [
    role,
  ]);
  await pg.query("select set_config('request.jwt.claim.sub', $1, true)", [
    userId ?? "",
  ]);
}

async function resetRequestRole(): Promise<void> {
  await pg.query("reset role");
  await pg.query("select set_config('request.jwt.claim.role', '', true)");
  await pg.query("select set_config('request.jwt.claim.sub', '', true)");
}

type DncFixture = {
  propertyId: string;
  conversationId: string;
  inboundMessageId: string;
};

async function seedDncFixture(
  initialDispo: string | null = null,
): Promise<DncFixture> {
  const contactId = crypto.randomUUID();
  const propertyId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const inboundMessageId = crypto.randomUUID();

  await pg.query(
    `insert into public.contacts (id, org_id, first_name, last_name)
     values ($1, $2, 'DNC Fixture', 'Contact')`,
    [contactId, TEST_ORG_ID],
  );
  await pg.query(
    `insert into public.properties (
       id, org_id, address, state, status, homeowner_contact_id, outreach_dispo
     ) values ($1, $2, $3, 'MO', 'new_lead', $4, $5)`,
    [
      propertyId,
      TEST_ORG_ID,
      `DNC fixture ${crypto.randomUUID()}`,
      contactId,
      initialDispo,
    ],
  );
  await pg.query(
    `insert into public.message_threads (
       org_id, channel, contact_id, property_id, conversation_id
     ) values ($1, 'sms', $2, $3, $4)`,
    [TEST_ORG_ID, contactId, propertyId, conversationId],
  );
  await pg.query(
    `insert into public.messages (
       id, org_id, channel, direction, status, property_id, contact_id,
       conversation_id, from_address, to_address, body
     ) values (
       $1, $2, 'sms', 'inbound', 'received', $3, $4, $5,
       '+18165550111', '+18165550222', 'I will sue you, stop texting me'
     )`,
    [inboundMessageId, TEST_ORG_ID, propertyId, contactId, conversationId],
  );

  return { propertyId, conversationId, inboundMessageId };
}

async function proposeJevDnc(
  fixture: DncFixture,
  reason = "Jev classified: dnc",
): Promise<Record<string, unknown>> {
  await setRequestRole("service_role");
  const result = await pg.query<{ result: Record<string, unknown> }>(
    `select public.fn_propose_ai_dnc_suppression_review(
       $1, $2, $3, $4
     ) as result`,
    [fixture.propertyId, fixture.conversationId, fixture.inboundMessageId, reason],
  );
  await resetRequestRole();
  return result.rows[0].result;
}

async function confirmReview(
  reviewId: string,
  userId = ownerUserId,
): Promise<Record<string, unknown>> {
  await setRequestRole("authenticated", userId);
  const result = await pg.query<{ result: Record<string, unknown> }>(
    `select public.fn_confirm_ai_disposition_review($1) as result`,
    [reviewId],
  );
  await resetRequestRole();
  return result.rows[0].result;
}

async function getProperty(
  propertyId: string,
): Promise<{ outreach_dispo: string | null; needs_human_attention: boolean }> {
  const result = await pg.query<{
    outreach_dispo: string | null;
    needs_human_attention: boolean;
  }>(
    `select outreach_dispo, needs_human_attention from public.properties where id = $1`,
    [propertyId],
  );
  return result.rows[0];
}

async function getReview(
  reviewId: string,
): Promise<{
  status: string;
  dispo_applied: boolean;
  disposition: string;
  superseded_reason: string | null;
}> {
  const result = await pg.query(
    `select status, dispo_applied, disposition, superseded_reason
     from public.ai_disposition_reviews where id = $1`,
    [reviewId],
  );
  return result.rows[0];
}

beforeAll(async () => {
  pg = new Client({ connectionString: testDbUrl() });
  await pg.connect();

  const schema = await pg.query<{ exists: boolean }>(
    "select to_regclass('public.sms_classification_runs') is not null as exists",
  );
  if (!schema.rows[0].exists) {
    await pg.query(migrationSql);
  }

  await pg.query("insert into public.organizations (id, name) values ($1, $2)", [
    TEST_ORG_ID,
    `DNC integration test org ${TEST_ORG_ID}`,
  ]);

  const { data: created, error } = await serviceClient.auth.admin.createUser({
    email: `dnc-integration-${crypto.randomUUID()}@bmhgroupkc.com`,
    password: crypto.randomUUID(),
    email_confirm: true,
  });
  if (error || !created.user) {
    throw new Error(`test user create failed: ${error?.message ?? "no user"}`);
  }
  ownerUserId = created.user.id;
  // Insert as 'owner' directly — satisfies FINAL_OWNER_GUARD, which a
  // fresh org's first membership insert otherwise trips.
  await pg.query(
    `insert into public.memberships (user_id, org_id, role) values ($1, $2, 'owner')`,
    [ownerUserId, TEST_ORG_ID],
  );

  await pg.query("begin");
});

beforeEach(async () => {
  await resetRequestRole();
  await pg.query("savepoint jev_dnc_case");
});

afterEach(async () => {
  await pg.query("rollback to savepoint jev_dnc_case");
  await pg.query("release savepoint jev_dnc_case");
});

afterAll(async () => {
  await pg.query("rollback");
  await pg.end();
  if (ownerUserId) {
    await serviceClient.auth.admin.deleteUser(ownerUserId);
  }
});

describe("fn_propose_ai_dnc_suppression_review", () => {
  it("creates a pending review with dispo_applied=false and does NOT write outreach_dispo", async () => {
    const fixture = await seedDncFixture();
    const result = await proposeJevDnc(fixture);
    expect(result.status).toBe("proposed");

    const review = await getReview(result.reviewId as string);
    expect(review.status).toBe("pending");
    expect(review.dispo_applied).toBe(false);
    expect(review.disposition).toBe("dnc");

    const property = await getProperty(fixture.propertyId);
    // The entire point of Option B: suppression is a separate,
    // application-side call (applyPhoneLevelOptOut / consent_events),
    // not this RPC's job. This RPC must never touch outreach_dispo.
    expect(property.outreach_dispo).toBeNull();
    expect(property.needs_human_attention).toBe(true);
  });

  it("replays idempotently on a retry with the same inbound message", async () => {
    const fixture = await seedDncFixture();
    const first = await proposeJevDnc(fixture);
    const second = await proposeJevDnc(fixture);
    expect(second.status).toBe("replayed");
    expect(second.reviewId).toBe(first.reviewId);
  });

  it("returns already_terminal when the property is already dnc", async () => {
    const fixture = await seedDncFixture("dnc");
    const result = await proposeJevDnc(fixture);
    expect(result.status).toBe("already_terminal");
  });

  it("supersedes an existing pending review for the same conversation", async () => {
    const fixture = await seedDncFixture();
    // Seed an unrelated pending review on the same conversation via the
    // legacy apply RPC (a different inbound message, matching how two
    // real classifications on the same thread would race).
    const priorMessageId = crypto.randomUUID();
    await pg.query(
      `insert into public.messages (
         id, org_id, channel, direction, status, property_id, contact_id,
         conversation_id, from_address, to_address, body
       )
       select $1, org_id, 'sms', 'inbound', 'received', property_id, contact_id,
         conversation_id, '+18165550111', '+18165550222', 'earlier message'
       from public.message_threads where conversation_id = $2 limit 1`,
      [priorMessageId, fixture.conversationId],
    );
    await setRequestRole("service_role");
    const priorApply = await pg.query<{ result: Record<string, unknown> }>(
      `select public.fn_apply_ai_disposition_with_review(
         $1, $2, $3, 'not_interested', 'earlier decision'
       ) as result`,
      [fixture.propertyId, fixture.conversationId, priorMessageId],
    );
    await resetRequestRole();
    const priorReviewId = priorApply.rows[0].result.reviewId as string;

    await proposeJevDnc(fixture);

    const priorReview = await getReview(priorReviewId);
    expect(priorReview.status).toBe("superseded");
    expect(priorReview.superseded_reason).toBe("new_ai_decision");
  });
});

describe("fn_confirm_ai_disposition_review — deferred dispo_applied=false branch", () => {
  it("applies the deferred outreach_dispo write at confirm time, without the trigger-collision bug", async () => {
    // Regression test for the exact bug Astra found in PR #645 review:
    // the original ordering (write outreach_dispo, THEN try to mark the
    // review confirmed) let trg_properties_supersede_ai_disposition_reviews
    // supersede the row being confirmed before its own status update
    // landed, which then violated ai_disposition_reviews_resolution_check
    // and rolled back the whole transaction. If that regresses, this
    // assertion fails with a thrown Postgres error, not a soft mismatch.
    const fixture = await seedDncFixture();
    const proposal = await proposeJevDnc(fixture);
    const reviewId = proposal.reviewId as string;

    const confirmResult = await confirmReview(reviewId);
    expect(confirmResult.status).toBe("confirmed");

    const review = await getReview(reviewId);
    expect(review.status).toBe("confirmed");
    expect(review.dispo_applied).toBe(true);

    const property = await getProperty(fixture.propertyId);
    expect(property.outreach_dispo).toBe("dnc");
    expect(property.needs_human_attention).toBe(false);
  });

  it("is retry-safe: confirming twice returns the same confirmed status without erroring", async () => {
    const fixture = await seedDncFixture();
    const proposal = await proposeJevDnc(fixture);
    const reviewId = proposal.reviewId as string;

    await confirmReview(reviewId);
    const second = await confirmReview(reviewId);
    expect(second.status).toBe("confirmed");

    const property = await getProperty(fixture.propertyId);
    expect(property.outreach_dispo).toBe("dnc");
  });

  it("still correctly supersedes a DIFFERENT pending review on the same property during confirm", async () => {
    // Verifies the reorder fix didn't accidentally protect every pending
    // review from the trigger — only the one being confirmed. A second,
    // unrelated pending review on the same property must still be
    // superseded when outreach_dispo changes underneath it.
    const fixture = await seedDncFixture();

    // Seed an unrelated pending review on a SEPARATE conversation for
    // the same property FIRST (message_threads is unique per (channel,
    // contact_id, property_id), so a genuinely separate thread needs a
    // second contact — e.g. a co-owner, same as production). Must come
    // before the DNC proposal below: fn_apply_ai_disposition_with_review
    // short-circuits to already_terminal once needs_human_attention is
    // true, which the DNC proposal sets.
    const otherContactId = crypto.randomUUID();
    const otherConversationId = crypto.randomUUID();
    const otherMessageId = crypto.randomUUID();
    await pg.query(
      `insert into public.contacts (id, org_id, first_name, last_name)
       values ($1, $2, 'Co-owner', 'Fixture')`,
      [otherContactId, TEST_ORG_ID],
    );
    await pg.query(
      `insert into public.message_threads (
         org_id, channel, contact_id, property_id, conversation_id
       )
       select org_id, 'sms', $2, id, $3
       from public.properties where id = $1`,
      [fixture.propertyId, otherContactId, otherConversationId],
    );
    await pg.query(
      `insert into public.messages (
         id, org_id, channel, direction, status, property_id, contact_id,
         conversation_id, from_address, to_address, body
       )
       select $1, org_id, 'sms', 'inbound', 'received', id, $2,
         $3, '+18165550111', '+18165550333', 'different conversation'
       from public.properties where id = $4`,
      [otherMessageId, otherContactId, otherConversationId, fixture.propertyId],
    );
    await setRequestRole("service_role");
    const otherApply = await pg.query<{ result: Record<string, unknown> }>(
      `select public.fn_apply_ai_disposition_with_review(
         $1, $2, $3, 'wrong_number', 'unrelated decision'
       ) as result`,
      [fixture.propertyId, otherConversationId, otherMessageId],
    );
    await resetRequestRole();
    const otherReviewId = otherApply.rows[0].result.reviewId as string;
    expect((await getReview(otherReviewId)).status).toBe("pending");

    // Now propose DNC on the main fixture's (different) conversation.
    // Its own conversation-scoped supersede logic must NOT touch the
    // other conversation's review — only confirming it should, via the
    // shared property-level trigger.
    const proposal = await proposeJevDnc(fixture);
    const reviewId = proposal.reviewId as string;
    expect((await getReview(otherReviewId)).status).toBe("pending");

    await confirmReview(reviewId);

    const otherReview = await getReview(otherReviewId);
    expect(otherReview.status).toBe("superseded");
    expect(otherReview.superseded_reason).toBe("property_outcome_changed");

    const confirmedReview = await getReview(reviewId);
    expect(confirmedReview.status).toBe("confirmed");
  });

  it("supersedes the deferred review if the property changed before confirmation", async () => {
    const fixture = await seedDncFixture();
    const proposal = await proposeJevDnc(fixture);
    const reviewId = proposal.reviewId as string;

    // Something else writes outreach_dispo before the human confirms —
    // e.g. a manual operator override.
    await pg.query(
      `update public.properties set outreach_dispo = 'wrong_number' where id = $1`,
      [fixture.propertyId],
    );

    const result = await confirmReview(reviewId);
    expect(result.status).toBe("superseded");

    const review = await getReview(reviewId);
    expect(review.status).toBe("superseded");
    expect(review.dispo_applied).toBe(false); // never got applied
  });
});
