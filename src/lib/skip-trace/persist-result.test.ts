import { describe, expect, it, vi } from "vitest";

import { normalizePhone, persistSkipTraceResult } from "./persist-result";

describe("normalizePhone", () => {
  it("prepends +1 to a bare 10-digit US number (Tracerfy's default)", () => {
    expect(normalizePhone("8167416576")).toBe("+18167416576");
  });

  it("prepends + to an 11-digit number starting with 1", () => {
    expect(normalizePhone("18167416576")).toBe("+18167416576");
  });

  it("keeps an already-E.164 number unchanged", () => {
    expect(normalizePhone("+18167416576")).toBe("+18167416576");
  });

  it("strips parentheses, dashes, dots, spaces", () => {
    expect(normalizePhone("(816) 741-6576")).toBe("+18167416576");
    expect(normalizePhone("816.741.6576")).toBe("+18167416576");
    expect(normalizePhone("816 741 6576")).toBe("+18167416576");
  });

  it("does not guess for non-US lengths", () => {
    // 7 digits — local form, can't infer country code
    expect(normalizePhone("7416576")).toBe("7416576");
    // 12 digits not starting with + or 1 — leave alone
    expect(normalizePhone("447911123456")).toBe("447911123456");
  });

  it("two equivalent inputs normalize to the same string (dedup safe)", () => {
    const a = normalizePhone("(816) 741-6576");
    const b = normalizePhone("8167416576");
    const c = normalizePhone("+1 816 741 6576");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe("persistSkipTraceResult DNC finalization", () => {
  it("returns a terminal DNC skip without touching contacts when DNC arrives after provider submit", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: "property-1",
        org_id: "org-1",
        homeowner_contact_id: "contact-1",
        is_dnc_locked: true,
      },
      error: null,
    });
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      maybeSingle,
    };
    const from = vi.fn((table: string) => {
      expect(table).toBe("properties");
      return builder;
    });

    const outcome = await persistSkipTraceResult({ from } as never, "org-1", {
      propertyId: "property-1",
      hit: true,
      persons: [
        {
          firstName: "Late",
          lastName: "DNC",
          isOwner: true,
          phones: [
            { number: "8165550100", type: "Mobile", dnc: false, rank: 1 },
          ],
          emails: [],
        },
      ],
      creditsDeducted: 1,
      raw: {},
    });

    expect(outcome).toEqual({
      status: "dnc_skipped",
      phonesAdded: 0,
      emailsAdded: 0,
    });
    expect(from).toHaveBeenCalledTimes(1);
  });

  it("does not resolve a property outside the job organization", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      maybeSingle,
    };
    const from = vi.fn(() => builder);

    const outcome = await persistSkipTraceResult({ from } as never, "org-a", {
      propertyId: "org-b-property",
      hit: true,
      persons: [],
      creditsDeducted: 1,
      raw: {},
    });

    expect(outcome.status).toBe("property_not_found");
    expect(builder.eq).toHaveBeenCalledWith("id", "org-b-property");
    expect(builder.eq).toHaveBeenCalledWith("org_id", "org-a");
    expect(from).toHaveBeenCalledTimes(1);
  });

  it("checks every provider phone and treats a later lookup error as fatal", async () => {
    const propertyBuilder = chainWithMaybeSingle({
      data: {
        id: "property-1",
        org_id: "org-1",
        homeowner_contact_id: null,
        is_dnc_locked: false,
      },
      error: null,
    });
    const phoneLookups = [
      { data: [], error: null },
      { data: null, error: { message: "lookup unavailable" } },
    ];
    const phoneOr = vi.fn(() => Promise.resolve(phoneLookups.shift()));
    const contactBuilder = {
      select: vi.fn(() => contactBuilder),
      eq: vi.fn(() => contactBuilder),
      or: phoneOr,
    };
    const from = vi.fn((table: string) =>
      table === "properties" ? propertyBuilder : contactBuilder,
    );

    await expect(
      persistSkipTraceResult({ from } as never, "org-1", {
        propertyId: "property-1",
        hit: true,
        persons: [
          {
            isOwner: true,
            phones: [
              { number: "8165550101", type: "Mobile", dnc: false, rank: 1 },
              { number: "8165550102", type: "Mobile", dnc: false, rank: 2 },
            ],
            emails: [],
          },
        ],
        creditsDeducted: 1,
        raw: {},
      }),
    ).rejects.toThrow(
      "contact phone lookup failed for +18165550102: lookup unavailable",
    );
    expect(phoneOr).toHaveBeenCalledTimes(2);
  });

  it("ratchets every plausible contact and reports ambiguity without guessing a property link", async () => {
    const propertyBuilder = chainWithMaybeSingle({
      data: {
        id: "property-1",
        org_id: "org-1",
        homeowner_contact_id: null,
        is_dnc_locked: false,
      },
      error: null,
    });
    const phoneResults = [
      { data: [{ id: "contact-clean" }], error: null },
      { data: [{ id: "contact-dnc" }], error: null },
    ];
    const ratchetedIds: string[] = [];
    const from = vi.fn((table: string) => {
      if (table === "properties") return propertyBuilder;
      const builder: Record<string, ReturnType<typeof vi.fn>> = {};
      builder.select = vi.fn((columns: string) => {
        if (columns === "id" && !builder.update.mock.calls.length) {
          return builder;
        }
        return builder;
      });
      builder.eq = vi.fn((column: string, value: unknown) => {
        if (column === "id") ratchetedIds.push(String(value));
        return builder;
      });
      builder.or = vi.fn(() => Promise.resolve(phoneResults.shift()));
      builder.update = vi.fn(() => builder);
      // A ratchet's terminal select returns exactly one row.
      builder.select = vi.fn((columns: string) =>
        builder.update.mock.calls.length && columns === "id"
          ? Promise.resolve({ data: [{ id: "confirmed" }], error: null })
          : builder,
      );
      return builder;
    });

    const outcome = await persistSkipTraceResult({ from } as never, "org-1", {
      propertyId: "property-1",
      hit: true,
      persons: [
        {
          isOwner: true,
          phones: [
            { number: "8165550201", type: "Mobile", dnc: false, rank: 1 },
            { number: "8165550202", type: "Mobile", dnc: true, rank: 2 },
          ],
          emails: [],
        },
      ],
      creditsDeducted: 1,
      raw: {},
    });

    expect(outcome).toEqual({
      status: "dnc_contact_ambiguous",
      ambiguousContactIds: ["contact-clean", "contact-dnc"],
      phonesAdded: 0,
      emailsAdded: 0,
    });
    expect(ratchetedIds).toEqual(["contact-dnc"]);
    expect(from).toHaveBeenCalledWith("contacts");
  });

  it("does not report DNC success when a zero-row ratchet is followed by a missing contact", async () => {
    const propertyBuilder = chainWithMaybeSingle({
      data: {
        id: "property-1",
        org_id: "org-1",
        homeowner_contact_id: "contact-1",
        is_dnc_locked: false,
      },
      error: null,
    });
    const contactCalls = [
      contactPhoneLookup([{ id: "contact-1" }]),
      chainWithMaybeSingle({ data: { do_not_contact: false }, error: null }),
      contactUpdateResult([]),
      chainWithMaybeSingle({ data: null, error: null }),
    ];
    const from = vi.fn((table: string) =>
      table === "properties" ? propertyBuilder : contactCalls.shift(),
    );

    await expect(
      persistSkipTraceResult({ from } as never, "org-1", {
        propertyId: "property-1",
        hit: true,
        persons: [
          {
            isOwner: true,
            phones: [
              { number: "8165550301", type: "Mobile", dnc: true, rank: 1 },
            ],
            emails: [],
          },
        ],
        creditsDeducted: 1,
        raw: {},
      }),
    ).rejects.toThrow("contact disappeared before the write was confirmed");
  });
});

function chainWithMaybeSingle(result: unknown) {
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.maybeSingle = vi.fn(() => Promise.resolve(result));
  return builder;
}

function contactPhoneLookup(data: Array<{ id: string }>) {
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.or = vi.fn(() => Promise.resolve({ data, error: null }));
  return builder;
}

function contactUpdateResult(data: Array<{ id: string }>) {
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  builder.update = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.select = vi.fn(() => Promise.resolve({ data, error: null }));
  return builder;
}
