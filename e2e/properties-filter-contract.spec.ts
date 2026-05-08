import { expect, test, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { adminClient, seedList, seedProspects, type SeededProspect } from "./fixtures";
import type { Database } from "../src/lib/supabase/types";
import type { FilterBlock } from "../src/lib/prospects/filter-schema";

function encodedFilters(blocks: FilterBlock[]) {
  return encodeURIComponent(JSON.stringify({ v: 1, blocks }));
}

async function openFilteredProperties(
  page: Page,
  blocks: FilterBlock[],
  expectedCount: number,
) {
  await page.goto(`/properties?filters=${encodedFilters(blocks)}`);
  await expect(
    page.getByText(/Failed to load prospects/i),
  ).not.toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByText(
      new RegExp(
        `Showing 1.* of ${expectedCount.toLocaleString()} prospect`,
      ),
    ).first(),
  ).toBeVisible({ timeout: 10_000 });
}

async function countListMembers(
  admin: SupabaseClient<Database>,
  listId: string,
  extra?: {
    status?: string;
    isVacant?: boolean;
    cassStatus?: string;
    ids?: string[];
  },
) {
  let query = admin
    .from("properties")
    .select("id, property_lists!inner(list_id)", {
      count: "exact",
      head: true,
    })
    .is("deleted_at", null)
    .eq("property_lists.list_id", listId);

  query = query.eq("status", extra?.status ?? "prospect");

  if (extra?.isVacant != null) query = query.eq("is_vacant", extra.isVacant);
  if (extra?.cassStatus) query = query.eq("cass_status", extra.cassStatus);
  if (extra?.ids?.length) query = query.in("id", extra.ids);

  const { count, error } = await query;
  expect(error).toBeNull();
  return count ?? 0;
}

async function propertyIdsInEveryList(
  admin: SupabaseClient<Database>,
  listIds: string[],
) {
  const { data, error } = await admin
    .from("property_lists")
    .select("property_id, list_id")
    .in("list_id", listIds);
  expect(error).toBeNull();

  const byProperty = new Map<string, Set<string>>();
  for (const row of data ?? []) {
    if (!byProperty.has(row.property_id)) {
      byProperty.set(row.property_id, new Set());
    }
    byProperty.get(row.property_id)!.add(row.list_id);
  }

  return Array.from(byProperty.entries())
    .filter(([, memberships]) => listIds.every((listId) => memberships.has(listId)))
    .map(([propertyId]) => propertyId);
}

async function propertyIdsWithStackCountAtLeast(
  admin: SupabaseClient<Database>,
  min: number,
) {
  const { data, error } = await admin
    .from("property_stack_counts")
    .select("property_id")
    .gte("stack_count", min);
  expect(error).toBeNull();
  return (data ?? [])
    .map((row) => row.property_id)
    .filter((propertyId): propertyId is string => propertyId != null);
}

test.describe.serial("Properties filter contract — seeded DB oracle", () => {
  let admin: SupabaseClient<Database>;
  let prefix: string;
  let listA: string;
  let listB: string;
  let seeded: SeededProspect[];

  test.beforeAll(async () => {
    admin = adminClient();
    prefix = `E2E Filter Contract ${Date.now()}`;
    listA = await seedList(admin, `${prefix} A`);
    listB = await seedList(admin, `${prefix} B`);
    seeded = await seedProspects(admin, 6, prefix);

    const updates = [
      { id: seeded[0].id, cass_status: "verified", is_vacant: true, status: "prospect" },
      { id: seeded[1].id, cass_status: "unverified", is_vacant: true, status: "prospect" },
      { id: seeded[2].id, cass_status: "verified", is_vacant: false, status: "prospect" },
      { id: seeded[3].id, cass_status: "invalid", is_vacant: null, status: "prospect" },
      { id: seeded[4].id, cass_status: "verified", is_vacant: true, status: "new_lead" },
      { id: seeded[5].id, cass_status: "ambiguous", is_vacant: false, status: "prospect" },
    ];

    for (const row of updates) {
      const { error } = await admin
        .from("properties")
        .update({
          cass_status: row.cass_status,
          is_vacant: row.is_vacant,
          status: row.status,
        })
        .eq("id", row.id);
      expect(error).toBeNull();
    }

    const { error: membershipsError } = await admin.from("property_lists").insert([
      { property_id: seeded[0].id, list_id: listA },
      { property_id: seeded[0].id, list_id: listB },
      { property_id: seeded[1].id, list_id: listA },
      { property_id: seeded[2].id, list_id: listA },
      { property_id: seeded[3].id, list_id: listB },
      { property_id: seeded[4].id, list_id: listA },
      { property_id: seeded[5].id, list_id: listB },
    ]);
    expect(membershipsError).toBeNull();
  });

  test.afterAll(async () => {
    if (!admin || !prefix) return;
    if (listA || listB) {
      await admin.from("property_lists").delete().in("list_id", [listA, listB]);
      await admin.from("lists").delete().in("id", [listA, listB]);
    }
    await admin.from("properties").delete().like("address", `${prefix}%`);
  });

  test("List any matches the database count for that list", async ({ page }) => {
    const expectedCount = await countListMembers(admin, listA);

    await openFilteredProperties(
      page,
      [{ id: "list-a", kind: "list", combinator: "any", values: [listA] }],
      expectedCount,
    );
  });

  test("List plus Vacant narrows to vacant members only", async ({ page }) => {
    const expectedCount = await countListMembers(admin, listA, {
      isVacant: true,
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        { id: "vacant-yes", kind: "vacancy", tri: "yes" },
      ],
      expectedCount,
    );
  });

  test("List plus CASS status narrows to verified members only", async ({ page }) => {
    const expectedCount = await countListMembers(admin, listA, {
      cassStatus: "verified",
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        { id: "cass-verified", kind: "cass", combinator: "any", values: ["verified"] },
      ],
      expectedCount,
    );
  });

  test("Pipeline status can intentionally leave the default Prospect scope", async ({
    page,
  }) => {
    const expectedCount = await countListMembers(admin, listA, {
      status: "new_lead",
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        {
          id: "new-leads",
          kind: "pipeline_status",
          combinator: "any",
          values: ["new_lead"],
        },
      ],
      expectedCount,
    );
  });

  test("Multi-list all requires membership in every selected list", async ({
    page,
  }) => {
    const idsInBoth = await propertyIdsInEveryList(admin, [listA, listB]);
    const expectedCount = await countListMembers(admin, listA, {
      ids: idsInBoth,
    });

    await openFilteredProperties(
      page,
      [{ id: "lists-all", kind: "list", combinator: "all", values: [listA, listB] }],
      expectedCount,
    );
  });

  test("List Count composes with List to find stacked prospects", async ({
    page,
  }) => {
    const stackedIds = await propertyIdsWithStackCountAtLeast(admin, 2);
    const expectedCount = await countListMembers(admin, listA, {
      ids: stackedIds,
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        { id: "stacked", kind: "list_count", range: { min: 2, max: null } },
      ],
      expectedCount,
    );
  });
});
