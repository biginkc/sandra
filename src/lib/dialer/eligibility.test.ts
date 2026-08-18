import { describe, expect, it } from "vitest";

import { classifyItem, previewBatchEligibility } from "./eligibility";

const property = (
  overrides: Partial<{
    id: string;
    state: string;
    is_dnc_locked: boolean | null;
    outreach_dispo: string | null;
  }> = {},
) => ({
  id: overrides.id ?? crypto.randomUUID(),
  state: overrides.state ?? "MO",
  is_dnc_locked: overrides.is_dnc_locked ?? false,
  outreach_dispo: overrides.outreach_dispo ?? null,
});

const contact = (
  overrides: Partial<{
    id: string;
    phone_1: string | null;
    phone_2: string | null;
    phone_3: string | null;
    do_not_contact: boolean;
    sms_opted_out: boolean;
  }> = {},
) => ({
  id: overrides.id ?? crypto.randomUUID(),
  phone_1: Object.hasOwn(overrides, "phone_1")
    ? overrides.phone_1!
    : "5551112222",
  phone_2: Object.hasOwn(overrides, "phone_2") ? overrides.phone_2! : null,
  phone_3: Object.hasOwn(overrides, "phone_3") ? overrides.phone_3! : null,
  do_not_contact: overrides.do_not_contact ?? false,
  sms_opted_out: overrides.sms_opted_out ?? false,
});

const inWindow = new Date("2026-01-01T18:00:00.000Z");
const outsideWindow = new Date("2026-01-01T04:00:00.000Z");

describe("classifyItem", () => {
  it("counts callable when phone present, contact not DNC, in window", () => {
    expect(
      previewBatchEligibility(
        [{ property: property(), contact: contact() }],
        inWindow,
      ),
    ).toEqual({ callable: 1, blocked: {}, missing: 0 });
  });

  it("counts blocked.do_not_contact when contact.do_not_contact=true", () => {
    expect(
      previewBatchEligibility(
        [
          {
            property: property(),
            contact: contact({ do_not_contact: true }),
          },
        ],
        inWindow,
      ),
    ).toEqual({
      callable: 0,
      blocked: { do_not_contact: 1 },
      missing: 0,
    });
  });

  it("counts blocked.outside_window when checkQuietHours returns ok=false", () => {
    expect(
      previewBatchEligibility(
        [{ property: property(), contact: contact() }],
        outsideWindow,
      ),
    ).toEqual({
      callable: 0,
      blocked: { outside_window: 1 },
      missing: 0,
    });
  });

  it("counts missing when no phones at all", () => {
    expect(
      previewBatchEligibility(
        [
          {
            property: property(),
            contact: contact({ phone_1: null, phone_2: null, phone_3: null }),
          },
        ],
        inWindow,
      ),
    ).toEqual({ callable: 0, blocked: {}, missing: 1 });
  });

  it("counts missing when phones cannot be normalized", () => {
    expect(
      previewBatchEligibility(
        [{ property: property(), contact: contact({ phone_1: "abc" }) }],
        inWindow,
      ),
    ).toEqual({ callable: 0, blocked: {}, missing: 1 });
  });

  it("aggregates across multiple properties", () => {
    expect(
      previewBatchEligibility(
        [
          { property: property({ id: "callable" }), contact: contact() },
          {
            property: property({ id: "dnc" }),
            contact: contact({ do_not_contact: true }),
          },
          {
            property: property({ id: "missing" }),
            contact: contact({ phone_1: null }),
          },
        ],
        inWindow,
      ),
    ).toEqual({
      callable: 1,
      blocked: { do_not_contact: 1 },
      missing: 1,
    });
  });

  it("counts each phone separately, not each prospect [D-01]", () => {
    expect(
      previewBatchEligibility(
        [
          {
            property: property(),
            contact: contact({ phone_1: "5551112222", phone_2: "5553334444" }),
          },
        ],
        inWindow,
      ),
    ).toEqual({ callable: 2, blocked: {}, missing: 0 });
  });

  it("blocks all phones for a prospect when contact is DNC", () => {
    expect(
      previewBatchEligibility(
        [
          {
            property: property(),
            contact: contact({
              phone_1: "5551112222",
              phone_2: "5553334444",
              do_not_contact: true,
            }),
          },
        ],
        inWindow,
      ),
    ).toEqual({
      callable: 0,
      blocked: { do_not_contact: 2 },
      missing: 0,
    });
  });

  it("treats sms_opted_out as callable for voice [voice != SMS]", () => {
    expect(
      classifyItem(
        {
          property: property(),
          contact: contact({ sms_opted_out: true }),
        },
        inWindow,
      ),
    ).toEqual(["callable"]);
  });

  it("blocks all phones with do_not_call when property.is_dnc_locked is true", () => {
    expect(
      classifyItem(
        {
          property: property({ is_dnc_locked: true }),
          contact: contact({ phone_1: "5551112222", phone_2: "5553334444" }),
        },
        inWindow,
      ),
    ).toEqual([{ blocked: "do_not_call" }, { blocked: "do_not_call" }]);
  });

  it("blocks all phones with do_not_call when property.outreach_dispo is 'dnc'", () => {
    expect(
      classifyItem(
        {
          property: property({ outreach_dispo: "dnc" }),
          contact: contact(),
        },
        inWindow,
      ),
    ).toEqual([{ blocked: "do_not_call" }]);
  });

  it("checks the DNC lock BEFORE quiet hours (durable block wins over time-of-day)", () => {
    expect(
      classifyItem(
        {
          property: property({ is_dnc_locked: true }),
          contact: contact(),
        },
        outsideWindow,
      ),
    ).toEqual([{ blocked: "do_not_call" }]);
  });

  it("does not block on DNC lock when is_dnc_locked is false and outreach_dispo is unrelated", () => {
    expect(
      classifyItem(
        {
          property: property({ is_dnc_locked: false, outreach_dispo: "interested" }),
          contact: contact(),
        },
        inWindow,
      ),
    ).toEqual(["callable"]);
  });

  it("previewBatchEligibility counts dnc-locked properties under blocked.do_not_call", () => {
    expect(
      previewBatchEligibility(
        [{ property: property({ is_dnc_locked: true }), contact: contact() }],
        inWindow,
      ),
    ).toEqual({ callable: 0, blocked: { do_not_call: 1 }, missing: 0 });
  });
});
