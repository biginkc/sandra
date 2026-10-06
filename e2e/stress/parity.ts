/**
 * Oracle 16, the page-level half: the rendered Call-next strip and the section counts against the database. Pure so the comparisons are unit-tested.
 */

/** The strip renders the first N of the database's ordered rows (N is the page's own limit): same ids, same order, none missing, none extra. */
export function stripParityProblems(rendered: readonly string[], db: readonly string[]): string[] {
  const p: string[] = [];
  if (db.length > 0 && rendered.length === 0) p.push("the strip rendered no rows but the database has Call-next rows");
  if (rendered.length > db.length) p.push(`the strip rendered ${rendered.length} rows, the database has ${db.length}`);
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
