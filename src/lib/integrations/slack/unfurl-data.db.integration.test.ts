import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

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
  ownerEmail: string;
  ownerPassword: string;
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
const ATTEMPT_FACT_KEYS = [
  "latest_attempt_id",
  "latest_attempt_occurred_at",
  "latest_attempt_outcome",
  "reached_call_id",
  "reached_call_occurred_at",
] as const;

const fixture: Fixture = {
  orgId: randomUUID(),
  foreignOrgId: randomUUID(),
  ownerId: randomUUID(),
  ownerEmail: "",
  ownerPassword: "",
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
let rpcWasAbsent = false;
let rpcLockHeld = false;
const rpcLockKey = "slack-preview-attempt-facts";

function previewAttemptFactsSql(): string {
  const migration = readFileSync(
    new URL(
      "../../../../supabase/migrations/20261003091441_slack_lead_unfurl_foundation.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const start = migration.indexOf(
    "create or replace function public.get_slack_preview_attempt_facts(",
  );
  const end = migration.indexOf(
    "create or replace function public.approve_slack_channel(",
    start,
  );
  if (start < 0 || end < 0) {
    throw new Error("authoritative Slack preview attempt RPC was not found");
  }
  return migration.slice(start, end);
}

/**
 * The shared local stack may not have the uncommitted migration applied yet.
 * Install only this exact function for the test, reload PostgREST's schema
 * cache, and remove it afterward when the test created it. The loader itself
 * still uses the real service-role RPC, never a SQL read shim.
 */
async function ensurePreviewAttemptFactsRpc(): Promise<void> {
  await pg.query("select pg_advisory_lock(hashtextextended($1, 0))", [rpcLockKey]);
  rpcLockHeld = true;
  try {
    const existing = await pg.query<{ oid: string | null }>(
      "select to_regprocedure('public.get_slack_preview_attempt_facts(uuid,uuid)')::oid as oid",
    );
    const oid = existing.rows[0]?.oid;
    if (oid) {
      const contract = await pg.query<{
        definition: string;
        service_execute: boolean;
        anon_execute: boolean;
        authenticated_execute: boolean;
      }>(
        `select pg_get_functiondef($1::oid) as definition,
                has_function_privilege('service_role', 'public.get_slack_preview_attempt_facts(uuid,uuid)', 'execute') as service_execute,
                has_function_privilege('anon', 'public.get_slack_preview_attempt_facts(uuid,uuid)', 'execute') as anon_execute,
                has_function_privilege('authenticated', 'public.get_slack_preview_attempt_facts(uuid,uuid)', 'execute') as authenticated_execute`,
        [oid],
      );
      const row = contract.rows[0];
      const definition = row?.definition.toLowerCase() ?? "";
      const expectedContract = [
        "returns table(",
        "latest_attempt_id",
        "reached_call_id",
        "security definer",
        "public.acquisition_attempts",
        "p.deleted_at is null",
      ].every((fragment) => definition.includes(fragment));
      if (
        !expectedContract ||
        !row.service_execute ||
        row.anon_execute ||
        row.authenticated_execute
      ) {
        throw new Error(
          "existing Slack preview attempt RPC does not match the expected contract or service-only grant",
        );
      }
      return;
    }

    await pg.query("begin");
    try {
      await pg.query(previewAttemptFactsSql());
      await pg.query(
        "revoke all on function public.get_slack_preview_attempt_facts(uuid,uuid) from public, anon, authenticated",
      );
      await pg.query(
        "grant execute on function public.get_slack_preview_attempt_facts(uuid,uuid) to service_role",
      );
      await pg.query("commit");
    } catch (error) {
      await pg.query("rollback");
      throw error;
    }
    rpcWasAbsent = true;
    await pg.query("select pg_notify('pgrst', 'reload schema')");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const { error } = await service.rpc("get_slack_preview_attempt_facts", {
        p_org_id: randomUUID(),
        p_property_id: randomUUID(),
      });
      if (!error) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("PostgREST did not expose the local Slack preview attempt RPC in time");
  } catch (error) {
    if (rpcLockHeld) {
      await pg.query("select pg_advisory_unlock(hashtextextended($1, 0))", [rpcLockKey]);
      rpcLockHeld = false;
    }
    throw error;
  }
}

async function removePreviewAttemptFactsRpc(): Promise<void> {
  if (!rpcLockHeld) return;
  try {
    if (rpcWasAbsent) {
      await pg.query("begin");
      try {
        await pg.query(
          "revoke all on function public.get_slack_preview_attempt_facts(uuid,uuid) from public, anon, authenticated, service_role",
        );
        await pg.query(
          "drop function if exists public.get_slack_preview_attempt_facts(uuid,uuid)",
        );
        await pg.query("commit");
      } catch (error) {
        await pg.query("rollback");
        throw error;
      }
      await pg.query("select pg_notify('pgrst', 'reload schema')");
    }
  } finally {
    await pg.query("select pg_advisory_unlock(hashtextextended($1, 0))", [rpcLockKey]);
    rpcLockHeld = false;
  }
}

function sqlUuidArray(ids: string[]): string[] {
  return ids;
}

async function seedFixture(): Promise<void> {
  fixture.ownerEmail = `slack-preview-owner-${fixture.ownerId}@example.test`;
  fixture.ownerPassword = randomUUID();
  const createdOwner = await service.auth.admin.createUser({
    email: fixture.ownerEmail,
    password: fixture.ownerPassword,
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
  await ensurePreviewAttemptFactsRpc();
  await seedFixture();
});

afterAll(async () => {
  try {
    if (pg) await cleanupFixture();
  } finally {
    if (pg) {
      await removePreviewAttemptFactsRpc();
      await pg.end();
    }
  }
});

describe("loadPreviewData against local PostgREST", () => {
  it("loads current columns and applies tenant-safe PostgREST OR filters", async () => {
    const result = await loadPreviewData({
      client: service,
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

    const { data: attemptFacts, error: attemptFactsError } = await service.rpc(
      "get_slack_preview_attempt_facts",
      { p_org_id: fixture.orgId, p_property_id: fixture.propertyId },
    );
    expect(attemptFactsError).toBeNull();
    expect(Object.keys(attemptFacts?.[0] ?? {}).sort()).toEqual(
      [...ATTEMPT_FACT_KEYS].sort(),
    );
    expect(attemptFacts?.[0]).toMatchObject({
      latest_attempt_id: fixture.pendingAttemptId,
      latest_attempt_occurred_at: "2026-10-03T12:07:00+00:00",
      latest_attempt_outcome: null,
      reached_call_id: null,
      reached_call_occurred_at: null,
    });

    const anonClient = createClient<Database>(
      localApiUrl,
      process.env.TEST_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const anonAttemptFacts = await anonClient.rpc(
      "get_slack_preview_attempt_facts",
      { p_org_id: fixture.orgId, p_property_id: fixture.propertyId },
    );
    expect(anonAttemptFacts.error).toBeTruthy();

    const authenticatedClient = createClient<Database>(
      localApiUrl,
      process.env.TEST_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const signIn = await authenticatedClient.auth.signInWithPassword({
      email: fixture.ownerEmail,
      password: fixture.ownerPassword,
    });
    expect(signIn.error).toBeNull();
    const authenticatedAttemptFacts = await authenticatedClient.rpc(
      "get_slack_preview_attempt_facts",
      { p_org_id: fixture.orgId, p_property_id: fixture.propertyId },
    );
    expect(authenticatedAttemptFacts.error).toBeTruthy();
  });

  it("keeps failed outbound text out of last contact, orders tied latest-three oldest-first, and advances on reached call", async () => {
    const beforeCall = await loadPreviewData({
      client: service,
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
      client: service,
      orgId: fixture.orgId,
      propertyId: fixture.propertyId,
    });
    expect(afterCall?.lastContactAt).toBe("2026-10-03T12:05:00+00:00");
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
      client: service,
      orgId: fixture.orgId,
      propertyId: fixture.propertyId,
    });
    expect(result?.messagesDisposition).toBe("not_interested");
  });

  it("returns null for a soft-deleted property even when its UUID and org are valid", async () => {
    await expect(
      loadPreviewData({
        client: service,
        orgId: fixture.orgId,
        propertyId: fixture.deletedPropertyId,
      }),
    ).resolves.toBeNull();

    const { data, error } = await service.rpc(
      "get_slack_preview_attempt_facts",
      { p_org_id: fixture.orgId, p_property_id: fixture.deletedPropertyId },
    );
    expect(error).toBeNull();
    expect(data).toEqual([{
      latest_attempt_id: null,
      latest_attempt_occurred_at: null,
      latest_attempt_outcome: null,
      reached_call_id: null,
      reached_call_occurred_at: null,
    }]);
  });

  it("keeps an assigned label within its org and fails closed for a foreign property", async () => {
    await pg.query(
      "delete from public.memberships where user_id = $1 and org_id = $2",
      [fixture.ownerId, fixture.orgId],
    );

    try {
      const ownerResult = await loadPreviewData({
        client: service,
        orgId: fixture.orgId,
        propertyId: fixture.propertyId,
      });
      expect(ownerResult?.ownerName).toBe("Synthetic Preview Owner");

      await expect(
        loadPreviewData({
          client: service,
          orgId: fixture.orgId,
          propertyId: fixture.foreignPropertyId,
        }),
      ).resolves.toBeNull();

      const { data, error } = await service.rpc(
        "get_slack_preview_attempt_facts",
        { p_org_id: fixture.orgId, p_property_id: fixture.foreignPropertyId },
      );
      expect(error).toBeNull();
      expect(data).toEqual([{
        latest_attempt_id: null,
        latest_attempt_occurred_at: null,
        latest_attempt_outcome: null,
        reached_call_id: null,
        reached_call_occurred_at: null,
      }]);
    } finally {
      await pg.query(
        "insert into public.memberships (user_id, org_id, role) values ($1, $2, 'owner')",
        [fixture.ownerId, fixture.orgId],
      );
    }
  });
});
