import { describe, expect, it } from "vitest";

import { hotPromotionSlackText, hotPromotionSmsText, hotTextHeadline } from "./messages";
import type { HotPromotion } from "./types";

const base: HotPromotion = { propertyId: "p1", assigneeUserId: "u1", name: "Pat", assignedAt: "2026-10-15T00:00:00Z", kind: "hot_text" };
const URL_ = "https://app.example.com";

describe("hot_text alert copy", () => {
  it("with an address: name, address, link", () => {
    const p = { ...base, address: "12 Oak St, Kansas City" };
    expect(hotTextHeadline(p)).toBe("Hot text on your lead: Pat, 12 Oak St, Kansas City");
    expect(hotPromotionSmsText(p, URL_)).toBe("Hot text on your lead: Pat, 12 Oak St, Kansas City. https://app.example.com/leads/p1");
    expect(hotPromotionSlackText(p, URL_)).toContain("Hot text on your lead: Pat, 12 Oak St, Kansas City.");
  });

  it("without an address (null or missing): falls back to name only", () => {
    expect(hotTextHeadline({ ...base, address: null })).toBe("Hot text on your lead: Pat");
    expect(hotPromotionSmsText(base, URL_)).toBe("Hot text on your lead: Pat. https://app.example.com/leads/p1");
  });

  it("never contains seller message text (no field for it exists on the input)", () => {
    const p = { ...base, address: "12 Oak St" } as HotPromotion & { body?: string };
    p.body = "I will sell for 100k, call me";
    for (const text of [hotPromotionSmsText(p, URL_), hotPromotionSlackText(p, URL_)]) {
      expect(text).not.toContain("100k");
      expect(text).not.toContain("call me");
    }
  });

  it("Slack escapes markup in the address; hand-off copy is unchanged and has no address", () => {
    expect(hotPromotionSlackText({ ...base, address: "A <b> & Co" }, URL_)).toContain("A &lt;b&gt; &amp; Co");
    const h = hotPromotionSmsText({ ...base, kind: "handoff", address: "12 Oak St" }, URL_);
    expect(h).toBe("Hot seller: Pat is now on My Leads under you. https://app.example.com/leads/p1");
  });
});
