import { describe, expect, it } from "vitest";

import { resolveEffectiveHomeownerContactId } from "./effective-homeowner";

type Row = { contact_id: string | null } | null;

function fakeSupabase(rows: { messages: Row; property_contacts: Row }) {
  const calls: string[] = [];
  const client = {
    from(table: "messages" | "property_contacts") {
      calls.push(table);
      const chain = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: rows[table], error: null }),
      };
      return chain;
    },
  };
  return { client: client as never, calls };
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
    const { client, calls } = fakeSupabase({
      messages: { contact_id: "replier" },
      property_contacts: { contact_id: "first-linked" },
    });
    await expect(
      resolveEffectiveHomeownerContactId(client, { propertyId: "p", homeownerContactId: null }),
    ).resolves.toBe("replier");
    expect(calls).toEqual(["messages"]);
  });

  it("falls back to the first linked person", async () => {
    const { client } = fakeSupabase({ messages: null, property_contacts: { contact_id: "first-linked" } });
    await expect(
      resolveEffectiveHomeownerContactId(client, { propertyId: "p", homeownerContactId: null }),
    ).resolves.toBe("first-linked");
  });

  it("returns null when nobody is linked", async () => {
    const { client } = fakeSupabase({ messages: null, property_contacts: null });
    await expect(
      resolveEffectiveHomeownerContactId(client, { propertyId: "p", homeownerContactId: null }),
    ).resolves.toBeNull();
  });
});
