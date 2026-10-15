import { Client } from "pg";

import { FAMILIES, VARIANTS, buildFamilyWorld, type FamilyDef, type Variant } from "./families";
import { materializeWorld, setupOrg, type Materialized, type OrgCtx } from "./materialize";
import { loadClassifierMigration, sq2FixLanded } from "./migration";
import type { Lead, World } from "./model";
import { EXPECTED_UNTIL, NEEDS_ATTENTION_CHIPS, WAITING_CHIPS, expectedViews, place, tabOf, type Placement } from "./oracle";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export type MismatchKind =
  | "wrong_tab" | "hidden_lead" | "wrong_chip" | "wrong_row" | "headline" | "broken_actions" | "count_row" | "view_membership"
  | "badge" | "order" | "pagination" | "owner_view" | "scope";

export type Mismatch = {
  kind: MismatchKind;
  family: string;
  repeat: number;
  lead: string;
  tags: string[];
  question?: string;
  /** Set only when the SQL output is exactly what a known, routed SQL fix would change (EXPECTED_UNTIL); reported, not gating. */
  expectedUntil?: string;
  expected: unknown;
  actual: unknown;
};

export type Timing = Record<string, number[]>;

export type WorldResult = { leads: number; checks: number; mismatches: Mismatch[]; timings: Timing };

const MS = (t0: bigint) => Number(process.hrtime.bigint() - t0) / 1e6;

/** Run `fn` as the signed-in member (the way the app's server actions reach the RPCs), then drop back to the owner role. */
export async function asAuthenticated<T>(db: Client, sub: string, fn: () => Promise<T>): Promise<T> {
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claim.role','authenticated',true)");
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [sub]);
  try { return await fn(); } finally { await db.query("reset role").catch(() => {}); }
}

export type ViewRead = { rows: Json[]; ids: string[]; first: Json; pages: number };

export class Reader {
  readonly timings: Timing = {};
  constructor(private readonly db: Client, private readonly ctx: OrgCtx, private readonly member: string, private readonly at: Date, private readonly sub: string) {}

  private record(label: string, ms: number) { (this.timings[label] ??= []).push(ms); }

  async page(tab: string, chip: string | null, page: number, size: number, stage: string | null = null, search: string | null = null): Promise<Json> {
    const t0 = process.hrtime.bigint();
    const r = await asAuthenticated(this.db, this.sub, async () =>
      (await this.db.query("select public.fn_my_leads_work_page($1,$2,$3,$4,$5,$6,$7,$8,$9) as r", [this.ctx.org, this.member, tab, chip, stage, search, page, size, this.at.toISOString()])).rows[0].r);
    this.record(`page:${tab}:${chip ?? "all"}`, MS(t0));
    return r;
  }

  /** Every page of a view, in order. */
  async view(tab: string, chip: string | null, size = 50, stage: string | null = null): Promise<ViewRead> {
    const first = await this.page(tab, chip, 1, size, stage);
    const rows: Json[] = [...first.rows];
    let pages = 1;
    for (let p = 2; rows.length < first.total && p <= 200; p += 1) {
      const next = await this.page(tab, chip, p, size, stage);
      rows.push(...next.rows);
      pages += 1;
    }
    return { rows, ids: rows.map((r) => r.propertyId), first, pages };
  }

  async facts(ids: string[]): Promise<Json> {
    const t0 = process.hrtime.bigint();
    const r = await asAuthenticated(this.db, this.sub, async () =>
      (await this.db.query("select public.fn_my_leads_work_facts($1,$2,$3,$4) as r", [this.ctx.org, this.member, ids, this.at.toISOString()])).rows[0].r);
    this.record("facts", MS(t0));
    return r;
  }

  async badge(): Promise<number> {
    const t0 = process.hrtime.bigint();
    const r = await asAuthenticated(this.db, this.sub, async () => (await this.db.query("select public.fn_my_leads_badge_v2($1) as r", [this.at.toISOString()])).rows[0].r as number);
    this.record("badge", MS(t0));
    return Number(r);
  }
}

const brokenActionsOf = (row: Json): string[] => [...new Set<string>((row.broken ?? []).map((b: Json) => b.action))].sort();

function sameSet(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
}

type Ctx = { family: string; repeat: number };

/** Compare one world's SQL output with the oracle. Pure with respect to the database (reads only). */
export async function compareWorld(reader: Reader, world: World, mat: Materialized, c: Ctx): Promise<{ mismatches: Mismatch[]; checks: number }> {
  const mismatches: Mismatch[] = [];
  let checks = 0;
  const keyOf = new Map([...mat.ids].map(([k, id]) => [id, k]));
  const leadOf = new Map(world.leads.map((l) => [l.key, l]));
  const placements = new Map<string, Placement>(world.leads.map((l) => [l.key, place(l, world.now)]));
  const add = (kind: MismatchKind, lead: Lead | null, expected: unknown, actual: unknown, expectedUntil?: string) =>
    mismatches.push({ kind, family: c.family, repeat: c.repeat, lead: lead?.key ?? "-", tags: lead?.tags ?? [], question: lead?.question, expected, actual, ...(expectedUntil ? { expectedUntil } : {}) });
  // The known SQ2 disagreement (fix routed to #876): the SQL's pre-v9 reading, computed precisely. A mismatch is excused only when the
  // SQL output equals this reading exactly and differs from v9 only because of it.
  // Self-retiring: once the fix migration is in the checkout, SQ2 mismatches are never excused again.
  const sq2 = sq2FixLanded() ? undefined : EXPECTED_UNTIL.SQ2;
  const legacy = new Map<string, Placement>(world.leads.map((l) => [l.key, place(l, world.now, { preV9Unknown: true })]));
  const rowMatches = (row: Json, p: Placement) => row.place === p.place && row.reason === p.reason && row.rowNo === p.row
    && sameSet(brokenActionsOf(row), p.brokenActions) && Object.entries(p.headline).every(([k, v]) => String(row.headline?.[k]) === String(v));

  // 1. Per lead, from the All tab (every queue lead appears there with its place, reason and row).
  const all = await reader.view("all", null);
  const byKey = new Map<string, Json>();
  for (const row of all.rows) {
    if (!keyOf.has(row.propertyId)) { add("scope", null, "only the member's own queue", { leaked: row.propertyId, decoy: mat.decoyIds.includes(row.propertyId) }); continue; }
    byKey.set(keyOf.get(row.propertyId)!, row);
  }
  for (const lead of world.leads) {
    const p = placements.get(lead.key)!;
    const row = byKey.get(lead.key);
    checks += 1;
    if (row && lead.question === "SQ2" && sq2 && !rowMatches(row, p) && rowMatches(row, legacy.get(lead.key)!)) {
      add("wrong_chip", lead, { reason: p.reason, row: p.row }, { reason: row.reason, row: row.rowNo }, sq2);
      continue;
    }
    if (!row) { add("hidden_lead", lead, { place: p.place, reason: p.reason }, "not returned by the All tab"); continue; }
    if (row.place !== p.place) {
      if (row.place === "neither" && p.place !== "neither") add("hidden_lead", lead, { place: p.place, reason: p.reason, row: p.row }, { place: row.place, reason: row.reason, row: row.rowNo });
      else add("wrong_tab", lead, { place: p.place, reason: p.reason, row: p.row }, { place: row.place, reason: row.reason, row: row.rowNo });
      continue;
    }
    if (row.reason !== p.reason) { add("wrong_chip", lead, { reason: p.reason, row: p.row }, { reason: row.reason, row: row.rowNo }); continue; }
    if (row.rowNo !== p.row) add("wrong_row", lead, p.row, row.rowNo);
    for (const [k, v] of Object.entries(p.headline)) {
      if (String(row.headline?.[k]) !== String(v)) add("headline", lead, { row: p.row, [k]: v }, { row: row.rowNo, [k]: row.headline?.[k] });
    }
    const actions = brokenActionsOf(row);
    if (!sameSet(actions, p.brokenActions)) add("broken_actions", lead, p.brokenActions, actions);
  }

  // 2. Every tab/chip view: membership equals the oracle's, counts equal both the rows returned and the oracle.
  const { views, badge } = expectedViews(placements);
  const legacyViews = expectedViews(legacy);
  const legacyExplains = (key: string, actual: number) => sq2 && (legacyViews.views.get(key)?.length ?? 0) === actual && (views.get(key)?.length ?? 0) !== actual ? sq2 : undefined;
  const wanted: Array<[string, string | null]> = [["all", null], ["needs_attention", null], ["waiting", null],
    ...NEEDS_ATTENTION_CHIPS.map((ch): [string, string | null] => ["needs_attention", ch]),
    ...WAITING_CHIPS.map((ch): [string, string | null] => ["waiting", ch]), ["all", "under_contract"]];
  for (const [tab, chip] of wanted) {
    const read = tab === "all" && chip === null ? all : await reader.view(tab, chip);
    const expectIds = new Set((views.get(`${tab}|${chip ?? ""}`) ?? []).map((k) => mat.ids.get(k)!));
    const gotIds = new Set(read.ids);
    checks += 1;
    if (read.ids.length !== gotIds.size) add("view_membership", null, `${tab}/${chip ?? "all"}: unique ids`, `${read.ids.length} rows, ${gotIds.size} unique`);
    const missing = [...expectIds].filter((id) => !gotIds.has(id)), extra = [...gotIds].filter((id) => !expectIds.has(id));
    // Differences that the per-lead pass already explains are not repeated here.
    const unexplained = (ids: string[]) => ids.filter((id) => {
      const k = keyOf.get(id)!, p = placements.get(k)!, row = byKey.get(k);
      return row && row.place === p.place && row.reason === p.reason;
    });
    if (unexplained(missing).length || unexplained(extra).length) add("view_membership", null, `${tab}/${chip ?? "all"}: ${expectIds.size} leads`, { missing: unexplained(missing).map((i) => keyOf.get(i)), extra: unexplained(extra).map((i) => keyOf.get(i)) });
    // count/row consistency: the reported total must equal the rows actually returned, and equal the oracle's count
    if (read.first.total !== read.ids.length) add("count_row", null, `${tab}/${chip ?? "all"}: total ${read.first.total}`, `${read.ids.length} rows returned`);
    if (read.first.total !== expectIds.size) add("count_row", null, `${tab}/${chip ?? "all"}: oracle count ${expectIds.size}`, `total ${read.first.total}`, legacyExplains(`${tab}|${chip ?? ""}`, read.first.total));
    if (chip === null && tab === "all") {
      const tc = (read.first.tabCounts ?? {}) as Record<string, number>;
      const exp = { needs_attention: views.get("needs_attention|")?.length ?? 0, waiting: views.get("waiting|")?.length ?? 0, all: world.leads.length };
      checks += 1;
      for (const k of Object.keys(exp) as Array<keyof typeof exp>) if (Number(tc[k]) !== exp[k]) add("count_row", null, `tabCounts.${k}: ${exp[k]}`, tc[k], legacyExplains(`${k}|`, Number(tc[k])));
      // The full map, both directions: a reason the oracle populates must be present, and the SQL may not invent one.
      const cc = (read.first.chipCounts ?? null) as Record<string, number> | null;
      if (!cc || typeof cc !== "object") add("count_row", null, "chipCounts map present", cc);
      const expectedReasons = new Set([...placements.values()].map((p) => p.reason));
      for (const reason of new Set([...expectedReasons, ...Object.keys(cc ?? {})])) {
        checks += 1;
        const e = views.get(`all|${reason}`)?.length ?? 0;
        const got = cc && reason in cc ? Number(cc[reason]) : undefined;
        if (got === undefined) add("count_row", null, `chipCounts.${reason}: ${e}`, "missing key", legacyExplains(`all|${reason}`, 0));
        else if (got !== e) add("count_row", null, `chipCounts.${reason}: ${e}`, got, legacyExplains(`all|${reason}`, got));
      }
    }
    // within-chip order (design 2 / 3): consecutive rows whose oracle key is known must be non-decreasing
    if (chip !== null && chip !== "under_contract") {
      checks += 1;
      const keys = read.rows.map((r) => placements.get(keyOf.get(r.propertyId) ?? "")?.sortAt);
      for (let i = 1; i < keys.length; i += 1) {
        const a = keys[i - 1], b = keys[i];
        if (a !== undefined && b !== undefined && b < a) { add("order", null, `${tab}/${chip}: ordered by the design's key`, read.rows.slice(Math.max(0, i - 1), i + 1).map((r) => keyOf.get(r.propertyId))); break; }
      }
    }
    // sort order: Needs attention follows the chip order (New lead, Call today, Due, New reply, Broken, Offer, Gone quiet, Nothing planned)
    if (tab === "needs_attention" && chip === null) {
      const ranks = read.rows.map((r) => NEEDS_ATTENTION_CHIPS.indexOf(r.reason));
      checks += 1;
      for (let i = 1; i < ranks.length; i += 1) if (ranks[i]! < ranks[i - 1]!) { add("order", null, "reason order New lead→Nothing planned", read.rows.map((r) => r.reason)); break; }
    }
  }

  // 3. Stage filter and stageCounts, search, and fn_my_leads_work_facts.
  const byStage = new Map<string, number>();
  for (const l of world.leads) byStage.set(l.stage, (byStage.get(l.stage) ?? 0) + 1);
  const sc = all.first.stageCounts as Record<string, number>;
  checks += 1;
  if (!sc || typeof sc !== "object") add("count_row", null, "stageCounts map present", sc);
  for (const stage of new Set([...byStage.keys(), ...Object.keys(sc ?? {})])) {
    const n = byStage.get(stage as never) ?? 0;
    const got = sc && stage in sc ? Number(sc[stage]) : undefined;
    if (got !== n) add("count_row", null, `stageCounts.${stage}: ${n}`, got ?? "missing key");
  }
  for (const stage of byStage.keys()) {
    const page = await reader.page("all", null, 1, 50, stage);
    checks += 1;
    if (page.total !== byStage.get(stage)) add("count_row", null, `all tab filtered to stage ${stage}: ${byStage.get(stage)}`, page.total);
  }
  for (const lead of world.leads.slice(0, 3)) {
    const hit = await reader.page("all", null, 1, 50, null, `${lead.key} Stress`);
    checks += 1;
    if (!hit.ids.includes(mat.ids.get(lead.key))) add("view_membership", lead, `search for its address finds it`, hit.ids.length);
  }
  const miss = await reader.page("all", null, 1, 50, null, "zzqx no such lead");
  checks += 1;
  if (miss.total !== 0) add("view_membership", null, "search for a nonexistent string finds nothing", miss.total);
  const sample = world.leads.slice(0, 48);
  const extra = [...mat.decoyIds.slice(0, 1), "00000000-0000-4000-8000-000000000000"];
  const facts = await reader.facts([...sample.map((l) => mat.ids.get(l.key)!), ...extra]);
  checks += 1;
  const factRows = new Map<string, Json>((facts.rows as Json[]).map((r) => [r.propertyId, r]));
  for (const lead of sample) {
    const r = factRows.get(mat.ids.get(lead.key)!), p = placements.get(lead.key)!;
    if (!r) add("hidden_lead", lead, "returned by fn_my_leads_work_facts", "missing");
    else if (r.place !== p.place || r.reason !== p.reason) {
      const l2 = legacy.get(lead.key)!;
      add("wrong_chip", lead, { via: "work_facts", place: p.place, reason: p.reason }, { place: r.place, reason: r.reason },
        lead.question === "SQ2" && sq2 && r.place === l2.place && r.reason === l2.reason ? sq2 : undefined);
    }
  }
  for (const id of extra) if (!(facts.missing as string[]).includes(id)) add("scope", null, "work_facts reports a decoy / unknown id as missing", id);

  // 4. Sidebar badge.
  checks += 1;
  const sqlBadge = await reader.badge();
  if (sqlBadge !== badge) add("badge", null, badge, sqlBadge, sq2 && sqlBadge === legacyViews.badge ? sq2 : undefined);

  return { mismatches, checks };
}

/** Owner viewing a rep sees exactly what the rep sees; an unrelated rep and another org's owner are refused. */
export async function compareOwnerView(db: Client, ctx: OrgCtx, world: World, c: Ctx, repAll: ViewRead): Promise<Mismatch[]> {
  const out: Mismatch[] = [];
  const at = new Date(world.now);
  const owner = new Reader(db, ctx, ctx.rep, at, ctx.owner);
  const seen = await owner.view("all", null);
  const norm = (v: ViewRead) => v.rows.map((r) => `${r.propertyId}|${r.place}|${r.reason}|${r.rowNo}`);
  if (JSON.stringify(norm(seen)) !== JSON.stringify(norm(repAll)))
    out.push({ kind: "owner_view", family: c.family, repeat: c.repeat, lead: "-", tags: [], expected: "owner view equals the rep's view", actual: { rep: repAll.ids.length, owner: seen.ids.length } });
  for (const [who, sub] of [["other_rep", ctx.otherRep], ["outsider", ctx.outsider]] as const) {
    await db.query("savepoint s1_scope");
    let code: string | null = null;
    try { await new Reader(db, ctx, ctx.rep, at, sub).page("all", null, 1, 25); } catch (error) { code = (error as { code?: string }).code ?? "error"; }
    await db.query("rollback to savepoint s1_scope");
    await db.query("reset role").catch(() => {});
    if (code !== "42501" && code !== "P0002") out.push({ kind: "scope", family: c.family, repeat: c.repeat, lead: "-", tags: [], expected: `${who} refused (42501)`, actual: code ?? "allowed" });
  }
  return out;
}

/** Pagination invariants: 25-row pages concatenate to the 50-row pages, no gaps or duplicates, and a page past the end clamps to the last. */
export async function comparePagination(reader: Reader, c: Ctx): Promise<Mismatch[]> {
  const out: Mismatch[] = [];
  const add = (expected: unknown, actual: unknown) => out.push({ kind: "pagination", family: c.family, repeat: c.repeat, lead: "-", tags: [], expected, actual });
  const big = await reader.view("needs_attention", null, 50);
  const small = await reader.view("needs_attention", null, 25);
  if (JSON.stringify(big.ids) !== JSON.stringify(small.ids)) add("25-row pages equal 50-row pages", { big: big.ids.length, small: small.ids.length });
  if (new Set(small.ids).size !== small.ids.length) add("no duplicate ids across pages", "duplicates");
  const last = Math.max(1, Math.ceil(small.first.total / 25));
  const beyond = await reader.page("needs_attention", null, last + 5, 25);
  if (beyond.page !== last || beyond.ids.length === 0) add(`page clamps to the last page (${last})`, { page: beyond.page, rows: beyond.ids.length });
  if (small.first.total > 25) {
    const page2 = await reader.page("needs_attention", null, 2, 25);
    if (JSON.stringify(page2.ids) !== JSON.stringify(small.ids.slice(25, 50))) add("page 2 is rows 26-50 of the full order", page2.ids.length);
    const rev = new Set(small.first.revision ? [small.first.revision] : []);
    if (rev.size === 0 || page2.revision !== small.first.revision) add("revision is stable across pages of one snapshot", { p1: small.first.revision, p2: page2.revision });
  }
  return out;
}

export type RunOptions = {
  families: readonly FamilyDef[];
  repeats: number;
  seed: number;
  variants?: readonly Variant[];
  onWorld?: (family: string, repeat: number, result: WorldResult) => void;
  /** Stop the whole run when a world throws instead of recording it as an error. */
  failFast?: boolean;
  /** Apply this SQL instead of the checkout's classifier migration (the harness self-test mutates it to prove the oracle notices). */
  migrationSql?: string;
};

export type FamilyRun = {
  family: string;
  title: string;
  worlds: number;
  leads: number;
  checks: number;
  mismatches: Mismatch[];
  errors: string[];
  timings: Timing;
  ms: number;
  /** leads per variant key (wording|stage) and mismatching leads per variant key */
  variantLeads: Record<string, number>;
  variantFailures: Record<string, number>;
};

export async function runFamilies(url: string, opts: RunOptions): Promise<FamilyRun[]> {
  const db = new Client({ connectionString: url });
  await db.connect();
  const runs: FamilyRun[] = [];
  const migrationSql = opts.migrationSql ?? loadClassifierMigration();
  try {
    // One outer transaction PER FAMILY: the migration is applied inside it, every world is a savepoint, nothing commits.
    // Not one per run: Postgres keeps the SQL-function caches built while calling the classifier until the top-level
    // transaction ends (rolling back a savepoint does not free them), so a whole-run transaction grew the backend by
    // ~30 MB/s until the 8 GB VM killed it (test-results/my-leads-queue-stress/oom-diagnosis.md).
    for (const family of opts.families) {
      await db.query("begin");
      await db.query(migrationSql);
      const run: FamilyRun = { family: family.id, title: family.title, worlds: 0, leads: 0, checks: 0, mismatches: [], errors: [], timings: {}, ms: 0, variantLeads: {}, variantFailures: {} };
      const t0 = process.hrtime.bigint();
      for (let repeat = 0; repeat < opts.repeats; repeat += 1) {
        const world = buildFamilyWorld(family, opts.seed, repeat, opts.variants ?? VARIANTS);
        try {
          const result = await evaluateInRolledBackTx(db, family, world, repeat);
          run.worlds += 1; run.leads += result.leads; run.checks += result.checks;
          run.mismatches.push(...result.mismatches);
          for (const [k, v] of Object.entries(result.timings)) (run.timings[k] ??= []).push(...v);
          for (const l of world.leads) { const vk = variantKey(l); run.variantLeads[vk] = (run.variantLeads[vk] ?? 0) + 1; }
          const failing = new Set(result.mismatches.filter((m) => m.lead !== "-").map((m) => m.lead));
          for (const l of world.leads) if (failing.has(l.key)) { const vk = variantKey(l); run.variantFailures[vk] = (run.variantFailures[vk] ?? 0) + 1; }
          opts.onWorld?.(family.id, repeat, result);
        } catch (error) {
          run.errors.push(`repeat ${repeat}: ${error instanceof Error ? error.message : String(error)}`);
          if (opts.failFast) throw error;
        }
      }
      run.ms = MS(t0);
      runs.push(run);
      await db.query("rollback");
    }
  } finally {
    await db.query("rollback").catch(() => {});
    await db.end();
  }
  return runs;
}

const variantKey = (l: Lead) => `${l.tags?.find((t) => t.startsWith("wording:"))?.slice(8) ?? "?"}|${l.tags?.find((t) => t.startsWith("stage:"))?.slice(6) ?? "?"}`;

/** Evaluate one world inside a savepoint of the caller's transaction and roll it back. */
export async function evaluateInRolledBackTx(db: Client, family: FamilyDef, world: World, repeat: number): Promise<WorldResult> {
  await db.query("savepoint s1_world");
  try {
    const ctx = await setupOrg(db);
    const mat = await materializeWorld(db, ctx, world, { decoys: true });
    await db.query("analyze");
    const at = new Date(world.now);
    const reader = new Reader(db, ctx, ctx.rep, at, ctx.rep);
    const c = { family: family.id, repeat };
    const { mismatches, checks } = await compareWorld(reader, world, mat, c);
    let extra = 0;
    if (family.view === "owner") {
      const repAll = await reader.view("all", null);
      mismatches.push(...(await compareOwnerView(db, ctx, world, c, repAll))); extra += 3;
    }
    if (family.view === "deep_link") { mismatches.push(...(await comparePagination(reader, c))); extra += 5; }
    return { leads: world.leads.length, checks: checks + extra, mismatches, timings: reader.timings };
  } finally {
    await db.query("rollback to savepoint s1_world").catch(() => {});
    await db.query("release savepoint s1_world").catch(() => {});
  }
}

export { FAMILIES };
