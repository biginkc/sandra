import { expect, test, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  adminClient,
  ensureTestUser,
  seedList,
  seedProspects,
  type SeededProspect,
} from "./fixtures";
import type { Database } from "../src/lib/supabase/types";
import type { FilterBlock } from "../src/lib/prospects/filter-schema";

const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000bbb";

function encodedFilters(blocks: FilterBlock[]) {
  return encodeURIComponent(JSON.stringify({ v: 1, blocks }));
}

async function openFilteredProperties(
  page: Page,
  blocks: FilterBlock[],
  expectedCount: number,
  expectedAddresses: string[] = [],
) {
  await page.goto(`/properties?filters=${encodedFilters(blocks)}`);
  await expect(page.getByText(/Failed to load prospects/i)).not.toBeVisible({
    timeout: 10_000,
  });

  if (expectedCount === 0) {
    await expect(
      page.getByRole("cell", {
        name: /No prospects\. Import a CSV to fill the data lake\./i,
      }),
    ).toBeVisible({ timeout: 10_000 });
    return;
  }

  await expect(
    page
      .getByText(
        new RegExp(`Showing 1.* of ${expectedCount.toLocaleString()} prospect`),
      )
      .first(),
  ).toBeVisible({ timeout: 10_000 });

  for (const address of expectedAddresses) {
    await expect(page.getByText(address)).toBeVisible({ timeout: 10_000 });
  }
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
  if (extra?.ids && extra.ids.length === 0) return 0;

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

async function seedTag(
  admin: SupabaseClient<Database>,
  name: string,
): Promise<string> {
  const { data, error } = await admin
    .from("tags")
    .insert({
      org_id: DEFAULT_ORG_ID,
      name,
      category: "custom",
      system_managed: false,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  expect(data).not.toBeNull();
  return data!.id;
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
    .filter(([, memberships]) =>
      listIds.every((listId) => memberships.has(listId)),
    )
    .map(([propertyId]) => propertyId);
}

async function propertyIdsWithAnyTag(
  admin: SupabaseClient<Database>,
  tagIds: string[],
) {
  const { data, error } = await admin
    .from("property_tags")
    .select("property_id")
    .in("tag_id", tagIds);
  expect(error).toBeNull();
  return Array.from(new Set((data ?? []).map((row) => row.property_id)));
}

async function propertyIdsInEveryTag(
  admin: SupabaseClient<Database>,
  tagIds: string[],
) {
  const { data, error } = await admin
    .from("property_tags")
    .select("property_id, tag_id")
    .in("tag_id", tagIds);
  expect(error).toBeNull();

  const byProperty = new Map<string, Set<string>>();
  for (const row of data ?? []) {
    if (!byProperty.has(row.property_id)) {
      byProperty.set(row.property_id, new Set());
    }
    byProperty.get(row.property_id)!.add(row.tag_id);
  }

  return Array.from(byProperty.entries())
    .filter(([, memberships]) =>
      tagIds.every((tagId) => memberships.has(tagId)),
    )
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

async function listMemberAddresses(
  admin: SupabaseClient<Database>,
  listId: string,
  extra?: {
    status?: string;
    isVacant?: boolean | null;
    vacancyNo?: boolean;
    cassStatus?: string;
    cassStatuses?: string[];
    notCassStatuses?: string[];
    equityMin?: number;
    equityMax?: number;
    arvMin?: number;
    arvMax?: number;
    bedsMin?: number;
    bedsMax?: number;
    bathsMin?: number;
    bathsMax?: number;
    yearBuiltMin?: number;
    yearBuiltMax?: number;
    states?: string[];
    markets?: string[];
    sources?: string[];
    outreachDispos?: string[];
    absentee?: boolean | null;
    absenteeNo?: boolean;
    assignedUserIds?: string[];
    unassignedOnly?: boolean;
    createdFrom?: string;
    createdTo?: string;
    needsHuman?: boolean;
    motivationLevels?: string[];
    ids?: string[];
  },
) {
  if (extra?.ids && extra.ids.length === 0) {
    return { ids: [], addresses: [] };
  }

  let query = admin
    .from("properties")
    .select("id, address, property_lists!inner(list_id)")
    .is("deleted_at", null)
    .eq("status", extra?.status ?? "prospect")
    .eq("property_lists.list_id", listId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true });

  if (extra?.isVacant != null) query = query.eq("is_vacant", extra.isVacant);
  if (extra?.vacancyNo)
    query = query.or("is_vacant.eq.false,is_vacant.is.null");
  if (extra?.cassStatus) query = query.eq("cass_status", extra.cassStatus);
  if (extra?.cassStatuses?.length)
    query = query.in("cass_status", extra.cassStatuses);
  if (extra?.notCassStatuses?.length)
    query = query.not(
      "cass_status",
      "in",
      `(${extra.notCassStatuses.map((value) => `"${value}"`).join(",")})`,
    );
  if (extra?.equityMin != null)
    query = query.gte("equity_pct", extra.equityMin);
  if (extra?.equityMax != null)
    query = query.lte("equity_pct", extra.equityMax);
  if (extra?.arvMin != null) query = query.gte("arv", extra.arvMin);
  if (extra?.arvMax != null) query = query.lte("arv", extra.arvMax);
  if (extra?.bedsMin != null) query = query.gte("beds", extra.bedsMin);
  if (extra?.bedsMax != null) query = query.lte("beds", extra.bedsMax);
  if (extra?.bathsMin != null) query = query.gte("baths", extra.bathsMin);
  if (extra?.bathsMax != null) query = query.lte("baths", extra.bathsMax);
  if (extra?.yearBuiltMin != null)
    query = query.gte("year_built", extra.yearBuiltMin);
  if (extra?.yearBuiltMax != null)
    query = query.lte("year_built", extra.yearBuiltMax);
  if (extra?.states?.length) query = query.in("state", extra.states);
  if (extra?.markets?.length) query = query.in("market", extra.markets);
  if (extra?.sources?.length) query = query.in("source", extra.sources);
  if (extra?.outreachDispos?.length)
    query = query.in("outreach_dispo", extra.outreachDispos);
  if (extra?.absentee != null)
    query = query.eq("absentee_flag", extra.absentee);
  if (extra?.absenteeNo)
    query = query.or("absentee_flag.eq.false,absentee_flag.is.null");
  if (extra?.assignedUserIds?.length)
    query = query.in("assigned_user_id", extra.assignedUserIds);
  if (extra?.unassignedOnly) query = query.is("assigned_user_id", null);
  if (extra?.createdFrom) query = query.gte("created_at", extra.createdFrom);
  if (extra?.createdTo) query = query.lte("created_at", extra.createdTo);
  if (extra?.needsHuman != null)
    query = query.eq("needs_human_attention", extra.needsHuman);
  if (extra?.motivationLevels?.length)
    query = query.in("motivation_level", extra.motivationLevels);
  if (extra?.ids?.length) query = query.in("id", extra.ids);

  const { data, error } = await query;
  expect(error).toBeNull();
  return {
    ids: (data ?? []).map((row) => row.id),
    addresses: (data ?? []).map((row) => row.address),
  };
}

async function propertyIdsWithAnyMessageDirection(
  admin: SupabaseClient<Database>,
  direction: "inbound" | "outbound",
  options: { unreadOnly?: boolean } = {},
) {
  let query = admin
    .from("messages")
    .select("property_id")
    .eq("direction", direction)
    .not("property_id", "is", null);

  if (options.unreadOnly) query = query.is("read_at", null);

  const { data, error } = await query;
  expect(error).toBeNull();
  return new Set(
    (data ?? [])
      .map((row) => row.property_id)
      .filter((propertyId): propertyId is string => propertyId != null),
  );
}

async function propertyIdsWithEngagement(
  admin: SupabaseClient<Database>,
  buckets: Array<"never_contacted" | "attempted" | "replied" | "opted_out">,
  listIds?: string[],
) {
  const inbound = await propertyIdsWithAnyMessageDirection(admin, "inbound");
  const outbound = await propertyIdsWithAnyMessageDirection(admin, "outbound");
  let universe: Set<string> | null = null;

  if (buckets.includes("never_contacted") || listIds) {
    let query = admin
      .from("properties")
      .select("id, property_lists!inner(list_id)")
      .is("deleted_at", null)
      .eq("status", "prospect");

    if (listIds?.length) query = query.in("property_lists.list_id", listIds);

    const { data, error } = await query;
    expect(error).toBeNull();
    universe = new Set((data ?? []).map((row) => row.id));
  }

  const ids = new Set<string>();

  if (buckets.includes("replied")) {
    for (const id of inbound) ids.add(id);
  }
  if (buckets.includes("attempted")) {
    for (const id of outbound) {
      if (!inbound.has(id)) ids.add(id);
    }
  }
  if (buckets.includes("opted_out")) {
    const { data, error } = await admin
      .from("properties")
      .select("id")
      .in("outreach_dispo", ["opted_out", "dnc"]);
    expect(error).toBeNull();
    for (const row of data ?? []) ids.add(row.id);
  }
  if (buckets.includes("never_contacted")) {
    expect(universe).not.toBeNull();
    for (const id of universe ?? []) {
      if (!inbound.has(id) && !outbound.has(id)) ids.add(id);
    }
  }

  if (universe) {
    return [...ids].filter((id) => universe.has(id));
  }

  return [...ids];
}

async function propertyIdsWithOpenTasks(admin: SupabaseClient<Database>) {
  const { data, error } = await admin
    .from("tasks")
    .select("related_property_id")
    .eq("status", "open");
  expect(error).toBeNull();
  return Array.from(
    new Set(
      (data ?? [])
        .map((row) => row.related_property_id)
        // Appointment-type tasks may have no related property (personal
        // blocks, contact-only bookings) — exclude those from the oracle.
        .filter((propertyId): propertyId is string => propertyId != null),
    ),
  );
}

test.describe.serial("Properties filter contract — seeded DB oracle", () => {
  let admin: SupabaseClient<Database>;
  let prefix: string;
  let listA: string;
  let listB: string;
  let tagA: string;
  let tagB: string;
  let testUserId: string;
  let seeded: SeededProspect[];

  async function cleanupSeededRows() {
    if (!admin || !prefix) return;
    const ids = seeded?.map((property) => property.id) ?? [];
    if (ids.length > 0) {
      await admin.from("messages").delete().in("property_id", ids);
      await admin.from("tasks").delete().in("related_property_id", ids);
      await admin.from("property_tags").delete().in("property_id", ids);
    }
    if (tagA || tagB) {
      await admin.from("property_tags").delete().in("tag_id", [tagA, tagB]);
      await admin.from("tags").delete().in("id", [tagA, tagB]);
    }
    if (listA || listB) {
      await admin.from("property_lists").delete().in("list_id", [listA, listB]);
      await admin.from("lists").delete().in("id", [listA, listB]);
    }
    await admin.from("properties").delete().like("address", `${prefix}%`);
  }

  async function cleanupLeakedRowsForPrefix() {
    if (!admin || !prefix) return;
    const { data: properties } = await admin
      .from("properties")
      .select("id")
      .like("address", `${prefix}%`);
    const propertyIds = (properties ?? []).map((property) => property.id);

    if (propertyIds.length > 0) {
      await admin.from("messages").delete().in("property_id", propertyIds);
      await admin.from("tasks").delete().in("related_property_id", propertyIds);
      await admin.from("property_tags").delete().in("property_id", propertyIds);
    }

    const { data: lists } = await admin
      .from("lists")
      .select("id")
      .like("name", `${prefix}%`);
    const listIds = (lists ?? []).map((list) => list.id);

    if (listIds.length > 0) {
      await admin.from("property_lists").delete().in("list_id", listIds);
      await admin.from("lists").delete().in("id", listIds);
    }

    const { data: tags } = await admin
      .from("tags")
      .select("id")
      .like("name", `${prefix}%`);
    const tagIds = (tags ?? []).map((tag) => tag.id);

    if (tagIds.length > 0) {
      await admin.from("property_tags").delete().in("tag_id", tagIds);
      await admin.from("tags").delete().in("id", tagIds);
    }

    await admin.from("properties").delete().like("address", `${prefix}%`);
  }

  test.beforeAll(async () => {
    admin = adminClient();
    prefix = `E2E Filter Contract ${Date.now()}`;
    testUserId = await ensureTestUser(admin);
    await cleanupLeakedRowsForPrefix();
    listA = await seedList(admin, `${prefix} A`);
    listB = await seedList(admin, `${prefix} B`);
    tagA = await seedTag(admin, `${prefix} Tag A`);
    tagB = await seedTag(admin, `${prefix} Tag B`);
    seeded = await seedProspects(admin, 6, prefix);
    const now = Date.now();
    const createdAt = [
      new Date(now - 24 * 60 * 60 * 1000).toISOString(),
      new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
      new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
      new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString(),
      new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
      new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
    ];

    const updates = [
      {
        id: seeded[0].id,
        cass_status: "verified",
        is_vacant: true,
        status: "prospect",
        state: "MO",
        market: "Jackson County MO",
        source: "propstream",
        outreach_dispo: "nurture",
        absentee_flag: true,
        beds: 3,
        baths: 2,
        year_built: 1995,
        assigned_user_id: testUserId,
        needs_human_attention: true,
        motivation_level: "hot",
        created_at: createdAt[0],
      },
      {
        id: seeded[1].id,
        cass_status: "unverified",
        is_vacant: true,
        status: "prospect",
        state: "KS",
        market: "Johnson County KS",
        source: "reisift",
        outreach_dispo: "wrong_number",
        absentee_flag: false,
        beds: 2,
        baths: 1,
        year_built: 1968,
        assigned_user_id: null,
        needs_human_attention: false,
        motivation_level: "warm",
        created_at: createdAt[1],
      },
      {
        id: seeded[2].id,
        cass_status: "verified",
        is_vacant: false,
        status: "prospect",
        state: "MO",
        market: "Jackson County MO",
        source: "propstream",
        outreach_dispo: "opted_out",
        absentee_flag: null,
        beds: 4,
        baths: 3,
        year_built: 2012,
        assigned_user_id: testUserId,
        needs_human_attention: false,
        motivation_level: "cold",
        created_at: createdAt[2],
      },
      {
        id: seeded[3].id,
        cass_status: "invalid",
        is_vacant: null,
        status: "prospect",
        state: "MO",
        market: "Buchanan County MO",
        source: "referral",
        outreach_dispo: "dnc",
        absentee_flag: true,
        beds: 1,
        baths: 1,
        year_built: 1945,
        assigned_user_id: null,
        needs_human_attention: true,
        motivation_level: null,
        created_at: createdAt[3],
      },
      {
        id: seeded[4].id,
        cass_status: "verified",
        is_vacant: true,
        status: "new_lead",
        state: "MO",
        market: "Jackson County MO",
        source: "propstream",
        outreach_dispo: "callback_requested",
        absentee_flag: false,
        beds: 5,
        baths: 4,
        year_built: 2020,
        assigned_user_id: testUserId,
        needs_human_attention: true,
        motivation_level: "hot",
        created_at: createdAt[4],
      },
      {
        id: seeded[5].id,
        cass_status: "ambiguous",
        is_vacant: false,
        status: "prospect",
        state: "KS",
        market: "Johnson County KS",
        source: "titlepro",
        outreach_dispo: null,
        absentee_flag: false,
        beds: 3,
        baths: 2,
        year_built: 1980,
        assigned_user_id: null,
        needs_human_attention: false,
        motivation_level: "warm",
        created_at: createdAt[5],
      },
    ];

    for (const row of updates) {
      const { error } = await admin
        .from("properties")
        .update({
          cass_status: row.cass_status,
          is_vacant: row.is_vacant,
          status: row.status,
          state: row.state,
          market: row.market,
          source: row.source,
          outreach_dispo: row.outreach_dispo,
          absentee_flag: row.absentee_flag,
          beds: row.beds,
          baths: row.baths,
          year_built: row.year_built,
          assigned_user_id: row.assigned_user_id,
          needs_human_attention: row.needs_human_attention,
          motivation_level: row.motivation_level,
          created_at: row.created_at,
          arv: row.id === seeded[1].id ? 200_000 : 100_000,
          equity_estimate:
            row.id === seeded[0].id
              ? 60_000
              : row.id === seeded[1].id
                ? 50_000
                : row.id === seeded[2].id
                  ? 75_000
                  : row.id === seeded[4].id
                    ? 80_000
                    : 10_000,
        })
        .eq("id", row.id);
      expect(error).toBeNull();
    }

    const { error: membershipsError } = await admin
      .from("property_lists")
      .insert([
        { property_id: seeded[0].id, list_id: listA },
        { property_id: seeded[0].id, list_id: listB },
        { property_id: seeded[1].id, list_id: listA },
        { property_id: seeded[2].id, list_id: listA },
        { property_id: seeded[3].id, list_id: listB },
        { property_id: seeded[4].id, list_id: listA },
        { property_id: seeded[5].id, list_id: listB },
      ]);
    expect(membershipsError).toBeNull();

    const { error: tagsError } = await admin.from("property_tags").insert([
      {
        org_id: DEFAULT_ORG_ID,
        property_id: seeded[0].id,
        tag_id: tagA,
        source: "manual",
      },
      {
        org_id: DEFAULT_ORG_ID,
        property_id: seeded[1].id,
        tag_id: tagA,
        source: "manual",
      },
      {
        org_id: DEFAULT_ORG_ID,
        property_id: seeded[2].id,
        tag_id: tagB,
        source: "manual",
      },
      {
        org_id: DEFAULT_ORG_ID,
        property_id: seeded[3].id,
        tag_id: tagA,
        source: "manual",
      },
      {
        org_id: DEFAULT_ORG_ID,
        property_id: seeded[3].id,
        tag_id: tagB,
        source: "manual",
      },
    ]);
    expect(tagsError).toBeNull();

    const { error: messagesError } = await admin.from("messages").insert([
      {
        property_id: seeded[0].id,
        direction: "inbound",
        channel: "sms",
        status: "received",
        body: "Interested",
        read_at: null,
      },
      {
        property_id: seeded[0].id,
        direction: "outbound",
        channel: "sms",
        status: "sent",
        body: "Following up",
      },
      {
        property_id: seeded[1].id,
        direction: "outbound",
        channel: "sms",
        status: "sent",
        body: "First touch",
      },
    ]);
    expect(messagesError).toBeNull();

    const { error: taskError } = await admin.from("tasks").insert([
      {
        org_id: DEFAULT_ORG_ID,
        assignee_id: testUserId,
        related_property_id: seeded[2].id,
        type: "follow_up",
        status: "open",
        title: `${prefix} follow-up`,
        due_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_by: testUserId,
      },
      {
        org_id: DEFAULT_ORG_ID,
        assignee_id: testUserId,
        related_property_id: seeded[1].id,
        type: "follow_up",
        status: "completed",
        title: `${prefix} completed follow-up`,
        due_at: new Date(Date.now() - 86_400_000).toISOString(),
        created_by: testUserId,
      },
    ]);
    expect(taskError).toBeNull();
  });

  test.afterAll(async () => {
    await cleanupSeededRows();
  });

  test("List any matches the database count for that list", async ({
    page,
  }) => {
    const expected = await listMemberAddresses(admin, listA);

    await openFilteredProperties(
      page,
      [{ id: "list-a", kind: "list", combinator: "any", values: [listA] }],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("List plus Vacant narrows to vacant members only", async ({ page }) => {
    const expectedCount = await countListMembers(admin, listA, {
      isVacant: true,
    });
    const expected = await listMemberAddresses(admin, listA, {
      isVacant: true,
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        { id: "vacant-yes", kind: "vacancy", tri: "yes" },
      ],
      expectedCount,
      expected.addresses,
    );
  });

  test("List plus Vacant=No includes false and null vacancy states", async ({
    page,
  }) => {
    const expected = await listMemberAddresses(admin, listB, {
      vacancyNo: true,
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-b", kind: "list", combinator: "any", values: [listB] },
        { id: "vacant-no", kind: "vacancy", tri: "no" },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("List plus CASS status narrows to verified members only", async ({
    page,
  }) => {
    const expectedCount = await countListMembers(admin, listA, {
      cassStatus: "verified",
    });
    const expected = await listMemberAddresses(admin, listA, {
      cassStatus: "verified",
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        {
          id: "cass-verified",
          kind: "cass",
          combinator: "any",
          values: ["verified"],
        },
      ],
      expectedCount,
      expected.addresses,
    );
  });

  test("List plus CASS any treats multiple selected statuses as OR", async ({
    page,
  }) => {
    const expected = await listMemberAddresses(admin, listA, {
      cassStatuses: ["verified", "unverified"],
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        {
          id: "cass-verified-unverified",
          kind: "cass",
          combinator: "any",
          values: ["verified", "unverified"],
        },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("List plus CASS not excludes the selected status", async ({ page }) => {
    const expected = await listMemberAddresses(admin, listA, {
      notCassStatuses: ["verified"],
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        {
          id: "not-cass-verified",
          kind: "cass",
          combinator: "not",
          values: ["verified"],
        },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("List plus Equity % uses the generated equity_pct oracle", async ({
    page,
  }) => {
    const expected = await listMemberAddresses(admin, listA, {
      equityMin: 50,
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        { id: "equity-min", kind: "equity_pct", range: { min: 50, max: null } },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("List plus Equity % max-only includes boundary values", async ({
    page,
  }) => {
    const expected = await listMemberAddresses(admin, listA, {
      equityMax: 30,
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        { id: "equity-max", kind: "equity_pct", range: { min: null, max: 30 } },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("List plus Estimated Value range uses ARV boundaries", async ({
    page,
  }) => {
    const expected = await listMemberAddresses(admin, listA, {
      arvMin: 150_000,
      arvMax: 200_000,
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        {
          id: "estimated-value-range",
          kind: "estimated_value",
          range: { min: 150_000, max: 200_000 },
        },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("Pipeline status can intentionally leave the default Prospect scope", async ({
    page,
  }) => {
    const expectedCount = await countListMembers(admin, listA, {
      status: "new_lead",
    });
    const expected = await listMemberAddresses(admin, listA, {
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
      expected.addresses,
    );
  });

  test("Pipeline status not can intentionally leave the default Prospect scope", async ({
    page,
  }) => {
    const expected = await listMemberAddresses(admin, listA, {
      status: "new_lead",
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        {
          id: "not-prospect",
          kind: "pipeline_status",
          combinator: "not",
          values: ["prospect"],
        },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("List not excludes members of the selected list without expanding ids", async ({
    page,
  }) => {
    const idsInBoth = await propertyIdsInEveryList(admin, [listA, listB]);
    const expected = await listMemberAddresses(admin, listA, {
      ids: (seeded ?? [])
        .map((property) => property.id)
        .filter((id) => !idsInBoth.includes(id)),
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        { id: "not-list-b", kind: "list", combinator: "not", values: [listB] },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("Multi-list all requires membership in every selected list", async ({
    page,
  }) => {
    const idsInBoth = await propertyIdsInEveryList(admin, [listA, listB]);
    const expected = await listMemberAddresses(admin, listA, {
      ids: idsInBoth,
    });

    await openFilteredProperties(
      page,
      [
        {
          id: "lists-all",
          kind: "list",
          combinator: "all",
          values: [listA, listB],
        },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("Tag any composes with List", async ({ page }) => {
    const taggedIds = await propertyIdsWithAnyTag(admin, [tagA]);
    const expected = await listMemberAddresses(admin, listA, {
      ids: taggedIds,
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        { id: "tag-a", kind: "tag", combinator: "any", values: [tagA] },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("Tag all requires every selected tag", async ({ page }) => {
    const taggedIds = await propertyIdsInEveryTag(admin, [tagA, tagB]);
    const expected = await listMemberAddresses(admin, listB, {
      ids: taggedIds,
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-b", kind: "list", combinator: "any", values: [listB] },
        {
          id: "tag-a-b",
          kind: "tag",
          combinator: "all",
          values: [tagA, tagB],
        },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("Tag not excludes tagged properties", async ({ page }) => {
    const taggedIds = await propertyIdsWithAnyTag(admin, [tagA]);
    const expected = await listMemberAddresses(admin, listA, {
      ids: (seeded ?? [])
        .map((property) => property.id)
        .filter((id) => !taggedIds.includes(id)),
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        { id: "not-tag-a", kind: "tag", combinator: "not", values: [tagA] },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("List Count composes with List to find stacked prospects", async ({
    page,
  }) => {
    const stackedIds = await propertyIdsWithStackCountAtLeast(admin, 2);
    const expected = await listMemberAddresses(admin, listA, {
      ids: stackedIds,
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        { id: "stacked", kind: "list_count", range: { min: 2, max: null } },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("List Count max-only finds unstacked list members", async ({ page }) => {
    const stackedIds = await propertyIdsWithStackCountAtLeast(admin, 2);
    const expected = await listMemberAddresses(admin, listA, {
      ids: (seeded ?? [])
        .map((property) => property.id)
        .filter((id) => !stackedIds.includes(id)),
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        { id: "not-stacked", kind: "list_count", range: { min: null, max: 1 } },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("List plus Beds, Baths, and Year Built ranges compose", async ({
    page,
  }) => {
    const expected = await listMemberAddresses(admin, listA, {
      bedsMin: 4,
      bathsMin: 3,
      yearBuiltMin: 2010,
      yearBuiltMax: 2020,
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        { id: "beds-min", kind: "beds", range: { min: 4, max: null } },
        { id: "baths-min", kind: "baths", range: { min: 3, max: null } },
        {
          id: "year-built-range",
          kind: "year_built",
          range: { min: 2010, max: 2020 },
        },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("List plus State and Market multi-selects compose", async ({ page }) => {
    const expected = await listMemberAddresses(admin, listA, {
      states: ["MO"],
      markets: ["Jackson County MO"],
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        { id: "state-mo", kind: "state", combinator: "any", values: ["MO"] },
        {
          id: "market-jackson",
          kind: "market",
          combinator: "any",
          values: ["Jackson County MO"],
        },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("List plus Source and Outreach Disposition compose", async ({
    page,
  }) => {
    const expected = await listMemberAddresses(admin, listA, {
      sources: ["propstream"],
      outreachDispos: ["opted_out"],
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        {
          id: "source-propstream",
          kind: "source",
          combinator: "any",
          values: ["propstream"],
        },
        {
          id: "outreach-opted-out",
          kind: "outreach_dispo",
          combinator: "any",
          values: ["opted_out"],
        },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("List plus Absentee=No includes false and null values", async ({
    page,
  }) => {
    const expected = await listMemberAddresses(admin, listA, {
      absenteeNo: true,
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        { id: "absentee-no", kind: "absentee", tri: "no" },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("List plus Assignee supports assigned users and unassigned sentinel", async ({
    page,
  }) => {
    const expected = await listMemberAddresses(admin, listA, {
      ids: seeded.map((property) => property.id),
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        {
          id: "assigned-or-unassigned",
          kind: "assignee",
          combinator: "any",
          values: [testUserId, "unassigned"],
        },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("List plus Created Date since and prior modes use rolling cutoffs", async ({
    page,
  }) => {
    const recentCutoff = new Date(
      Date.now() - 3 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const recent = await listMemberAddresses(admin, listA, {
      createdFrom: recentCutoff,
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        {
          id: "created-since",
          kind: "created_date",
          date: { mode: "since", days: 3 },
        },
      ],
      recent.addresses.length,
      recent.addresses,
    );

    const priorCutoff = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const prior = await listMemberAddresses(admin, listA, {
      createdTo: priorCutoff,
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        {
          id: "created-prior",
          kind: "created_date",
          date: { mode: "prior", days: 7 },
        },
      ],
      prior.addresses.length,
      prior.addresses,
    );
  });

  test("List plus Needs Human Attention and Motivation Level compose", async ({
    page,
  }) => {
    const expected = await listMemberAddresses(admin, listA, {
      needsHuman: true,
      motivationLevels: ["hot"],
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        { id: "needs-human", kind: "needs_human_attention", tri: "yes" },
        {
          id: "motivation-hot",
          kind: "motivation_level",
          combinator: "any",
          values: ["hot"],
        },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("List plus Engagement replied matches the message oracle", async ({
    page,
  }) => {
    const repliedIds = await propertyIdsWithEngagement(admin, ["replied"]);
    const expected = await listMemberAddresses(admin, listA, {
      ids: repliedIds,
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        {
          id: "replied",
          kind: "engagement",
          combinator: "any",
          values: ["replied"],
        },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("List plus Engagement attempted matches outbound-only prospects", async ({
    page,
  }) => {
    const attemptedIds = await propertyIdsWithEngagement(
      admin,
      ["attempted"],
      [listA],
    );
    const expected = await listMemberAddresses(admin, listA, {
      ids: attemptedIds,
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        {
          id: "attempted",
          kind: "engagement",
          combinator: "any",
          values: ["attempted"],
        },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("List plus Engagement never_contacted matches prospects without messages", async ({
    page,
  }) => {
    const neverContactedIds = await propertyIdsWithEngagement(
      admin,
      ["never_contacted"],
      [listA],
    );
    const expected = await listMemberAddresses(admin, listA, {
      ids: neverContactedIds,
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        {
          id: "never-contacted",
          kind: "engagement",
          combinator: "any",
          values: ["never_contacted"],
        },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("List plus Engagement opted_out matches disposition-backed opt-outs", async ({
    page,
  }) => {
    const optedOutIds = await propertyIdsWithEngagement(
      admin,
      ["opted_out"],
      [listA],
    );
    const expected = await listMemberAddresses(admin, listA, {
      ids: optedOutIds,
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        {
          id: "opted-out",
          kind: "engagement",
          combinator: "any",
          values: ["opted_out"],
        },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("List plus Engagement not replied excludes inbound responders", async ({
    page,
  }) => {
    const repliedIds = await propertyIdsWithEngagement(
      admin,
      ["replied"],
      [listA],
    );
    const expected = await listMemberAddresses(admin, listA, {
      ids: seeded
        .map((property) => property.id)
        .filter((id) => !repliedIds.includes(id)),
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        {
          id: "not-replied",
          kind: "engagement",
          combinator: "not",
          values: ["replied"],
        },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("List plus Engagement attempted-or-replied matches the message oracle", async ({
    page,
  }) => {
    const engagedIds = await propertyIdsWithEngagement(admin, [
      "attempted",
      "replied",
    ]);
    const expected = await listMemberAddresses(admin, listA, {
      ids: engagedIds,
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        {
          id: "engaged",
          kind: "engagement",
          combinator: "any",
          values: ["attempted", "replied"],
        },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("List plus Has Unread Inbound matches the unread message oracle", async ({
    page,
  }) => {
    const unreadIds = [
      ...(await propertyIdsWithAnyMessageDirection(admin, "inbound", {
        unreadOnly: true,
      })),
    ];
    const expected = await listMemberAddresses(admin, listA, {
      ids: unreadIds,
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        { id: "unread", kind: "has_unread_inbound", tri: "yes" },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("List plus Has Unread Inbound=No excludes unread responders", async ({
    page,
  }) => {
    const unreadIds = [
      ...(await propertyIdsWithAnyMessageDirection(admin, "inbound", {
        unreadOnly: true,
      })),
    ];
    const expected = await listMemberAddresses(admin, listA, {
      ids: seeded
        .map((property) => property.id)
        .filter((id) => !unreadIds.includes(id)),
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        { id: "not-unread", kind: "has_unread_inbound", tri: "no" },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("List plus Has Open Tasks matches the task oracle", async ({ page }) => {
    const taskIds = await propertyIdsWithOpenTasks(admin);
    const expected = await listMemberAddresses(admin, listA, {
      ids: taskIds,
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        { id: "open-task", kind: "has_open_tasks", tri: "yes" },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });

  test("List plus Has Open Tasks=No excludes open-task properties", async ({
    page,
  }) => {
    const taskIds = await propertyIdsWithOpenTasks(admin);
    const expected = await listMemberAddresses(admin, listA, {
      ids: seeded
        .map((property) => property.id)
        .filter((id) => !taskIds.includes(id)),
    });

    await openFilteredProperties(
      page,
      [
        { id: "list-a", kind: "list", combinator: "any", values: [listA] },
        { id: "no-open-task", kind: "has_open_tasks", tri: "no" },
      ],
      expected.addresses.length,
      expected.addresses,
    );
  });
});
