/* eslint-disable @typescript-eslint/no-explicit-any -- duck-typed builders */
/**
 * Search x filter composition on the REAL `search_properties` rpc builder
 * (stress plan #3 for Search). Every block kind is ANDed with a text search
 * through the same `buildScopedQuery` the page uses, authenticated through
 * PostgREST. Expectations are computed in plain TypeScript from the seeded
 * model; the translator is never asked what the answer should be.
 *
 * LOCAL disposable stack only (destructive resets):
 *   FILTER_LOCAL_DB_URL=... FILTER_LOCAL_API_URL=... \
 *   npx vitest run --config vitest.filter-local.config.ts \
 *     src/lib/prospects/search-filter-composition.integration.test.ts
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import {
  BMH_ORG_ID,
  TEST_ORG_B_ID,
  clientForUser,
  createOrgUser,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";
import { assertLocalOnlyEnvironment } from "@/lib/testing/local-only-guard";

import { BLOCK_KINDS, type FilterBlock } from "./filter-schema";
import { filterSelectFragment } from "./filter-to-supabase";
import { buildScopedQuery } from "./search-scope";

assertLocalOnlyEnvironment();
const svc = createTestClient() as any;
let userA: any;
let userAId = "";
const authUsers: string[] = [];
const TERM = "Zorbaxian";
const MKT = "COMPMKT";
const N = 480;

type P = {
  id: string; hit: boolean; status: string; dispo: string | null; vac: boolean; cass: string; state: string;
  beds: number; motiv: string | null; absentee: boolean; inb: number; outb: number; unread: number;
  tags: string[]; lists: string[]; openTask: boolean;
};
const model: P[] = [];
let T1 = "", T2 = "", L1 = "", L2 = "";

async function insertChunked(table: string, rows: any[], size = 200) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await svc.from(table).insert(rows.slice(i, i + size));
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

beforeAll(async () => {
  await resetTenantTables(svc);
  await seedTwoOrgs(svc);
  const a = await createOrgUser(svc, { orgId: BMH_ORG_ID, email: `sc-${randomUUID()}@example.test`, role: "owner" });
  const b = await createOrgUser(svc, { orgId: TEST_ORG_B_ID, email: `sd-${randomUUID()}@example.test`, role: "owner" });
  authUsers.push(a.userId, b.userId);
  userAId = a.userId;
  userA = clientForUser(a.jwt);
  const mk = async (table: string, row: any) => (await svc.from(table).insert(row).select("id").single()).data.id as string;
  T1 = await mk("tags", { org_id: BMH_ORG_ID, name: `t1-${randomUUID()}`, category: "custom" });
  T2 = await mk("tags", { org_id: BMH_ORG_ID, name: `t2-${randomUUID()}`, category: "custom" });
  L1 = await mk("lists", { org_id: BMH_ORG_ID, name: `l1-${randomUUID()}` });
  L2 = await mk("lists", { org_id: BMH_ORG_ID, name: `l2-${randomUUID()}` });

  const statuses = ["prospect", "new_lead", "interested", "dead", "closed"];
  const dispos = ["wrong_number", "not_interested", "nurture", "opted_out", "dnc", null, null];
  const cass = ["verified", "unverified", "invalid", "ambiguous"];
  const motiv = ["hot", "warm", "cold", null];
  const contacts: any[] = [];
  const props: any[] = [];
  const msgs: any[] = [];
  const ptags: any[] = [];
  const plists: any[] = [];
  const tasks: any[] = [];
  const now = new Date().toISOString();
  for (let i = 0; i < N; i++) {
    const id = randomUUID();
    const contactId = randomUUID();
    const surnameHit = i % 3 === 0;
    const addressHit = i % 11 === 0;
    contacts.push({
      id: contactId, org_id: BMH_ORG_ID, first_name: "Pat", last_name: surnameHit ? TERM : `Plain${i}`,
      phone_1: `+1816777${String(1000 + i).padStart(4, "0")}`, phone_1_type: "mobile",
    });
    const p: P = {
      id, hit: surnameHit || addressHit, status: statuses[i % 5], dispo: dispos[i % 7], vac: i % 2 === 0, cass: cass[i % 4],
      state: i % 2 === 0 ? "MO" : "KS", beds: i % 6, motiv: motiv[i % 4], absentee: i % 5 < 2,
      inb: 0, outb: 0, unread: 0, tags: [], lists: [], openTask: false,
    };
    props.push({
      id, org_id: BMH_ORG_ID, address: addressHit ? `${i} ${TERM} Way` : `${i} Comp St`, city: "Kansas City", state: p.state,
      status: p.status, market: MKT, is_vacant: p.vac, cass_status: p.cass, beds: p.beds, motivation_level: p.motiv,
      absentee_flag: p.absentee, homeowner_contact_id: contactId,
    });
    const mkm = (direction: string, read: boolean) =>
      msgs.push({ org_id: BMH_ORG_ID, property_id: id, channel: "sms", direction, body: "m", read_at: direction === "inbound" && read ? now : null });
    switch (i % 4) {
      case 1: mkm("inbound", false); p.inb = 1; p.unread = 1; break;
      case 2: mkm("outbound", false); p.outb = 1; break;
      case 3: mkm("inbound", true); mkm("outbound", false); p.inb = 1; p.outb = 1; break;
    }
    if (i % 2 === 0) { p.tags.push(T1); ptags.push({ org_id: BMH_ORG_ID, property_id: id, tag_id: T1 }); }
    if (i % 5 === 0) { p.tags.push(T2); ptags.push({ org_id: BMH_ORG_ID, property_id: id, tag_id: T2 }); }
    if (i % 3 === 0) { p.lists.push(L1); plists.push({ org_id: BMH_ORG_ID, property_id: id, list_id: L1 }); }
    if (i % 4 === 0) { p.lists.push(L2); plists.push({ org_id: BMH_ORG_ID, property_id: id, list_id: L2 }); }
    if (i % 6 === 0) {
      p.openTask = true;
      tasks.push({ org_id: BMH_ORG_ID, assignee_id: userAId, created_by: userAId, related_property_id: id, type: "follow_up", status: "open", title: "t", due_at: now });
    }
    model.push(p);
  }
  await insertChunked("contacts", contacts);
  await insertChunked("properties", props.map((p) => ({ ...p, outreach_dispo: null })));
  await insertChunked("messages", msgs);
  await insertChunked("property_tags", ptags);
  await insertChunked("property_lists", plists);
  await insertChunked("tasks", tasks);
  // DNC-style dispositions lock child tables, so they are applied last.
  const byDispo = new Map<string, string[]>();
  for (const p of model) if (p.dispo) byDispo.set(p.dispo, [...(byDispo.get(p.dispo) ?? []), p.id]);
  for (const [dispo, ids] of byDispo) {
    for (let i = 0; i < ids.length; i += 100) {
      const { error } = await svc.from("properties").update({ outreach_dispo: dispo }).in("id", ids.slice(i, i + 100));
      if (error) throw new Error(`dispo: ${error.message}`);
    }
  }
}, 300_000);

afterAll(async () => {
  for (const id of authUsers) await svc.auth.admin.deleteUser(id).catch(() => undefined);
  await resetTenantTables(svc);
}, 120_000);

// ------------------------- independent oracle -------------------------
const OPT = new Set(["opted_out", "dnc"]);
const S = (p: P, v: string) =>
  v === "replied" ? p.inb > 0
    : v === "attempted" ? p.outb > 0 && p.inb === 0
      : v === "never_contacted" ? p.inb === 0 && p.outb === 0
        : p.dispo !== null && OPT.has(p.dispo);
function setOracle(have: string[], comb: string, values: string[]) {
  if (comb === "not") return !values.some((v) => have.includes(v));
  if (comb === "all") return values.every((v) => have.includes(v));
  return values.some((v) => have.includes(v));
}
const inRange = (n: number | null, r: { min: number | null; max: number | null }) =>
  (r.min == null && r.max == null) || (n !== null && (r.min == null || n >= r.min) && (r.max == null || n <= r.max));
function matches(p: P, b: any): boolean {
  switch (b.kind) {
    case "outreach_dispo":
      return b.combinator === "not" ? p.dispo === null || !b.values.includes(p.dispo) : p.dispo !== null && b.values.includes(p.dispo);
    case "pipeline_status": return setOracle([p.status], b.combinator, b.values);
    case "cass": return setOracle([p.cass], b.combinator, b.values);
    case "state": return setOracle([p.state], b.combinator, b.values);
    case "market": return setOracle([MKT], b.combinator, b.values);
    case "motivation_level": return p.motiv !== null && setOracle([p.motiv], b.combinator, b.values);
    case "vacancy": return b.tri === "any" || p.vac === (b.tri === "yes");
    case "absentee": return b.tri === "any" || p.absentee === (b.tri === "yes");
    case "beds": return inRange(p.beds, b.range);
    case "tag": return setOracle(p.tags, b.combinator, b.values);
    case "list": return setOracle(p.lists, b.combinator, b.values);
    case "list_count": return b.range.min != null && p.lists.length < Math.max(b.range.min, 1) ? false : b.range.max == null || p.lists.length <= b.range.max;
    case "has_unread_inbound": return b.tri === "any" || (p.unread > 0) === (b.tri === "yes");
    case "has_open_tasks": return b.tri === "any" || p.openTask === (b.tri === "yes");
    case "engagement":
      if (b.combinator === "not") return !b.values.some((v: string) => S(p, v));
      if (b.combinator === "all" && (b.values.includes("never_contacted") || (b.values.includes("attempted") && b.values.includes("replied")))) return false;
      return b.values.some((v: string) => S(p, v));
    default: throw new Error(b.kind);
  }
}
const expected = (blocks: any[], search: boolean) =>
  model.filter((p) => (!search || p.hit) && blocks.every((b) => matches(p, b))).map((p) => p.id).sort();

const blk = (b: Record<string, unknown>): FilterBlock => ({ id: randomUUID(), ...b }) as any;

async function run(blocks: FilterBlock[], search: string | null) {
  const frag = filterSelectFragment(blocks);
  const select = frag ? `id, address, ${frag}` : "id, address";
  const ids: string[] = [];
  let count: number | null = null;
  for (let from = 0; ; from += 1000) {
    const { builder } = await buildScopedQuery(userA, {
      origin: "search_page", select, selectOpts: { count: "exact" }, search, blockStack: blocks, includeMessages: true,
    });
    const { data, error, count: c } = await builder.order("address").order("id").range(from, from + 999);
    if (error) throw new Error(`${error.code}: ${error.message}`);
    count = c;
    ids.push(...(data ?? []).map((r: any) => r.id));
    if (!data || data.length < 1000) break;
  }
  return { ids: ids.sort(), count };
}

async function parity(blocks: FilterBlock[]) {
  for (const search of [TERM, null]) {
    const want = expected(blocks, search !== null);
    const got = await run(blocks, search);
    expect(got.ids, `${JSON.stringify(blocks.map((b: any) => b.kind))} search=${search}`).toEqual(want);
    expect(got.count).toBe(want.length);
    expect(new Set(got.ids).size).toBe(got.ids.length);
  }
}

describe("Search x filters on the real search_properties rpc builder", () => {
  it("search alone returns exactly the property-text and contact-name hits", async () => {
    const got = await run([], TERM);
    expect(got.ids).toEqual(expected([], true));
    expect(got.ids.length).toBeGreaterThan(100);
  });

  it("outreach_dispo wrong_number / not_interested / nurture, singly and combined, with NULL-safe 'not'", async () => {
    for (const values of [["wrong_number"], ["not_interested"], ["nurture"], ["wrong_number", "not_interested", "nurture"]]) {
      await parity([blk({ kind: "outreach_dispo", combinator: "any", values })]);
    }
    await parity([blk({ kind: "outreach_dispo", combinator: "not", values: ["wrong_number"] })]);
    await parity([blk({ kind: "outreach_dispo", combinator: "not", values: ["wrong_number", "not_interested", "nurture"] })]);
    // The motivating owner case: wrong numbers among everything a name search finds.
    const want = expected([blk({ kind: "outreach_dispo", combinator: "any", values: ["wrong_number"] })], true);
    expect(want.length).toBeGreaterThan(0);
  });

  it("pipeline_status shows leads and prospects together; dead/closed included", async () => {
    await parity([]);
    await parity([blk({ kind: "pipeline_status", combinator: "any", values: ["new_lead", "interested"] })]);
    await parity([blk({ kind: "pipeline_status", combinator: "any", values: ["dead", "closed"] })]);
    await parity([blk({ kind: "pipeline_status", combinator: "not", values: ["dead"] })]);
  });

  it("cache-column blocks: engagement (all combinators), unread, open tasks, tags, lists, list_count", async () => {
    const buckets = ["never_contacted", "attempted", "replied", "opted_out"];
    for (const combinator of ["any", "all", "not"]) {
      for (const values of [["replied"], ["attempted"], ["never_contacted"], ["opted_out"], ["replied", "opted_out"], ["attempted", "replied"], buckets]) {
        await parity([blk({ kind: "engagement", combinator, values })]);
      }
    }
    for (const tri of ["yes", "no"]) {
      await parity([blk({ kind: "has_unread_inbound", tri })]);
      await parity([blk({ kind: "has_open_tasks", tri })]);
    }
    for (const [combinator, values] of [["any", [T1]], ["all", [T1, T2]], ["not", [T2]], ["any", [T1, T2]]] as Array<[string, string[]]>) {
      await parity([blk({ kind: "tag", combinator, values })]);
    }
    for (const [combinator, values] of [["any", [L1]], ["all", [L1, L2]], ["not", [L1]]] as Array<[string, string[]]>) {
      await parity([blk({ kind: "list", combinator, values })]);
    }
    for (const [min, max] of [[1, null], [2, null], [null, 1]] as Array<[number | null, number | null]>) {
      await parity([blk({ kind: "list_count", range: { min, max } })]);
    }
  }, 240_000);

  it("plain column blocks: vacancy, cass, state, market, beds, motivation, absentee", async () => {
    await parity([blk({ kind: "vacancy", tri: "yes" })]);
    await parity([blk({ kind: "vacancy", tri: "no" })]);
    await parity([blk({ kind: "cass", combinator: "any", values: ["verified", "unverified"] })]);
    await parity([blk({ kind: "cass", combinator: "not", values: ["invalid"] })]);
    await parity([blk({ kind: "state", combinator: "any", values: ["KS"] })]);
    await parity([blk({ kind: "market", combinator: "any", values: [MKT] })]);
    await parity([blk({ kind: "beds", range: { min: 2, max: 4 } })]);
    await parity([blk({ kind: "motivation_level", combinator: "any", values: ["hot", "warm"] })]);
    await parity([blk({ kind: "absentee", tri: "yes" })]);
  }, 120_000);

  it("multi-block stacks AND with the search", async () => {
    await parity([
      blk({ kind: "outreach_dispo", combinator: "any", values: ["wrong_number", "nurture"] }),
      blk({ kind: "pipeline_status", combinator: "any", values: ["new_lead", "prospect"] }),
      blk({ kind: "tag", combinator: "any", values: [T1] }),
    ]);
    await parity([
      blk({ kind: "engagement", combinator: "not", values: ["opted_out"] }),
      blk({ kind: "has_unread_inbound", tri: "yes" }),
      blk({ kind: "list", combinator: "any", values: [L1] }),
      blk({ kind: "vacancy", tri: "yes" }),
    ]);
    await parity([
      blk({ kind: "outreach_dispo", combinator: "not", values: ["wrong_number", "not_interested", "nurture"] }),
      blk({ kind: "has_open_tasks", tri: "yes" }),
      blk({ kind: "cass", combinator: "any", values: ["verified"] }),
    ]);
  }, 120_000);

  it("every one of the 23 block kinds executes with a search on the rpc builder (no embedded-filter errors)", async () => {
    const uuid = randomUUID();
    const stack: Record<string, any> = {
      list: { combinator: "any", values: [L1] }, tag: { combinator: "not", values: [T1] },
      list_count: { range: { min: 1, max: 5 } }, vacancy: { tri: "no" }, cass: { combinator: "not", values: ["verified"] },
      outreach_dispo: { combinator: "not", values: ["wrong_number", "nurture"] }, source: { combinator: "not", values: ["sms"] },
      beds: { range: { min: 1, max: 9 } }, baths: { range: { min: null, max: 9 } }, year_built: { range: { min: 1900, max: null } },
      state: { combinator: "any", values: ["MO", "KS"] }, market: { combinator: "any", values: [MKT] }, absentee: { tri: "no" },
      estimated_value: { range: { min: 0, max: 1e9 } }, equity_pct: { range: { min: 0, max: 100 } },
      pipeline_status: { combinator: "any", values: ["prospect", "new_lead"] }, engagement: { combinator: "not", values: ["opted_out", "replied"] },
      assignee: { combinator: "any", values: ["unassigned", uuid] }, created_date: { date: { mode: "since", days: 3650 } },
      has_unread_inbound: { tri: "no" }, needs_human_attention: { tri: "no" }, has_open_tasks: { tri: "no" },
      motivation_level: { combinator: "any", values: ["hot", "warm", "cold"] },
    };
    expect(Object.keys(stack).sort()).toEqual([...BLOCK_KINDS].sort());
    for (const [k, rest] of Object.entries(stack)) await run([blk({ kind: k, ...rest })], TERM);
    await run(Object.entries(stack).map(([k, rest]) => blk({ kind: k, ...rest })), TERM);
  }, 240_000);

  it("sorting by a non-id column with a search stays stable across pages (no dupes, count == rows)", async () => {
    const seen = new Set<string>();
    let total = 0;
    for (let from = 0; from === 0 || from < total; from += 50) {
      const { builder } = await buildScopedQuery(userA, {
        origin: "search_page", select: "id, address, created_at, market", selectOpts: { count: "exact" }, search: TERM, blockStack: [], includeMessages: true,
      });
      const { data, count, error } = await builder.order("market").order("id").range(from, from + 49);
      expect(error).toBeNull();
      total = count ?? 0;
      for (const r of data ?? []) { expect(seen.has(r.id)).toBe(false); seen.add(r.id); }
    }
    expect(seen.size).toBe(total);
  });
});
