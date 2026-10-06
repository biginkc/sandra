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

/** Each rendered section badge ("N leads") equals the database's count of the rep's leads in that stage. The drip section is a different population and is not compared. */
export function sectionParityProblems(sections: ReadonlyArray<{ stage: string; badge: string }>, dbCounts: Readonly<Record<string, number>>): string[] {
  const p: string[] = [];
  if (sections.length === 0) p.push("no section rendered");
  for (const s of sections) {
    if (s.stage === "in_drip") continue;
    const n = Number(/^(\d+) leads?$/.exec(s.badge)?.[1] ?? NaN);
    if (!Number.isFinite(n)) { p.push(`section ${s.stage}: no readable count badge ("${s.badge}")`); continue; }
    const want = dbCounts[s.stage] ?? 0;
    if (n !== want) p.push(`section ${s.stage} shows ${n}, the database has ${want}`);
  }
  return p;
}
