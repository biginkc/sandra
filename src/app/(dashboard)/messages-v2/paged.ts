/**
 * Reads a whole list, not just the first response. PostgREST silently caps a response (often 1,000 rows,
 * sometimes less), so neither "a short page means the end" nor offsets are safe: offsets shift when rows
 * change between requests, and a server cap below the page size makes every page "short". This pages by
 * keyset on a unique column (`id`): ask for rows with key > the last key seen, until a page comes back EMPTY.
 * Any failed page, or a page that does not move the key forward, fails the whole read (never a partial success).
 */
export const PAGE_ROWS = 1000;

type KeysetQuery = {
  order(column: string, opts: { ascending: boolean }): KeysetQuery;
  gt(column: string, value: string): KeysetQuery;
  limit(n: number): PromiseLike<{ data: unknown; error: unknown }>;
};

export async function fetchAllKeyset<T>(
  /** A fresh, filtered, UNORDERED query each call; this adds the key order, the cursor and the limit. */
  make: () => unknown,
  key = "id",
  pageRows: number = PAGE_ROWS,
): Promise<{ rows: T[]; error: unknown }> {
  const rows: T[] = [];
  let last: string | null = null;
  for (;;) {
    let q = (make() as KeysetQuery).order(key, { ascending: true });
    if (last !== null) q = q.gt(key, last);
    const res = await q.limit(pageRows);
    if (res.error) return { rows: [], error: res.error };
    const page = (res.data ?? []) as Array<Record<string, unknown>>;
    if (page.length === 0) return { rows, error: null };
    const next = page[page.length - 1]?.[key];
    if (typeof next !== "string" || (last !== null && next <= last)) {
      return { rows: [], error: { message: `keyset paging on ${key} did not advance` } };
    }
    rows.push(...(page as T[]));
    last = next;
  }
}
