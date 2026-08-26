import { describe, expect, it } from "vitest";

import { resolveCoachTokens, resolveFileNumber, resolveScriptText } from "./token-resolver";
import type { CoachCallContext } from "./types";

const baseContext: CoachCallContext = {
  sellerName: "Jane Homeowner",
  propertyAddress: "123 Main St",
  propertyCounty: "Jackson",
  repName: "Alex Rep",
  repPhoneE164: "+18165551234",
  motivation: "Job relocation",
  leadId: "abcd1234-ef56-7890-abcd-ef1234567890",
  sellerPhoneE164: "+18165559876",
};

describe("resolveCoachTokens", () => {
  it("fills every token from context, using the seller's first name", () => {
    const tokens = resolveCoachTokens(baseContext);
    expect(tokens.seller_name).toEqual({ value: "Jane", isPlaceholder: false });
    expect(tokens.property_address).toEqual({ value: "123 Main St", isPlaceholder: false });
    expect(tokens.rep_name).toEqual({ value: "Alex Rep", isPlaceholder: false });
    expect(tokens.rep_phone).toEqual({ value: "+18165551234", isPlaceholder: false });
    expect(tokens.motivation).toEqual({ value: "Job relocation", isPlaceholder: false });
  });

  it("renders a placeholder chip instead of a blank value for missing fields", () => {
    const tokens = resolveCoachTokens({ ...baseContext, motivation: null, repName: "  " });
    expect(tokens.motivation).toEqual({ value: "—", isPlaceholder: true });
    expect(tokens.rep_name).toEqual({ value: "—", isPlaceholder: true });
  });
});

describe("resolveFileNumber", () => {
  it("uses county first-2-uppercase + last-4 of the lead id", () => {
    const result = resolveFileNumber(baseContext);
    expect(result).toEqual({ value: "JA-7890", isPlaceholder: false });
  });

  it("falls back to the seller phone's last 4 digits when the lead id is missing", () => {
    const result = resolveFileNumber({ ...baseContext, leadId: null });
    expect(result).toEqual({ value: "JA-9876", isPlaceholder: false });
  });

  it("falls back to the seller phone when the lead id has no usable characters", () => {
    const result = resolveFileNumber({ ...baseContext, leadId: "" });
    expect(result).toEqual({ value: "JA-9876", isPlaceholder: false });
  });

  it("returns a placeholder when neither county nor a usable id/phone exist", () => {
    expect(resolveFileNumber({ ...baseContext, propertyCounty: null })).toEqual({
      value: "—",
      isPlaceholder: true,
    });
    expect(
      resolveFileNumber({ ...baseContext, leadId: null, sellerPhoneE164: null }),
    ).toEqual({ value: "—", isPlaceholder: true });
  });

  it("handles a multi-word county name by using its first two letters", () => {
    const result = resolveFileNumber({ ...baseContext, propertyCounty: "St. Louis" });
    expect(result.value.startsWith("ST-")).toBe(true);
  });
});

describe("resolveScriptText", () => {
  it("splits text into plain and resolved token segments", () => {
    const tokens = resolveCoachTokens(baseContext);
    const segments = resolveScriptText("this is {rep_name}, hey {seller_name}", tokens);
    expect(segments).toEqual([
      { kind: "text", value: "this is " },
      { kind: "token", token: "rep_name", resolved: { value: "Alex Rep", isPlaceholder: false } },
      { kind: "text", value: ", hey " },
      { kind: "token", token: "seller_name", resolved: { value: "Jane", isPlaceholder: false } },
    ]);
  });

  it("passes through unrecognized tokens (e.g. {closing_date}) as literal text", () => {
    const tokens = resolveCoachTokens(baseContext);
    const segments = resolveScriptText("closing on {closing_date}", tokens);
    expect(segments).toEqual([
      { kind: "text", value: "closing on " },
      { kind: "text", value: "{closing_date}" },
    ]);
  });

  it("returns a single text segment when there are no tokens", () => {
    const tokens = resolveCoachTokens(baseContext);
    expect(resolveScriptText("plain sentence", tokens)).toEqual([
      { kind: "text", value: "plain sentence" },
    ]);
  });
});
