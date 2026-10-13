import type { SupabaseClient } from "@supabase/supabase-js";

/** In-memory test double for the follow-up notifier and the cron that runs it (unit tests only). */
export type Row = Record<string, unknown>;

/** Reads `a->b->>c` paths the way PostgREST does. */
export function pathValue(row: Row, col: string): unknown {
  const [head, ...rest] = col.split(/->>?/);
  let v: unknown = row[head!];
  for (const key of rest) v = v && typeof v === "object" ? (v as Row)[key] : undefined;
  return v;
}

/** In-memory double with the filter surface the worker uses; every write lands only in the table it names. */
export function makeClient(tables: Record<string, Row[] | "absent">, hooks: { beforeWrite?: () => void; failWrite?: (values: Row) => boolean } = {}) {
  const writes: { table: string; values: Row }[] = [];
  function from(table: string) {
    const source = tables[table];
    // Filters run when the statement executes (not when it is built), like Postgres re-checking a row after waiting for its lock.
    const filters: ((r: Row) => boolean)[] = [];
    let sorter: ((a: Row, b: Row) => number) | null = null;
    let max = Infinity;
    let pending: Row | null = null;
    const run = () => {
      let rows: Row[] = source === "absent" ? [] : (source ?? []);
      rows = rows.filter((r) => filters.every((f) => f(r)));
      if (sorter) rows = [...rows].sort(sorter);
      return rows.slice(0, max);
    };
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (col: string, val: unknown) => (filters.push((r) => pathValue(r, col) === val), api),
      lte: (col: string, val: string) => (filters.push((r) => pathValue(r, col) !== undefined && pathValue(r, col) !== null && String(pathValue(r, col)) <= val), api),
      is: (col: string, val: null) => (filters.push((r) => (pathValue(r, col) ?? null) === val), api),
      order: (col: string, o?: { ascending?: boolean }) => ((sorter = (a, b) => String(a[col]).localeCompare(String(b[col])) * (o?.ascending === false ? -1 : 1)), api),
      limit: (n: number) => ((max = n), api),
      update: (values: Row) => ((pending = values), api),
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        if (source === "absent") return resolve({ data: null, error: { code: "42P01", message: `relation "${table}" does not exist` } });
        const rows = run();
        if (pending) {
          if (hooks.failWrite?.(pending)) return resolve({ data: null, error: { message: "db down" } });
          hooks.beforeWrite?.();
          // The hook may change a row between the statement being issued and applied; re-check, as Postgres does.
          const still = rows.filter((r) => filters.every((f) => f(r)));
          writes.push({ table, values: pending });
          for (const row of still) Object.assign(row, pending);
          return resolve({ data: still.map((r) => ({ id: r.id })), error: null });
        }
        return resolve({ data: rows, error: null });
      },
    };
    return api;
  }
  return { client: { from } as unknown as SupabaseClient, writes, tables };
}

