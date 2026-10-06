/**
 * Oracle 16, the page-level half: the rendered Call-next strip and the section counts against the database. Pure so the comparisons are unit-tested.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The strip's page limit, read from its single source of truth (`CALL_NEXT_LIMIT` in src/lib/my-leads/call-next.ts) rather than copied. That module
 * imports `server-only` and the Supabase stack, which neither the Playwright worker nor tsx can load, so the declaration is read from the file; it
 * throws if the declaration changes shape, and a unit test checks the value against a real import of the module.
 */
export function readCallNextLimit(file = path.resolve(__dirname, "../../src/lib/my-leads/call-next.ts")): number {
  const m = /export const CALL_NEXT_LIMIT = (\d+);/.exec(readFileSync(file, "utf8"));
  if (!m) throw new Error("CALL_NEXT_LIMIT declaration not found in call-next.ts: update e2e/stress/parity.ts");
  return Number(m[1]);
}

/**
 * The strip renders exactly the first min(limit, db rows) of the database's ordered rows: same ids, same order, none missing (also none dropped
 * from the END), none extra.
 */
export function stripParityProblems(rendered: readonly string[], db: readonly string[], limit: number = readCallNextLimit()): string[] {
  const p: string[] = [];
  const want = Math.min(limit, db.length);
  if (db.length > 0 && rendered.length === 0) p.push("the strip rendered no rows but the database has Call-next rows");
  if (rendered.length !== want) p.push(`the strip rendered ${rendered.length} rows, expected ${want} (page limit ${limit}, database rows ${db.length})`);
  if (new Set(rendered).size !== rendered.length) p.push("the strip rendered a lead twice");
  rendered.forEach((id, i) => { if (db[i] !== id) p.push(`strip row ${i + 1} is ${id}, the database says ${db[i] ?? "nothing"}`); });
  return p;
}

import { MY_LEAD_STAGE_ORDER } from "../../src/app/(dashboard)/my-leads/_components/types";

export const IN_DRIP = "in_drip" as const;
/** Every section the page renders, in order. Built from the app's own stage list so a new stage fails parity until the harness learns it. */
export const ALL_SECTIONS: readonly string[] = [...MY_LEAD_STAGE_ORDER, IN_DRIP];

export type ExpectedSections = { stages: Readonly<Record<string, number>>; inDrip: number };
export type RenderedSection = { stage: string; badge: string };

/**
 * Expected section counts, from the rep's leads: one row per (stage, in active drip) with a count. Archived queue states and deleted leads are
 * excluded by the query; leads in an ACTIVE drip count under in_drip, not under their stage (as the page subtracts them). A stage the app does not
 * know is reported, not dropped.
 */
export function expectedSectionCounts(rows: ReadonlyArray<{ stage: string; in_drip: boolean; n: number }>): { expected: ExpectedSections; problems: string[] } {
  const stages: Record<string, number> = Object.fromEntries(MY_LEAD_STAGE_ORDER.map((st) => [st, 0]));
  let inDrip = 0;
  const problems: string[] = [];
  for (const r of rows) {
    if (!(MY_LEAD_STAGE_ORDER as readonly string[]).includes(r.stage)) { problems.push(`unknown stage ${r.stage} in database (${r.n} lead(s))`); continue; }
    if (r.in_drip) inDrip += r.n; else stages[r.stage] = (stages[r.stage] ?? 0) + r.n;
  }
  return { expected: { stages, inDrip }, problems };
}

/**
 * Section parity over the COMPLETE expected set, not just what rendered. The page always renders all six sections (empty ones show `0 leads`), so a
 * missing, extra or duplicated section is a render failure whatever the database holds. `alwaysRendered: false` is the conscious switch for a page
 * that renders only non-empty sections (missing then matters only when the database has leads; present-with-0 is extra).
 */
export function sectionParityProblems(rendered: ReadonlyArray<RenderedSection>, expected: ExpectedSections, opts: { alwaysRendered?: boolean } = {}): string[] {
  const alwaysRendered = opts.alwaysRendered ?? true;
  const p: string[] = [];
  const countOf = (stage: string) => (stage === IN_DRIP ? expected.inDrip : expected.stages[stage] ?? 0);
  const seen = new Map<string, RenderedSection[]>();
  for (const r of rendered) seen.set(r.stage, [...(seen.get(r.stage) ?? []), r]);
  for (const stage of seen.keys()) if (!ALL_SECTIONS.includes(stage)) p.push(`extra section ${stage}`);
  for (const stage of ALL_SECTIONS) {
    const got = seen.get(stage) ?? [];
    const want = countOf(stage);
    if (got.length === 0) {
      if (alwaysRendered || want > 0) p.push(`section ${stage} missing (database has ${want})`);
      continue;
    }
    if (got.length > 1) p.push(`section ${stage} rendered twice`);
    // The page renders `1 lead` and `N leads` (queue.tsx): "1 leads" and "2 lead" are wrong.
    const bm = /^(\d+) (lead|leads)$/.exec(got[0]!.badge);
    const n = bm && ((bm[1] === "1") === (bm[2] === "lead")) ? Number(bm[1]) : NaN;
    if (!Number.isFinite(n)) { p.push(`section ${stage}: no readable count badge ("${got[0]!.badge}")`); continue; }
    if (!alwaysRendered && want === 0) { p.push(`section ${stage} rendered although the database has none (page is render-only-when-non-empty)`); continue; }
    if (n !== want) p.push(`section ${stage} shows ${n}, database has ${want}`);
  }
  if (rendered.length === 0) p.push("no section rendered");
  return p;
}

/**
 * The expected-count source: the page's own owned-lead definition, `my_leads_queue_rows` called with the REP as its member argument (an internal helper, not executable by `authenticated`; an open assignment episode, not DNC-locked,
 * status not closed/dead/dnc, archived excluded), each row joined to its property and to whether it is in an ACTIVE drip. The same query, filtered to
 * non-run addresses, is the "rep owns only run leads" guard.
 */
export const QUEUE_ROWS_SQL = `select r.property_id as property_id, r.stage as stage,
       exists (select 1 from public.sequence_enrollments e where e.property_id = r.property_id and e.org_id = $1 and e.status = 'active') as in_drip,
       (p.address like $3 || '%') as is_run_lead
  from public.my_leads_queue_rows($1, $2, statement_timestamp()) r
  join public.properties p on p.id = r.property_id and p.org_id = $1`;

export type QueueRow = { property_id?: string; stage: string; in_drip: boolean; is_run_lead: boolean };

/** Folds the rep's queue rows into expected section counts, and refuses (a problem) when the rep owns a lead that is not a run lead. */
export function expectedFromQueueRows(rows: readonly QueueRow[]): { expected: ExpectedSections; problems: string[] } {
  const counted = new Map<string, number>();
  for (const r of rows) { const k = `${r.stage}|${r.in_drip}`; counted.set(k, (counted.get(k) ?? 0) + 1); }
  const { expected, problems } = expectedSectionCounts([...counted].map(([k, n]) => { const [stage, d] = k.split("|"); return { stage: stage!, in_drip: d === "true", n }; }));
  const foreign = rows.filter((r) => !r.is_run_lead).length;
  if (foreign > 0) problems.push(`the rep owns ${foreign} queue lead(s) that are not run leads: section counts cannot be compared`);
  return { expected, problems };
}

/**
 * Non-vacuity: the comparisons above are meaningless over nothing. The strip must render at least one row (when the database has Call-next rows),
 * the rep's queue must hold at least one lead, and EVERY run lead must be in that queue (a missing run lead is a lost lead, not a smaller count).
 */
export function nonVacuityProblems(i: { renderedStrip: readonly string[]; dbStrip: readonly string[]; queueRows: readonly QueueRow[]; runLeadIds: readonly string[] }): string[] {
  const p: string[] = [];
  if (i.dbStrip.length === 0) p.push("the database has no Call-next rows: strip parity compared nothing");
  if (i.renderedStrip.length === 0) p.push("the page rendered no strip rows: strip parity compared nothing");
  if (i.queueRows.length === 0) p.push("the rep's queue is empty: section parity compared nothing");
  const inQueue = new Set(i.queueRows.map((r) => r.property_id));
  const missing = i.runLeadIds.filter((id) => !inQueue.has(id));
  if (missing.length > 0) p.push(`${missing.length} run lead(s) are missing from the rep's queue (first: ${missing[0]})`);
  return p;
}
