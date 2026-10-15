/**
 * Reads a whole list, not just the first response. PostgREST silently caps a response (1,000 rows by default),
 * so a plain list query can "succeed" with later rows missing. This pages with `range` until a short page, and
 * any page error fails the whole read (the caller decides whether that is fatal; it is never a partial success).
 */
export const PAGE_ROWS = 1000;

export async function fetchAllPages<T>(
  make: () => { range(from: number, to: number): PromiseLike<{ data: unknown; error: unknown }> },
  pageRows: number = PAGE_ROWS,
): Promise<{ rows: T[]; error: unknown }> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageRows) {
    const res = await make().range(from, from + pageRows - 1);
    if (res.error) return { rows: [], error: res.error };
    const page = (res.data ?? []) as T[];
    rows.push(...page);
    if (page.length < pageRows) return { rows, error: null };
  }
}
