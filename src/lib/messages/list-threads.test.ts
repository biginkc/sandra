import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/types";

import { listThreads } from "./list-threads";

/**
 * Stub Supabase client that records every `.in("id", chunk)` call and returns
 * rows for the contacts/properties tables based on a seed map. Just enough of
 * the chain API to satisfy listThreads.
 */
function makeStub(opts: {
  messages: Array<{
    contact_id: string;
    property_id: string | null;
    body: string;
    direction: "inbound" | "outbound";
    created_at: string;
    read_at: string | null;
  }>;
  contacts: Map<string, { id: string; first_name: string | null; last_name: string | null; entity_name: string | null; phone_1: string | null }>;
  properties: Map<string, { id: string; address: string | null; city: string | null; state: string | null; assigned_user_id: string | null }>;
}) {
  const inCalls: Record<string, string[][]> = { contacts: [], properties: [] };

  const messagesQuery = {
    select: () => messagesQuery,
    eq: () => messagesQuery,
    not: () => messagesQuery,
    neq: () => messagesQuery,
    gte: () => messagesQuery,
    order: () => Promise.resolve({ data: opts.messages, error: null }),
  };

  function tableQuery(name: "contacts" | "properties") {
    return {
      select: () => ({
        in: (_col: string, chunk: string[]) => {
          inCalls[name].push(chunk);
          const source = name === "contacts" ? opts.contacts : opts.properties;
          const data = chunk
            .map((id) => source.get(id))
            .filter((row): row is NonNullable<typeof row> => Boolean(row));
          return Promise.resolve({ data, error: null });
        },
      }),
    };
  }

  const supabase = {
    from: (table: string) => {
      if (table === "messages") return messagesQuery;
      if (table === "contacts") return tableQuery("contacts");
      if (table === "properties") return tableQuery("properties");
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient<Database>;

  return { supabase, inCalls };
}

describe("listThreads — chunking", () => {
  it("splits oversized contact-id IN clauses into multiple Supabase calls", async () => {
    // 600 contacts > the 250 chunk threshold ⇒ should produce 3 chunked calls.
    const N = 600;
    const messages = Array.from({ length: N }, (_, i) => ({
      contact_id: `c-${i}`,
      property_id: `p-${i}`,
      body: `msg ${i}`,
      direction: "inbound" as const,
      created_at: new Date(Date.now() - i * 1000).toISOString(),
      read_at: null,
    }));
    const contacts = new Map(
      messages.map((m) => [
        m.contact_id,
        { id: m.contact_id, first_name: "C", last_name: String(0), entity_name: null, phone_1: null },
      ]),
    );
    const properties = new Map(
      messages.map((m) => [
        m.property_id!,
        { id: m.property_id!, address: "1 Main", city: null, state: null, assigned_user_id: null },
      ]),
    );

    const { supabase, inCalls } = makeStub({ messages, contacts, properties });

    const threads = await listThreads(supabase, {});

    // Pre-fix this would be 1 call with 600 ids → PostgREST 400.
    expect(inCalls.contacts.length).toBe(3);
    expect(inCalls.contacts.map((c) => c.length)).toEqual([250, 250, 100]);
    expect(inCalls.properties.length).toBe(3);
    expect(inCalls.properties.map((c) => c.length)).toEqual([250, 250, 100]);

    // And the result still includes all N contacts hydrated end-to-end.
    expect(threads.length).toBe(N);
    expect(new Set(threads.map((t) => t.contactId)).size).toBe(N);
  });

  it("skips the network entirely when there are no contact ids", async () => {
    const { supabase, inCalls } = makeStub({
      messages: [],
      contacts: new Map(),
      properties: new Map(),
    });
    // Spy on `from` to assert we don't even touch the contacts table.
    const fromSpy = vi.spyOn(supabase, "from");

    const threads = await listThreads(supabase, {});

    expect(threads).toEqual([]);
    expect(inCalls.contacts.length).toBe(0);
    expect(inCalls.properties.length).toBe(0);
    // messages table may still be queried; contacts/properties must not be.
    const tablesHit = fromSpy.mock.calls.map((c) => c[0]);
    expect(tablesHit).not.toContain("contacts");
    expect(tablesHit).not.toContain("properties");
  });
});
