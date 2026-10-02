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
  function builder(table: string) {
    let rows = [...(tables[table] ?? [])];
    const api = {
      select: () => api,
      eq: (col: string, val: unknown) => ((rows = rows.filter((r) => r[col] === val)), api),
      in: (col: string, vals: unknown[]) => ((rows = rows.filter((r) => vals.includes(r[col]))), api),
      is: () => api,
      order: () => api,
      limit: (n: number) => ((rows = rows.slice(0, n)), api),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null }),
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
  return { client: client as unknown as SupabaseClient<Database>, calls };
}

export const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
export const KEY = "22222222-2222-4222-8222-222222222222";
export const PHONE = "+18165550142";

export function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    status: "requested",
    phone_e164: PHONE,
    property_id: "p1",
    contact_id: "c1",
    idempotency_key: KEY,
    rep_context: "ctx",
    bland_call_id: null,
    outcome: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}
