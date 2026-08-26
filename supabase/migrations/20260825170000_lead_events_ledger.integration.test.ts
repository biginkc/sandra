import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { TablesInsert } from "@/lib/supabase/types";
import { createTestClient } from "@tests/integration/client";
import { loadTestEnv } from "@tests/integration/env";
import {
  BMH_ORG_ID,
  TEST_ORG_B_ID,
  clientForUser,
  createOrgUser,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

const serviceClient = createTestClient();
const createdUserIds: string[] = [];
let pg: Client;

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

function uniqueEmail(label: string): string {
  return `lead-events-${label}-${Date.now()}-${crypto.randomUUID()}@bmhgroupkc.com`;
}

async function createUserForOrg(orgId: string) {
  const user = await createOrgUser(serviceClient, {
    orgId,
    email: uniqueEmail(orgId.slice(-3)),
    role: "member",
  });
  createdUserIds.push(user.userId);
  return { ...user, client: clientForUser(user.jwt) };
}

async function insertProperty(orgId = BMH_ORG_ID): Promise<string> {
  const { data, error } = await serviceClient
    .from("properties")
    .insert({
      org_id: orgId,
      address: `lead-events ${crypto.randomUUID()}`,
      state: "MO",
      status: "new_lead",
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

function eventInsert(
  propertyId: string,
  overrides: Partial<TablesInsert<"lead_events">> = {},
): TablesInsert<"lead_events"> {
  return {
    org_id: BMH_ORG_ID,
    property_id: propertyId,
    actor_type: "system",
    event_type: "lead_created",
    ...overrides,
  };
}

beforeAll(async () => {
  await resetTenantTables(serviceClient);
  await seedTwoOrgs(serviceClient);
  pg = new Client({ connectionString: testDbUrl() });
  await pg.connect();
});

beforeEach(async () => {
  await resetTenantTables(serviceClient);
});

afterAll(async () => {
  for (const userId of createdUserIds) {
    await serviceClient.auth.admin.deleteUser(userId);
  }
  await resetTenantTables(serviceClient);
  await pg.end();
});

describe("Migration 20260825170000 — lead events ledger", () => {
  it("accepts a service-role insert and allows a same-org member to read it", async () => {
    const propertyId = await insertProperty();
    const member = await createUserForOrg(BMH_ORG_ID);
    const { data: inserted, error: insertError } = await serviceClient
      .from("lead_events")
      .insert(eventInsert(propertyId))
      .select("id")
      .single();
    expect(insertError).toBeNull();

    const { data, error } = await member.client
      .from("lead_events")
      .select("id")
      .eq("id", inserted!.id);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: inserted!.id }]);
  });

  it("hides another organization's rows", async () => {
    const propertyId = await insertProperty();
    const outsider = await createUserForOrg(TEST_ORG_B_ID);
    const { data: inserted } = await serviceClient
      .from("lead_events")
      .insert(eventInsert(propertyId))
      .select("id")
      .single();

    const { data, error } = await outsider.client
      .from("lead_events")
      .select("id")
      .eq("id", inserted!.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("rejects a property and organization mismatch", async () => {
    const propertyId = await insertProperty();
    const { error } = await serviceClient.from("lead_events").insert(
      eventInsert(propertyId, {
        org_id: TEST_ORG_B_ID,
      }),
    );
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/foreign key|violates/i);
  });

  it("grants only the approved append/read privileges", async () => {
    const propertyId = await insertProperty();
    const member = await createUserForOrg(BMH_ORG_ID);
    const { data: inserted } = await serviceClient
      .from("lead_events")
      .insert(eventInsert(propertyId))
      .select("id")
      .single();

    const { error: insertError } = await member.client
      .from("lead_events")
      .insert(eventInsert(propertyId));
    expect(insertError?.message).toMatch(
      /permission denied|row-level security/i,
    );

    const { error: updateError } = await member.client
      .from("lead_events")
      .update({ event_type: "qualified" })
      .eq("id", inserted!.id);
    expect(updateError?.message).toMatch(
      /permission denied|row-level security/i,
    );

    const { error: deleteError } = await member.client
      .from("lead_events")
      .delete()
      .eq("id", inserted!.id);
    expect(deleteError?.message).toMatch(
      /permission denied|row-level security/i,
    );

    const { error: serviceUpdateError } = await serviceClient
      .from("lead_events")
      .update({ event_type: "qualified" })
      .eq("id", inserted!.id);
    expect(serviceUpdateError?.message).toMatch(/permission denied/i);

    const { error: serviceDeleteError } = await serviceClient
      .from("lead_events")
      .delete()
      .eq("id", inserted!.id);
    expect(serviceDeleteError?.message).toMatch(/permission denied/i);

    const privileges = await pg.query<{
      authenticated_select: boolean;
      authenticated_insert: boolean;
      service_select: boolean;
      service_insert: boolean;
      service_update: boolean;
      service_delete: boolean;
      service_truncate: boolean;
    }>(`
      select
        has_table_privilege('authenticated', 'public.lead_events', 'select')
          as authenticated_select,
        has_table_privilege('authenticated', 'public.lead_events', 'insert')
          as authenticated_insert,
        has_table_privilege('service_role', 'public.lead_events', 'select')
          as service_select,
        has_table_privilege('service_role', 'public.lead_events', 'insert')
          as service_insert,
        has_table_privilege('service_role', 'public.lead_events', 'update')
          as service_update,
        has_table_privilege('service_role', 'public.lead_events', 'delete')
          as service_delete,
        has_table_privilege('service_role', 'public.lead_events', 'truncate')
          as service_truncate
    `);
    expect(privileges.rows[0]).toEqual({
      authenticated_select: true,
      authenticated_insert: false,
      service_select: true,
      service_insert: true,
      service_update: false,
      service_delete: false,
      service_truncate: false,
    });

    const { data: after } = await serviceClient
      .from("lead_events")
      .select("event_type")
      .eq("id", inserted!.id)
      .single();
    expect(after?.event_type).toBe("lead_created");
  });

  it("enforces actor identity consistency", async () => {
    const propertyId = await insertProperty();
    const actor = await createUserForOrg(BMH_ORG_ID);

    for (const actorType of ["ai", "system"] as const) {
      const { error } = await serviceClient.from("lead_events").insert(
        eventInsert(propertyId, {
          actor_type: actorType,
          actor_id: actor.userId,
        }),
      );
      expect(error?.message).toMatch(
        /lead_events_actor_identity_check|violates/i,
      );
    }
  });

  it("preserves a user event and actor identity when the account is deleted", async () => {
    const propertyId = await insertProperty();
    const actor = await createUserForOrg(BMH_ORG_ID);
    const { data: inserted, error } = await serviceClient
      .from("lead_events")
      .insert(
        eventInsert(propertyId, {
          actor_type: "user",
          actor_id: actor.userId,
        }),
      )
      .select("id")
      .single();
    expect(error).toBeNull();

    expect(
      (await serviceClient.auth.admin.deleteUser(actor.userId)).error,
    ).toBeNull();
    const { data: after } = await serviceClient
      .from("lead_events")
      .select("actor_type, actor_id")
      .eq("id", inserted!.id)
      .single();
    expect(after).toEqual({ actor_type: "user", actor_id: actor.userId });
  });

  it("blocks direct property deletion while ledger history still points to it", async () => {
    const propertyId = await insertProperty();
    await serviceClient.from("lead_events").insert(eventInsert(propertyId));

    const { error } = await serviceClient
      .from("properties")
      .delete()
      .eq("id", propertyId);
    expect(error?.message).toMatch(/foreign key|violates/i);

    const { count } = await serviceClient
      .from("lead_events")
      .select("id", { count: "exact", head: true })
      .eq("property_id", propertyId);
    expect(count).toBe(1);
  });

  it("deduplicates non-null source identities but permits unsourced events", async () => {
    const propertyId = await insertProperty();
    const sourceId = crypto.randomUUID();
    const sourced = eventInsert(propertyId, {
      source_type: "properties.created",
      source_id: sourceId,
    });

    expect(
      (await serviceClient.from("lead_events").insert(sourced)).error,
    ).toBeNull();
    const duplicate = await serviceClient.from("lead_events").insert(sourced);
    expect(duplicate.error?.message).toMatch(/duplicate key|unique/i);

    const unsourced = eventInsert(propertyId);
    expect(
      (await serviceClient.from("lead_events").insert([unsourced, unsourced]))
        .error,
    ).toBeNull();
  });

  it("publishes lead_events for Supabase Realtime", async () => {
    const result = await pg.query<{ present: boolean }>(`
      select exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'lead_events'
      ) as present
    `);
    expect(result.rows[0]?.present).toBe(true);
  });

  it("reset_tenant_tables truncates lead events and preserves memberships", async () => {
    const propertyId = await insertProperty();
    const member = await createUserForOrg(BMH_ORG_ID);
    await serviceClient.from("lead_events").insert(eventInsert(propertyId));

    await resetTenantTables(serviceClient);

    const { count } = await serviceClient
      .from("lead_events")
      .select("id", { count: "exact", head: true });
    expect(count).toBe(0);
    const { count: membershipCount } = await serviceClient
      .from("memberships")
      .select("id", { count: "exact", head: true })
      .eq("user_id", member.userId)
      .eq("org_id", BMH_ORG_ID);
    expect(membershipCount).toBe(1);
  });
});
