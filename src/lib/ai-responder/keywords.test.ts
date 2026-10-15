import { describe, expect, it } from "vitest";

import { hasAllowedPriceSignal, matchEscalationKeyword, priceSignalAllowed } from "./keywords";

describe("matchEscalationKeyword — tier A (handoff request)", () => {
  it("matches 'can I talk to a human?'", () => {
    expect(matchEscalationKeyword("Can I talk to a human?")).toMatchObject({
      tier: "handoff_request",
    });
  });

  it("matches 'speak to an agent'", () => {
    expect(matchEscalationKeyword("I want to speak to an agent")).toMatchObject({
      tier: "handoff_request",
    });
  });

  it("matches 'real person please'", () => {
    expect(matchEscalationKeyword("real person please")).toMatchObject({
      tier: "handoff_request",
    });
  });

  it("matches 'connect me to someone'", () => {
    expect(matchEscalationKeyword("please connect me")).toMatchObject({
      tier: "handoff_request",
    });
  });

  it("is case-insensitive", () => {
    expect(matchEscalationKeyword("HUMAN PLEASE")).toMatchObject({
      tier: "handoff_request",
    });
  });
});

describe("matchEscalationKeyword — tier B (price/offer)", () => {
  it("matches 'what's your offer'", () => {
    expect(matchEscalationKeyword("what's your offer?")).toMatchObject({
      tier: "price_offer",
    });
  });

  it("matches 'how much will you pay'", () => {
    expect(matchEscalationKeyword("how much can you pay")).toMatchObject({
      tier: "price_offer",
    });
  });

  it("matches '$200k' (dollar-sign regex path)", () => {
    expect(matchEscalationKeyword("I want $200k")).toMatchObject({
      tier: "price_offer",
      phrase: "numeric-amount",
    });
  });

  it("matches 'around 150 thousand' (scale-word regex path)", () => {
    expect(matchEscalationKeyword("around 150 thousand")).toMatchObject({
      tier: "price_offer",
      phrase: "numeric-amount",
    });
  });

  it("matches '200k' alone (scale-word regex path)", () => {
    expect(matchEscalationKeyword("thinking 200k")).toMatchObject({
      tier: "price_offer",
    });
  });

  it("does NOT match a bare number like house or zip", () => {
    expect(matchEscalationKeyword("I live at 1234 Main St, 64151")).toBeNull();
  });
});

describe("matchEscalationKeyword — tier C (legal/contract)", () => {
  it("matches 'my lawyer said'", () => {
    expect(matchEscalationKeyword("My lawyer said no")).toMatchObject({
      tier: "legal_contract",
    });
  });

  it("matches 'attorney'", () => {
    expect(matchEscalationKeyword("talk to my attorney first")).toMatchObject({
      tier: "legal_contract",
    });
  });

  it("matches 'contract'", () => {
    expect(matchEscalationKeyword("I want the contract terms")).toMatchObject({
      tier: "legal_contract",
    });
  });

  it("matches 'closing'", () => {
    expect(matchEscalationKeyword("when is closing?")).toMatchObject({
      tier: "legal_contract",
    });
  });
});

describe("matchEscalationKeyword — tier D (distressed seller)", () => {
  it("matches 'my husband passed away'", () => {
    expect(matchEscalationKeyword("My husband passed away last year")).toMatchObject({
      tier: "distressed_seller",
    });
  });

  it("matches 'probate'", () => {
    expect(matchEscalationKeyword("we're still in probate")).toMatchObject({
      tier: "distressed_seller",
    });
  });

  it("matches 'divorce'", () => {
    expect(matchEscalationKeyword("going through a divorce")).toMatchObject({
      tier: "distressed_seller",
    });
  });

  it("matches 'bankruptcy'", () => {
    expect(matchEscalationKeyword("filed bankruptcy last month")).toMatchObject({
      tier: "distressed_seller",
    });
  });

  it("matches 'foreclosure'", () => {
    expect(matchEscalationKeyword("facing foreclosure")).toMatchObject({
      tier: "distressed_seller",
    });
  });
});

describe("matchEscalationKeyword — non-matches", () => {
  it("returns null for a neutral reply", () => {
    expect(matchEscalationKeyword("yeah sure, what do you want to know?")).toBeNull();
  });

  it("returns null for a question about the property", () => {
    expect(matchEscalationKeyword("Is this still about the Main St house?")).toBeNull();
  });

  it("returns null for an empty body", () => {
    expect(matchEscalationKeyword("")).toBeNull();
  });
});

describe("matchEscalationKeyword — allowedPhrases override", () => {
  it("when allowedPhrases is supplied, ignores phrases not in the list", () => {
    // Default would match "lawyer" as tier C. Passing an allowedPhrases
    // array that excludes 'lawyer' should suppress the match.
    expect(
      matchEscalationKeyword("my lawyer said", {
        allowedPhrases: ["price", "offer"], // no 'lawyer'
      }),
    ).toBeNull();
  });

  it("numeric-amount regex path is NOT gated by allowedPhrases (always on for safety)", () => {
    expect(
      matchEscalationKeyword("$150k", {
        allowedPhrases: ["hello"], // dollar regex still wins
      }),
    ).toMatchObject({ tier: "price_offer", phrase: "numeric-amount" });
  });
});

describe("priceSignalAllowed", () => {
  const numeric = () => matchEscalationKeyword("I want $150k");
  const word = () => matchEscalationKeyword("what's your price?");

  it("null and non-price tiers are never a price signal", () => {
    expect(priceSignalAllowed(null)).toBe(false);
    expect(priceSignalAllowed(matchEscalationKeyword("my lawyer said"))).toBe(false);
  });
  it("a numeric amount with no allow-list (null / undefined) counts", () => {
    expect(priceSignalAllowed(numeric())).toBe(true);
    expect(priceSignalAllowed(numeric(), null)).toBe(true);
  });
  it("a numeric amount counts when the allow-list includes a price-tier phrase (case-insensitive)", () => {
    expect(priceSignalAllowed(numeric(), ["price"])).toBe(true);
    expect(priceSignalAllowed(numeric(), ["How Much"])).toBe(true);
  });
  it("a numeric amount does NOT count when the allow-list has no price-tier phrase (including an empty list)", () => {
    expect(priceSignalAllowed(numeric(), ["hello"])).toBe(false);
    expect(priceSignalAllowed(numeric(), ["lawyer", "callback"])).toBe(false);
    expect(priceSignalAllowed(numeric(), [])).toBe(false);
  });
  it("a phrase-based price match counts (it already passed the allow-list inside matchEscalationKeyword)", () => {
    expect(priceSignalAllowed(word(), ["price"])).toBe(true);
    expect(priceSignalAllowed(word())).toBe(true);
  });
});

describe("hasAllowedPriceSignal", () => {
  it("empty / non-price text is false", () => {
    expect(hasAllowedPriceSignal("")).toBe(false);
    expect(hasAllowedPriceSignal("my lawyer is involved")).toBe(false);
  });
  it("a price phrase anywhere counts even when another tier wins the match", () => {
    expect(hasAllowedPriceSignal("My lawyer is involved. What's your price?")).toBe(true);
    expect(hasAllowedPriceSignal("My lawyer is involved. What's your price?", ["price", "lawyer"])).toBe(true);
  });
  it("a price phrase the org did not list does not count", () => {
    expect(hasAllowedPriceSignal("What's your price?", ["lawyer"])).toBe(false);
    expect(hasAllowedPriceSignal("How much? my lawyer", ["how much"])).toBe(true);
  });
  it("a numeric amount counts with no list or a list containing a price phrase, not otherwise", () => {
    expect(hasAllowedPriceSignal("I'd take $150k")).toBe(true);
    expect(hasAllowedPriceSignal("I'd take $150k", null)).toBe(true);
    expect(hasAllowedPriceSignal("I'd take $150k", ["price"])).toBe(true);
    expect(hasAllowedPriceSignal("I'd take $150k", ["lawyer", "callback"])).toBe(false);
    expect(hasAllowedPriceSignal("I'd take $150k", [])).toBe(false);
  });
});
