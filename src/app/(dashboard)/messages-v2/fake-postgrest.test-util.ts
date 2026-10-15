/**
 * Test-only in-memory PostgREST: real filter semantics for the operators the waiting list and tape use,
 * a configurable server row cap (like PostgREST's max-rows), per-table failures, and RPC handlers.
 * Not imported by app code.
 */
import type { LooseSupabase } from "./queries";

type Row = Record<string, unknown>;
type Op =
  | { k: "eq" | "gt" | "gte" | "lt"; col: string; v: unknown }
  | { k: "in"; col: string; v: unknown[] }
  | { k: "isnull"; col: string; not: boolean }
  | { k: "cursor"; at: string; id: string };

export type FakeOptions = {
  /** Max rows any single response returns (PostgREST max-rows). */
  cap?: number;
  /** Return an error for this table query (called with the table and the 1-based request number for it). */
  fail?: (table: string, n: number, ops: Op[]) => boolean;
  rpc?: Record<string, (args: Record<string, unknown>) => { data: unknown; error: unknown }>;
};

export function fakePostgrest(tables: Record<string, Row[]>, opts: FakeOptions = {}) {
  const requests = new Map<string, number>();
  const log: Array<{ table: string; ops: Op[]; select: string | null }> = [];
  const rpcLog: string[] = [];
  const from = (table: string) => {
    const ops: Op[] = [];
    const orders: Array<{ col: string; asc: boolean }> = [];
    let limit = Infinity;
    let range: [number, number] | null = null;
    let single = false;
    let patch: Row | null = null;
    let select: string | null = null;
    const q: Record<string, unknown> = {};
    q.select = (cols = "*") => ((select = cols), q);
    q.eq = (col: string, v: unknown) => (ops.push({ k: "eq", col, v }), q);
    q.gt = (col: string, v: unknown) => (ops.push({ k: "gt", col, v }), q);
    q.gte = (col: string, v: unknown) => (ops.push({ k: "gte", col, v }), q);
    q.lt = (col: string, v: unknown) => (ops.push({ k: "lt", col, v }), q);
    q.in = (col: string, v: unknown[]) => (ops.push({ k: "in", col, v }), q);
    // Only the null forms are implemented; anything else throws so a test can never pass on an ignored filter.
    q.is = (col: string, v: unknown) => {
      if (v !== null) throw new Error(`fake is(${col}, ${String(v)}) unsupported: only null`);
      ops.push({ k: "isnull", col, not: false });
      return q;
    };
    q.not = (col: string, op: string, v: unknown) => {
      if (op !== "is" || v !== null) throw new Error(`fake not(${col}, ${op}, ${String(v)}) unsupported: only "is", null`);
      ops.push({ k: "isnull", col, not: true });
      return q;
    };
    q.order = (col: string, o: { ascending: boolean } = { ascending: true }) => (orders.push({ col, asc: o.ascending }), q);
    q.limit = (n: number) => ((limit = n), q);
    q.range = (a: number, b: number) => ((range = [a, b]), q);
    q.maybeSingle = () => ((single = true), q);
    q.update = (vals: Row) => ((patch = vals), q);
    // Only the tape's (started_at, id) keyset filter is supported: started_at.lt."X",and(started_at.eq."X",id.lt.Y)
    q.or = (f: string) => {
      const m = /^started_at\.lt\."([^"]+)",and\(started_at\.eq\."([^"]+)",id\.lt\.([^)]+)\)$/.exec(f);
      if (!m || m[1] !== m[2]) throw new Error(`fake or() cannot parse ${f}`);
      ops.push({ k: "cursor", at: m[1], id: m[3] });
      return q;
    };
    q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      const n = (requests.get(table) ?? 0) + 1;
      requests.set(table, n);
      log.push({ table, ops: [...ops], select });
      if (opts.fail?.(table, n, ops)) return Promise.resolve({ data: null, error: { message: `fail ${table}` } }).then(resolve, reject);
      const cmp = (a: unknown, b: unknown) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
      let rows = (tables[table] ?? []).filter((r) =>
        ops.every((o) => {
          const v = "col" in o ? r[o.col] : undefined;
          switch (o.k) {
            case "eq":
              return v === o.v;
            case "gt":
              return v !== null && v !== undefined && cmp(v, o.v) > 0;
            case "gte":
              return v !== null && v !== undefined && cmp(v, o.v) >= 0;
            case "lt":
              return v !== null && v !== undefined && cmp(v, o.v) < 0;
            case "in":
              return o.v.includes(v);
            case "isnull":
              return o.not ? v !== null && v !== undefined : v === null || v === undefined;
            case "cursor": {
              const at = String(r.started_at);
              return cmp(at, o.at) < 0 || (at === o.at && cmp(r.id, o.id) < 0);
            }
          }
        }),
      );
      if (orders.length)
        rows = [...rows].sort((a, b) => {
          for (const o of orders) {
            const c = cmp(a[o.col], b[o.col]);
            if (c) return o.asc ? c : -c;
          }
          return 0;
        });
      if (range) rows = rows.slice(range[0], range[1] + 1);
      if (Number.isFinite(limit)) rows = rows.slice(0, limit);
      if (opts.cap) rows = rows.slice(0, opts.cap);
      if (patch) {
        const p = patch;
        tables[table] = (tables[table] ?? []).map((r) => (rows.includes(r) ? { ...r, ...p } : r));
        rows = rows.map((r) => ({ ...r, ...p }));
      }
      return Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null }).then(resolve, reject);
    };
    return q;
  };
  const client = {
    from,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcLog.push(fn);
      const h = opts.rpc?.[fn];
      // An RPC the test did not register is a bug in the test, never an empty success.
      if (!h) throw new Error(`fake rpc ${fn} not registered`);
      return h(args);
    },
  } as unknown as LooseSupabase;
  return { client, requests, log, rpcLog };
}
