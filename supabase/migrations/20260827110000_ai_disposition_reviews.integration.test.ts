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
import {
  BMH_ORG_ID,
  TEST_ORG_B_ID,
  createOrgUser,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

const serviceClient = createTestClient();
const migrationSql = readFileSync(
  "supabase/migrations/20260827110000_ai_disposition_reviews.sql",
  "utf8",
)
  .replace(/\nbegin;\s*/i, "\n")
  .replace(/\s*commit;\s*$/i, "");

let pg: Client;
let sameOrgUserId = "";
let outsiderUserId = "";
let schemaWasCommitted = false;

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
  await pg.query("select set_config('request.jwt.claim.role', $1, true)", [role]);
  await pg.query("select set_config('request.jwt.claim.sub', $1, true)", [
    userId ?? "",
  ]);
}

async function resetRequestRole(): Promise<void> {
  await pg.query("reset role");
  await pg.query("select set_config('request.jwt.claim.role', '', true)");
  await pg.query("select set_config('request.jwt.claim.sub', '', true)");
}

async function expectDatabaseError(
  operation: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  await pg.query("savepoint expected_database_error");
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  await pg.query("rollback to savepoint expected_database_error");
  await pg.query("release savepoint expected_database_error");
  expect(caught).toBeDefined();
  expect(caught).toMatchObject({ message: expect.stringMatching(pattern) });
}

type AiFixture = {
  propertyId: string;
  conversationId: string;
  inboundMessageId: string;
};

async function seedAiFixture(
  initialDisposition: string | null = null,
): Promise<AiFixture> {
  return seedAiFixtureWithClient(pg, initialDisposition);
}

async function seedAiFixtureWithClient(
  client: Client,
  initialDisposition: string | null = null,
): Promise<AiFixture> {
  const contactId = crypto.randomUUID();
  const propertyId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const inboundMessageId = crypto.randomUUID();

  await client.query(
    `insert into public.contacts (id, org_id, first_name, last_name)
     values ($1, $2, 'AI Review', 'Fixture')`,
    [contactId, BMH_ORG_ID],
  );
  await client.query(
    `insert into public.properties (
       id, org_id, address, state, status, homeowner_contact_id, outreach_dispo
     ) values ($1, $2, $3, 'MO', 'new_lead', $4, $5)`,
    [
      propertyId,
      BMH_ORG_ID,
      `AI review ${crypto.randomUUID()}`,
      contactId,
      initialDisposition,
    ],
  );
  await client.query(
    `insert into public.message_threads (
       org_id, channel, contact_id, property_id, conversation_id
     ) values ($1, 'sms', $2, $3, $4)`,
    [BMH_ORG_ID, contactId, propertyId, conversationId],
  );
  await client.query(
    `insert into public.messages (
       id, org_id, channel, direction, status, property_id, contact_id,
       conversation_id, from_address, to_address, body
     ) values (
       $1, $2, 'sms', 'inbound', 'received', $3, $4, $5,
       '+18165550111', '+18165550222', 'AI disposition fixture'
     )`,
    [inboundMessageId, BMH_ORG_ID, propertyId, contactId, conversationId],
  );

  return { propertyId, conversationId, inboundMessageId };
}

async function applyAiDisposition(
  fixture: AiFixture,
  disposition = "not_interested",
  reason = "model classified the reply",
): Promise<Record<string, unknown>> {
  await setRequestRole("service_role");
  const result = await pg.query<{ result: Record<string, unknown> }>(
    `select public.fn_apply_ai_disposition_with_review(
       $1, $2, $3, $4, $5
     ) as result`,
    [
      fixture.propertyId,
      fixture.conversationId,
      fixture.inboundMessageId,
      disposition,
      reason,
    ],
  );
  await resetRequestRole();
  return result.rows[0].result;
}

async function setServiceRole(client: Client): Promise<void> {
  await client.query("set local role service_role");
  await client.query(
    "select set_config('request.jwt.claim.role', 'service_role', true)",
  );
  await client.query("select set_config('request.jwt.claim.sub', '', true)");
}

async function applyAiDispositionOnClient(
  client: Client,
  fixture: AiFixture,
): Promise<Record<string, unknown>> {
  const result = await client.query<{ result: Record<string, unknown> }>(
    `select public.fn_apply_ai_disposition_with_review(
       $1, $2, $3, 'not_interested', 'concurrent retry'
     ) as result`,
    [fixture.propertyId, fixture.conversationId, fixture.inboundMessageId],
  );
  return result.rows[0].result;
}

async function waitUntilBlockedOnLock(
  observer: Client,
  blockedPid: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await observer.query<{
      wait_event_type: string | null;
    }>(
      `select wait_event_type
       from pg_catalog.pg_stat_activity
       where pid = $1`,
      [blockedPid],
    );
    if (state.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("concurrent replay did not block on the property lock");
}

async function cleanupCommittedFixture(
  client: Client,
  fixture: AiFixture,
): Promise<void> {
  await client.query("begin");
  try {
    await client.query("delete from public.lead_events where property_id = $1", [
      fixture.propertyId,
    ]);
    await client.query(
      "delete from public.ai_disposition_reviews where property_id = $1",
      [fixture.propertyId],
    );
    await client.query("delete from public.messages where property_id = $1", [
      fixture.propertyId,
    ]);
    await client.query(
      "delete from public.message_threads where property_id = $1",
      [fixture.propertyId],
    );
    const contact = await client.query<{ homeowner_contact_id: string | null }>(
      "select homeowner_contact_id from public.properties where id = $1",
      [fixture.propertyId],
    );
    await client.query("delete from public.properties where id = $1", [
      fixture.propertyId,
    ]);
    if (contact.rows[0]?.homeowner_contact_id) {
      await client.query("delete from public.contacts where id = $1", [
        contact.rows[0].homeowner_contact_id,
      ]);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

beforeAll(async () => {
  await resetTenantTables(serviceClient);
  await seedTwoOrgs(serviceClient);

  const sameOrgUser = await createOrgUser(serviceClient, {
    orgId: BMH_ORG_ID,
    email: `ai-dispo-review-same-${crypto.randomUUID()}@bmhgroupkc.com`,
    role: "member",
  });
  sameOrgUserId = sameOrgUser.userId;
  const outsider = await createOrgUser(serviceClient, {
    orgId: TEST_ORG_B_ID,
    email: `ai-dispo-review-other-${crypto.randomUUID()}@bmhgroupkc.com`,
    role: "member",
  });
  outsiderUserId = outsider.userId;

  pg = new Client({ connectionString: testDbUrl() });
  await pg.connect();
  const schema = await pg.query<{ exists: boolean }>(
    "select to_regclass('public.ai_disposition_reviews') is not null as exists",
  );
  schemaWasCommitted = schema.rows[0].exists;
  await pg.query("begin");
  if (!schemaWasCommitted) {
    await pg.query(migrationSql);
  }
});

beforeEach(async () => {
  await resetRequestRole();
  await pg.query("savepoint ai_disposition_review_case");
});

afterEach(async () => {
  await pg.query("rollback to savepoint ai_disposition_review_case");
  await pg.query("release savepoint ai_disposition_review_case");
});

afterAll(async () => {
  if (pg) {
    await pg.query("rollback");
    await pg.end();
  }
  await serviceClient.auth.admin.deleteUser(sameOrgUserId);
  await serviceClient.auth.admin.deleteUser(outsiderUserId);
  await resetTenantTables(serviceClient);
});

describe("Migration 20260827110000 — AI disposition reviews", () => {
  it("applies the outcome, pending review, and audit event atomically", async () => {
    const fixture = await seedAiFixture();

    const result = await applyAiDisposition(
      fixture,
      "not_interested",
      "  model classified the reply  ",
    );
    expect(result).toMatchObject({ status: "applied", reviewStatus: "pending" });

    const property = await pg.query<{ outreach_dispo: string | null }>(
      "select outreach_dispo from public.properties where id = $1",
      [fixture.propertyId],
    );
    expect(property.rows[0].outreach_dispo).toBe("not_interested");

    const reviews = await pg.query<{
      id: string;
      status: string;
      disposition: string;
      ai_reason: string;
    }>(
      `select id, status, disposition, ai_reason
       from public.ai_disposition_reviews
       where source_inbound_message_id = $1`,
      [fixture.inboundMessageId],
    );
    expect(reviews.rows).toEqual([
      expect.objectContaining({
        id: result.reviewId,
        status: "pending",
        disposition: "not_interested",
        ai_reason: "model classified the reply",
      }),
    ]);

    const events = await pg.query<{
      actor_type: string;
      event_type: string;
      source_id: string;
    }>(
      `select actor_type, event_type, source_id
       from public.lead_events
       where property_id = $1 and event_type = 'dispo_set'`,
      [fixture.propertyId],
    );
    expect(events.rows).toEqual([
      {
        actor_type: "ai",
        event_type: "dispo_set",
        source_id: result.reviewId,
      },
    ]);
  });

  it("rolls back every write when the inbound identity is invalid", async () => {
    const fixture = await seedAiFixture();

    await expectDatabaseError(async () => {
      await setRequestRole("service_role");
      await pg.query(
        `select public.fn_apply_ai_disposition_with_review(
           $1, $2, $3, 'not_interested', 'mismatched thread'
         )`,
        [fixture.propertyId, crypto.randomUUID(), fixture.inboundMessageId],
      );
    }, /inbound SMS does not match property\/conversation/i);

    const property = await pg.query<{ outreach_dispo: string | null }>(
      "select outreach_dispo from public.properties where id = $1",
      [fixture.propertyId],
    );
    const reviews = await pg.query<{ count: string }>(
      "select count(*)::text as count from public.ai_disposition_reviews",
    );
    const events = await pg.query<{ count: string }>(
      `select count(*)::text as count from public.lead_events
       where property_id = $1 and event_type = 'dispo_set'`,
      [fixture.propertyId],
    );
    expect(property.rows[0].outreach_dispo).toBeNull();
    expect(reviews.rows[0].count).toBe("0");
    expect(events.rows[0].count).toBe("0");
  });

  it("replays the source message without duplicating or changing the first decision", async () => {
    const fixture = await seedAiFixture();
    const first = await applyAiDisposition(fixture, "not_interested", "first");
    const replay = await applyAiDisposition(fixture, "dnc", "retry drift");

    expect(replay).toEqual({
      status: "replayed",
      reviewId: first.reviewId,
      reviewStatus: "pending",
    });
    const property = await pg.query<{ outreach_dispo: string | null }>(
      "select outreach_dispo from public.properties where id = $1",
      [fixture.propertyId],
    );
    const counts = await pg.query<{ reviews: string; events: string }>(
      `select
         (select count(*) from public.ai_disposition_reviews
          where source_inbound_message_id = $1)::text as reviews,
         (select count(*) from public.lead_events
          where property_id = $2 and event_type = 'dispo_set')::text as events`,
      [fixture.inboundMessageId, fixture.propertyId],
    );
    expect(property.rows[0].outreach_dispo).toBe("not_interested");
    expect(counts.rows[0]).toEqual({ reviews: "1", events: "1" });
  });

  it("serializes simultaneous same-source applies into one applied result and one replay", async () => {
    // Before the migration is installed, this file rehearses its DDL inside
    // pg's rollback-only transaction. PostgreSQL intentionally hides that
    // uncommitted function/table from a second session, so true two-session
    // coverage becomes available only after the normal migration step has
    // committed the schema. Keep a structural assertion in the rehearsal
    // lane so moving the replay check back above the property lock still
    // fails before deployment; normal post-migration CI executes the full
    // contention test below.
    if (!schemaWasCommitted) {
      const propertyLock = migrationSql.indexOf(
        "select p.org_id, p.outreach_dispo, p.needs_human_attention",
      );
      const replayRecheck = migrationSql.indexOf(
        "where review.source_inbound_message_id = p_source_inbound_message_id",
      );
      expect(propertyLock).toBeGreaterThan(-1);
      expect(replayRecheck).toBeGreaterThan(propertyLock);
      return;
    }

    const observer = new Client({ connectionString: testDbUrl() });
    const first = new Client({ connectionString: testDbUrl() });
    const second = new Client({ connectionString: testDbUrl() });
    let fixture: AiFixture | null = null;

    await Promise.all([observer.connect(), first.connect(), second.connect()]);
    try {
      await observer.query("begin");
      fixture = await seedAiFixtureWithClient(observer);
      await observer.query("commit");

      await first.query("begin");
      await first.query(
        "select id from public.properties where id = $1 for update",
        [fixture.propertyId],
      );
      await setServiceRole(first);

      await second.query("begin");
      await setServiceRole(second);
      const secondPid = await second.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      const secondApply = applyAiDispositionOnClient(second, fixture);
      await waitUntilBlockedOnLock(observer, secondPid.rows[0].pid);

      const firstResult = await applyAiDispositionOnClient(first, fixture);
      await first.query("commit");
      const secondResult = await secondApply;
      await second.query("commit");

      expect(firstResult).toMatchObject({
        status: "applied",
        reviewStatus: "pending",
      });
      expect(secondResult).toEqual({
        status: "replayed",
        reviewId: firstResult.reviewId,
        reviewStatus: "pending",
      });

      const counts = await observer.query<{ reviews: string; events: string }>(
        `select
           (select count(*) from public.ai_disposition_reviews
            where source_inbound_message_id = $1)::text as reviews,
           (select count(*) from public.lead_events
            where property_id = $2 and event_type = 'dispo_set')::text as events`,
        [fixture.inboundMessageId, fixture.propertyId],
      );
      expect(counts.rows[0]).toEqual({ reviews: "1", events: "1" });
    } finally {
      await first.query("rollback").catch(() => undefined);
      await second.query("rollback").catch(() => undefined);
      await observer.query("rollback").catch(() => undefined);
      if (fixture) {
        await cleanupCommittedFixture(observer, fixture);
      }
      await Promise.all([
        observer.end().catch(() => undefined),
        first.end().catch(() => undefined),
        second.end().catch(() => undefined),
      ]);
    }
  });

  it("allows only an active same-org user to see and confirm a pending review", async () => {
    const fixture = await seedAiFixture();
    const applied = await applyAiDisposition(fixture, "wrong_number", "wrong person");

    await setRequestRole("authenticated", outsiderUserId);
    const outsiderRows = await pg.query<{ id: string }>(
      "select id from public.ai_disposition_reviews where id = $1",
      [applied.reviewId],
    );
    expect(outsiderRows.rows).toHaveLength(0);
    await resetRequestRole();

    await expectDatabaseError(async () => {
      await setRequestRole("authenticated", outsiderUserId);
      await pg.query("select public.fn_confirm_ai_disposition_review($1)", [
        applied.reviewId,
      ]);
    }, /active organization access required/i);

    await setRequestRole("authenticated", sameOrgUserId);
    const confirmed = await pg.query<{ result: Record<string, unknown> }>(
      "select public.fn_confirm_ai_disposition_review($1) as result",
      [applied.reviewId],
    );
    await resetRequestRole();
    expect(confirmed.rows[0].result).toEqual({
      status: "confirmed",
      reviewId: applied.reviewId,
    });

    const state = await pg.query<{
      status: string;
      reviewed_by: string | null;
      outreach_dispo: string | null;
    }>(
      `select review.status, review.reviewed_by, property.outreach_dispo
       from public.ai_disposition_reviews review
       join public.properties property on property.id = review.property_id
       where review.id = $1`,
      [applied.reviewId],
    );
    expect(state.rows[0]).toEqual({
      status: "confirmed",
      reviewed_by: sameOrgUserId,
      outreach_dispo: "wrong_number",
    });

    const events = await pg.query<{ count: string; actor_id: string | null }>(
      `select count(*)::text as count, max(actor_id::text) as actor_id
       from public.lead_events
       where source_type = 'ai_disposition_reviews.confirmed'
         and source_id = $1`,
      [applied.reviewId],
    );
    expect(events.rows[0]).toEqual({ count: "1", actor_id: sameOrgUserId });
  });

  it("supersedes a pending review when another writer changes the property outcome", async () => {
    const fixture = await seedAiFixture();
    const applied = await applyAiDisposition(fixture, "not_interested", "not selling");

    await pg.query(
      "update public.properties set outreach_dispo = 'callback_requested' where id = $1",
      [fixture.propertyId],
    );

    const state = await pg.query<{
      status: string;
      superseded_reason: string | null;
      resolved: boolean;
    }>(
      `select status, superseded_reason, resolved_at is not null as resolved
       from public.ai_disposition_reviews where id = $1`,
      [applied.reviewId],
    );
    expect(state.rows[0]).toEqual({
      status: "superseded",
      superseded_reason: "property_outcome_changed",
      resolved: true,
    });

    const events = await pg.query<{ count: string }>(
      `select count(*)::text as count from public.lead_events
       where source_type = 'ai_disposition_reviews.superseded'
         and source_id = $1`,
      [applied.reviewId],
    );
    expect(events.rows[0].count).toBe("1");
  });

  it("does not allow direct review workflow writes by API roles", async () => {
    const fixture = await seedAiFixture();

    await expectDatabaseError(async () => {
      await setRequestRole("service_role");
      await pg.query(
        `insert into public.ai_disposition_reviews (
           org_id, property_id, conversation_id, source_inbound_message_id,
           disposition, ai_reason
         ) values ($1, $2, $3, $4, 'not_interested', 'direct write')`,
        [
          BMH_ORG_ID,
          fixture.propertyId,
          fixture.conversationId,
          fixture.inboundMessageId,
        ],
      );
    }, /permission denied/i);

    const privileges = await pg.query<{
      authenticated_select: boolean;
      authenticated_insert: boolean;
      service_select: boolean;
      service_insert: boolean;
      service_apply: boolean;
      authenticated_confirm: boolean;
    }>(
      `select
         has_table_privilege('authenticated', 'public.ai_disposition_reviews', 'select')
           as authenticated_select,
         has_table_privilege('authenticated', 'public.ai_disposition_reviews', 'insert')
           as authenticated_insert,
         has_table_privilege('service_role', 'public.ai_disposition_reviews', 'select')
           as service_select,
         has_table_privilege('service_role', 'public.ai_disposition_reviews', 'insert')
           as service_insert,
         has_function_privilege(
           'service_role',
           'public.fn_apply_ai_disposition_with_review(uuid,uuid,uuid,text,text)',
           'execute'
         ) as service_apply,
         has_function_privilege(
           'authenticated',
           'public.fn_confirm_ai_disposition_review(uuid)',
           'execute'
         ) as authenticated_confirm`,
    );
    expect(privileges.rows[0]).toEqual({
      authenticated_select: true,
      authenticated_insert: false,
      service_select: true,
      service_insert: false,
      service_apply: true,
      authenticated_confirm: true,
    });
  });

});
