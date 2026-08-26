import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

import { loadCoachCallContext } from "./coach-context-actions";

const lead = {
  address: "123 Main St",
  motivation_level: "Job relocation",
  county: { name: "Jackson" },
  homeowner: { first_name: "Jane", last_name: "Doe", entity_name: null },
};

function mockSupabase(user: { email?: string; user_metadata?: Record<string, unknown> } | null, leadRow: unknown = lead) {
  createClient.mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) },
    from: vi.fn(() => {
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        maybeSingle: vi.fn().mockResolvedValue({ data: leadRow, error: null }),
      };
      return builder;
    }),
  });
}

describe("loadCoachCallContext — rep display name", () => {
  beforeEach(() => {
    createClient.mockReset();
  });

  it("prefers a rep-set display_name over the email fallback", async () => {
    mockSupabase({ email: "alex.rep@bmhgroupkc.com", user_metadata: { display_name: "Alex R." } });
    const context = await loadCoachCallContext({ propertyId: "p1", sellerPhoneE164: null, repPhoneE164: null });
    expect(context.repName).toBe("Alex R.");
  });

  it("falls back to a title-cased email local part when display_name is unset", async () => {
    mockSupabase({ email: "alex.rep@bmhgroupkc.com", user_metadata: {} });
    const context = await loadCoachCallContext({ propertyId: "p1", sellerPhoneE164: null, repPhoneE164: null });
    expect(context.repName).toBe("Alex Rep");
  });

  it("falls back to email when display_name is blank/whitespace", async () => {
    mockSupabase({ email: "alex.rep@bmhgroupkc.com", user_metadata: { display_name: "   " } });
    const context = await loadCoachCallContext({ propertyId: "p1", sellerPhoneE164: null, repPhoneE164: null });
    expect(context.repName).toBe("Alex Rep");
  });

  it("never blanks rep name entirely — null when there's no user", async () => {
    mockSupabase(null);
    const context = await loadCoachCallContext({ propertyId: "p1", sellerPhoneE164: null, repPhoneE164: null });
    expect(context.repName).toBeNull();
  });
});

describe("loadCoachCallContext — lead fields", () => {
  beforeEach(() => {
    createClient.mockReset();
  });

  it("resolves seller name, address, county, and motivation from the property row", async () => {
    mockSupabase({ email: "alex.rep@bmhgroupkc.com" });
    const context = await loadCoachCallContext({ propertyId: "p1", sellerPhoneE164: "+18165559876", repPhoneE164: "+18165551234" });
    expect(context).toMatchObject({
      sellerName: "Jane Doe",
      propertyAddress: "123 Main St",
      propertyCounty: "Jackson",
      motivation: "Job relocation",
      leadId: "p1",
      sellerPhoneE164: "+18165559876",
      repPhoneE164: "+18165551234",
    });
  });

  it("skips the property lookup entirely when there's no propertyId", async () => {
    mockSupabase({ email: "alex.rep@bmhgroupkc.com" }, null);
    const context = await loadCoachCallContext({ propertyId: null, sellerPhoneE164: null, repPhoneE164: null });
    expect(context.propertyAddress).toBeNull();
    expect(context.sellerName).toBeNull();
  });
});
