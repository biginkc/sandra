/* eslint-disable @typescript-eslint/no-explicit-any -- builders are duck-typed */
/**
 * Filter translator correctness through REAL PostgREST with an authenticated
 * (RLS-bound) client — stress plan #3 / PR A.
 *
 * Expectations are computed here in plain TypeScript from the seeded model.
 * They are NEVER produced by running the new translator. The only other
 * oracle is the committed 45-case engagement fixture, generated once from a
 * frozen copy of the legacy translator on a small dataset
 * (GENERATE_ENGAGEMENT_FIXTURE=1 regenerates it).
 *
 * Runs ONLY against a disposable local Supabase stack
 * (`npx vitest run --config vitest.filter-local.config.ts`); it is excluded
 * from the hosted `npm run test:integration` suite.
 *
 * Every scenario runs through BOTH a `from('properties')` builder and a
 * `setof properties` rpc builder (a test-only passthrough function created
 * and dropped by this file).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import {
  BMH_ORG_ID,
  TEST_ORG_B_ID,
  clientForUser,
  createOrgUser,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";
import { applyFilters as legacyApplyFilters, filterSelectFragment as legacyFragment } from "@tests/integration/fixtures/legacy-filter-to-supabase.frozen";
import { assertLocalOnlyEnvironment } from "@/lib/testing/local-only-guard";
import { resetTenantTables } from "@tests/integration/reset";

import { BLOCK_KINDS, type FilterBlock } from "./filter-schema";
import { applyFilters } from "./filter-to-supabase";

const FIXTURE_PATH = path.resolve(
  __dirname,
  "../../../tests/integration/fixtures/engagement-45-cases.fixture.json",
);
const GENERATE = process.env.GENERATE_ENGAGEMENT_FIXTURE === "1";

// Destructive (resets/truncates tenant tables): local disposable stack ONLY.
assertLocalOnlyEnvironment();
const svc = createTestClient();
let userA: any;
let userAId = "";
let userB: any;
const authUsers: string[] = [];
let rpcFn = "";
let pg: PgClient | null = null;

// ---------------------------------------------------------------------------
// In-memory model of everything seeded (the oracle's only input)
// ---------------------------------------------------------------------------
type P = {
  id: string;
  label: string;
  market: string;
  dispo: string | null;
  inb: number;
  outb: number;
  unread: number;
  tags: string[];
  lists: string[];
  openTask: boolean;
};
const model: P[] = [];
let T1 = "", T2 = "", T3 = "", L1 = "", L2 = "", L3 = "";
let XORG_ID = "";
let ORGB_PROP_ID = "";

async function insertChunked(table: string, rows: any[], size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await (svc as any).from(table).insert(rows.slice(i, i + size));
    if (error) throw new Error(`${table} insert: ${error.message}`);
  }
}

// DNC-locking makes child tables read-only, so dispositions are applied AFTER
// every child row is inserted.
async function applyDispos() {
  const byDispo = new Map<string, string[]>();
  for (const p of model) if (p.dispo) byDispo.set(p.dispo, [...(byDispo.get(p.dispo) ?? []), p.id]);
  for (const [dispo, ids] of byDispo) {
    for (let i = 0; i < ids.length; i += 100) {
      const { error } = await (svc as any).from("properties").update({ outreach_dispo: dispo }).in("id", ids.slice(i, i + 100));
      if (error) throw new Error(`dispo update: ${error.message}`);
    }
  }
}

const SMALL = "SMALLMKT";
const BIG = "BIGMKT";

async function seedSmall() {
  const dispos: Array<string | null> = [null, "opted_out", "dnc", "nurture"];
  const states: Array<[string, number, number, number]> = [
    // name, inbound, outbound, unread inbound
    ["replied_in", 1, 0, 1],
    ["replied_both", 1, 2, 0],
    ["attempted", 0, 2, 0],
    ["never", 0, 0, 0],
  ];
  const props: any[] = [];
  const msgs: any[] = [];
  for (const [sname, inb, outb, unread] of states) {
    for (const dispo of dispos) {
      const id = randomUUID();
      const label = `S-${sname}-${dispo ?? "null"}`;
      props.push({ id, org_id: BMH_ORG_ID, address: label, state: "MO", status: "prospect", market: SMALL });
      model.push({ id, label, market: SMALL, dispo, inb, outb, unread, tags: [], lists: [], openTask: false });
      for (let k = 0; k < inb; k++)
        msgs.push({ org_id: BMH_ORG_ID, property_id: id, channel: "sms", direction: "inbound", body: "in", read_at: k < unread ? null : new Date().toISOString() });
      for (let k = 0; k < outb; k++)
        msgs.push({ org_id: BMH_ORG_ID, property_id: id, channel: "sms", direction: "outbound", body: "out" });
    }
  }
  await insertChunked("properties", props);
  await insertChunked("messages", msgs);
}

async function seedBig() {
  const N = 1300;
  const props: any[] = [];
  const msgs: any[] = [];
  const ptags: any[] = [];
  const plists: any[] = [];
  const tasks: any[] = [];
  const now = new Date().toISOString();
  for (let i = 0; i < N; i++) {
    const id = randomUUID();
    const dispo =
      i % 13 === 0 ? "opted_out" : i % 17 === 0 ? "dnc" : i % 5 === 0 ? "nurture" : i % 7 === 0 ? "wrong_number" : null;
    const p: P = { id, label: `big-${i}`, market: BIG, dispo, inb: 0, outb: 0, unread: 0, tags: [], lists: [], openTask: false };
    props.push({ id, org_id: BMH_ORG_ID, address: `${i} Big St`, state: "MO", status: "prospect", market: BIG });
    const mk = (direction: "inbound" | "outbound", read: boolean) =>
      msgs.push({ org_id: BMH_ORG_ID, property_id: id, channel: "sms", direction, body: "m", read_at: direction === "inbound" && read ? now : null });
    if (i < 450) {
      mk("inbound", false); p.inb++; p.unread++;
      if (i % 3 === 0) { mk("outbound", false); p.outb++; }
      if (i % 4 === 0) { mk("inbound", true); p.inb++; }
    } else if (i < 750) {
      mk("outbound", false); p.outb++;
    } else if (i === 1298) {
      mk("inbound", true); p.inb++; // replied, not unread
    } else if (i === 1299) {
      for (let k = 0; k < 1200; k++) mk("outbound", false);
      p.outb += 1200; // heavy: > PostgREST row cap by itself
    }
    const tagIds: Array<[boolean, string]> = [[i < 450, T1], [i % 3 === 0, T2], [i >= 1000, T3]];
    for (const [on, t] of tagIds) if (on) { p.tags.push(t); ptags.push({ org_id: BMH_ORG_ID, property_id: id, tag_id: t }); }
    const listIds: Array<[boolean, string]> = [[i < 450, L1], [i % 2 === 0, L2], [i % 5 === 0, L3]];
    for (const [on, l] of listIds) if (on) { p.lists.push(l); plists.push({ org_id: BMH_ORG_ID, property_id: id, list_id: l }); }
    if (i < 450) {
      p.openTask = true;
      tasks.push({ org_id: BMH_ORG_ID, assignee_id: userAId, created_by: userAId, related_property_id: id, type: "custom", status: "open", title: "t", due_at: now });
    }
    if (i % 10 === 3) // completed-only task: must NOT count as open
      tasks.push({ org_id: BMH_ORG_ID, assignee_id: userAId, created_by: userAId, related_property_id: id, type: "custom", status: "completed", title: "t", due_at: now });
    model.push(p);
  }
  await insertChunked("properties", props);
  await insertChunked("messages", msgs);
  await insertChunked("property_tags", ptags);
  await insertChunked("property_lists", plists);
  await insertChunked("tasks", tasks);
}

async function seedCrossOrg() {
  // Org A property carrying ONLY org-B child rows (anomalous data): user A's
  // (the DB itself forbids cross-org tag/list/task rows, so only messages
  // can be anomalous) RLS must hide every one of them, so it is never_contacted / no tags / etc.
  XORG_ID = randomUUID();
  await insertChunked("properties", [{ id: XORG_ID, org_id: BMH_ORG_ID, address: "XORG", state: "MO", status: "prospect", market: "XORGMKT" }]);
  model.push({ id: XORG_ID, label: "XORG", market: "XORGMKT", dispo: null, inb: 0, outb: 0, unread: 0, tags: [], lists: [], openTask: false });
  await insertChunked("messages", [{ org_id: TEST_ORG_B_ID, property_id: XORG_ID, channel: "sms", direction: "inbound", body: "b", read_at: null }]);
  // Inaccessible property: wholly org B.
  ORGB_PROP_ID = randomUUID();
  await insertChunked("properties", [{ id: ORGB_PROP_ID, org_id: TEST_ORG_B_ID, address: "ORGB", state: "MO", status: "prospect", market: BIG }]);
  await insertChunked("messages", [{ org_id: TEST_ORG_B_ID, property_id: ORGB_PROP_ID, channel: "sms", direction: "inbound", body: "b", read_at: null }]);
}

async function createPassthrough() {
  const url = process.env.TEST_SUPABASE_DB_URL;
  if (!url) return;
  pg = new PgClient({ connectionString: url });
  await pg.connect();
  rpcFn = `zz_filter_all_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  await pg.query(`create function public.${rpcFn}() returns setof public.properties language sql stable security invoker as 'select * from public.properties'`);
  await pg.query(`grant execute on function public.${rpcFn}() to authenticated, service_role`);
  await pg.query(`notify pgrst, 'reload schema'`);
  for (let i = 0; i < 30; i++) {
    const { error } = await userA.rpc(rpcFn).select("id").limit(1);
    if (!error) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("passthrough rpc never became visible to PostgREST");
}

beforeAll(async () => {
  await resetTenantTables(svc);
  await seedTwoOrgs(svc);
  const a = await createOrgUser(svc, { orgId: BMH_ORG_ID, email: `fa-${randomUUID()}@example.test`, role: "owner" });
  const b = await createOrgUser(svc, { orgId: TEST_ORG_B_ID, email: `fb-${randomUUID()}@example.test`, role: "owner" });
  authUsers.push(a.userId, b.userId);
  userAId = a.userId;
  userA = clientForUser(a.jwt);
  userB = clientForUser(b.jwt);
  if (GENERATE) { await seedSmall(); await applyDispos(); return; }
  const mkTag = async (n: string) => (await (svc as any).from("tags").insert({ org_id: BMH_ORG_ID, name: `${n}-${randomUUID()}`, category: "custom" }).select("id").single()).data.id as string;
  const mkList = async (n: string) => (await (svc as any).from("lists").insert({ org_id: BMH_ORG_ID, name: `${n}-${randomUUID()}` }).select("id").single()).data.id as string;
  [T1, T2, T3] = [await mkTag("t1"), await mkTag("t2"), await mkTag("t3")];
  [L1, L2, L3] = [await mkList("l1"), await mkList("l2"), await mkList("l3")];
  await seedSmall();
  await seedBig();
  await seedCrossOrg();
  await applyDispos();
  await createPassthrough();
}, 240_000);

afterAll(async () => {
  try { if (pg && rpcFn) await pg.query(`drop function if exists public.${rpcFn}()`); } catch { /* best effort */ }
  try { await pg?.query(`notify pgrst, 'reload schema'`); await pg?.end(); } catch { /* ignore */ }
  for (const id of authUsers) await svc.auth.admin.deleteUser(id).catch(() => undefined);
  await resetTenantTables(svc);
}, 120_000);

// ---------------------------------------------------------------------------
// Independent oracle (plan §6 table and today's documented definitions)
// ---------------------------------------------------------------------------
const OPT = new Set(["opted_out", "dnc"]);
const S = (p: P, v: string): boolean => {
  switch (v) {
    case "replied": return p.inb > 0;
    case "attempted": return p.outb > 0 && p.inb === 0;
    case "never_contacted": return p.inb === 0 && p.outb === 0;
    case "opted_out": return p.dispo !== null && OPT.has(p.dispo);
    default: throw new Error(v);
  }
};
function engagementOracle(p: P, combinator: string, values: string[]): boolean {
  if (values.length === 0) return true;
  if (combinator === "not") return !values.some((v) => S(p, v));
  if (combinator === "all" && (values.includes("never_contacted") || (values.includes("attempted") && values.includes("replied")))) return false;
  return values.some((v) => S(p, v)); // any, all-single, all-other-multi (legacy union)
}
function idSetOracle(have: string[], combinator: string, values: string[]): boolean {
  if (values.length === 0) return true;
  if (combinator === "not") return !values.some((v) => have.includes(v));
  if (combinator === "all") return values.every((v) => have.includes(v));
  return values.some((v) => have.includes(v));
}
function expectedFor(blocks: any[], market: string): P[] {
  return model.filter((p) => p.market === market).filter((p) =>
    blocks.every((b) => {
      switch (b.kind) {
        case "engagement": return engagementOracle(p, b.combinator, b.values);
        case "list": return idSetOracle(p.lists, b.combinator, b.values);
        case "tag": return idSetOracle(p.tags, b.combinator, b.values);
        case "has_unread_inbound": return b.tri === "any" || (p.unread > 0) === (b.tri === "yes");
        case "has_open_tasks": return b.tri === "any" || p.openTask === (b.tri === "yes");
        case "list_count": {
          const c = p.lists.length;
          if (b.range.min == null && b.range.max == null) return true;
          if (b.range.min != null && c < Math.max(b.range.min, 1)) return false;
          return b.range.max == null || c <= b.range.max;
        }
        case "outreach_dispo": {
          if (b.values.length === 0) return true;
          if (b.combinator === "not") return p.dispo === null || !b.values.includes(p.dispo);
          return p.dispo !== null && b.values.includes(p.dispo);
        }
        default: throw new Error(`oracle: ${b.kind}`);
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Running a stack through real PostgREST on either builder
// ---------------------------------------------------------------------------
type Kind = "table" | "rpc";
async function runIds(client: any, kind: Kind, blocks: any[], market: string, translator: any = applyFilters, fragment?: (b: any) => string | null): Promise<{ ids: string[]; count: number | null }> {
  const frag = fragment ? fragment(blocks) : null;
  const sel = frag ? `id, ${frag}` : "id";
  const ids: string[] = [];
  let count: number | null = null;
  for (let from = 0; ; from += 1000) {
    const base = kind === "table" ? client.from("properties").select(sel, { count: "exact" }) : client.rpc(rpcFn, {}, { count: "exact" }).select(sel);
    let q = base.eq("market", market).is("deleted_at", null);
    q = (await translator(q, blocks, client)).builder;
    const { data, error, count: c } = await q.order("id").range(from, from + 999);
    if (error) throw new Error(`${kind} query failed: ${error.code} ${error.message}`);
    count = c;
    ids.push(...(data ?? []).map((r: any) => r.id));
    if (!data || data.length < 1000) break;
  }
  return { ids, count };
}

const kinds = (): Kind[] => (rpcFn ? ["table", "rpc"] : ["table"]);
const blk = (b: Record<string, unknown>): FilterBlock => ({ id: randomUUID(), ...b }) as any;

async function expectParity(blocks: FilterBlock[], market: string) {
  const want = expectedFor(blocks, market).map((p) => p.id).sort();
  for (const kind of kinds()) {
    const got = await runIds(userA, kind, blocks, market);
    expect(got.ids.slice().sort(), `${kind} ids`).toEqual(want);
    expect(got.count, `${kind} exact count`).toBe(want.length);
    expect(new Set(got.ids).size, `${kind} no dupes`).toBe(got.ids.length);
  }
  return want.length;
}

// ---------------------------------------------------------------------------
// 45-case engagement fixture
// ---------------------------------------------------------------------------
const BUCKETS = ["never_contacted", "attempted", "replied", "opted_out"];
function allCases() {
  const out: Array<{ key: string; combinator: string; values: string[] }> = [];
  for (const combinator of ["any", "all", "not"]) {
    for (let mask = 1; mask < 16; mask++) {
      const values = BUCKETS.filter((_, i) => mask & (1 << i));
      out.push({ key: `${combinator}:${values.join("+")}`, combinator, values });
    }
  }
  return out;
}

describe("engagement: 45 cases pinned to the legacy translator", () => {
  it.runIf(GENERATE)("GENERATE fixture from the frozen legacy translator (small data only)", async () => {
    const fixture: Record<string, string[]> = {};
    for (const c of allCases()) {
      const blocks = [blk({ kind: "engagement", combinator: c.combinator, values: c.values })];
      const { ids } = await runIds(userA, "table", blocks, SMALL, legacyApplyFilters, legacyFragment);
      const byId = new Map(model.map((p) => [p.id, p.label]));
      fixture[c.key] = ids.map((id) => byId.get(id)!).sort();
    }
    fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + "\n");
  }, 240_000);

  it.skipIf(GENERATE)("independent TypeScript oracle == committed legacy fixture (all 45)", () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as Record<string, string[]>;
    expect(Object.keys(fixture)).toHaveLength(45);
    for (const c of allCases()) {
      const want = expectedFor([{ kind: "engagement", combinator: c.combinator, values: c.values }], SMALL).map((p) => p.label).sort();
      expect(want, c.key).toEqual(fixture[c.key]);
    }
  });

  it.skipIf(GENERATE)("new translator == committed legacy fixture on both builders (all 45)", async () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as Record<string, string[]>;
    const byId = new Map(model.map((p) => [p.id, p.label]));
    for (const kind of kinds()) {
      for (const c of allCases()) {
        const blocks = [blk({ kind: "engagement", combinator: c.combinator, values: c.values })];
        const { ids, count } = await runIds(userA, kind, blocks, SMALL);
        expect(ids.map((i) => byId.get(i)!).sort(), `${kind} ${c.key}`).toEqual(fixture[c.key]);
        expect(count).toBe(fixture[c.key].length);
      }
    }
  }, 240_000);
});

describe.skipIf(GENERATE)("cache-column filters at scale (>1000 messages, >1000 matches, >400 ids/block)", () => {
  it("sanity: seeded scale really exceeds the old limits", () => {
    const big = model.filter((p) => p.market === BIG);
    expect(big.length).toBeGreaterThan(1000);
    expect(big.reduce((n, p) => n + p.inb + p.outb, 0)).toBeGreaterThan(1000);
    expect(big.filter((p) => p.unread > 0).length).toBeGreaterThan(400);
    expect(big.filter((p) => p.openTask).length).toBeGreaterThan(400);
  });

  it("engagement: every single/multi combination over the large dataset", async () => {
    for (const c of allCases()) {
      await expectParity([blk({ kind: "engagement", combinator: c.combinator, values: c.values })], BIG);
    }
  }, 240_000);

  it("has_unread_inbound yes/no and has_open_tasks yes/no (positive + negative, >400 ids)", async () => {
    for (const tri of ["yes", "no"]) {
      expect(await expectParity([blk({ kind: "has_unread_inbound", tri })], BIG)).toBeGreaterThan(0);
      expect(await expectParity([blk({ kind: "has_open_tasks", tri })], BIG)).toBeGreaterThan(0);
    }
  }, 120_000);

  it("tags: any / all (multi) / not, positive and negative", async () => {
    for (const [combinator, values] of [
      ["any", [T1]], ["any", [T1, T2]], ["all", [T1]], ["all", [T1, T2]], ["all", [T1, T2, T3]],
      ["not", [T1]], ["not", [T1, T3]], ["any", [T3]], ["not", [T2, T3]],
    ] as Array<[string, string[]]>) {
      await expectParity([blk({ kind: "tag", combinator, values })], BIG);
    }
  }, 120_000);

  it("lists: any / all (multi) / not", async () => {
    for (const [combinator, values] of [
      ["any", [L1]], ["any", [L2, L3]], ["all", [L1, L2]], ["all", [L1, L2, L3]], ["not", [L1]], ["not", [L2, L3]],
    ] as Array<[string, string[]]>) {
      await expectParity([blk({ kind: "list", combinator, values })], BIG);
    }
  }, 120_000);

  it("list_count ranges (min 0 excludes zero-list rows, max-only keeps them)", async () => {
    for (const [min, max] of [[1, null], [0, null], [2, null], [null, 1], [null, 3], [1, 2], [3, 3], [null, 0]] as Array<[number | null, number | null]>) {
      await expectParity([blk({ kind: "list_count", range: { min, max } })], BIG);
    }
  }, 120_000);

  it("a result set larger than 1000 rows is walked completely with the exact count", async () => {
    const n = await expectParity([blk({ kind: "list_count", range: { min: null, max: 9 } })], BIG);
    expect(n).toBeGreaterThan(1000);
    const m = await expectParity([blk({ kind: "engagement", combinator: "not", values: ["opted_out"] })], BIG);
    expect(m).toBeGreaterThan(1000);
  }, 120_000);

  it("combined stacks across blocks incl. NULL outreach_dispo, overlapping opted_out and each state", async () => {
    const stacks: FilterBlock[][] = [
      [blk({ kind: "engagement", combinator: "any", values: ["replied", "opted_out"] }), blk({ kind: "tag", combinator: "any", values: [T1] })],
      [blk({ kind: "engagement", combinator: "all", values: ["replied", "opted_out"] }), blk({ kind: "has_unread_inbound", tri: "no" })],
      [blk({ kind: "engagement", combinator: "not", values: ["never_contacted", "opted_out"] }), blk({ kind: "list", combinator: "not", values: [L1] })],
      [blk({ kind: "engagement", combinator: "not", values: ["opted_out"] }), blk({ kind: "outreach_dispo", combinator: "not", values: ["nurture"] })],
      [blk({ kind: "has_open_tasks", tri: "yes" }), blk({ kind: "has_unread_inbound", tri: "yes" }), blk({ kind: "tag", combinator: "all", values: [T1, T2] }), blk({ kind: "list_count", range: { min: 2, max: null } })],
      [blk({ kind: "outreach_dispo", combinator: "any", values: ["nurture", "wrong_number"] }), blk({ kind: "engagement", combinator: "any", values: ["never_contacted"] })],
      [blk({ kind: "engagement", combinator: "any", values: ["attempted"] }), blk({ kind: "engagement", combinator: "not", values: ["opted_out"] })],
    ];
    for (const s of stacks) await expectParity(s, BIG);
  }, 180_000);

  it("never exceeds URL limits: the request carries no id lists", async () => {
    // 450+ ids per block would 414 under the legacy id-list approach; the
    // successful parity runs above prove it. Make the claim explicit on one URL.
    const q: any = userA.from("properties").select("id");
    const { builder } = await applyFilters(q, [blk({ kind: "has_unread_inbound", tri: "yes" }), blk({ kind: "tag", combinator: "any", values: [T1] })], userA);
    expect(String(builder.url).length).toBeLessThan(600);
  });
});

describe.skipIf(GENERATE)("every block kind runs on both builders (rpc builder must not hit embedded filters)", () => {
  it("all 23 kinds translate and execute without a PostgREST error", async () => {
    const uuid = randomUUID();
    const stack: Record<string, any> = {
      list: { combinator: "any", values: [L1] },
      tag: { combinator: "not", values: [T1] },
      list_count: { range: { min: 1, max: 5 } },
      vacancy: { tri: "no" },
      cass: { combinator: "not", values: ["verified"] },
      outreach_dispo: { combinator: "not", values: ["wrong_number", "nurture"] },
      source: { combinator: "not", values: ["csv"] },
      beds: { range: { min: 1, max: 9 } },
      baths: { range: { min: null, max: 9 } },
      year_built: { range: { min: 1900, max: null } },
      state: { combinator: "any", values: ["MO", "KS"] },
      market: { combinator: "any", values: [BIG] },
      absentee: { tri: "no" },
      estimated_value: { range: { min: 0, max: 1e9 } },
      equity_pct: { range: { min: 0, max: 100 } },
      pipeline_status: { combinator: "any", values: ["prospect"] },
      engagement: { combinator: "not", values: ["opted_out", "replied"] },
      assignee: { combinator: "any", values: ["unassigned", uuid] },
      created_date: { date: { mode: "since", days: 3650 } },
      has_unread_inbound: { tri: "no" },
      needs_human_attention: { tri: "no" },
      has_open_tasks: { tri: "no" },
      motivation_level: { combinator: "not", values: ["hot"] },
    };
    expect(Object.keys(stack).sort()).toEqual([...BLOCK_KINDS].sort());
    for (const kind of kinds()) {
      for (const [k, rest] of Object.entries(stack)) {
        await runIds(userA, kind, [blk({ kind: k, ...rest })], BIG);
      }
      await runIds(userA, kind, Object.entries(stack).map(([k, rest]) => blk({ kind: k, ...rest })), BIG);
    }
  }, 240_000);
});

describe.skipIf(GENERATE)("tenant isolation of the filter cache", () => {
  it("org-B message rows on an org-A property do not count (never_contacted, no unread)", async () => {
    const xorg = (blocks: FilterBlock[]) => expectedFor(blocks, "XORGMKT").length;
    for (const kind of kinds()) {
      const q = (blocks: FilterBlock[]) => runIds(userA, kind, blocks, "XORGMKT");
      expect((await q([blk({ kind: "engagement", combinator: "any", values: ["never_contacted"] })])).ids).toEqual([XORG_ID]);
      expect((await q([blk({ kind: "has_unread_inbound", tri: "yes" })])).ids).toEqual([]);
      expect((await q([blk({ kind: "has_open_tasks", tri: "yes" })])).ids).toEqual([]);
      expect((await q([blk({ kind: "list_count", range: { min: 1, max: null } })])).ids).toEqual([]);
      expect((await q([blk({ kind: "tag", combinator: "not", values: [T1] })])).ids).toEqual([XORG_ID]);
    }
    expect(xorg([blk({ kind: "engagement", combinator: "any", values: ["never_contacted"] })])).toBe(1);
  });

  it("an inaccessible org-B property never appears for user A, and user B sees only org B", async () => {
    for (const kind of kinds()) {
      const a = await runIds(userA, kind, [blk({ kind: "engagement", combinator: "any", values: ["replied"] })], BIG);
      expect(a.ids).not.toContain(ORGB_PROP_ID);
      const b = await runIds(userB, kind, [blk({ kind: "engagement", combinator: "any", values: ["replied"] })], BIG);
      expect(b.ids).toEqual([ORGB_PROP_ID]);
      expect(b.count).toBe(1);
    }
  });

  it("cache columns cannot be forged by a client write (pin trigger)", async () => {
    const target = model.find((p) => p.market === BIG && p.inb === 0 && p.outb === 0)!;
    const read = async () => (await svc.from("properties").select("has_inbound_message, has_unread_inbound, filter_list_count").eq("id", target.id).single()).data as any;
    const before = await read();
    expect(before.has_inbound_message).toBe(false);
    await userA.from("properties").update({ has_inbound_message: true, has_unread_inbound: true, filter_list_count: 99 }).eq("id", target.id);
    expect(await read()).toEqual(before);
  });
});
