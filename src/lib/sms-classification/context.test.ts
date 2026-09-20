import { describe, expect, it } from "vitest";

import { buildTwoWayThreadState } from "./context";

type Row = { direction: string; body: string | null; created_at: string; id: string };

/** Minimal fluent stub matching the subset of the Supabase query builder
 *  `buildTwoWayThreadState`/`loadConversation` actually call. Filters are
 *  applied in-memory against `rows` rather than executing real SQL. */
function stubSupabase(rows: Row[]) {
  const calls: { neq?: string; eqConversation?: string; eqContact?: string } = {};
  const builder = {
    from: () => builder,
    select: () => builder,
    eq: (col: string, val: string) => {
      if (col === "conversation_id") calls.eqConversation = val;
      if (col === "contact_id") calls.eqContact = val;
      return builder;
    },
    order: (col: string, opts?: { ascending?: boolean }) => {
      const ascending = opts?.ascending ?? true;
      rows = rows
        .slice()
        .sort((a, b) =>
          ascending
            ? a[col as keyof Row]! > b[col as keyof Row]! ? 1 : -1
            : a[col as keyof Row]! > b[col as keyof Row]! ? -1 : 1,
        );
      return builder;
    },
    limit: () => builder,
    neq: (_col: string, val: string) => {
      calls.neq = val;
      return builder;
    },
    then: (resolve: (r: { data: Row[] }) => void) => {
      let filtered = rows;
      if (calls.eqConversation) {
        // conversation_id isn't in Row for this stub's simplicity — tests
        // that need conversation filtering pass pre-filtered rows.
      }
      if (calls.neq) filtered = filtered.filter((r) => r.id !== calls.neq);
      resolve({ data: filtered });
    },
  };
  return { client: builder as unknown as Parameters<typeof buildTwoWayThreadState>[0], calls };
}

describe("buildTwoWayThreadState", () => {
  it("preserves direction labels for both inbound and outbound messages", async () => {
    const rows: Row[] = [
      { id: "1", direction: "outbound", body: "Hi, interested in selling?", created_at: "2026-01-01T00:00:00Z" },
      { id: "2", direction: "inbound", body: "Who is this", created_at: "2026-01-01T00:01:00Z" },
    ];
    const { client } = stubSupabase(rows);
    const result = await buildTwoWayThreadState(client, {
      propertyId: "p1",
      contactId: "c1",
      conversationId: null,
      excludeMessageId: null,
    });
    expect(result).toEqual([
      { direction: "outbound", body: "Hi, interested in selling?", sentAt: "2026-01-01T00:00:00Z" },
      { direction: "inbound", body: "Who is this", sentAt: "2026-01-01T00:01:00Z" },
    ]);
  });

  it("returns chronological order (oldest first) regardless of insertion order", async () => {
    // Stub sorts descending (matching the real query's
    // `.order("created_at", { ascending: false })`), then context.ts
    // reverses to chronological — this asserts that reversal happens.
    const rows: Row[] = [
      { id: "2", direction: "inbound", body: "second", created_at: "2026-01-01T00:01:00Z" },
      { id: "1", direction: "outbound", body: "first", created_at: "2026-01-01T00:00:00Z" },
    ];
    const { client } = stubSupabase(rows);
    const result = await buildTwoWayThreadState(client, {
      propertyId: "p1",
      contactId: "c1",
      conversationId: null,
      excludeMessageId: null,
    });
    expect(result.map((m) => m.body)).toEqual(["first", "second"]);
    // A real integration test against a live DB should also cover this
    // once the local Supabase permission issue (see recent commits on
    // this branch) is resolved — this stub proves the reverse-after-sort
    // logic, not the real query's actual ordering guarantee.
  });

  it("excludes the current inbound message by id", async () => {
    const rows: Row[] = [
      { id: "1", direction: "outbound", body: "kept", created_at: "2026-01-01T00:00:00Z" },
      { id: "2", direction: "inbound", body: "excluded (current inbound)", created_at: "2026-01-01T00:01:00Z" },
    ];
    const { client } = stubSupabase(rows);
    const result = await buildTwoWayThreadState(client, {
      propertyId: "p1",
      contactId: "c1",
      conversationId: null,
      excludeMessageId: "2",
    });
    expect(result).toHaveLength(1);
    expect(result[0].body).toBe("kept");
  });

  it("maps a null body to an empty string, never null", async () => {
    const rows: Row[] = [
      { id: "1", direction: "inbound", body: null, created_at: "2026-01-01T00:00:00Z" },
    ];
    const { client } = stubSupabase(rows);
    const result = await buildTwoWayThreadState(client, {
      propertyId: "p1",
      contactId: "c1",
      conversationId: null,
      excludeMessageId: null,
    });
    expect(result[0].body).toBe("");
  });

  it("treats any non-inbound direction value as outbound", async () => {
    const rows: Row[] = [
      { id: "1", direction: "system", body: "weird value", created_at: "2026-01-01T00:00:00Z" },
    ];
    const { client } = stubSupabase(rows);
    const result = await buildTwoWayThreadState(client, {
      propertyId: "p1",
      contactId: "c1",
      conversationId: null,
      excludeMessageId: null,
    });
    expect(result[0].direction).toBe("outbound");
  });
});
