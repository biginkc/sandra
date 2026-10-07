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

describe("provider failure reasons", () => {
  it("provider_billing parses loud: rose color, credits label", () => {
    const parsed = parseEscalationReason("provider_billing");
    expect(parsed).not.toBeNull();
    expect(parsed!.color).toBe("rose");
    expect(parsed!.shortLabel).toBe("API credits out");
    expect(parsed!.longLabel).toMatch(/credits exhausted/i);
  });

  it("provider_auth parses loud: rose color, key label", () => {
    const parsed = parseEscalationReason("provider_auth");
    expect(parsed).not.toBeNull();
    expect(parsed!.color).toBe("rose");
    expect(parsed!.shortLabel).toBe("API key dead");
    expect(parsed!.longLabel).toMatch(/key rejected/i);
  });

  it("dead_letter_failed:<reason> (Q8 rule 7) parses loud and names the original reason", () => {
    const parsed = parseEscalationReason("dead_letter_failed:send_blocked:db_error");
    expect(parsed).not.toBeNull();
    expect(parsed!.color).toBe("rose");
    expect(parsed!.shortLabel).toBe("Reply text not saved");
    expect(parsed!.longLabel).toMatch(/send blocked db error/i);
  });
});

describe("send timeout reasons", () => {
  it("dead_letter_failed:send_timeout:<inbound_id> keeps the loud gate, names the timeout, hides the uuid", () => {
    const parsed = parseEscalationReason("dead_letter_failed:send_timeout:3f1c2d9e-0000-4000-8000-123456789abc");
    expect(parsed!.gate).toBe("dead_letter_failed");
    expect(parsed!.color).toBe("rose");
    expect(parsed!.shortLabel).toBe("Reply text not saved");
    expect(parsed!.longLabel).toMatch(/timed out/i);
    expect(parsed!.longLabel).not.toMatch(/3f1c/);
  });
  it("send_timeout:<inbound_id> never shows the raw uuid", () => {
    const parsed = parseEscalationReason("send_timeout:3f1c2d9e-0000-4000-8000-123456789abc");
    expect(parsed!.longLabel).toBe("Reply timed out at the provider — held for review");
    expect(parsed!.longLabel).not.toMatch(/3f1c/);
  });
  it("send_timeout:<inbound_id>:backed is the same send_timeout gate and label, no uuid", () => {
    const parsed = parseEscalationReason("send_timeout:3f1c2d9e-0000-4000-8000-123456789abc:backed");
    expect(parsed!.gate).toBe("send_timeout");
    expect(parsed!.shortLabel).toBe("Send timed out");
    expect(parsed!.longLabel).toBe("Reply timed out at the provider — held for review");
    expect(parsed!.longLabel).not.toMatch(/3f1c|backed/);
  });
  it("dead_letter_failed:send_timeout:<inbound_id>:backed is labelled like the unbacked form", () => {
    const a = parseEscalationReason("dead_letter_failed:send_timeout:3f1c2d9e-0000-4000-8000-123456789abc");
    const b = parseEscalationReason("dead_letter_failed:send_timeout:3f1c2d9e-0000-4000-8000-123456789abc:backed");
    expect(b).toMatchObject({ gate: a!.gate, color: a!.color, shortLabel: a!.shortLabel, longLabel: a!.longLabel });
  });
  it("send_timeout_unparseable is the send_timeout gate with a needs-review label", () => {
    const parsed = parseEscalationReason("send_timeout_unparseable");
    expect(parsed!.gate).toBe("send_timeout");
    expect(parsed!.shortLabel).toBe("Send timed out");
    expect(parsed!.longLabel).toBe("Reply timed out at the provider — record unreadable, needs review");
  });
  it("send_timeout_then_sent warns not to re-send", () => {
    const parsed = parseEscalationReason("send_timeout_then_sent");
    expect(parsed!.longLabel).toBe("Reply accepted by provider late — do not re-send");
  });
  it("suppression_incomplete labels the same with or without a review id, never showing the uuid", () => {
    const bare = parseEscalationReason("suppression_incomplete");
    const withId = parseEscalationReason("suppression_incomplete:3f1c2d9e-0000-4000-8000-123456789abc");
    expect(withId).toMatchObject({
      gate: "suppression_incomplete",
      shortLabel: "Suppression incomplete",
      color: "rose",
      longLabel: bare!.longLabel,
    });
    expect(withId!.longLabel).not.toMatch(/3f1c2d9e/);
  });
});
