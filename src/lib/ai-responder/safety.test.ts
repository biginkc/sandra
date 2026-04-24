import { describe, expect, it } from "vitest";

import { validateAiReplyBody } from "./safety";

describe("validateAiReplyBody", () => {
  it("allows a neutral first-touch acknowledgment", () => {
    expect(
      validateAiReplyBody(
        "Thanks for replying — someone from our team will reach out to chat.",
      ),
    ).toEqual({ ok: true });
  });

  it("rejects bodies that quote a dollar amount", () => {
    expect(validateAiReplyBody("We can offer $120k")).toEqual({
      ok: false,
      reason: "contains_dollar_amount",
    });
  });

  it("rejects bodies with a numeric + scale word (no dollar sign)", () => {
    expect(validateAiReplyBody("Around 120k would work")).toEqual({
      ok: false,
      reason: "contains_numeric_amount",
    });
  });

  it("rejects bodies with 'I promise'", () => {
    expect(validateAiReplyBody("I promise we'll buy it")).toEqual({
      ok: false,
      reason: "contains_commitment",
    });
  });

  it("rejects bodies with 'we guarantee'", () => {
    expect(validateAiReplyBody("We guarantee closing by Dec 31")).toEqual({
      ok: false,
      reason: "contains_commitment",
    });
  });

  it("rejects 'we will buy' style commitments", () => {
    expect(validateAiReplyBody("we will buy your property")).toEqual({
      ok: false,
      reason: "contains_commitment",
    });
  });

  it("accepts a body that mentions the street number", () => {
    // 123 Main St — a bare number without a scale word shouldn't trip.
    expect(
      validateAiReplyBody("Is this about 123 Main St? Want to chat?"),
    ).toEqual({ ok: true });
  });
});
