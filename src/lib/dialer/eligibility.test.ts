import { describe, expect, it } from "vitest";

import { canShowCallButton, classifyItem, previewBatchEligibility } from "./eligibility";

const property = (
  overrides: Partial<{ id: string; state: string; is_dnc_locked: boolean }> = {},
) => ({
  id: overrides.id ?? crypto.randomUUID(),
  state: overrides.state ?? "MO",
  is_dnc_locked: overrides.is_dnc_locked ?? false,
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

  it("blocks with durable reason when property.is_dnc_locked is true, even in-window", () => {
    expect(
      classifyItem(
        {
          property: property({ is_dnc_locked: true }),
          contact: contact(),
        },
        inWindow,
      ),
    ).toEqual([{ blocked: "property_dnc_locked" }]);
  });

  it("blocks with durable reason when property.is_dnc_locked is true, regardless of quiet hours", () => {
    expect(
      classifyItem(
        {
          property: property({ is_dnc_locked: true }),
          contact: contact(),
        },
        outsideWindow,
      ),
    ).toEqual([{ blocked: "property_dnc_locked" }]);
  });

  it("property_dnc_locked reason is distinct from quiet-hours reasons", () => {
    const durable = classifyItem(
      { property: property({ is_dnc_locked: true }), contact: contact() },
      inWindow,
    );
    const quietHours = classifyItem(
      { property: property(), contact: contact() },
      outsideWindow,
    );

    expect(durable).toEqual([{ blocked: "property_dnc_locked" }]);
    expect(quietHours).toEqual([{ blocked: "outside_window" }]);
    expect((durable[0] as { blocked: string }).blocked).not.toBe(
      (quietHours[0] as { blocked: string }).blocked,
    );
  });

  it("property_dnc_locked takes priority over all phones for a multi-phone prospect", () => {
    expect(
      previewBatchEligibility(
        [
          {
            property: property({ is_dnc_locked: true }),
            contact: contact({
              phone_1: "5551112222",
              phone_2: "5553334444",
            }),
          },
        ],
        inWindow,
      ),
    ).toEqual({
      callable: 0,
      blocked: { property_dnc_locked: 2 },
      missing: 0,
    });
  });
});

describe("canShowCallButton", () => {
  it("keeps a lead button visible during quiet hours", () => {
    expect(canShowCallButton({ property: property(), contact: contact() })).toBe(true);
  });

  it("hides only DNC and no-phone leads", () => {
    expect(canShowCallButton({ property: property({ is_dnc_locked: true }), contact: contact() })).toBe(false);
    expect(canShowCallButton({ property: property(), contact: contact({ do_not_contact: true }) })).toBe(false);
    expect(canShowCallButton({ property: property(), contact: contact({ phone_1: null, phone_2: null, phone_3: null }) })).toBe(false);
  });
});
