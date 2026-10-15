import { Client } from "pg";

import { createRng } from "../prng";
import { materializeWorld, setupOrg } from "./materialize";
import { loadClassifierMigration } from "./migration";
import { NEEDS_ATTENTION_CHIPS, WAITING_CHIPS, expectedViews, place } from "./oracle";
import { PROD_SHAPE_2026_10_14, prodShapedWorld, scaleCounts } from "./prod-shape";
import { P95_BUDGET_MS, stat, type PlanNode, type ScaleSize } from "./report";
import { Reader, type Mismatch } from "./runner";

export type ScaleOptions = {
  sizes: readonly number[];
  /** Timing samples per call (default 10). */
  samples: number;
  seed: number;
  messages?: [number, number];
  /** EXPLAIN ANALYZE breakdown for every measured size (default on). */
  explain?: boolean;
};

type RawPlan = { "Node Type": string; "Actual Total Time": number; "Actual Loops": number; "Actual Rows": number; Plans?: RawPlan[]; "CTE Name"?: string; "Subplan Name"?: string; "Relation Name"?: string; "Function Name"?: string; "Index Name"?: string; "Parent Relationship"?: string };

/**
 * The classifier is SECURITY DEFINER, so EXPLAIN on a call shows one Function Scan. Run its body instead, with the parameters bound as
 * literals, and rank plan nodes by exclusive time (own time x loops minus children), labelled with their CTE / relation.
 */
export async function explainClassifier(db: Client, org: string, member: string, at: string): Promise<PlanNode[]> {
  const def = (await db.query("select prosrc from pg_proc where oid = 'public.my_leads_work_classified(uuid,uuid,timestamptz)'::regprocedure")).rows[0].prosrc as string;
  const body = def.replace(/\bp_org\b/g, `'${org}'::uuid`).replace(/\bp_member\b/g, `'${member}'::uuid`).replace(/\bp_at\b/g, `'${at}'::timestamptz`).trim().replace(/;\s*$/, "");
  const plan = (await db.query(`explain (analyze, format json) ${body}`)).rows[0]["QUERY PLAN"][0].Plan as RawPlan;
  const out: PlanNode[] = [];
  const walk = (p: RawPlan, cte: string | null) => {
    const label = p["CTE Name"] ?? p["Subplan Name"] ?? cte;
    const total = p["Actual Total Time"] * p["Actual Loops"];
    const kids = (p.Plans ?? []).reduce((a, c) => a + c["Actual Total Time"] * c["Actual Loops"], 0);
    const what = p["Relation Name"] ?? p["Function Name"] ?? p["Index Name"] ?? "";
    out.push({ node: `${p["Node Type"]}${what ? ` ${what}` : ""}${label ? ` [${label}]` : ""}`, exclusiveMs: Math.round(Math.max(0, total - kids) * 10) / 10, totalMs: Math.round(total * 10) / 10, loops: p["Actual Loops"], rows: p["Actual Rows"] });
    for (const c of p.Plans ?? []) walk(c, p["Node Type"] === "CTE Scan" ? cte : (c["Parent Relationship"] === "InitPlan" || c["Subplan Name"]) ? (c["Subplan Name"] ?? label) : label);
  };
  walk(plan, null);
  return out.sort((a, b) => b.exclusiveMs - a.exclusiveMs).slice(0, 5);
}

/**
 * Scale lane: prod-shaped queues of N leads (4-12 messages each, ledger receipts linked), seeded in a rolled-back transaction.
 * Measures p50/p95 of fn_my_leads_work_page per tab and chip and of fn_my_leads_badge_v2 (all as the signed-in member), and the
 * cost of the two queue projections the classifier re-reads (reported separately). At this size a full row-by-row comparison would
 * take minutes per view, so correctness here is the oracle's tab/chip COUNTS against the page's counts plus the badge.
 */
export async function runScale(url: string, opts: ScaleOptions): Promise<{ sizes: ScaleSize[]; mismatches: Mismatch[] }> {
  const sizes: ScaleSize[] = [];
  const mismatches: Mismatch[] = [];
  for (const n of opts.sizes) {
    const db = new Client({ connectionString: url });
    await db.connect();
    try {
      await db.query("begin");
      await db.query(loadClassifierMigration());
      const rng = createRng(opts.seed + n);
      const now = Date.UTC(2026, 9, 14, 17, 0, 0);
      const world = prodShapedWorld(scaleCounts(PROD_SHAPE_2026_10_14, n), rng, now, { messages: opts.messages });
      const t0 = Date.now();
      const ctx = await setupOrg(db);
      const mat = await materializeWorld(db, ctx, world);
      await db.query("analyze");
      const seedMs = Date.now() - t0;
      const messages = world.leads.reduce((a, l) => a + l.messages.length, 0);

      const reader = new Reader(db, ctx, ctx.rep, new Date(now), ctx.rep);
      const placements = new Map(world.leads.map((l) => [l.key, place(l, now)]));
      const { views, badge } = expectedViews(placements);
      const wanted: Array<[string, string | null]> = [["needs_attention", null], ["waiting", null], ["all", null],
        ...NEEDS_ATTENTION_CHIPS.map((c): [string, string | null] => ["needs_attention", c]), ...WAITING_CHIPS.map((c): [string, string | null] => ["waiting", c])];
      for (let s = 0; s < opts.samples; s += 1) {
        for (const [tab, chip] of wanted) {
          const first = await reader.page(tab, chip, 1, 25);
          if (s === 0) {
            const exp = views.get(`${tab}|${chip ?? ""}`)?.length ?? 0;
            if (first.total !== exp) mismatches.push({ kind: "count_row", family: `scale_${n}`, repeat: 0, lead: "-", tags: [], expected: `${tab}/${chip ?? "all"}: ${exp}`, actual: first.total });
          }
        }
        const b = await reader.badge();
        if (s === 0 && b !== badge) mismatches.push({ kind: "badge", family: `scale_${n}`, repeat: 0, lead: "-", tags: [], expected: badge, actual: b });
      }
      // the duplicate queue projections the classifier re-reads, timed on their own (as the table owner; they are internal)
      for (let s = 0; s < opts.samples; s += 1) {
        for (const [label, sql] of [
          ["projection:my_leads_queue_rows", "select count(*) from public.my_leads_queue_rows($1,$2,$3)"],
          ["projection:my_leads_touch_facts", "select count(*) from public.my_leads_touch_facts($1,$2,$3)"],
          ["projection:work_classified", "select count(*) from public.my_leads_work_classified($1,$2,$3)"],
        ] as const) {
          const t = process.hrtime.bigint();
          await db.query(sql, [ctx.org, ctx.rep, new Date(now).toISOString()]);
          (reader.timings[label] ??= []).push(Number(process.hrtime.bigint() - t) / 1e6);
        }
      }
      const explainTop = opts.explain !== false ? await explainClassifier(db, ctx.org, ctx.rep, new Date(now).toISOString()) : undefined;
      const timings = Object.fromEntries(Object.entries(reader.timings).map(([k, v]) => [k, stat(v)]));
      const budgeted = Object.entries(timings).filter(([k]) => !k.startsWith("projection:"));
      sizes.push({ explainTop, leads: n, messagesPerLead: opts.messages ?? [4, 12], messages, seedMs, timings, worstP95Ms: budgeted.reduce((a, [, v]) => Math.max(a, v.p95), 0), budgetMs: P95_BUDGET_MS });
      void mat;
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  }
  return { sizes, mismatches };
}
