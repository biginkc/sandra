import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

type Rows = Record<string, unknown>[];
type RpcHandler = (args: Record<string, unknown>) => unknown;

/**
 * Minimal in-memory Supabase double for the Norma unit tests: table reads with
 * eq/in filters, and RPCs routed to handlers (unhandled RPCs throw so a test
 * can never silently reach a real database or network).
 */
export function fakeClient(tables: Record<string, Rows>, rpcs: Record<string, RpcHandler> = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const updates: { table: string; values: Record<string, unknown>; id: unknown }[] = [];
  function builder(table: string) {
    let rows = [...(tables[table] ?? [])];
    const sorts: { col: string; asc: boolean }[] = [];
    const sorted = () =>
      sorts.length
        ? [...rows].sort((a, b) => {
            for (const { col, asc } of sorts) {
              const x = String(a[col] ?? ""), y = String(b[col] ?? "");
              if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
            }
            return 0;
          })
        : rows;
    const api = {
      select: () => api,
      eq: (col: string, val: unknown) => ((rows = rows.filter((r) => r[col] === val)), api),
      in: (col: string, vals: unknown[]) => ((rows = rows.filter((r) => vals.includes(r[col]))), api),
      is: () => api,
      lte: (col: string, val: string) => ((rows = rows.filter((r) => String(r[col]) <= val)), api),
      update: (values: Record<string, unknown>) => ({
        eq: async (_col: string, id: unknown) => {
          updates.push({ table, values, id });
          return { data: null, error: null };
        },
      }),
      order: (col: string, opts?: { ascending?: boolean }) => (sorts.push({ col, asc: opts?.ascending !== false }), api),
      limit: (n: number) => ((rows = sorted().slice(0, n)), sorts.length = 0, api),
      maybeSingle: async () => ({ data: sorted()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => resolve({ data: sorted(), error: null }),
    };
    return api;
  }
  const client = {
    from: (table: string) => builder(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const handler = rpcs[name];
      if (!handler) throw new Error(`unexpected rpc ${name}`);
      return { data: handler(args), error: null };
    },
  };
  return { client: client as unknown as SupabaseClient<Database>, calls, updates };
}

export const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
export const KEY = "22222222-2222-4222-8222-222222222222";
export const PHONE = "+18165550142";

export function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    status: "requested",
    org_id: "org1",
    phone_e164: PHONE,
    property_id: "p1",
    contact_id: "c1",
    idempotency_key: KEY,
    rep_context: "ctx",
    bland_call_id: null,
    outcome: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    next_check_at: new Date(0).toISOString(),
    ...overrides,
  };
}
