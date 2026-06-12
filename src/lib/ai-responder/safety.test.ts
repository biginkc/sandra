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

  it("rejects bodies containing slang", () => {
    expect(
      validateAiReplyBody("My bad for the cold text, hit me up anytime."),
    ).toEqual({ ok: false, reason: "contains_slang" });
  });

  it("rejects slang only on word boundaries", () => {
    // "Coolidge" must not trip "cool".
    expect(
      validateAiReplyBody("Is this about the place on Coolidge Street?"),
    ).toEqual({ ok: true });
  });

  it("rejects bodies that start lowercase", () => {
    expect(validateAiReplyBody("thanks for confirming.")).toEqual({
      ok: false,
      reason: "starts_lowercase",
    });
  });

  it("rejects lowercase hiding behind leading punctuation or quotes", () => {
    expect(validateAiReplyBody('"thanks for confirming."')).toEqual({
      ok: false,
      reason: "starts_lowercase",
    });
    expect(validateAiReplyBody("(thanks for confirming.)")).toEqual({
      ok: false,
      reason: "starts_lowercase",
    });
  });

  it("accepts an uppercase start behind leading punctuation", () => {
    expect(validateAiReplyBody('"Thanks for confirming."')).toEqual({
      ok: true,
    });
  });

  it("accepts digit-prefixed bodies whose first letter is uppercase", () => {
    expect(
      validateAiReplyBody("123 Main St works for a quick call."),
    ).toEqual({ ok: true });
    expect(
      validateAiReplyBody("123 main st works for a quick call."),
    ).toEqual({ ok: false, reason: "starts_lowercase" });
  });

  it("rejects bodies over one SMS segment (160 chars)", () => {
    expect(validateAiReplyBody("X" + "x".repeat(160))).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  it("accepts a body at exactly 160 chars", () => {
    expect(validateAiReplyBody("X" + "x".repeat(159))).toEqual({ ok: true });
  });
});
