import type { SupabaseClient } from "@supabase/supabase-js";
import { Pool, types } from "pg";

import type { Database } from "@/lib/supabase/types";

import type { Trace } from "./trace";

/**
 * A Supabase-client double that talks to a REAL Postgres through a connection
 * pool. Every operation (rpc, select, update) is issued as its own statement on
 * whichever pooled connection is free, so concurrent callers genuinely
 * interleave inside the database (unlike the one-transaction integration
 * tests). Only the surface the Norma code uses is implemented; anything else
 * throws so a test can never silently do something unmodelled.
 *
 * Hooks let a test hold an operation at a named point (barriers).
 */
export type OpInfo = { actor: string; kind: "rpc" | "select" | "update"; name: string; args?: unknown };
export type OpHook = (info: OpInfo) => Promise<void> | void;

export type PgClientOptions = {
  actor: string;
  trace?: Trace;
  /** Awaited before the statement is sent. */
  before?: OpHook;
  /** Awaited after the statement completed (success or error). */
  after?: (info: OpInfo, outcome: { ok: boolean; code?: string }) => Promise<void> | void;
};

type ProcMeta = { retset: boolean };

// timestamptz as an ISO string with microseconds, the way PostgREST returns it,
// so a value read back can be used in an equality filter without losing precision.
const TIMESTAMPTZ = 1184;
const parseTimestamptz = (value: string) => {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(?::?(\d{2}))?$/.exec(value);
  if (!match) return value;
  return `${match[1]}T${match[2]}${match[3]}:${match[4] ?? "00"}`;
};

export function createStressPool(connectionString: string, max = 48) {
  const pool = new Pool({
    connectionString,
    max,
    // The service-role claim every fn_norma_* function checks, set at connect.
    options: "-c request.jwt.claim.role=service_role",
    types: {
      getTypeParser: ((oid: number, format?: "text" | "binary") =>
        oid === TIMESTAMPTZ ? parseTimestamptz : types.getTypeParser(oid, format as "text")) as typeof types.getTypeParser,
    },
  });
  pool.on("error", () => undefined);
  return pool;
}

const q = (ident: string) => {
  // A column, or a PostgREST JSON path such as payload->slack_notice->>lease_token.
  if (!/^[a-z_][a-z0-9_]*((->>?)[a-z_][a-z0-9_]*)*$/i.test(ident)) throw new Error(`pg-client: unsupported identifier ${ident}`);
  const [column, ...rest] = ident.split(/(->>?)/);
  let sql = `"${column}"`;
  for (let i = 0; i < rest.length; i += 2) sql += `${rest[i]}'${rest[i + 1]}'`;
  return sql;
};

type Filter = { sql: (n: number) => string; params: unknown[] };

export function createPgSupabase(pool: Pool, options: PgClientOptions): SupabaseClient<Database> {
  const procs = new Map<string, ProcMeta>();
  let procsLoaded: Promise<void> | null = null;
  const loadProcs = () =>
    (procsLoaded ??= pool
      .query<{ proname: string; proretset: boolean }>(
        "select p.proname, p.proretset from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'",
      )
      .then((r) => {
        for (const row of r.rows) procs.set(row.proname, { retset: row.proretset });
      }));

  async function run<T>(info: OpInfo, exec: () => Promise<T>): Promise<{ data: T | null; error: { message: string; code?: string } | null }> {
    options.trace?.add(options.actor, "start", `${info.kind}:${info.name}`, info.kind === "rpc" ? { args: info.args } : undefined);
    try {
      await options.before?.(info);
      const data = await exec();
      options.trace?.add(options.actor, "end", `${info.kind}:${info.name}`);
      await options.after?.(info, { ok: true });
      return { data, error: null };
    } catch (error) {
      const code = (error as { code?: string }).code;
      options.trace?.add(options.actor, "end", `${info.kind}:${info.name}`, { error: (error as Error).message, code, detail: (error as { detail?: string }).detail, where: (error as { where?: string }).where });
      await options.after?.(info, { ok: false, code });
      return { data: null, error: { message: (error as Error).message, code } };
    }
  }

  async function rpc(name: string, args: Record<string, unknown> = {}) {
    await loadProcs();
    const meta = procs.get(name);
    if (!meta) return { data: null, error: { message: `function ${name} does not exist`, code: "PGRST202" } };
    const keys = Object.keys(args).filter((k) => args[k] !== undefined);
    const call = `public.${q(name)}(${keys.map((k, i) => `${q(k)} => $${i + 1}`).join(", ")})`;
    const params = keys.map((k) => args[k]);
    return run({ actor: options.actor, kind: "rpc", name, args }, async () => {
      if (meta.retset) return (await pool.query(`select * from ${call}`, params)).rows;
      const row = (await pool.query(`select ${call} as v`, params)).rows[0];
      return row?.v ?? null;
    });
  }

  function from(table: string) {
    const filters: Filter[] = [];
    let mode: "select" | "update" = "select";
    let columns = "*";
    let returning: string | null = null;
    let patch: Record<string, unknown> = {};
    let orderBy: string | null = null;
    let limitN: number | null = null;
    let single: "maybe" | "one" | null = null;

    const cols = (list: string) =>
      list.trim() === "*" ? "*" : list.split(",").map((c) => q(c.trim())).join(", ");
    const where = (params: unknown[]) => {
      const parts = filters.map((f) => {
        const sql = f.sql(params.length + 1);
        params.push(...f.params);
        return sql;
      });
      return parts.length ? ` where ${parts.join(" and ")}` : "";
    };
    const push = (col: string, op: string, value: unknown) => {
      filters.push({ sql: (n) => `${q(col)} ${op} $${n}`, params: [value] });
    };

    async function execute() {
      const info: OpInfo = { actor: options.actor, kind: mode, name: table };
      return run(info, async () => {
        const params: unknown[] = [];
        let sql: string;
        if (mode === "select") {
          sql = `select ${cols(columns)} from public.${q(table)}`;
          sql += where(params);
          if (orderBy) sql += ` order by ${orderBy}`;
          if (limitN !== null) sql += ` limit ${Math.floor(limitN)}`;
        } else {
          const keys = Object.keys(patch);
          const sets = keys.map((k) => {
            params.push(patch[k]);
            return `${q(k)} = $${params.length}`;
          });
          sql = `update public.${q(table)} set ${sets.join(", ")}`;
          sql += where(params);
          if (returning) sql += ` returning ${cols(returning)}`;
        }
        const result = await pool.query(sql, params);
        const rows = mode === "update" && !returning ? null : result.rows;
        if (single && rows) {
          if (rows.length > 1) throw Object.assign(new Error("multiple rows for single()"), { code: "PGRST116" });
          if (rows.length === 0 && single === "one") throw Object.assign(new Error("no rows for single()"), { code: "PGRST116" });
          return rows[0] ?? null;
        }
        return rows;
      });
    }

    const api = {
      select(list = "*") {
        if (mode === "update") returning = list;
        else columns = list;
        return api;
      },
      update(values: Record<string, unknown>) {
        mode = "update";
        patch = values;
        return api;
      },
      eq(col: string, value: unknown) {
        if (value === null) filters.push({ sql: () => `${q(col)} is null`, params: [] });
        else push(col, "=", value);
        return api;
      },
      neq: (col: string, value: unknown) => (push(col, "<>", value), api),
      lt: (col: string, value: unknown) => (push(col, "<", value), api),
      lte: (col: string, value: unknown) => (push(col, "<=", value), api),
      gt: (col: string, value: unknown) => (push(col, ">", value), api),
      gte: (col: string, value: unknown) => (push(col, ">=", value), api),
      in(col: string, values: unknown[]) {
        filters.push({ sql: (n) => `${q(col)} = any($${n})`, params: [values] });
        return api;
      },
      is(col: string, value: null | boolean) {
        filters.push({ sql: () => `${q(col)} is ${value === null ? "null" : value ? "true" : "false"}`, params: [] });
        return api;
      },
      not(col: string, op: string, value: null) {
        if (op !== "is" || value !== null) throw new Error("pg-client: only not(col,'is',null) is modelled");
        filters.push({ sql: () => `${q(col)} is not null`, params: [] });
        return api;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orderBy = `${q(col)} ${opts?.ascending === false ? "desc" : "asc"}`;
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      maybeSingle() {
        single = "maybe";
        return execute();
      },
      single() {
        single = "one";
        return execute();
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return execute().then(resolve, reject);
      },
    };
    return api;
  }

  return { from, rpc } as unknown as SupabaseClient<Database>;
}
