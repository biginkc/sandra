import { describe, expect, it } from "vitest";
import { buildLeadDeepLink } from "./deep-link";
import { hotPromotionSlackText } from "@/lib/hold-alerts/messages";
import type { HotPromotion } from "@/lib/hold-alerts/types";

describe("operator lead destinations", () => {
  it("normalizes origins and encodes property IDs as one path segment", () => {
    expect(buildLeadDeepLink("a b/?#", { baseUrl: "app.test///" })).toBe("https://app.test/leads/a%20b%2F%3F%23");
    expect(buildLeadDeepLink("p1", { baseUrl: "http://localhost:3000/" })).toBe("http://localhost:3000/leads/p1");
  });
  it("uses configured origins in precedence order", () => {
    const env = { NEXT_PUBLIC_APP_URL: "public.test", APP_URL: "app.test", VERCEL_PROJECT_PRODUCTION_URL: "vercel.test" };
    expect(buildLeadDeepLink("p", { env })).toBe("https://public.test/leads/p");
    expect(buildLeadDeepLink("p", { env: { APP_URL: "app.test" } })).toBe("https://app.test/leads/p");
    expect(buildLeadDeepLink("p", { env: { VERCEL_PROJECT_PRODUCTION_URL: "vercel.test" } })).toBe("https://vercel.test/leads/p");
  });
  it("never substitutes a conversation for an unknown property", () => {
    expect(buildLeadDeepLink(null, { baseUrl: "https://app.test" })).toBe("https://app.test/leads");
  });
  for (const kind of ["ambiguous_thread", "routing_v2_alert", "selling_opportunity", "lead_reply", "hot_failed", "hot_text", "handoff"] as const) {
    it(`${kind} uses only a lead destination, even with a legacy thread link`, () => {
      const p = { kind, propertyId: null, name: "Pat", assigneeUserId: "u", assignedAt: "2026-11-12", key: "test-key", linkPath: "/messages?thread=c1" } as HotPromotion;
      expect(hotPromotionSlackText(p, "https://app.test")).toContain("https://app.test/leads");
      expect(hotPromotionSlackText(p, "https://app.test")).not.toContain("/messages");
      expect(hotPromotionSlackText({ ...p, propertyId: "p1" }, "https://app.test")).toContain("https://app.test/leads/p1");
    });
  }
});
