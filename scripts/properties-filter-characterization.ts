#!/usr/bin/env tsx

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

import {
  applyFilters,
  filterSelectFragment,
} from "../src/lib/prospects/filter-to-supabase";
import {
  encodeFilters,
  type BlockStack,
  type Combinator,
  type FilterBlock,
  type TriBool,
} from "../src/lib/prospects/filter-schema";
import { parseProspectsSearch } from "../src/app/(dashboard)/properties/prospects-query";
import type { Database } from "../src/lib/supabase/types";

const PROJECT_REF = "copflsklaefwzipsrjqz";
const ORG_ID = "00000000-0000-0000-0000-000000000bbb";
const SUPABASE_URL = requiredEnv("NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL");
const SUPABASE_ANON_KEY = requiredEnv(
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
);
const TEST_EMAIL = process.env.PROD_EMAIL ?? "sandra-filter-test@bmhgroupkc.com";
const PROD_PASSWORD = requiredEnv("PROD_PASSWORD");
const OUT_DIR = "docs/qa/properties-filter-characterization";
const ACTUAL_COUNT_TIMEOUT_MS = 20_000;

if (!SUPABASE_URL.includes(PROJECT_REF)) {
  throw new Error(`Refusing to run against non-production Supabase URL for ${PROJECT_REF}.`);
}

type PropertyRow = {
  id: string;
  org_id: string;
  status: string | null;
  cass_status: string | null;
  is_vacant: boolean | null;
  outreach_dispo: string | null;
  source: string | null;
  beds: number | null;
  baths: number | null;
  year_built: number | null;
  state: string | null;
  market: string | null;
  absentee_flag: boolean | null;
  arv: number | null;
  equity_pct: number | null;
  assigned_user_id: string | null;
  created_at: string;
  needs_human_attention: boolean | null;
  motivation_level: string | null;
};

type Scenario = {
  name: string;
  blocks: BlockStack;
};

type ResultRow = {
  filter: string;
  scenario: string;
  blocks: BlockStack;
  expected: number;
  actual: number | null;
  pass: boolean;
  error: string | null;
  encodedLength: number;
};

type DataSet = {
  properties: PropertyRow[];
  propertyListsByProperty: Map<string, Set<string>>;
  propertyTagsByProperty: Map<string, Set<string>>;
  inboundIds: Set<string>;
  outboundIds: Set<string>;
  unreadInboundIds: Set<string>;
  openTaskIds: Set<string>;
  lists: Array<{ id: string; name: string }>;
  tags: Array<{ id: string; name: string; category: string | null }>;
  teamUsers: string[];
};

function maskError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
  return message
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<jwt>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>");
}

function requiredEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.length > 0) return value;
  }
  throw new Error(
    `Missing required env var (${names.join(" or ")}). Run: source /tmp/sandra-prod.env`,
  );
}

async function paged<T>(
  queryFactory: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await queryFactory(from, to);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

async function loadData(user: SupabaseClient<Database>): Promise<DataSet> {
  const properties = await paged<PropertyRow>((from, to) =>
    user
      .from("properties")
      .select(
        [
          "id",
          "org_id",
          "status",
          "cass_status",
          "is_vacant",
          "outreach_dispo",
          "source",
          "beds",
          "baths",
          "year_built",
          "state",
          "market",
          "absentee_flag",
          "arv",
          "equity_pct",
          "assigned_user_id",
          "created_at",
          "needs_human_attention",
          "motivation_level",
        ].join(", "),
      )
      .eq("org_id", ORG_ID)
      .is("deleted_at", null)
      .order("id", { ascending: true })
      .range(from, to) as never,
  );

  const propertyLists = await paged<{ property_id: string; list_id: string }>((from, to) =>
    user
      .from("property_lists")
      .select("property_id, list_id")
      .eq("org_id", ORG_ID)
      .order("property_id", { ascending: true })
      .range(from, to) as never,
  );
  const propertyTags = await paged<{ property_id: string; tag_id: string }>((from, to) =>
    user
      .from("property_tags")
      .select("property_id, tag_id")
      .eq("org_id", ORG_ID)
      .order("property_id", { ascending: true })
      .range(from, to) as never,
  );
  const messages = await paged<{ property_id: string | null; direction: string; read_at: string | null }>((from, to) =>
    user
      .from("messages")
      .select("property_id, direction, read_at")
      .eq("org_id", ORG_ID)
      .not("property_id", "is", null)
      .order("property_id", { ascending: true })
      .range(from, to) as never,
  );
  const tasks = await paged<{ related_property_id: string | null; status: string }>((from, to) =>
    user
      .from("tasks")
      .select("related_property_id, status")
      .eq("org_id", ORG_ID)
      .eq("status", "open")
      .not("related_property_id", "is", null)
      .order("related_property_id", { ascending: true })
      .range(from, to) as never,
  );
  const lists = await paged<{ id: string; name: string }>((from, to) =>
    user
      .from("lists")
      .select("id, name")
      .eq("org_id", ORG_ID)
      .order("name", { ascending: true })
      .range(from, to) as never,
  );
  const tags = await paged<{ id: string; name: string; category: string | null }>((from, to) =>
    user
      .from("tags")
      .select("id, name, category")
      .eq("org_id", ORG_ID)
      .eq("category", "custom")
      .order("name", { ascending: true })
      .range(from, to) as never,
  );

  const byList = new Map<string, Set<string>>();
  for (const row of propertyLists) {
    if (!byList.has(row.property_id)) byList.set(row.property_id, new Set());
    byList.get(row.property_id)!.add(row.list_id);
  }
  const byTag = new Map<string, Set<string>>();
  for (const row of propertyTags) {
    if (!byTag.has(row.property_id)) byTag.set(row.property_id, new Set());
    byTag.get(row.property_id)!.add(row.tag_id);
  }

  const inboundIds = new Set<string>();
  const outboundIds = new Set<string>();
  const unreadInboundIds = new Set<string>();
  for (const row of messages) {
    if (!row.property_id) continue;
    if (row.direction === "inbound") {
      inboundIds.add(row.property_id);
      if (row.read_at == null) unreadInboundIds.add(row.property_id);
    }
    if (row.direction === "outbound") outboundIds.add(row.property_id);
  }

  return {
    properties,
    propertyListsByProperty: byList,
    propertyTagsByProperty: byTag,
    inboundIds,
    outboundIds,
    unreadInboundIds,
    openTaskIds: new Set(tasks.map((row) => row.related_property_id).filter(Boolean) as string[]),
    lists,
    tags,
    teamUsers: Array.from(
      new Set(properties.map((row) => row.assigned_user_id).filter(Boolean) as string[]),
    ).sort(),
  };
}

function distinctValues<K extends keyof PropertyRow>(
  rows: PropertyRow[],
  key: K,
  limit = Number.POSITIVE_INFINITY,
): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = row[key];
    if (typeof value !== "string" || value.length === 0) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

function numericCuts(
  rows: PropertyRow[],
  key: keyof PropertyRow,
  avoidExactObservedValues = false,
): number[] {
  const values = rows
    .map((row) => row[key])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (values.length === 0) return [];
  if (avoidExactObservedValues) {
    const distinct = Array.from(new Set(values));
    if (distinct.length < 2) return distinct;
    const atMidpoint = (p: number) => {
      const index = Math.min(
        distinct.length - 2,
        Math.max(0, Math.floor(distinct.length * p)),
      );
      return (distinct[index] + distinct[index + 1]) / 2;
    };
    return Array.from(
      new Set([atMidpoint(0.1), atMidpoint(0.25), atMidpoint(0.5), atMidpoint(0.75), atMidpoint(0.9)]),
    );
  }
  const at = (p: number) => values[Math.min(values.length - 1, Math.max(0, Math.floor(values.length * p)))];
  return Array.from(new Set([at(0.1), at(0.25), at(0.5), at(0.75), at(0.9)].filter((value) => value != null)));
}

function addScenario(scenarios: Scenario[], name: string, block: FilterBlock): void {
  scenarios.push({ name, blocks: [block] });
}

function addMultiScenarios(
  scenarios: Scenario[],
  kind: Extract<FilterBlock, { combinator: Combinator }>["kind"],
  label: string,
  values: string[],
  cap = Number.POSITIVE_INFINITY,
): void {
  const capped = values.slice(0, cap);
  for (const value of capped) {
    addScenario(scenarios, `${label}: any ${value}`, {
      id: `${kind}-any-${value}`,
      kind,
      combinator: "any",
      values: [value],
    } as FilterBlock);
  }
  if (capped.length >= 2) {
    for (const combinator of ["any", "all", "not"] as const) {
      addScenario(scenarios, `${label}: ${combinator} first 2`, {
        id: `${kind}-${combinator}-first-2`,
        kind,
        combinator,
        values: capped.slice(0, 2),
      } as FilterBlock);
    }
    addScenario(scenarios, `${label}: not first`, {
      id: `${kind}-not-first`,
      kind,
      combinator: "not",
      values: [capped[0]],
    } as FilterBlock);
  }
}

function buildScenarios(data: DataSet): Scenario[] {
  const scenarios: Scenario[] = [{ name: "baseline prospect default", blocks: [] }];

  const props = data.properties;
  addMultiScenarios(scenarios, "list", "List", data.lists.map((list) => list.id), 80);
  addMultiScenarios(scenarios, "tag", "Tag", data.tags.map((tag) => tag.id), 80);
  addMultiScenarios(scenarios, "cass", "CASS", ["verified", "unverified", "invalid", "ambiguous"]);
  addMultiScenarios(
    scenarios,
    "outreach_dispo",
    "Outreach Disposition",
    ["wrong_number", "bad_number", "not_interested", "opted_out", "dnc", "nurture", "callback_requested"],
  );
  addMultiScenarios(
    scenarios,
    "source",
    "Source",
    [
      "dealmachine",
      "propstream",
      "titlepro",
      "reisift",
      "agent_outreach",
      "driving_for_dollars",
      "referral",
      "cold_call",
      "sms",
      "web_form",
      "direct_mail",
    ],
  );
  addMultiScenarios(scenarios, "state", "State", distinctValues(props, "state"));
  addMultiScenarios(scenarios, "market", "Market", distinctValues(props, "market"), 80);
  addMultiScenarios(
    scenarios,
    "pipeline_status",
    "Pipeline Status",
    ["prospect", "new_lead", "contacted", "interested", "offer_sent", "offer_declined", "under_contract", "closed", "dead"],
  );
  addMultiScenarios(scenarios, "assignee", "Assignee", ["unassigned", ...data.teamUsers], 80);
  addMultiScenarios(scenarios, "motivation_level", "Motivation Level", ["hot", "warm", "cold"]);
  addMultiScenarios(scenarios, "engagement", "Engagement", ["never_contacted", "attempted", "replied", "opted_out"]);

  for (const kind of ["vacancy", "absentee", "has_unread_inbound", "needs_human_attention", "has_open_tasks"] as const) {
    for (const tri of ["yes", "no", "any"] as const) {
      addScenario(scenarios, `${kind}: ${tri}`, { id: `${kind}-${tri}`, kind, tri });
    }
  }

  const ranges: Array<[Extract<FilterBlock, { range: { min: number | null; max: number | null } }>["kind"], keyof PropertyRow, string]> = [
    ["beds", "beds", "Beds"],
    ["baths", "baths", "Baths"],
    ["year_built", "year_built", "Year Built"],
    ["estimated_value", "arv", "Estimated Value"],
    ["equity_pct", "equity_pct", "Equity %"],
  ];
  for (const [kind, key, label] of ranges) {
    const cuts = numericCuts(props, key, kind === "equity_pct");
    for (const cut of cuts) {
      addScenario(scenarios, `${label}: min ${cut}`, { id: `${kind}-min-${cut}`, kind, range: { min: cut, max: null } } as FilterBlock);
      addScenario(scenarios, `${label}: max ${cut}`, { id: `${kind}-max-${cut}`, kind, range: { min: null, max: cut } } as FilterBlock);
    }
    if (cuts.length >= 4) {
      addScenario(scenarios, `${label}: middle band`, {
        id: `${kind}-band`,
        kind,
        range: { min: cuts[1], max: cuts[cuts.length - 2] },
      } as FilterBlock);
    }
  }

  for (const range of [
    { min: 1, max: null },
    { min: 2, max: null },
    { min: 3, max: null },
    { min: null, max: 1 },
    { min: 2, max: 3 },
  ]) {
    addScenario(scenarios, `List Count: ${JSON.stringify(range)}`, {
      id: `list-count-${range.min ?? "null"}-${range.max ?? "null"}`,
      kind: "list_count",
      range,
    });
  }

  const now = new Date();
  const since30 = new Date(now.getTime() - 30 * 86400000).toISOString();
  const since180 = new Date(now.getTime() - 180 * 86400000).toISOString();
  addScenario(scenarios, "Created Date: since 30 days", {
    id: "created-since-30",
    kind: "created_date",
    date: { mode: "since", days: 30 },
  });
  addScenario(scenarios, "Created Date: prior 180 days", {
    id: "created-prior-180",
    kind: "created_date",
    date: { mode: "prior", days: 180 },
  });
  addScenario(scenarios, "Created Date: fixed 180 to 30 days ago", {
    id: "created-fixed",
    kind: "created_date",
    date: { mode: "fixed", from: since180, to: since30 },
  });

  const comboBlocks: BlockStack[] = [
    [
      { id: "combo-vacant", kind: "vacancy", tri: "yes" },
      { id: "combo-cass", kind: "cass", combinator: "any", values: ["verified"] },
    ],
    [
      { id: "combo-list-count", kind: "list_count", range: { min: 2, max: null } },
      { id: "combo-equity", kind: "equity_pct", range: { min: 40, max: null } },
    ],
    [
      { id: "combo-engaged", kind: "engagement", combinator: "any", values: ["attempted", "replied"] },
      { id: "combo-tasks", kind: "has_open_tasks", tri: "no" },
    ],
  ];
  comboBlocks.forEach((blocks, index) =>
    scenarios.push({ name: `Cross-filter combo ${index + 1}`, blocks }),
  );

  if (data.lists.length >= 2) {
    scenarios.push({
      name: "Repeated list positive blocks",
      blocks: [
        {
          id: "list-any-first",
          kind: "list",
          combinator: "any",
          values: [data.lists[0].id],
        },
        {
          id: "list-any-second",
          kind: "list",
          combinator: "any",
          values: [data.lists[1].id],
        },
      ],
    });
    scenarios.push({
      name: "Repeated list negative blocks",
      blocks: [
        {
          id: "list-not-first",
          kind: "list",
          combinator: "not",
          values: [data.lists[0].id],
        },
        {
          id: "list-not-second",
          kind: "list",
          combinator: "not",
          values: [data.lists[1].id],
        },
      ],
    });
  }
  if (data.tags.length >= 2) {
    scenarios.push({
      name: "Repeated tag positive blocks",
      blocks: [
        {
          id: "tag-any-first",
          kind: "tag",
          combinator: "any",
          values: [data.tags[0].id],
        },
        {
          id: "tag-any-second",
          kind: "tag",
          combinator: "any",
          values: [data.tags[1].id],
        },
      ],
    });
    scenarios.push({
      name: "Repeated tag negative blocks",
      blocks: [
        {
          id: "tag-not-first",
          kind: "tag",
          combinator: "not",
          values: [data.tags[0].id],
        },
        {
          id: "tag-not-second",
          kind: "tag",
          combinator: "not",
          values: [data.tags[1].id],
        },
      ],
    });
  }

  return scenarios;
}

function applyTri(value: boolean | null, tri: TriBool): boolean {
  if (tri === "any") return true;
  if (tri === "yes") return value === true;
  return value === false || value == null;
}

function applyMulti(value: string | null, values: string[], combinator: Combinator): boolean {
  if (values.length === 0) return true;
  if (combinator === "all") {
    return values.length === 1 ? value === values[0] : false;
  }
  if (combinator === "not") {
    return value != null && !values.includes(value);
  }
  return value != null && values.includes(value);
}

function applyRange(value: number | null, range: { min: number | null; max: number | null }): boolean {
  if (range.min == null && range.max == null) return true;
  if (value == null) return false;
  if (range.min != null && value < range.min) return false;
  if (range.max != null && value > range.max) return false;
  return true;
}

function setMatches(values: Set<string> | undefined, selected: string[], combinator: Combinator): boolean {
  const set = values ?? new Set<string>();
  if (selected.length === 0) return true;
  if (combinator === "all") return selected.every((id) => set.has(id));
  if (combinator === "not") return selected.every((id) => !set.has(id));
  return selected.some((id) => set.has(id));
}

function engagementBuckets(row: PropertyRow, data: DataSet): Set<string> {
  const buckets = new Set<string>();
  const inbound = data.inboundIds.has(row.id);
  const outbound = data.outboundIds.has(row.id);
  if (inbound) buckets.add("replied");
  if (outbound && !inbound) buckets.add("attempted");
  if (!outbound && !inbound) buckets.add("never_contacted");
  if (row.outreach_dispo === "opted_out" || row.outreach_dispo === "dnc") buckets.add("opted_out");
  return buckets;
}

function dateMatches(createdAt: string, block: Extract<FilterBlock, { kind: "created_date" }>): boolean {
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return false;
  if (block.date.mode === "fixed") {
    if (block.date.from && created < Date.parse(block.date.from)) return false;
    if (block.date.to && created > Date.parse(block.date.to)) return false;
    return true;
  }
  const cutoff = Date.now() - block.date.days * 86400000;
  if (block.date.mode === "since") return created >= cutoff;
  return created <= cutoff;
}

function blockMatches(row: PropertyRow, block: FilterBlock, data: DataSet): boolean {
  switch (block.kind) {
    case "vacancy":
      return applyTri(row.is_vacant, block.tri);
    case "absentee":
      return applyTri(row.absentee_flag, block.tri);
    case "needs_human_attention":
      return applyTri(row.needs_human_attention, block.tri);
    case "cass":
      return applyMulti(row.cass_status, block.values, block.combinator);
    case "outreach_dispo":
      return applyMulti(row.outreach_dispo, block.values, block.combinator);
    case "source":
      return applyMulti(row.source, block.values, block.combinator);
    case "state":
      return applyMulti(row.state, block.values, block.combinator);
    case "market":
      return applyMulti(row.market, block.values, block.combinator);
    case "pipeline_status":
      return applyMulti(row.status, block.values, block.combinator);
    case "motivation_level":
      return applyMulti(row.motivation_level, block.values, block.combinator);
    case "beds":
      return applyRange(row.beds, block.range);
    case "baths":
      return applyRange(row.baths, block.range);
    case "year_built":
      return applyRange(row.year_built, block.range);
    case "estimated_value":
      return applyRange(row.arv, block.range);
    case "equity_pct":
      return applyRange(row.equity_pct, block.range);
    case "created_date":
      return dateMatches(row.created_at, block);
    case "assignee": {
      if (block.values.length === 0) return true;
      const hasUnassigned = block.values.includes("unassigned");
      const uuids = block.values.filter((value) => value !== "unassigned");
      if (block.combinator === "not") {
        if (hasUnassigned && row.assigned_user_id == null) return false;
        if (row.assigned_user_id && uuids.includes(row.assigned_user_id)) return false;
        return true;
      }
      if (row.assigned_user_id == null) return hasUnassigned;
      return uuids.includes(row.assigned_user_id);
    }
    case "list":
      return setMatches(data.propertyListsByProperty.get(row.id), block.values, block.combinator);
    case "tag":
      return setMatches(data.propertyTagsByProperty.get(row.id), block.values, block.combinator);
    case "list_count": {
      const count = data.propertyListsByProperty.get(row.id)?.size ?? 0;
      return applyRange(count, block.range);
    }
    case "engagement": {
      const buckets = engagementBuckets(row, data);
      if (block.values.length === 0) return true;
      if (block.combinator === "all") return block.values.every((value) => buckets.has(value));
      if (block.combinator === "not") return block.values.every((value) => !buckets.has(value));
      return block.values.some((value) => buckets.has(value));
    }
    case "has_unread_inbound":
      return applyTri(data.unreadInboundIds.has(row.id), block.tri);
    case "has_open_tasks":
      return applyTri(data.openTaskIds.has(row.id), block.tri);
    default: {
      const _exhaustive: never = block;
      return _exhaustive;
    }
  }
}

function oracleCount(blocks: BlockStack, data: DataSet): number {
  const hasPipelineStatus = blocks.some((block) => block.kind === "pipeline_status");
  return data.properties.filter((row) => {
    if (!hasPipelineStatus && row.status !== "prospect") return false;
    return blocks.every((block) => blockMatches(row, block, data));
  }).length;
}

function filterName(blocks: BlockStack): string {
  if (blocks.length === 0) return "baseline";
  if (blocks.length === 1) return blocks[0].kind;
  return blocks.map((block) => block.kind).join("+");
}

async function actualCount(user: SupabaseClient<Database>, blocks: BlockStack): Promise<number> {
  const encoded = encodeFilters({ v: 1, blocks });
  const parsed = parseProspectsSearch({ filters: encoded });
  const hasPipelineStatusBlock = parsed.blockStack.some((block) => block.kind === "pipeline_status");
  const propertyListSelect = filterSelectFragment(parsed.blockStack);
  const propertiesSelect = ["id", propertyListSelect].filter(Boolean).join(", ");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ACTUAL_COUNT_TIMEOUT_MS);

  let query = user
    .from("properties")
    .select(propertiesSelect, { count: "exact", head: true })
    .eq("org_id", ORG_ID)
    .is("deleted_at", null);
  if (!hasPipelineStatusBlock) {
    query = query.eq("status", "prospect");
  }
  query = (await applyFilters(query, parsed.blockStack, user)).builder;
  try {
    if (typeof query.abortSignal === "function") {
      query = query.abortSignal(controller.signal);
    }
    const { count, error } = await query;
    if (error) throw new Error(error.message);
    return count ?? 0;
  } finally {
    clearTimeout(timer);
  }
}

async function actualCountWithTimeout(
  user: SupabaseClient<Database>,
  blocks: BlockStack,
): Promise<number> {
  return await Promise.race([
    actualCount(user, blocks),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`actual count timed out after ${ACTUAL_COUNT_TIMEOUT_MS}ms`)),
        ACTUAL_COUNT_TIMEOUT_MS + 500,
      ),
    ),
  ]);
}

function summarize(results: ResultRow[]) {
  const failures = results.filter((row) => !row.pass);
  const byFilter = new Map<string, { total: number; failed: number }>();
  for (const row of results) {
    const entry = byFilter.get(row.filter) ?? { total: 0, failed: 0 };
    entry.total += 1;
    if (!row.pass) entry.failed += 1;
    byFilter.set(row.filter, entry);
  }
  return {
    total: results.length,
    passed: results.length - failures.length,
    failed: failures.length,
    byFilter: Object.fromEntries(byFilter),
  };
}

function writeOutputs(results: ResultRow[], data: DataSet) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const summary = summarize(results);
  const payload = {
    generatedAt: new Date().toISOString(),
    projectRef: PROJECT_REF,
    orgId: ORG_ID,
    dataShape: {
      activeProperties: data.properties.length,
      lists: data.lists.length,
      customTags: data.tags.length,
      assignedUsers: data.teamUsers.length,
    },
    summary,
    results,
  };
  fs.writeFileSync(
    path.join(OUT_DIR, "pass1-production-matrix.json"),
    JSON.stringify(payload, null, 2),
  );

  const failures = results.filter((row) => !row.pass);
  const lines = [
    "# Pass 1 Production Filter Matrix",
    "",
    `Generated: ${payload.generatedAt}`,
    `Project: ${PROJECT_REF}`,
    `Org: ${ORG_ID}`,
    `Active properties loaded for oracle: ${data.properties.length.toLocaleString()}`,
    `Scenarios: ${summary.total}`,
    `Passed: ${summary.passed}`,
    `Failed: ${summary.failed}`,
    "",
    "## Failures",
    "",
    failures.length === 0
      ? "None."
      : "| Filter | Scenario | Expected | Actual | Error |\n| --- | --- | ---: | ---: | --- |",
    ...failures.map(
      (row) =>
        `| ${row.filter} | ${row.scenario.replaceAll("|", "\\|")} | ${row.expected} | ${row.actual ?? "ERR"} | ${row.error ?? ""} |`,
    ),
    "",
    "## By Filter",
    "",
    "| Filter | Total | Failed |",
    "| --- | ---: | ---: |",
    ...Object.entries(summary.byFilter)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([filter, row]) => `| ${filter} | ${row.total} | ${row.failed} |`),
    "",
  ];
  fs.writeFileSync(path.join(OUT_DIR, "pass1-production-matrix.md"), lines.join("\n"));
  console.log(JSON.stringify({ pass: summary.failed === 0, summary, outputDir: OUT_DIR }));
}

async function main() {
  const user = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: authError } = await user.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: PROD_PASSWORD,
  });
  if (authError) throw authError;

  const data = await loadData(user);
  const scenarios = buildScenarios(data);
  const results: ResultRow[] = [];
  for (const [index, scenario] of scenarios.entries()) {
    const expected = oracleCount(scenario.blocks, data);
    let actual: number | null = null;
    let error: string | null = null;
    try {
      actual = await actualCountWithTimeout(user, scenario.blocks);
    } catch (caught) {
      error = maskError(caught);
    }
    results.push({
      filter: filterName(scenario.blocks),
      scenario: scenario.name,
      blocks: scenario.blocks,
      expected,
      actual,
      pass: error == null && actual === expected,
      error,
      encodedLength: encodeFilters({ v: 1, blocks: scenario.blocks }).length,
    });
    if ((index + 1) % 25 === 0) {
      const failed = results.filter((row) => !row.pass).length;
      console.log(`[pass1] ${index + 1}/${scenarios.length} scenarios, failed=${failed}`);
    }
  }

  writeOutputs(results, data);
  if (results.some((row) => !row.pass)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(maskError(error));
  process.exit(1);
});
