import { describe, expect, it } from "vitest";

import {
  RAPID_OFFER_PCT_DEFAULT,
  computeRapidOffer,
  formatRapidOffer,
  rapidOfferBlocksSend,
  resolveRapidOfferPct,
  resolveRapidOfferSource,
  usesRapidOfferToken,
} from "./rapid-offer";

describe("computeRapidOffer", () => {
  it("takes 75% and rounds to the nearest $1,000", () => {
    expect(computeRapidOffer(185_000, 0.75)).toBe(139_000); // 138,750
    expect(computeRapidOffer(200_000, 0.75)).toBe(150_000);
  });
  it("rounds half-up at the $500 boundary", () => {
    expect(computeRapidOffer(138_500, 1)).toBe(139_000);
    expect(computeRapidOffer(138_499, 1)).toBe(138_000);
    expect(computeRapidOffer(2_000, 0.75)).toBe(2_000); // 1,500 -> 2,000
  });
  it("returns null for null/NaN/zero/negative and sub-$500 results", () => {
    expect(computeRapidOffer(null, 0.75)).toBeNull();
    expect(computeRapidOffer(undefined, 0.75)).toBeNull();
    expect(computeRapidOffer(Number.NaN, 0.75)).toBeNull();
    expect(computeRapidOffer(0, 0.75)).toBeNull();
    expect(computeRapidOffer(-100_000, 0.75)).toBeNull();
    expect(computeRapidOffer(400, 0.75)).toBeNull();
  });
});

describe("resolveRapidOfferPct", () => {
  it("defaults when unset or invalid", () => {
    expect(resolveRapidOfferPct(undefined)).toBe(RAPID_OFFER_PCT_DEFAULT);
    expect(resolveRapidOfferPct("")).toBe(0.75);
    expect(resolveRapidOfferPct("abc")).toBe(0.75);
    expect(resolveRapidOfferPct("0")).toBe(0.75);
    expect(resolveRapidOfferPct("-0.5")).toBe(0.75);
    expect(resolveRapidOfferPct("1.2")).toBe(0.75);
  });
  it("accepts values in (0, 1]", () => {
    expect(resolveRapidOfferPct("0.7")).toBe(0.7);
    expect(resolveRapidOfferPct("1")).toBe(1);
  });
});

describe("formatRapidOffer", () => {
  it("formats en-US dollars with no decimals", () => {
    expect(formatRapidOffer(139_000)).toBe("$139,000");
    expect(formatRapidOffer(1_250_000)).toBe("$1,250,000");
  });
});

describe("resolveRapidOfferSource", () => {
  it("uses properties.arv only", () => {
    expect(resolveRapidOfferSource({ arv: 200_000 })).toEqual({ value: 200_000, source: "properties.arv" });
    expect(resolveRapidOfferSource({ arv: null })).toBeNull();
    expect(resolveRapidOfferSource({ arv: 0 })).toBeNull();
  });
});

describe("rapidOfferBlocksSend", () => {
  it("blocks only when the token is used and the value is empty", () => {
    expect(rapidOfferBlocksSend("Offer {{rapid_offer}}", { rapid_offer: "" })).toBe(true);
    expect(rapidOfferBlocksSend("Offer {{rapid_offer}}", {})).toBe(true);
    expect(rapidOfferBlocksSend("Offer {{rapid_offer}}", { rapid_offer: "$139,000" })).toBe(false);
    expect(rapidOfferBlocksSend("Hi {{first_name}}", { rapid_offer: "" })).toBe(false);
  });
});

describe("usesRapidOfferToken", () => {
  it("detects the token with spacing and filters", () => {
    expect(usesRapidOfferToken("Offer: {{rapid_offer}}")).toBe(true);
    expect(usesRapidOfferToken("Offer: {{ rapid_offer | x }}")).toBe(true);
    expect(usesRapidOfferToken("Hi {{first_name}}")).toBe(false);
    expect(usesRapidOfferToken(null)).toBe(false);
  });
});
