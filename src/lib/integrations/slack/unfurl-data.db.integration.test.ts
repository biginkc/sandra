import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertLocalOnlyEnvironment } from "@/lib/testing/local-only-guard";
import type { Database } from "@/lib/supabase/types";

import { loadPreviewData } from "./unfurl-data";

/**
 * This suite deliberately targets only the runner-owned loopback stack. It
 * inserts synthetic rows directly through local Postgres, then reads them
 * through the same Supabase REST client used by the unfurl worker. It never
 * resets or migrates the shared stack.
 */
assertLocalOnlyEnvironment();

type Fixture = {
  orgId: string;
  foreignOrgId: string;
  ownerId: string;
  anchorOwnerId: string;
  foreignOwnerId: string;
  contactId: string;
  foreignContactId: string;
  propertyId: string;
  siblingPropertyId: string;
  deletedPropertyId: string;
  foreignPropertyId: string;
  tieLowMessageId: string;
  tieHighMessageId: string;
  failedMessageId: string;
  oldSuccessfulMessageId: string;
  siblingMessageId: string;
  pendingReviewId: string;
  latestAttemptId: string;
  pendingAttemptId: string;
  reachedAttemptId: string;
  conversationId: string;
  messageIds: string[];
  attemptIds: string[];
};

const localDbUrl = process.env.TEST_SUPABASE_DB_URL!;
const localApiUrl = process.env.TEST_SUPABASE_URL!;
const serviceKey = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY!;

const fixture: Fixture = {
  orgId: randomUUID(),
  foreignOrgId: randomUUID(),
  ownerId: randomUUID(),
  anchorOwnerId: randomUUID(),
  foreignOwnerId: randomUUID(),
  contactId: randomUUID(),
  foreignContactId: randomUUID(),
  propertyId: randomUUID(),
  siblingPropertyId: randomUUID(),
  deletedPropertyId: randomUUID(),
  foreignPropertyId: randomUUID(),
  tieLowMessageId: `11111111-1111-4111-8111-${randomUUID().slice(-12)}`,
  tieHighMessageId: `eeeeeeee-eeee-4eee-8eee-${randomUUID().slice(-12)}`,
  failedMessageId: randomUUID(),
  oldSuccessfulMessageId: randomUUID(),
  siblingMessageId: randomUUID(),
  pendingReviewId: randomUUID(),
  latestAttemptId: randomUUID(),
  pendingAttemptId: randomUUID(),
  reachedAttemptId: randomUUID(),
  conversationId: randomUUID(),
  messageIds: [],
  attemptIds: [],
};

let pg: Client;
let service: SupabaseClient<Database>;

type AttemptQuery = {
  select(columns: string): AttemptQuery;
  eq(column: string, value: string): AttemptQuery;
  order(column: string, options: { ascending: boolean }): AttemptQuery;
  limit(count: number): AttemptQuery;
  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: null }>;
};

function sqlAttemptQuery(): AttemptQuery {
  const equals: Record<string, string> = {};
  let columns = "id, occurred_at, outcome";
  let limit = 1;
  const builder: AttemptQuery = {
    select(nextColumns) {
      columns = nextColumns;
      return builder;
    },
    eq(column, value) {
      equals[column] = value;
      return builder;
    },
    order() {
      return builder;
    },
    limit(nextLimit) {
      limit = nextLimit;
      return builder;
    },
    async maybeSingle() {
      const result = await pg.query(
        `select ${columns}
           from public.acquisition_attempts
          where org_id = $1 and property_id = $2
            and ($3::text is null or attempt_kind = $3)
            and ($4::text is null or outcome = $4)
          order by occurred_at desc, id desc
          limit $5`,
        [
          equals.org_id,
          equals.property_id,
          equals.attempt_kind ?? null,
          equals.outcome ?? null,
          limit,
        ],
      );
      const row = result.rows[0] ?? null;
      if (row && row.occurred_at instanceof Date) {
        row.occurred_at = row.occurred_at.toISOString();
      }
      if (row && row.created_at instanceof Date) {
        row.created_at = row.created_at.toISOString();
      }
      return { data: row, error: null };
    },
  };
  return builder;
}

/**
 * acquisition_attempts intentionally has no service_role REST grant in the
 * current schema. Keep the loader on real PostgREST for every other table and
 * use the direct loopback SQL adapter only for those two authoritative reads.
 */
function loaderClient(): SupabaseClient<Database> {
  return {
    from(table: string) {
      return table === "acquisition_attempts"
        ? sqlAttemptQuery()
        : service.from(table as never);
    },
    auth: service.auth,
  } as unknown as SupabaseClient<Database>;
}

function sqlUuidArray(ids: string[]): string[] {
  return ids;
}

async function seedFixture(): Promise<void> {
  const createdOwner = await service.auth.admin.createUser({
    email: `slack-preview-owner-${fixture.ownerId}@example.test`,
    password: randomUUID(),
    email_confirm: true,
    app_metadata: { display_name: "Synthetic Preview Owner" },
  });
  if (createdOwner.error || !createdOwner.data.user) {
    throw new Error(
      `synthetic owner create failed: ${createdOwner.error?.message ?? "no user"}`,
    );
  }
  fixture.ownerId = createdOwner.data.user.id;

  const createdAnchor = await service.auth.admin.createUser({
    email: `slack-preview-anchor-${fixture.anchorOwnerId}@example.test`,
    password: randomUUID(),
    email_confirm: true,
  });
  if (createdAnchor.error || !createdAnchor.data.user) {
    throw new Error(
      `synthetic anchor create failed: ${createdAnchor.error?.message ?? "no user"}`,
    );
  }
  fixture.anchorOwnerId = createdAnchor.data.user.id;

  const createdForeignOwner = await service.auth.admin.createUser({
    email: `slack-preview-foreign-${fixture.foreignOwnerId}@example.test`,
    password: randomUUID(),
    email_confirm: true,
  });
  if (createdForeignOwner.error || !createdForeignOwner.data.user) {
    throw new Error(
      `synthetic foreign owner create failed: ${createdForeignOwner.error?.message ?? "no user"}`,
    );
  }
  fixture.foreignOwnerId = createdForeignOwner.data.user.id;

  await pg.query("begin");
  try {
    await pg.query(
      `insert into public.organizations (id, name)
       values ($1, $2), ($3, $4)`,
      [
        fixture.orgId,
        `Slack preview test org ${fixture.orgId}`,
        fixture.foreignOrgId,
        `Slack preview foreign org ${fixture.foreignOrgId}`,
      ],
    );

    await pg.query(
      `insert into public.memberships (user_id, org_id, role)
       values
         ($1, $2, 'owner'), ($3, $2, 'owner'),
         ($4, $5, 'owner'), ($1, $5, 'member')`,
      [
        fixture.ownerId,
        fixture.orgId,
        fixture.anchorOwnerId,
        fixture.foreignOwnerId,
        fixture.foreignOrgId,
      ],
    );

    await pg.query(
      `insert into public.contacts (id, org_id, first_name, last_name)
       values ($1, $2, 'Synthetic', 'Homeowner'), ($3, $4, 'Foreign', 'Homeowner')`,
      [
        fixture.contactId,
        fixture.orgId,
        fixture.foreignContactId,
        fixture.foreignOrgId,
      ],
    );

    await pg.query(
      `insert into public.properties
         (id, org_id, address, city, state, status, homeowner_contact_id,
          assigned_user_id, outreach_dispo)
       values
         ($1, $2, '101 Preview Lane', 'Kansas City', 'MO', 'new_lead', $3, $4, 'not_interested'),
         ($5, $2, '102 Sibling Lane', 'Kansas City', 'MO', 'new_lead', $3, $4, null),
         ($6, $7, '999 Foreign Lane', 'St. Louis', 'MO', 'new_lead', $8, $9, null)`,
      [
        fixture.propertyId,
        fixture.orgId,
        fixture.contactId,
        fixture.ownerId,
        fixture.siblingPropertyId,
        fixture.foreignPropertyId,
        fixture.foreignOrgId,
        fixture.foreignContactId,
        fixture.foreignOwnerId,
      ],
    );

    await pg.query(
      `insert into public.properties
         (id, org_id, address, city, state, status, homeowner_contact_id,
          assigned_user_id, deleted_at)
       values ($1, $2, '103 Deleted Lane', 'Kansas City', 'MO', 'new_lead', $3, $4,
          '2026-10-03T11:00:00Z')`,
      [
        fixture.deletedPropertyId,
        fixture.orgId,
        fixture.contactId,
        fixture.ownerId,
      ],
    );

    await pg.query(
      `insert into public.messages
         (id, org_id, channel, direction, property_id, contact_id, body, status, created_at, metadata)
       values
         ($1, $2, 'sms', 'outbound', $3, $4, 'Sent tie', 'sent', '2026-10-03T12:03:00Z', null),
         ($5, $2, 'sms', 'inbound', null, $4, 'Contact-only tie', 'received', '2026-10-03T12:03:00Z', null),
         ($6, $2, 'sms', 'outbound', $3, $4, 'Provider failed', 'bounced', '2026-10-03T12:04:00Z', null),
         ($7, $2, 'sms', 'outbound', $3, $4, 'Older successful', 'delivered', '2026-10-03T12:00:00Z', null),
         ($8, $2, 'sms', 'inbound', $9, $4, 'Other property must stay out', 'received', '2026-10-03T12:10:00Z', null)`,
      [
        fixture.tieLowMessageId,
        fixture.orgId,
        fixture.propertyId,
        fixture.contactId,
        fixture.tieHighMessageId,
        fixture.failedMessageId,
        fixture.oldSuccessfulMessageId,
        fixture.siblingMessageId,
        fixture.siblingPropertyId,
      ],
    );

    await pg.query(
      `insert into public.ai_disposition_reviews
         (id, org_id, property_id, conversation_id, source_inbound_message_id,
          disposition, ai_reason, status)
       values ($1, $2, $3, $4, $5, 'dnc', 'Synthetic pending proposal', 'pending')`,
      [
        fixture.pendingReviewId,
        fixture.orgId,
        fixture.propertyId,
        fixture.conversationId,
        fixture.tieHighMessageId,
      ],
    );

    await pg.query(
      `insert into public.acquisition_attempts
         (id, org_id, property_id, actor_user_id, attempt_kind, source, outcome,
          occurred_at, idempotency_key)
       values ($1, $2, $3, $4, 'outreach', 'manual', 'no_answer',
          '2026-10-03T12:06:00Z', $5)`,
      [
        fixture.latestAttemptId,
        fixture.orgId,
        fixture.propertyId,
        fixture.ownerId,
        randomUUID(),
      ],
    );

    await pg.query(
      `insert into public.acquisition_attempts
         (id, org_id, property_id, actor_user_id, attempt_kind, source, outcome,
          occurred_at, provider_attempt_key, idempotency_key)
       values ($1, $2, $3, $4, 'call', 'sandra', null,
          '2026-10-03T12:07:00Z', $5, $6)`,
      [
        fixture.pendingAttemptId,
        fixture.orgId,
        fixture.propertyId,
        fixture.ownerId,
        `sandra-${fixture.pendingAttemptId}`,
        randomUUID(),
      ],
    );

    fixture.messageIds = [
      fixture.tieLowMessageId,
      fixture.tieHighMessageId,
      fixture.failedMessageId,
      fixture.oldSuccessfulMessageId,
      fixture.siblingMessageId,
    ];
    fixture.attemptIds = [fixture.latestAttemptId, fixture.pendingAttemptId];
    await pg.query("commit");
  } catch (error) {
    await pg.query("rollback");
    throw error;
  }
}

async function cleanupFixture(): Promise<void> {
  let databaseError: unknown = null;
  await pg.query("begin");
  try {
    await pg.query(
      "delete from public.ai_disposition_reviews where id = any($1::uuid[])",
      [[fixture.pendingReviewId]],
    );
    await pg.query("delete from public.messages where id = any($1::uuid[])", [
      sqlUuidArray(fixture.messageIds),
    ]);
    await pg.query(
      "delete from public.acquisition_attempts where id = any($1::uuid[])",
      [sqlUuidArray(fixture.attemptIds)],
    );
    await pg.query(
      "delete from public.message_threads where org_id = any($1::uuid[])",
      [[fixture.orgId, fixture.foreignOrgId]],
    );
    await pg.query("delete from public.properties where id = any($1::uuid[])", [
      [
        fixture.propertyId,
        fixture.siblingPropertyId,
        fixture.deletedPropertyId,
        fixture.foreignPropertyId,
      ],
    ]);
    await pg.query("delete from public.contacts where id = any($1::uuid[])", [
      [fixture.contactId, fixture.foreignContactId],
    ]);
    await pg.query("set local session_replication_role = replica");
    await pg.query(
      "delete from public.memberships where org_id = any($1::uuid[])",
      [[fixture.orgId, fixture.foreignOrgId]],
    );
    await pg.query("set local session_replication_role = origin");
    await pg.query(
      "delete from public.organizations where id = any($1::uuid[])",
      [[fixture.orgId, fixture.foreignOrgId]],
    );
    await pg.query("commit");
  } catch (error) {
    await pg.query("rollback");
    databaseError = error;
  }

  for (const userId of [
    fixture.ownerId,
    fixture.anchorOwnerId,
    fixture.foreignOwnerId,
  ]) {
    const { error } = await service.auth.admin.deleteUser(userId);
    if (error && !/not found/i.test(error.message)) {
      databaseError ??= error;
    }
  }
  if (databaseError) {
    throw databaseError;
  }
}

beforeAll(async () => {
  pg = new Client({ connectionString: localDbUrl });
  await pg.connect();
  service = createClient<Database>(localApiUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await seedFixture();
});

afterAll(async () => {
  try {
    if (pg) await cleanupFixture();
  } finally {
    await pg?.end();
  }
});

describe("loadPreviewData against local PostgREST", () => {
  it("loads current columns and applies tenant-safe PostgREST OR filters", async () => {
    const result = await loadPreviewData({
      client: loaderClient(),
      orgId: fixture.orgId,
      propertyId: fixture.propertyId,
    });

    expect(result).toMatchObject({
      propertyId: fixture.propertyId,
      leadName: "Synthetic Homeowner",
      address: "101 Preview Lane, Kansas City, MO",
      ownerName: "Synthetic Preview Owner",
      latestAttempt: {
        id: fixture.pendingAttemptId,
        outcome: null,
      },
      messagesDisposition: "not_interested",
      lastContactAt: "2026-10-03T12:03:00+00:00",
    });

    const { data, error } = await service
      .from("messages")
      .select("id, property_id, contact_id, direction, status")
      .eq("org_id", fixture.orgId)
      .eq("channel", "sms")
      .or(
        "direction.eq.inbound,and(direction.eq.outbound,status.in.(sent,delivered,failed,bounced))",
      )
      .or(
        `property_id.eq.${fixture.propertyId},and(property_id.is.null,contact_id.eq.${fixture.contactId})`,
      )
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });

    expect(error).toBeNull();
    expect(data?.map((row) => row.id)).toEqual([
      fixture.failedMessageId,
      fixture.tieHighMessageId,
      fixture.tieLowMessageId,
      fixture.oldSuccessfulMessageId,
    ]);
    expect(data?.map((row) => row.id)).not.toContain(fixture.siblingMessageId);
  });

  it("keeps failed outbound text out of last contact, orders tied latest-three oldest-first, and advances on reached call", async () => {
    const beforeCall = await loadPreviewData({
      client: loaderClient(),
      orgId: fixture.orgId,
      propertyId: fixture.propertyId,
    });

    expect(beforeCall?.messages.map((message) => message.id)).toEqual([
      fixture.tieLowMessageId,
      fixture.tieHighMessageId,
      fixture.failedMessageId,
    ]);
    expect(
      beforeCall?.messages.some(
        (message) => message.id === fixture.siblingMessageId,
      ),
    ).toBe(false);
    expect(beforeCall?.lastContactAt).toBe("2026-10-03T12:03:00+00:00");

    await pg.query(
      `insert into public.acquisition_attempts
         (id, org_id, property_id, actor_user_id, attempt_kind, source, outcome,
          occurred_at, provider_attempt_key, idempotency_key)
       values ($1, $2, $3, $4, 'call', 'dialpad', 'reached',
          '2026-10-03T12:05:00Z', $5, $6)`,
      [
        fixture.reachedAttemptId,
        fixture.orgId,
        fixture.propertyId,
        fixture.ownerId,
        `dialpad-cti:test-${fixture.reachedAttemptId}`,
        randomUUID(),
      ],
    );
    fixture.attemptIds.push(fixture.reachedAttemptId);

    const afterCall = await loadPreviewData({
      client: loaderClient(),
      orgId: fixture.orgId,
      propertyId: fixture.propertyId,
    });
    expect(afterCall?.lastContactAt).toBe("2026-10-03T12:05:00.000Z");
  });

  it("reports the applied property disposition while a separate AI proposal is pending", async () => {
    const { data: review, error: reviewError } = await service
      .from("ai_disposition_reviews")
      .select("status, disposition")
      .eq("id", fixture.pendingReviewId)
      .single();

    expect(reviewError).toBeNull();
    expect(review).toEqual({ status: "pending", disposition: "dnc" });

    const result = await loadPreviewData({
      client: loaderClient(),
      orgId: fixture.orgId,
      propertyId: fixture.propertyId,
    });
    expect(result?.messagesDisposition).toBe("not_interested");
  });

  it("returns null for a soft-deleted property even when its UUID and org are valid", async () => {
    await expect(
      loadPreviewData({
        client: loaderClient(),
        orgId: fixture.orgId,
        propertyId: fixture.deletedPropertyId,
      }),
    ).resolves.toBeNull();
  });

  it("fails closed for a foreign property and does not resolve an owner through another org", async () => {
    await pg.query(
      "delete from public.memberships where user_id = $1 and org_id = $2",
      [fixture.ownerId, fixture.orgId],
    );

    try {
      const ownerResult = await loadPreviewData({
        client: loaderClient(),
        orgId: fixture.orgId,
        propertyId: fixture.propertyId,
      });
      expect(ownerResult?.ownerName).toBeNull();

      await expect(
        loadPreviewData({
          client: loaderClient(),
          orgId: fixture.orgId,
          propertyId: fixture.foreignPropertyId,
        }),
      ).resolves.toBeNull();
    } finally {
      await pg.query(
        "insert into public.memberships (user_id, org_id, role) values ($1, $2, 'owner')",
        [fixture.ownerId, fixture.orgId],
      );
    }
  });
});
