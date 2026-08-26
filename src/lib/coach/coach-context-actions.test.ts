import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

import { loadCoachCallContext } from "./coach-context-actions";

const lead = {
  address: "123 Main St",
  // motivation_level (production values: "hot" | "warm" | "cold") is
  // deliberately NOT the seller's stated motivation — it's a lead-scoring
  // tier, not free text like "downsizing" or "job relocation". Sandra has
  // no dedicated motivation/reason field, so {motivation} always resolves
  // to a placeholder regardless of what this row contains.
  motivation_level: "warm",
  source: "cold_call",
  is_vacant: false,
  absentee_flag: false,
  year_built: 1998,
  county: { name: "Jackson" },
  homeowner: { first_name: "Jane", last_name: "Doe", entity_name: null },
};

function mockSupabase(
  user: { email?: string; user_metadata?: Record<string, unknown> } | null,
  leadRow: unknown = lead,
  leadError: { message: string } | null = null,
  userError: { message: string } | null = null,
) {
  createClient.mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: userError ? null : user }, error: userError }) },
    from: vi.fn(() => {
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        maybeSingle: vi.fn().mockResolvedValue({ data: leadError ? null : leadRow, error: leadError }),
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

  it("resolves seller name, address, and county from the property row", async () => {
    mockSupabase({ email: "alex.rep@bmhgroupkc.com" });
    const context = await loadCoachCallContext({ propertyId: "p1", sellerPhoneE164: "+18165559876", repPhoneE164: "+18165551234" });
    expect(context).toMatchObject({
      sellerName: "Jane Doe",
      propertyAddress: "123 Main St",
      propertyCounty: "Jackson",
      leadId: "p1",
      sellerPhoneE164: "+18165559876",
      repPhoneE164: "+18165551234",
      yearBuilt: "1998",
    });
  });

  it("returns yearBuilt as null when the property row has no year_built", async () => {
    mockSupabase({ email: "alex.rep@bmhgroupkc.com" }, { ...lead, year_built: null });
    const context = await loadCoachCallContext({ propertyId: "p1", sellerPhoneE164: null, repPhoneE164: null });
    expect(context.yearBuilt).toBeNull();
  });

  it("never maps motivation_level (a hot/warm/cold score) to {motivation} — always a placeholder-triggering null", async () => {
    mockSupabase({ email: "alex.rep@bmhgroupkc.com" }, { ...lead, motivation_level: "hot" });
    const context = await loadCoachCallContext({ propertyId: "p1", sellerPhoneE164: null, repPhoneE164: null });
    expect(context.motivation).toBeNull();
  });

  it("skips the property lookup entirely when there's no propertyId", async () => {
    mockSupabase({ email: "alex.rep@bmhgroupkc.com" }, null);
    const context = await loadCoachCallContext({ propertyId: null, sellerPhoneE164: null, repPhoneE164: null });
    expect(context.propertyAddress).toBeNull();
    expect(context.sellerName).toBeNull();
  });

  it("always returns coldCallerName null — no such field exists in Sandra's schema yet", async () => {
    mockSupabase({ email: "alex.rep@bmhgroupkc.com" });
    const context = await loadCoachCallContext({ propertyId: "p1", sellerPhoneE164: null, repPhoneE164: null });
    expect(context.coldCallerName).toBeNull();
  });

  it("passes through the property's source as leadSource for opener branch auto-select", async () => {
    mockSupabase({ email: "alex.rep@bmhgroupkc.com" });
    const context = await loadCoachCallContext({ propertyId: "p1", sellerPhoneE164: null, repPhoneE164: null });
    expect(context.leadSource).toBe("cold_call");
  });

  it("throws (never silently returns an empty context) when the property query itself errors", async () => {
    mockSupabase({ email: "alex.rep@bmhgroupkc.com" }, lead, { message: "permission denied for table properties" });
    await expect(
      loadCoachCallContext({ propertyId: "p1", sellerPhoneE164: null, repPhoneE164: null }),
    ).rejects.toThrow(/permission denied/);
  });

  it("throws (never silently blanks the rep context) when auth.getUser() itself errors", async () => {
    // Regression: getUser()'s error was previously discarded entirely
    // (only `data: { user }` was destructured) — an expired/invalid
    // session resolved `user` to null with no signal, silently rendering
    // a blank rep-name chip instead of routing into the same
    // "context failed to load" retry path the property-query error uses.
    mockSupabase({ email: "alex.rep@bmhgroupkc.com" }, lead, null, { message: "invalid or expired session" });
    await expect(
      loadCoachCallContext({ propertyId: "p1", sellerPhoneE164: null, repPhoneE164: null }),
    ).rejects.toThrow(/invalid or expired session/);
  });
});

describe("loadCoachCallContext — occupancy derivation", () => {
  beforeEach(() => {
    createClient.mockReset();
  });

  it("is vacant when is_vacant is true, regardless of absentee_flag", async () => {
    mockSupabase({ email: "a@b.com" }, { ...lead, is_vacant: true, absentee_flag: true });
    const context = await loadCoachCallContext({ propertyId: "p1", sellerPhoneE164: null, repPhoneE164: null });
    expect(context.occupancy).toBe("vacant");
  });

  it("is owner_occupied when not vacant and absentee_flag is false", async () => {
    mockSupabase({ email: "a@b.com" }, { ...lead, is_vacant: false, absentee_flag: false });
    const context = await loadCoachCallContext({ propertyId: "p1", sellerPhoneE164: null, repPhoneE164: null });
    expect(context.occupancy).toBe("owner_occupied");
  });

  it("is tenant_occupied when not vacant and absentee_flag is true", async () => {
    mockSupabase({ email: "a@b.com" }, { ...lead, is_vacant: false, absentee_flag: true });
    const context = await loadCoachCallContext({ propertyId: "p1", sellerPhoneE164: null, repPhoneE164: null });
    expect(context.occupancy).toBe("tenant_occupied");
  });

  it("is unknown when neither is_vacant nor absentee_flag is set", async () => {
    mockSupabase({ email: "a@b.com" }, { ...lead, is_vacant: null, absentee_flag: null });
    const context = await loadCoachCallContext({ propertyId: "p1", sellerPhoneE164: null, repPhoneE164: null });
    expect(context.occupancy).toBe("unknown");
  });

  it("is unknown — NOT tenant_occupied — when is_vacant is unscored but absentee_flag is true", async () => {
    // Regression: absentee_flag only means the mailing address differs
    // from the property — that's equally consistent with "has tenants" or
    // "sits vacant, just not scored yet". Previously this fell straight to
    // tenant_occupied whenever is_vacant wasn't literally `true`,
    // mislabeling an unscored-vacancy lead as having tenants.
    mockSupabase({ email: "a@b.com" }, { ...lead, is_vacant: null, absentee_flag: true });
    const context = await loadCoachCallContext({ propertyId: "p1", sellerPhoneE164: null, repPhoneE164: null });
    expect(context.occupancy).toBe("unknown");
  });

  it("is unknown — NOT owner_occupied — when is_vacant is unscored but absentee_flag is false", async () => {
    mockSupabase({ email: "a@b.com" }, { ...lead, is_vacant: null, absentee_flag: false });
    const context = await loadCoachCallContext({ propertyId: "p1", sellerPhoneE164: null, repPhoneE164: null });
    expect(context.occupancy).toBe("unknown");
  });

  it("is null when there's no lead at all", async () => {
    mockSupabase({ email: "a@b.com" }, null);
    const context = await loadCoachCallContext({ propertyId: null, sellerPhoneE164: null, repPhoneE164: null });
    expect(context.occupancy).toBeNull();
  });
});
