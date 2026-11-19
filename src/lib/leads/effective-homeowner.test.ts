import { describe, expect, it } from "vitest";

import { resolveEffectiveHomeownerContactId } from "./effective-homeowner";

type Row = { contact_id: string | null } | null;

function fakeSupabase(rows: { messages: Row; property_contacts: Row }) {
  const calls: string[] = [];
  const filters: unknown[][] = [];
  const client = {
    from(table: "messages" | "property_contacts") {
      calls.push(table);
      const chain = {
        select: () => chain,
        eq: (...args: unknown[]) => (filters.push([table, "eq", ...args]), chain),
        not: () => chain,
        order: (...args: unknown[]) => (filters.push([table, "order", ...args]), chain),
        limit: () => chain,
        maybeSingle: async () => ({ data: rows[table], error: null }),
      };
      return chain;
    },
  };
  return { client: client as never, calls, filters };
}

describe("resolveEffectiveHomeownerContactId", () => {
  it("keeps the saved homeowner without querying", async () => {
    const { client, calls } = fakeSupabase({ messages: null, property_contacts: null });
    await expect(
      resolveEffectiveHomeownerContactId(client, { propertyId: "p", homeownerContactId: "saved" }),
    ).resolves.toBe("saved");
    expect(calls).toEqual([]);
  });

  it("replies to whoever texted in", async () => {
    const { client, calls, filters } = fakeSupabase({
      messages: { contact_id: "replier" },
      property_contacts: { contact_id: "first-linked" },
    });
    await expect(
      resolveEffectiveHomeownerContactId(client, { propertyId: "p", homeownerContactId: null }),
    ).resolves.toBe("replier");
    expect(calls).toEqual(["messages"]);
    expect(filters).toEqual([
      ["messages", "eq", "property_id", "p"],
      ["messages", "eq", "direction", "inbound"],
      ["messages", "eq", "channel", "sms"],
      ["messages", "order", "created_at", { ascending: false }],
    ]);
  });

  it("falls back to the first linked person", async () => {
    const { client, filters } = fakeSupabase({ messages: null, property_contacts: { contact_id: "first-linked" } });
    await expect(
      resolveEffectiveHomeownerContactId(client, { propertyId: "p", homeownerContactId: null }),
    ).resolves.toBe("first-linked");
    expect(filters.filter(([table]) => table === "property_contacts")).toEqual([
      ["property_contacts", "eq", "property_id", "p"],
      ["property_contacts", "order", "source_position", { ascending: true }],
      ["property_contacts", "order", "created_at", { ascending: true }],
    ]);
  });

  it("returns null when nobody is linked", async () => {
    const { client } = fakeSupabase({ messages: null, property_contacts: null });
    await expect(
      resolveEffectiveHomeownerContactId(client, { propertyId: "p", homeownerContactId: null }),
    ).resolves.toBeNull();
  });
});
