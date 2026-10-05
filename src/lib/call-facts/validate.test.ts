import { describe, expect, it } from "vitest";

import { parseDollarAmount, parseFutureNextStep, validateFacts } from "./validate";

const NOW = new Date("2026-10-05T15:00:00Z"); // Mon 10:00 Central
const input = {
  summary: "Seller wants about 185k.\nThey must move   by spring, house needs a new roof.",
  transcript: "Rep: hi\nSeller: We still owe $92,000 on the mortgage. Call me back next Tuesday at 2.",
};

describe("validateFacts", () => {
  it("keeps a field whose evidence appears verbatim (case-insensitive, whitespace-collapsed)", () => {
    const out = validateFacts({ motivation: { value: "must move by spring", evidence: "THEY MUST MOVE BY SPRING" } }, input, NOW);
    expect(out.motivation).toEqual({ value: "must move by spring", evidence: "THEY MUST MOVE BY SPRING" });
    expect(validateFacts({ condition: { value: "roof", evidence: "house needs a\n new roof" } }, input, NOW).condition).toBeDefined();
  });

  it("drops a field whose evidence is not in the input, is empty, or is not a string", () => {
    const raw = {
      motivation: { value: "divorce", evidence: "they are getting divorced" },
      timeline: { value: "spring", evidence: "" },
      condition: { value: "roof", evidence: 7 },
      mortgage: { value: "$92,000", evidence: null },
    };
    expect(validateFacts(raw, input, NOW)).toEqual({});
  });

  it("drops a field whose value is missing, null or too long", () => {
    expect(validateFacts({ motivation: { value: null, evidence: "must move by spring" } }, input, NOW)).toEqual({});
    expect(validateFacts({ motivation: { value: "x".repeat(301), evidence: "must move by spring" } }, input, NOW)).toEqual({});
  });

  it("drops unknown fields and non-object input", () => {
    expect(validateFacts({ ssn: { value: "1", evidence: "must move by spring" } }, input, NOW)).toEqual({});
    expect(validateFacts(null, input, NOW)).toEqual({});
    expect(validateFacts([], input, NOW)).toEqual({});
    expect(validateFacts("x", input, NOW)).toEqual({});
  });

  it("returns nothing when there is no input text to quote", () => {
    expect(validateFacts({ motivation: { value: "a", evidence: "a" } }, { summary: null, transcript: " " }, NOW)).toEqual({});
  });

  it("price and mortgage keep the VERBATIM value and carry the parsed amount separately", () => {
    const ok = validateFacts(
      { asking_price: { value: "185k", evidence: "about 185k" }, mortgage: { value: "$92,000", evidence: "We still owe $92,000 on the mortgage" } },
      input,
      NOW,
    );
    expect(ok.asking_price).toEqual({ value: "185k", evidence: "about 185k", amount_cents: 18_500_000 });
    expect(ok.mortgage).toEqual({ value: "$92,000", evidence: "We still owe $92,000 on the mortgage", amount_cents: 9_200_000 });
    expect(JSON.stringify(ok)).not.toContain("$185,000"); // no derived text is ever stored as the value
    for (const bad of ["a lot", "$0", "-5", "", "$1e9", "about 185k", "12 dollars 5"]) {
      expect(validateFacts({ asking_price: { value: bad, evidence: "about 185k" } }, input, NOW).asking_price).toBeUndefined();
    }
  });

  it("a value that is not verbatim in the input is dropped even when its evidence is", () => {
    expect(validateFacts({ asking_price: { value: "$185,000", evidence: "about 185k" } }, input, NOW).asking_price).toBeUndefined();
    expect(validateFacts({ motivation: { value: "going broke", evidence: "must move by spring" } }, input, NOW).motivation).toBeUndefined();
  });

  it("next_step keeps the verbatim phrase and carries the resolved instant separately (future, within the horizon)", () => {
    const at = (resolved: string) =>
      validateFacts({ next_step: { value: "next Tuesday at 2", evidence: "next Tuesday at 2", resolved } }, input, NOW).next_step;
    expect(at("2026-10-13T14:00")).toEqual({ value: "next Tuesday at 2", evidence: "next Tuesday at 2", due_at: "2026-10-13T19:00:00.000Z" });
    expect(at("2026-10-13")?.due_at).toBe("2026-10-13T14:00:00.000Z"); // default 09:00 CDT
    expect(at("2026-10-05T09:00")).toBeUndefined(); // 14:00Z is before NOW
    expect(at("2026-10-04")).toBeUndefined(); // past
    expect(at("2028-01-01")).toBeUndefined(); // beyond the horizon
    expect(at("next tuesday")).toBeUndefined(); // not ISO
    expect(at("2026-13-45")).toBeUndefined(); // invalid
    expect(validateFacts({ next_step: { value: "next Tuesday at 2", evidence: "next Tuesday at 2" } }, input, NOW).next_step).toBeUndefined(); // nothing resolved
  });
});

describe("parseDollarAmount / parseFutureNextStep", () => {
  it("parses common spoken and written forms", () => {
    expect(parseDollarAmount("$185,000")).toBe(185000);
    expect(parseDollarAmount("185K")).toBe(185000);
    expect(parseDollarAmount("1.2 million")).toBe(1_200_000);
    expect(parseDollarAmount("185000")).toBe(185000);
    expect(parseDollarAmount("two hundred")).toBeNull();
  });
  it("rejects a past instant", () => {
    expect(parseFutureNextStep("2026-10-05T10:00", NOW)).toBeNull();
  });
});
