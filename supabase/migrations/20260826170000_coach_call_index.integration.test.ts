import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";
import { createTestClient } from "@tests/integration/client";
import { BMH_ORG_ID, clientForUser, createOrgUser, seedTwoOrgs } from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

const serviceClient = createTestClient();
const createdUserIds: string[] = [];

// coach_call_index isn't in the generated Database type yet (it can only be
// regenerated against the live schema after this migration is applied) —
// narrow-cast for this test file, matching the repo's existing pattern for
// pre-regen tables (see tests/integration/fixtures/multi-user.ts's
// MembershipWriter).
type CoachCallIndexRow = { client_call_id: string; operator_user_id: string; property_id: string | null };
type CoachCallIndexClient = {
  from(table: "coach_call_index"): {
    upsert(values: Omit<CoachCallIndexRow, "property_id"> & { property_id?: string | null }): Promise<{
      error: { message: string } | null;
    }>;
    select(columns: "client_call_id"): {
      eq(column: "client_call_id", value: string): Promise<{
        data: { client_call_id: string }[] | null;
        error: { message: string } | null;
      }>;
    };
  };
};

function asIndexClient(client: SupabaseClient<Database>): CoachCallIndexClient {
  return client as unknown as CoachCallIndexClient;
}

function uniqueEmail(label: string): string {
  return `coach-call-index-${label}-${Date.now()}-${crypto.randomUUID()}@bmhgroupkc.com`;
}

async function createUser(label: string) {
  const user = await createOrgUser(serviceClient, { orgId: BMH_ORG_ID, email: uniqueEmail(label), role: "member" });
  createdUserIds.push(user.userId);
  return { ...user, client: clientForUser(user.jwt) };
}

async function insertProperty(): Promise<string> {
  const { data, error } = await serviceClient
    .from("properties")
    .insert({
      org_id: BMH_ORG_ID,
      address: `coach-call-index ${crypto.randomUUID()}`,
      state: "MO",
      status: "new_lead",
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

beforeAll(async () => {
  await resetTenantTables(serviceClient);
  await seedTwoOrgs(serviceClient);
});

beforeEach(async () => {
  await resetTenantTables(serviceClient);
});

afterAll(async () => {
  for (const userId of createdUserIds) {
    await serviceClient.auth.admin.deleteUser(userId);
  }
  await resetTenantTables(serviceClient);
});

describe("Migration 20260826170000 — coach_call_index (coach realtime authorization)", () => {
  it("accepts a service-role upsert and lets the owning operator read their own row", async () => {
    const propertyId = await insertProperty();
    const owner = await createUser("owner");
    const clientCallId = crypto.randomUUID();

    const { error: upsertError } = await asIndexClient(serviceClient)
      .from("coach_call_index")
      .upsert({ client_call_id: clientCallId, operator_user_id: owner.userId, property_id: propertyId });
    expect(upsertError).toBeNull();

    const { data, error } = await asIndexClient(owner.client)
      .from("coach_call_index")
      .select("client_call_id")
      .eq("client_call_id", clientCallId);
    expect(error).toBeNull();
    expect(data).toEqual([{ client_call_id: clientCallId }]);
  });

  it("hides another operator's call index row — the exact ownership check the coach realtime.messages policy reuses", async () => {
    const propertyId = await insertProperty();
    const owner = await createUser("owner");
    const other = await createUser("other");
    const clientCallId = crypto.randomUUID();

    await asIndexClient(serviceClient)
      .from("coach_call_index")
      .upsert({ client_call_id: clientCallId, operator_user_id: owner.userId, property_id: propertyId });

    const { data, error } = await asIndexClient(other.client)
      .from("coach_call_index")
      .select("client_call_id")
      .eq("client_call_id", clientCallId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("refuses a direct authenticated insert — only the service-role start-call path may write", async () => {
    const owner = await createUser("owner");
    const { error } = await asIndexClient(owner.client)
      .from("coach_call_index")
      .upsert({ client_call_id: crypto.randomUUID(), operator_user_id: owner.userId, property_id: null });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/permission denied|row-level security/i);
  });

  it("upsert on conflict updates the row in place (idempotent re-mint of the same client_call_id)", async () => {
    const propertyA = await insertProperty();
    const propertyB = await insertProperty();
    const owner = await createUser("owner");
    const clientCallId = crypto.randomUUID();

    await asIndexClient(serviceClient)
      .from("coach_call_index")
      .upsert({ client_call_id: clientCallId, operator_user_id: owner.userId, property_id: propertyA });
    const { error } = await asIndexClient(serviceClient)
      .from("coach_call_index")
      .upsert({ client_call_id: clientCallId, operator_user_id: owner.userId, property_id: propertyB });
    expect(error).toBeNull();

    const { data } = await asIndexClient(owner.client)
      .from("coach_call_index")
      .select("client_call_id")
      .eq("client_call_id", clientCallId);
    expect(data).toHaveLength(1);
  });
});
