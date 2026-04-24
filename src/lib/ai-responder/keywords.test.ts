import { describe, expect, it } from "vitest";

import { matchEscalationKeyword } from "./keywords";

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
