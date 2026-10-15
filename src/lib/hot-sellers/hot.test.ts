import { describe, expect, it } from "vitest";

import { hotPromotionKey, isHotReason, isHotSeller } from "./hot";

describe("isHotReason", () => {
  it.each([
    "new_lead",
    "hot_lead",
    "model:hot_lead",
    "model:call_request",
    "model:price_or_offer",
    "keyword:price_offer",
    "jev_below_threshold:new_lead",
    "jev_new_lead_promotion_failed",
    "hot_lead_assign_failed",
    "hot_lead_event_failed",
  ])("%s is hot", (reason) => {
    expect(isHotReason(reason)).toBe(true);
  });

  it.each(["draft_held", "model:new_lead_promoted", "model:nurture", "keyword:dnc", "price_quoted", "jev_below_threshold:nurture", null, undefined, ""])(
    "%s is not hot",
    (reason) => {
      expect(isHotReason(reason as string | null | undefined)).toBe(false);
    },
  );
});

describe("isHotSeller", () => {
  it("is hot when the Jev outcome is new_lead", () => {
    expect(isHotSeller({ jevOutcome: "new_lead" })).toBe(true);
  });
  it("is hot when any reason is hot", () => {
    expect(isHotSeller({ reasons: ["draft_held", null, "model:call_request"] })).toBe(true);
  });
  it("is not hot with no signals or only cold ones", () => {
    expect(isHotSeller({})).toBe(false);
    expect(isHotSeller({ jevOutcome: "nurture", reasons: ["draft_held", undefined] })).toBe(false);
  });
});

describe("hotPromotionKey", () => {
  it("is once per property", () => {
    expect(hotPromotionKey("p1")).toBe("hot_promotion:p1");
  });
});
