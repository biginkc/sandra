import { expect, test, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { adminClient, ensureTestUser, seedList } from "./fixtures";
import type { Database } from "../src/lib/supabase/types";
import type { FilterBlock } from "../src/lib/prospects/filter-schema";

const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000bbb";
const ORACLE_PREFIX = "E2E DB Oracle Smoke";

type Oracle = {
  count: number;
  addresses: string[];
};

type Scenario = {
  name: string;
  blocks: FilterBlock[];
  oracle: Oracle;
};

function encodedFilters(blocks: FilterBlock[]) {
  return encodeURIComponent(JSON.stringify({ v: 1, blocks }));
}

async function expectScenarioMatchesPage(page: Page, scenario: Scenario) {
  const url = `/properties?filters=${encodedFilters(scenario.blocks)}`;
  const summary = page
    .getByText(
      new RegExp(
        `Showing 1.* of ${scenario.oracle.count.toLocaleString()} prospect`,
      ),
    )
    .first();

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.goto(url);
    await page.getByRole("heading", { name: "Prospects" }).waitFor();
    await expect(page.getByText(/Failed to load prospects/i)).not.toBeVisible({
      timeout: 10_000,
    });
    try {
      await expect(summary, `${scenario.name} count`).toBeVisible({
        timeout: 5_000,
      });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;

  for (const address of scenario.oracle.addresses.slice(0, 5)) {
    await expect(
      page.getByText(address),
      `${scenario.name} first-page address ${address}`,
    ).toBeVisible();
  }
}

async function listOracle(
  admin: SupabaseClient<Database>,
  listId: string,
  extra: {
    status?: string;
    isVacant?: boolean;
    cassStatuses?: string[];
    equityMin?: number;
    ids?: string[];
  } = {},
): Promise<Oracle> {
  if (extra.ids && extra.ids.length === 0) return { count: 0, addresses: [] };

  let query = admin
    .from("properties")
    .select("id, address, created_at, property_lists!inner(list_id)", {
      count: "exact",
    })
    .is("deleted_at", null)
    .eq("status", extra.status ?? "prospect")
    .eq("property_lists.list_id", listId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(0, 49);

  if (extra.isVacant != null) query = query.eq("is_vacant", extra.isVacant);
  if (extra.cassStatuses?.length)
    query = query.in("cass_status", extra.cassStatuses);
  if (extra.equityMin != null) query = query.gte("equity_pct", extra.equityMin);
  if (extra.ids?.length) query = query.in("id", extra.ids);

  const { data, count, error } = await query;
  expect(error).toBeNull();
  return {
    count: count ?? 0,
    addresses: (data ?? []).map((row) => row.address),
  };
}

async function pipelineOracle(
  admin: SupabaseClient<Database>,
  status: string,
): Promise<Oracle> {
  const { data, count, error } = await admin
    .from("properties")
    .select("id, address, created_at", { count: "exact" })
    .is("deleted_at", null)
    .eq("status", status)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(0, 49);
  expect(error).toBeNull();
  return {
    count: count ?? 0,
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

async function propertyIdsWithOpenTasks(admin: SupabaseClient<Database>) {
  const { data, error } = await admin
    .from("tasks")
    .select("related_property_id")
    .eq("status", "open");
  expect(error).toBeNull();
  return Array.from(
    new Set((data ?? []).map((row) => row.related_property_id)),
  );
}

async function propertyIdsWithEngagement(
  admin: SupabaseClient<Database>,
  bucket: "attempted" | "replied" | "never_contacted",
  listId: string,
) {
  const inbound = await propertyIdsWithAnyMessageDirection(admin, "inbound");
  const outbound = await propertyIdsWithAnyMessageDirection(admin, "outbound");
  const universe = await listOracle(admin, listId);

  const { data, error } = await admin
    .from("properties")
    .select("id, property_lists!inner(list_id)")
    .is("deleted_at", null)
    .eq("status", "prospect")
    .eq("property_lists.list_id", listId);
  expect(error).toBeNull();
  const listIds = (data ?? []).map((row) => row.id);
  if (universe.count === 0) return [];

  if (bucket === "replied") return listIds.filter((id) => inbound.has(id));
  if (bucket === "attempted") {
    return listIds.filter((id) => outbound.has(id) && !inbound.has(id));
  }
  return listIds.filter((id) => !outbound.has(id) && !inbound.has(id));
}

async function discoverLargestList(admin: SupabaseClient<Database>) {
  const { data: lists, error } = await admin
    .from("lists")
    .select("id, name")
    .is("archived_at", null);
  expect(error).toBeNull();

  let best: { id: string; name: string; count: number } | null = null;
  for (const list of lists ?? []) {
    const oracle = await listOracle(admin, list.id);
    if (oracle.count > 0 && (!best || oracle.count > best.count)) {
      best = { id: list.id, name: list.name, count: oracle.count };
    }
  }
  return best;
}

async function ensureFallbackData(admin: SupabaseClient<Database>) {
  const existing = await discoverLargestList(admin);
  if (existing && existing.count >= 5) return;

  const testUserId = await ensureTestUser(admin);
  await cleanupFallbackData(admin);
  const listA = await seedList(admin, `${ORACLE_PREFIX} A`);
  const listB = await seedList(admin, `${ORACLE_PREFIX} B`);
  const now = Date.now();

  const { data: seeded, error: seedError } = await admin
    .from("properties")
    .insert(
      Array.from({ length: 8 }, (_, index) => ({
        address: `${ORACLE_PREFIX} ${index + 1} Golden Path Ln`,
        city: "Kansas City",
        state: index % 2 === 0 ? "MO" : "KS",
        zip: "64151",
        market: index % 2 === 0 ? "Jackson County MO" : "Johnson County KS",
        created_at: new Date(now - index * 86_400_000).toISOString(),
        cass_status: index % 2 === 0 ? "verified" : "unverified",
        is_vacant: index % 3 === 0,
        status: index === 7 ? "new_lead" : "prospect",
        arv: index === 1 ? 200_000 : 100_000,
        equity_estimate: index === 1 ? 50_000 : 70_000,
        outreach_dispo: index === 3 ? "opted_out" : null,
      })),
    )
    .select("id, address");
  expect(seedError).toBeNull();
  expect(seeded).not.toBeNull();

  const memberships = (seeded ?? []).flatMap((property, index) => [
    { property_id: property.id, list_id: listA },
    ...(index % 2 === 0 ? [{ property_id: property.id, list_id: listB }] : []),
  ]);
  const { error: membershipError } = await admin
    .from("property_lists")
    .insert(memberships);
  expect(membershipError).toBeNull();

  const { error: messageError } = await admin.from("messages").insert([
    {
      property_id: seeded![0].id,
      direction: "inbound",
      channel: "sms",
      status: "received",
      body: "Interested",
      read_at: null,
    },
    {
      property_id: seeded![1].id,
      direction: "outbound",
      channel: "sms",
      status: "sent",
      body: "Checking in",
    },
  ]);
  expect(messageError).toBeNull();

  const { error: taskError } = await admin.from("tasks").insert({
    org_id: DEFAULT_ORG_ID,
    assignee_id: testUserId,
    related_property_id: seeded![2].id,
    type: "follow_up",
    status: "open",
    title: `${ORACLE_PREFIX} open task`,
    due_at: new Date(now + 86_400_000).toISOString(),
    created_by: testUserId,
  });
  expect(taskError).toBeNull();
}

async function cleanupFallbackData(admin: SupabaseClient<Database>) {
  const { data: properties } = await admin
    .from("properties")
    .select("id")
    .like("address", `${ORACLE_PREFIX}%`);
  const propertyIds = (properties ?? []).map((property) => property.id);
  if (propertyIds.length > 0) {
    await admin.from("messages").delete().in("property_id", propertyIds);
    await admin.from("tasks").delete().in("related_property_id", propertyIds);
    await admin.from("property_lists").delete().in("property_id", propertyIds);
    await admin.from("properties").delete().in("id", propertyIds);
  }

  const { data: lists } = await admin
    .from("lists")
    .select("id")
    .like("name", `${ORACLE_PREFIX}%`);
  const listIds = (lists ?? []).map((list) => list.id);
  if (listIds.length > 0) {
    await admin.from("property_lists").delete().in("list_id", listIds);
    await admin.from("lists").delete().in("id", listIds);
  }
}

async function discoverScenarios(admin: SupabaseClient<Database>) {
  await ensureFallbackData(admin);
  const list = await discoverLargestList(admin);
  if (!list) return [];

  const scenarios: Scenario[] = [];
  const push = async (
    name: string,
    blocks: FilterBlock[],
    oracle: Promise<Oracle>,
  ) => {
    const resolved = await oracle;
    if (resolved.count > 0) scenarios.push({ name, blocks, oracle: resolved });
  };

  await push(
    `largest list: ${list.name}`,
    [{ id: "oracle-list", kind: "list", combinator: "any", values: [list.id] }],
    listOracle(admin, list.id),
  );
  await push(
    `largest list + CASS verified`,
    [
      { id: "oracle-list", kind: "list", combinator: "any", values: [list.id] },
      {
        id: "oracle-cass",
        kind: "cass",
        combinator: "any",
        values: ["verified"],
      },
    ],
    listOracle(admin, list.id, { cassStatuses: ["verified"] }),
  );
  await push(
    `largest list + equity >= 50`,
    [
      { id: "oracle-list", kind: "list", combinator: "any", values: [list.id] },
      {
        id: "oracle-equity",
        kind: "equity_pct",
        range: { min: 50, max: null },
      },
    ],
    listOracle(admin, list.id, { equityMin: 50 }),
  );
  await push(
    `largest list + vacant`,
    [
      { id: "oracle-list", kind: "list", combinator: "any", values: [list.id] },
      { id: "oracle-vacant", kind: "vacancy", tri: "yes" },
    ],
    listOracle(admin, list.id, { isVacant: true }),
  );

  const repliedIds = await propertyIdsWithEngagement(admin, "replied", list.id);
  await push(
    `largest list + engagement replied`,
    [
      { id: "oracle-list", kind: "list", combinator: "any", values: [list.id] },
      {
        id: "oracle-replied",
        kind: "engagement",
        combinator: "any",
        values: ["replied"],
      },
    ],
    listOracle(admin, list.id, { ids: repliedIds }),
  );

  const attemptedIds = await propertyIdsWithEngagement(
    admin,
    "attempted",
    list.id,
  );
  await push(
    `largest list + engagement attempted`,
    [
      { id: "oracle-list", kind: "list", combinator: "any", values: [list.id] },
      {
        id: "oracle-attempted",
        kind: "engagement",
        combinator: "any",
        values: ["attempted"],
      },
    ],
    listOracle(admin, list.id, { ids: attemptedIds }),
  );

  const unreadIds = [
    ...(await propertyIdsWithAnyMessageDirection(admin, "inbound", {
      unreadOnly: true,
    })),
  ];
  await push(
    `largest list + unread inbound`,
    [
      { id: "oracle-list", kind: "list", combinator: "any", values: [list.id] },
      { id: "oracle-unread", kind: "has_unread_inbound", tri: "yes" },
    ],
    listOracle(admin, list.id, { ids: unreadIds }),
  );

  await push(
    `largest list + open tasks`,
    [
      { id: "oracle-list", kind: "list", combinator: "any", values: [list.id] },
      { id: "oracle-open-tasks", kind: "has_open_tasks", tri: "yes" },
    ],
    listOracle(admin, list.id, { ids: await propertyIdsWithOpenTasks(admin) }),
  );

  await push(
    `pipeline status new_lead`,
    [
      {
        id: "oracle-new-lead",
        kind: "pipeline_status",
        combinator: "any",
        values: ["new_lead"],
      },
    ],
    pipelineOracle(admin, "new_lead"),
  );

  return scenarios;
}

test.describe.serial("Properties filter DB oracle smoke", () => {
  let admin: SupabaseClient<Database>;

  test.beforeAll(async () => {
    admin = adminClient();
  });

  test.afterAll(async () => {
    await cleanupFallbackData(admin);
  });

  test("discovers meaningful DB scenarios and verifies Sandra renders the same rows", async ({
    page,
  }, testInfo) => {
    const scenarios = await discoverScenarios(admin);
    testInfo.annotations.push({
      type: "db-oracle-scenarios",
      description: scenarios.map((scenario) => scenario.name).join("; "),
    });

    test.skip(
      scenarios.length < 4,
      `Only found ${scenarios.length} meaningful DB-backed filter scenarios.`,
    );

    for (const scenario of scenarios) {
      await test.step(scenario.name, async () => {
        await expectScenarioMatchesPage(page, scenario);
      });
    }
  });
});
