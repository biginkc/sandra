import { describe, expect, it } from "vitest";

import { parseEscalationReason } from "./format-reason";

describe("parseEscalationReason — null/empty", () => {
  it("returns null for null", () => {
    expect(parseEscalationReason(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(parseEscalationReason(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseEscalationReason("")).toBeNull();
  });
});

describe("parseEscalationReason — keyword tiers", () => {
  it("parses keyword:handoff_request as sky", () => {
    expect(parseEscalationReason("keyword:handoff_request")).toMatchObject({
      gate: "keyword",
      tier: "handoff_request",
      color: "sky",
      shortLabel: "Wants human",
      longLabel: "keyword match (handoff request)",
    });
  });

  it("parses keyword:price_offer as emerald", () => {
    expect(parseEscalationReason("keyword:price_offer")).toMatchObject({
      tier: "price_offer",
      color: "emerald",
      shortLabel: "Price offer",
      longLabel: "keyword match (price offer)",
    });
  });

  it("parses keyword:legal_contract as violet", () => {
    expect(parseEscalationReason("keyword:legal_contract")).toMatchObject({
      tier: "legal_contract",
      color: "violet",
      shortLabel: "Legal/Contract",
      longLabel: "keyword match (legal contract)",
    });
  });

  it("parses keyword:distressed_seller as rose", () => {
    expect(parseEscalationReason("keyword:distressed_seller")).toMatchObject({
      tier: "distressed_seller",
      color: "rose",
      shortLabel: "Distressed",
      longLabel: "keyword match (distressed seller)",
    });
  });

  it("treats keyword:<unknown_tier> as amber generic keyword", () => {
    const r = parseEscalationReason("keyword:bogus_tier");
    expect(r).not.toBeNull();
    expect(r!.tier).toBeNull();
    expect(r!.color).toBe("amber");
    expect(r!.gate).toBe("keyword");
  });
});

describe("parseEscalationReason — non-keyword gates (all amber)", () => {
  it("sentiment:hostile", () => {
    expect(parseEscalationReason("sentiment:hostile")).toMatchObject({
      gate: "sentiment",
      tier: null,
      color: "amber",
      shortLabel: "Sentiment",
      longLabel: "seller sounded hostile",
    });
  });

  it("low_confidence:0.42", () => {
    expect(parseEscalationReason("low_confidence:0.42")).toMatchObject({
      gate: "low_confidence",
      color: "amber",
      shortLabel: "Low confidence",
      longLabel: "model unsure (0.42)",
    });
  });

  it("safety:contains_dollar_amount", () => {
    expect(parseEscalationReason("safety:contains_dollar_amount")).toMatchObject({
      gate: "safety",
      color: "amber",
      shortLabel: "Safety blocked",
      longLabel: "unsafe reply blocked (contains dollar amount)",
    });
  });

  it("model:asked for price", () => {
    expect(parseEscalationReason("model:asked for price")).toMatchObject({
      gate: "model",
      color: "amber",
      shortLabel: "Model escalated",
      longLabel: "model chose to escalate: asked for price",
    });
  });

  it("send_blocked:no_consent", () => {
    expect(parseEscalationReason("send_blocked:no_consent")).toMatchObject({
      gate: "send_blocked",
      color: "amber",
      shortLabel: "Send blocked",
      longLabel: "send pipeline blocked (no consent)",
    });
  });

  it("generate_error", () => {
    expect(parseEscalationReason("generate_error")).toMatchObject({
      gate: "generate_error",
      color: "amber",
      shortLabel: "AI error",
      longLabel: "model call failed",
    });
  });
});

describe("parseEscalationReason — unknown gate falls back gracefully", () => {
  it("returns the raw string as longLabel for unknown gate", () => {
    const r = parseEscalationReason("future_gate:something");
    expect(r).not.toBeNull();
    expect(r!.color).toBe("amber");
    expect(r!.shortLabel).toBe("Needs review");
    expect(r!.longLabel).toBe("future_gate:something");
  });
});
