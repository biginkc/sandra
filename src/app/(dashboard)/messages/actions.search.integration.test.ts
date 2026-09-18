import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import {
  BMH_ORG_ID,
  TEST_ORG_B_ID,
  clientForUser,
  createOrgUser,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

const mocks = vi.hoisted(() => ({
  serverClient: undefined as unknown,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => mocks.serverClient,
}));

import { searchContactsForMatch, searchPropertiesForMatch } from "./actions";

const serviceClient = createTestClient();
const createdUserIds: string[] = [];

async function seedProperty(opts: {
  address: string;
  orgId: string;
}): Promise<string> {
  const { data, error } = await serviceClient
    .from("properties")
    .insert({
      org_id: opts.orgId,
      address: opts.address,
      state: "MO",
      status: "prospect",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seed property failed");
  return data.id;
}

async function seedContact(opts: {
  firstName: string;
  lastName: string;
  orgId: string;
}): Promise<string> {
  const { data, error } = await serviceClient
    .from("contacts")
    .insert({
      org_id: opts.orgId,
      first_name: opts.firstName,
      last_name: opts.lastName,
      phone_1_type: "unknown",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seed contact failed");
  return data.id;
}

describe("searchPropertiesForMatch (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(serviceClient);
    await seedTwoOrgs(serviceClient);
  });

  afterAll(async () => {
    for (const userId of createdUserIds) {
      await serviceClient.auth.admin.deleteUser(userId);
    }
  });

  it("returns only properties visible to the caller's org", async () => {
    const userA = await createOrgUser(serviceClient, {
      orgId: BMH_ORG_ID,
      email: `search-properties-org-a-${Date.now()}@example.test`,
      role: "member",
    });
    createdUserIds.push(userA.userId);
    mocks.serverClient = clientForUser(userA.jwt);

    const orgAPropertyId = await seedProperty({
      orgId: BMH_ORG_ID,
      address: "901 Gate Scoped Search Ave",
    });
    const orgBPropertyId = await seedProperty({
      orgId: TEST_ORG_B_ID,
      address: "902 Gate Scoped Search Ave",
    });

    const result = await searchPropertiesForMatch("Gate Scoped Search");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.data.map((hit) => hit.id);
    expect(ids).toContain(orgAPropertyId);
    expect(ids).not.toContain(orgBPropertyId);
  });

  it("matches a contact by the full first-and-last name", async () => {
    const userA = await createOrgUser(serviceClient, {
      orgId: BMH_ORG_ID,
      email: `search-contacts-full-name-${Date.now()}@example.test`,
      role: "member",
    });
    createdUserIds.push(userA.userId);
    mocks.serverClient = clientForUser(userA.jwt);

    const contactId = await seedContact({
      orgId: BMH_ORG_ID,
      firstName: "Existing",
      lastName: "ContactU02",
    });

    const result = await searchContactsForMatch("Existing ContactU02");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((hit) => hit.id)).toContain(contactId);
  });
});
