import { beforeEach, expect, it, vi } from "vitest";

const { createClient, listSequenceNeedsPersonPage } = vi.hoisted(() => ({
  createClient: vi.fn(),
  listSequenceNeedsPersonPage: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("../actions", () => ({ listSequenceNeedsPersonPage }));

import { listNeedsPersonLeads } from "./actions";

beforeEach(() => vi.clearAllMocks());

it("links each property to its own conversation when two properties share an owner", async () => {
  listSequenceNeedsPersonPage.mockResolvedValue({ ok: true, data: [
    { property_id: "property-a", sequence_id: "sequence", bucket: "couldnt_send", reason: "Failed" },
    { property_id: "property-b", sequence_id: "sequence", bucket: "couldnt_send", reason: "Failed" },
  ] });

  const messages = [
    { property_id: "property-b", conversation_id: "conversation-b", created_at: "2026-09-29T12:00:00Z" },
    { property_id: "property-a", conversation_id: "conversation-a", created_at: "2026-09-28T12:00:00Z" },
  ];
  const queryProperties = {
    select: vi.fn(() => ({
      in: vi.fn(() => ({ is: vi.fn(async () => ({ data: [
        { id: "property-a", address: "A Street", status: "contacted", homeowner_contact_id: "shared-owner" },
        { id: "property-b", address: "B Street", status: "contacted", homeowner_contact_id: "shared-owner" },
      ], error: null })) })),
    })),
  };
  const queriedProperties: string[] = [];
  const from = vi.fn((table: string) => {
    if (table === "properties") return queryProperties;
    if (table !== "messages") throw new Error(`Unexpected table: ${table}`);
    return { select: () => ({ eq: (column: string, value: string) => {
      expect(column).toBe("property_id");
      queriedProperties.push(value);
      return { eq: () => ({ not: () => ({ order: () => ({ limit: () => ({
        maybeSingle: async () => ({ data: messages.find((message) => message.property_id === value), error: null }),
      }) }) }) }) };
    } }) };
  });
  createClient.mockResolvedValue({ from });

  const result = await listNeedsPersonLeads("couldnt_send", 1);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.data.map((lead) => [lead.property_id, lead.threadId])).toEqual([
    ["property-a", "conversation-a"],
    ["property-b", "conversation-b"],
  ]);
  expect(queriedProperties).toEqual(["property-a", "property-b"]);
});
