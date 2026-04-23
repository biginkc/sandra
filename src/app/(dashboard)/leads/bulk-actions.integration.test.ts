import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

// Same mock pattern as actions.integration.test.ts — swap the action's
// server-side `createClient()` for our service-role test client so
// writes hit sandra-crm-test.
const testClient = createTestClient();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => testClient,
}));

// Admin check reads ADMIN_EMAILS env. Pin a known value before tests so
// the admin-only delete action has a predictable answer.
process.env.ADMIN_EMAILS = "jarrad@bmhgroupkc.com";

// Stub getUser() to control admin-ness on a per-test basis.
// `currentUser` has an email only — id is null so writes to FK columns
// (applied_by, last_added_by) pass through as null and don't need a
// seeded auth.users row. Admin is detected by email, so this still
// exercises the isAdminEmail() check.
let currentEmail: string | null = "jarrad@bmhgroupkc.com";
vi.spyOn(testClient.auth, "getUser").mockImplementation(async () =>
  ({
    data: {
      user: currentEmail
        ? ({ id: null, email: currentEmail } as never)
        : null,
    },
    error: null,
  }) as never,
);

// eslint-disable-next-line import/first
import {
  addPropertiesToListBulk,
  applyTagBulk,
  assignLeadsBulk,
  deletePropertiesBulk,
  removePropertiesFromListBulk,
  revertToProspect,
  setMotivationBulk,
} from "@/app/(dashboard)/leads/actions";

async function seedProspect(address: string): Promise<string> {
  const { data, error } = await testClient
    .from("properties")
    .insert({ address, state: "MO", status: "prospect" })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seed failed");
  return data.id;
}

async function seedList(name: string): Promise<string> {
  const { data, error } = await testClient
    .from("lists")
    .insert({ name })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seed list failed");
  return data.id;
}

async function seedCustomTag(name: string): Promise<string> {
  const { data, error } = await testClient
    .from("tags")
    .insert({ name, category: "custom", system_managed: false })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seed tag failed");
  return data.id;
}

describe("bulk actions (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(testClient);
    currentEmail = "jarrad@bmhgroupkc.com";
  });

  it("assignLeadsBulk updates every selected property", async () => {
    const ids = [
      await seedProspect("1 Assign Ln"),
      await seedProspect("2 Assign Ln"),
    ];
    // assigned_user_id FKs to auth.users — assign to null (unassign) is the
    // safe shape that doesn't require a seeded auth user.
    const result = await assignLeadsBulk(ids, null);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data.succeeded).toBe(2);

    const { data } = await testClient
      .from("properties")
      .select("assigned_user_id")
      .in("id", ids);
    for (const row of data ?? []) {
      expect(row.assigned_user_id).toBeNull();
    }
  });

  it("addPropertiesToListBulk stacks onto an existing list (no duplicate rows)", async () => {
    const listId = await seedList("Absentee High Equity");
    const ids = [
      await seedProspect("1 Stack Ln"),
      await seedProspect("2 Stack Ln"),
    ];

    const first = await addPropertiesToListBulk(ids, listId);
    expect(first.ok).toBe(true);

    // Re-adding the same ids must not create duplicate property_lists rows.
    const second = await addPropertiesToListBulk(ids, listId);
    expect(second.ok).toBe(true);

    const { count } = await testClient
      .from("property_lists")
      .select("*", { count: "exact", head: true })
      .eq("list_id", listId);
    expect(count).toBe(2);
  });

  it("removePropertiesFromListBulk deletes memberships for the given list only", async () => {
    const listA = await seedList("Absentee");
    const listB = await seedList("Pre-Foreclosure");
    const id = await seedProspect("1 Multi Ln");

    await addPropertiesToListBulk([id], listA);
    await addPropertiesToListBulk([id], listB);

    const result = await removePropertiesFromListBulk([id], listA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.succeeded).toBe(1);

    const { data: stillOn } = await testClient
      .from("property_lists")
      .select("list_id")
      .eq("property_id", id);
    expect(stillOn).toHaveLength(1);
    expect(stillOn?.[0].list_id).toBe(listB);
  });

  it("applyTagBulk refuses non-custom tags with TAG_NOT_APPLICABLE", async () => {
    const id = await seedProspect("1 NoTag Ln");
    const { data: sysTag } = await testClient
      .from("tags")
      .insert({ name: "source:test", category: "source", system_managed: true })
      .select("id")
      .single();

    const result = await applyTagBulk([id], sysTag!.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TAG_NOT_APPLICABLE");
  });

  it("applyTagBulk attaches a custom tag to every selected property", async () => {
    const tagId = await seedCustomTag("competing-offer");
    const ids = [
      await seedProspect("1 Tagged Ln"),
      await seedProspect("2 Tagged Ln"),
    ];

    const result = await applyTagBulk(ids, tagId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.succeeded).toBe(2);

    const { count } = await testClient
      .from("property_tags")
      .select("*", { count: "exact", head: true })
      .eq("tag_id", tagId);
    expect(count).toBe(2);
  });

  it("setMotivationBulk updates everyone to the same level", async () => {
    const ids = [
      await seedProspect("1 Mot Ln"),
      await seedProspect("2 Mot Ln"),
      await seedProspect("3 Mot Ln"),
    ];
    const result = await setMotivationBulk(ids, "hot");
    expect(result.ok).toBe(true);

    const { data } = await testClient
      .from("properties")
      .select("motivation_level")
      .in("id", ids);
    for (const row of data ?? []) expect(row.motivation_level).toBe("hot");
  });

  it("setMotivationBulk clears with null", async () => {
    const id = await seedProspect("1 Clr Ln");
    await testClient
      .from("properties")
      .update({ motivation_level: "warm" })
      .eq("id", id);

    const result = await setMotivationBulk([id], null);
    expect(result.ok).toBe(true);

    const { data } = await testClient
      .from("properties")
      .select("motivation_level")
      .eq("id", id)
      .single();
    expect(data?.motivation_level).toBeNull();
  });

  it("deletePropertiesBulk soft-deletes when caller is admin", async () => {
    currentEmail = "jarrad@bmhgroupkc.com";
    const ids = [
      await seedProspect("1 Del Ln"),
      await seedProspect("2 Del Ln"),
    ];
    const result = await deletePropertiesBulk(ids);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.succeeded).toBe(2);

    const { data } = await testClient
      .from("properties")
      .select("deleted_at")
      .in("id", ids);
    for (const row of data ?? []) {
      expect(row.deleted_at).not.toBeNull();
    }
  });

  it("deletePropertiesBulk rejects non-admin callers with FORBIDDEN", async () => {
    currentEmail = "va@bmhgroupkc.com";
    const id = await seedProspect("1 NoDel Ln");
    const result = await deletePropertiesBulk([id]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FORBIDDEN");

    const { data } = await testClient
      .from("properties")
      .select("deleted_at")
      .eq("id", id)
      .single();
    expect(data?.deleted_at).toBeNull();
  });

  it("revertToProspect flips status back and clears qualified stamps", async () => {
    const id = await seedProspect("1 Revert Ln");
    // Qualify it first so revert has something to undo.
    await testClient
      .from("properties")
      .update({
        status: "contacted",
        qualified_at: new Date().toISOString(),
        qualified_by: "user-original",
      })
      .eq("id", id);

    const result = await revertToProspect(id);
    expect(result.ok).toBe(true);

    const { data } = await testClient
      .from("properties")
      .select("status, qualified_at, qualified_by")
      .eq("id", id)
      .single();
    expect(data?.status).toBe("prospect");
    expect(data?.qualified_at).toBeNull();
    expect(data?.qualified_by).toBeNull();
  });

  it("revertToProspect is a no-op on an already-prospect row", async () => {
    const id = await seedProspect("1 AlreadyProspect Ln");
    const result = await revertToProspect(id);
    expect(result.ok).toBe(true);
  });
});
