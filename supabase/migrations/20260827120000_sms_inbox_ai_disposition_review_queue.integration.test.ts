import { readFileSync } from "node:fs";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { loadTestEnv } from "@tests/integration/env";
import {
  BMH_ORG_ID,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

const serviceClient = createTestClient();
const foundationSql = readFileSync(
  "supabase/migrations/20260827110000_ai_disposition_reviews.sql",
  "utf8",
)
  .replace(/\nbegin;\s*/i, "\n")
  .replace(/\s*commit;\s*$/i, "");
const inboxSql = readFileSync(
  "supabase/migrations/20260827120000_sms_inbox_ai_disposition_review_queue.sql",
  "utf8",
);

type SnapshotRow = {
  thread_id: string;
  contact_name: string | null;
  is_opted_out: boolean;
  is_test_traffic: boolean;
  ai_disposition_review_id: string | null;
  ai_disposition_review_status: string | null;
  ai_disposition_review_disposition: string | null;
  ai_disposition_review_reason: string | null;
  ai_disposition_review_created_at: string | null;
  ai_disposition_review_source_inbound_message_id: string | null;
};

type Snapshot = {
  rows: SnapshotRow[];
  counts: { all: number; dispo: number };
  total: number;
  hidden_count: number;
};

let pg: Client;
let viewerId = "";

function testDbUrl(): string {
  const env = loadTestEnv();
  const value = process.env.TEST_SUPABASE_DB_URL ?? env.TEST_SUPABASE_DB_URL;
  if (!value) throw new Error("Missing TEST_SUPABASE_DB_URL");
  return value;
}

async function seedThread(options: {
  label: string;
  ageDays?: number;
  dnc?: boolean;
  testTraffic?: boolean;
  reviewStatus?: "pending" | "confirmed" | null;
  disposition?: "not_interested" | "dnc";
}): Promise<{
  conversationId: string;
  messageId: string;
  reviewId: string | null;
}> {
  const contactId = crypto.randomUUID();
  const propertyId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const reviewId = options.reviewStatus ? crypto.randomUUID() : null;
  const createdAt = new Date(
    Date.now() - (options.ageDays ?? 0) * 24 * 60 * 60 * 1_000,
  ).toISOString();

  await pg.query(
    `insert into public.contacts (
       id, org_id, first_name, last_name, do_not_contact
     ) values ($1, $2, $3, 'Queue', $4)`,
    [contactId, BMH_ORG_ID, options.label, options.dnc ?? false],
  );
  await pg.query(
    `insert into public.properties (
       id, org_id, address, state, status, homeowner_contact_id, outreach_dispo
     ) values ($1, $2, $3, 'MO', 'contacted', $4, $5)`,
    [
      propertyId,
      BMH_ORG_ID,
      options.testTraffic ? `Jitter ${options.label}` : `${options.label} Ln`,
      contactId,
      options.reviewStatus || options.label === "Historical"
        ? (options.disposition ?? "not_interested")
        : null,
    ],
  );
  await pg.query(
    `insert into public.message_threads (
       org_id, channel, contact_id, property_id, conversation_id
     ) values ($1, 'sms', $2, $3, $4)`,
    [BMH_ORG_ID, contactId, propertyId, conversationId],
  );
  await pg.query(
    `insert into public.messages (
       id, org_id, channel, direction, status, property_id, contact_id,
       conversation_id, from_address, to_address, body, created_at
     ) values (
       $1, $2, 'sms', 'inbound', 'received', $3, $4, $5,
       '+18165550101', '+18162804181', $6, $7
     )`,
    [
      messageId,
      BMH_ORG_ID,
      propertyId,
      contactId,
      conversationId,
      `${options.label} inbox fixture`,
      createdAt,
    ],
  );

  if (reviewId && options.reviewStatus) {
    await pg.query(
      `insert into public.ai_disposition_reviews (
         id, org_id, property_id, conversation_id,
         source_inbound_message_id, disposition, ai_reason, status,
         created_at, resolved_at, reviewed_by
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         case when $8 = 'confirmed' then now() else null end,
         case when $8 = 'confirmed' then $10::uuid else null end
       )`,
      [
        reviewId,
        BMH_ORG_ID,
        propertyId,
        conversationId,
        messageId,
        options.disposition ?? "not_interested",
        `AI reason for ${options.label}`,
        options.reviewStatus,
        createdAt,
        viewerId,
      ],
    );
  }

  return { conversationId, messageId, reviewId };
}

async function snapshot(filter: "all" | "dispo", hideNoise: boolean) {
  await pg.query("set local role authenticated");
  await pg.query(
    "select set_config('request.jwt.claim.role', 'authenticated', true)",
  );
  await pg.query("select set_config('request.jwt.claim.sub', $1, true)", [
    viewerId,
  ]);
  const result = await pg.query<{ value: Snapshot }>(
    `select public.sms_inbox_thread_page_snapshot(
       now() - interval '90 days', $1, null, null, $2, 200, 0
     ) as value`,
    [filter, hideNoise],
  );
  await pg.query("reset role");
  return result.rows[0]!.value;
}

beforeAll(async () => {
  await resetTenantTables(serviceClient);
  await seedTwoOrgs(serviceClient);

  const email = `inbox-ai-review-${crypto.randomUUID()}@example.com`;
  const { data, error } = await serviceClient.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("missing auth user");
  viewerId = data.user.id;
  const { error: membershipError } = await serviceClient
    .from("memberships")
    .insert({
      user_id: viewerId,
      org_id: BMH_ORG_ID,
      role: "member",
    });
  if (membershipError) throw membershipError;

  pg = new Client({ connectionString: testDbUrl() });
  await pg.connect();
  await pg.query("begin");
  const schema = await pg.query<{ exists: boolean }>(
    "select to_regclass('public.ai_disposition_reviews') is not null as exists",
  );
  if (!schema.rows[0]!.exists) await pg.query(foundationSql);
  await pg.query(inboxSql);
});

afterAll(async () => {
  if (pg) {
    await pg.query("rollback").catch(() => {});
    await pg.end();
  }
  if (viewerId) {
    await serviceClient.auth.admin.deleteUser(viewerId).catch(() => {});
  }
});

describe("Sandra Dispo inbox queue migration", () => {
  it("returns only current AI reviews while preserving recency and noise boundaries", async () => {
    const pending = await seedThread({
      label: "Pending",
      reviewStatus: "pending",
    });
    const oldDnc = await seedThread({
      label: "Old DNC",
      ageDays: 120,
      dnc: true,
      reviewStatus: "pending",
      disposition: "dnc",
    });
    const testTraffic = await seedThread({
      label: "Test",
      testTraffic: true,
      reviewStatus: "pending",
    });
    const historical = await seedThread({
      label: "Historical",
      reviewStatus: null,
    });
    const confirmed = await seedThread({
      label: "Confirmed",
      reviewStatus: "confirmed",
    });

    const all = await snapshot("all", true);
    expect(all.rows.map((row) => row.thread_id)).toEqual(
      expect.arrayContaining([
        pending.conversationId,
        historical.conversationId,
        confirmed.conversationId,
      ]),
    );
    expect(all.rows.map((row) => row.thread_id)).not.toContain(
      oldDnc.conversationId,
    );
    expect(all.rows.map((row) => row.thread_id)).not.toContain(
      testTraffic.conversationId,
    );
    expect(all.counts).toMatchObject({ all: 3, dispo: 2 });

    const dispo = await snapshot("dispo", true);
    expect(dispo.total).toBe(2);
    expect(dispo.counts.dispo).toBe(dispo.total);
    expect(dispo.rows.map((row) => row.thread_id)).toEqual(
      expect.arrayContaining([pending.conversationId, oldDnc.conversationId]),
    );
    expect(dispo.rows.map((row) => row.thread_id)).not.toContain(
      testTraffic.conversationId,
    );
    expect(dispo.rows.map((row) => row.thread_id)).not.toContain(
      historical.conversationId,
    );
    expect(dispo.rows.map((row) => row.thread_id)).not.toContain(
      confirmed.conversationId,
    );

    const oldDncRow = dispo.rows.find(
      (row) => row.thread_id === oldDnc.conversationId,
    );
    expect(oldDncRow).toMatchObject({
      is_opted_out: true,
      is_test_traffic: false,
      ai_disposition_review_id: oldDnc.reviewId,
      ai_disposition_review_status: "pending",
      ai_disposition_review_disposition: "dnc",
      ai_disposition_review_reason: "AI reason for Old DNC",
      ai_disposition_review_source_inbound_message_id: oldDnc.messageId,
    });
    expect(oldDncRow?.ai_disposition_review_created_at).toBeTruthy();

    const withNoiseRequested = await snapshot("dispo", false);
    expect(withNoiseRequested.rows.map((row) => row.thread_id)).not.toContain(
      testTraffic.conversationId,
    );
    expect(withNoiseRequested.counts.dispo).toBe(withNoiseRequested.total);
  });
});
