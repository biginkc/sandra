import { describe, expect, it } from "vitest";

import { resolveCoachTokens, resolveDisplayText, resolveFileNumber, resolveScriptText } from "./token-resolver";
import type { CoachCallContext, CoachEntryFields } from "./types";

const baseContext: CoachCallContext = {
  sellerName: "Jane Homeowner",
  propertyAddress: "123 Main St",
  propertyCounty: "Jackson",
  repName: "Alex Rep",
  repPhoneE164: "+18165551234",
  motivation: "Job relocation",
  leadId: "abcd1234-ef56-7890-abcd-ef1234567890",
  sellerPhoneE164: "+18165559876",
  coldCallerName: "Rose",
  yearBuilt: "1987",
  leadSource: "cold_call",
  occupancy: "owner_occupied",
};

const entryFields: CoachEntryFields = {
  motivation: null,
  dream_outcome: "move closer to family",
  cold_caller_name: null,
  closing_date: "Sept 15",
  offer_price: "$210,000",
  net_to_seller: "$180,000",
};

describe("resolveCoachTokens", () => {
  it("fills every token from context, using the seller's first name", () => {
    const tokens = resolveCoachTokens(baseContext);
    expect(tokens.seller_name).toEqual({ value: "Jane", isPlaceholder: false });
    expect(tokens.property_address).toEqual({ value: "123 Main St", isPlaceholder: false });
    expect(tokens.rep_name).toEqual({ value: "Alex Rep", isPlaceholder: false });
    expect(tokens.rep_phone).toEqual({ value: "+18165551234", isPlaceholder: false });
    expect(tokens.motivation).toEqual({ value: "Job relocation", isPlaceholder: false });
    expect(tokens.cold_caller_name).toEqual({ value: "Rose", isPlaceholder: false });
    expect(tokens.year_built).toEqual({ value: "1987", isPlaceholder: false });
  });

  it("renders a placeholder chip instead of a blank value for missing fields", () => {
    const tokens = resolveCoachTokens({ ...baseContext, motivation: null, repName: "  ", coldCallerName: null, yearBuilt: null });
    expect(tokens.motivation).toEqual({ value: "—", isPlaceholder: true });
    expect(tokens.rep_name).toEqual({ value: "—", isPlaceholder: true });
    expect(tokens.cold_caller_name).toEqual({ value: "—", isPlaceholder: true });
    expect(tokens.year_built).toEqual({ value: "—", isPlaceholder: true });
  });

  it("resolves the seller outcome and three deal-panel tokens from entryFields when supplied", () => {
    const tokens = resolveCoachTokens(baseContext, entryFields);
    expect(tokens.dream_outcome).toEqual({ value: "move closer to family", isPlaceholder: false });
    expect(tokens.closing_date).toEqual({ value: "Sept 15", isPlaceholder: false });
    expect(tokens.offer_price).toEqual({ value: "$210,000", isPlaceholder: false });
    expect(tokens.net_to_seller).toEqual({ value: "$180,000", isPlaceholder: false });
  });

  it("lets the rep fill motivation and cold-caller name when trusted context does not have them", () => {
    const tokens = resolveCoachTokens(
      { ...baseContext, motivation: null, coldCallerName: null },
      { ...entryFields, motivation: "Move closer to family", cold_caller_name: "Morgan" },
    );

    expect(tokens.motivation).toEqual({ value: "Move closer to family", isPlaceholder: false });
    expect(tokens.cold_caller_name).toEqual({ value: "Morgan", isPlaceholder: false });
  });

  it("uses typed entries when trusted motivation and cold-caller values contain only whitespace", () => {
    const tokens = resolveCoachTokens(
      { ...baseContext, motivation: "  \t", coldCallerName: "\n " },
      { ...entryFields, motivation: "Move closer to family", cold_caller_name: "Morgan" },
    );

    expect(tokens.motivation).toEqual({ value: "Move closer to family", isPlaceholder: false });
    expect(tokens.cold_caller_name).toEqual({ value: "Morgan", isPlaceholder: false });
  });

  it("keeps trusted motivation and cold-caller context authoritative over session fallback values", () => {
    const tokens = resolveCoachTokens(baseContext, {
      ...entryFields,
      motivation: "stale manual motivation",
      cold_caller_name: "Stale Caller",
    });

    expect(tokens.motivation).toEqual({ value: "Job relocation", isPlaceholder: false });
    expect(tokens.cold_caller_name).toEqual({ value: "Rose", isPlaceholder: false });
  });

  it("treats the outcome and every deal-panel token as an unset placeholder when entryFields is omitted", () => {
    const tokens = resolveCoachTokens(baseContext);
    expect(tokens.dream_outcome).toEqual({ value: "—", isPlaceholder: true });
    expect(tokens.closing_date).toEqual({ value: "—", isPlaceholder: true });
    expect(tokens.offer_price).toEqual({ value: "—", isPlaceholder: true });
    expect(tokens.net_to_seller).toEqual({ value: "—", isPlaceholder: true });
  });

  it("covers all 12 declared script tokens with no gaps", () => {
    const tokens = resolveCoachTokens(baseContext, entryFields);
    expect(Object.keys(tokens).sort()).toEqual(
      [
        "seller_name",
        "rep_name",
        "property_address",
        "motivation",
        "dream_outcome",
        "rep_phone",
        "file_number",
        "cold_caller_name",
        "year_built",
        "closing_date",
        "offer_price",
        "net_to_seller",
      ].sort(),
    );
    for (const token of Object.values(tokens)) {
      expect(token).toHaveProperty("value");
      expect(token).toHaveProperty("isPlaceholder");
    }
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

  it("falls back to the phone tail ALONE (no county prefix) when county is missing — the documented fallback", () => {
    // Per the approved script's token legend: "Fallback if county missing:
    // last 4 of seller's phone." The fallback triggers on county being
    // unavailable, and its value has no county prefix (county is exactly
    // what's missing) — this is distinct from the county-present-but-no-
    // lead-id case above, which keeps the county prefix.
    expect(resolveFileNumber({ ...baseContext, propertyCounty: null })).toEqual({
      value: "9876",
      isPlaceholder: false,
    });
  });

  it("returns a placeholder only when truly nothing is usable", () => {
    expect(
      resolveFileNumber({ ...baseContext, propertyCounty: null, sellerPhoneE164: null }),
    ).toEqual({ value: "—", isPlaceholder: true });
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

  it("resolves every declared token, including the deal-panel ones", () => {
    const tokens = resolveCoachTokens(baseContext, entryFields);
    const segments = resolveScriptText("closing on {closing_date}", tokens);
    expect(segments).toEqual([
      { kind: "text", value: "closing on " },
      { kind: "token", token: "closing_date", resolved: { value: "Sept 15", isPlaceholder: false } },
    ]);
  });

  it("passes through an unrecognized token as literal text", () => {
    const tokens = resolveCoachTokens(baseContext);
    const segments = resolveScriptText("{not_a_real_token} here", tokens);
    expect(segments).toEqual([
      { kind: "text", value: "{not_a_real_token}" },
      { kind: "text", value: " here" },
    ]);
  });

  it("returns a single text segment when there are no tokens", () => {
    const tokens = resolveCoachTokens(baseContext);
    expect(resolveScriptText("plain sentence", tokens)).toEqual([
      { kind: "text", value: "plain sentence" },
    ]);
  });
});

describe("resolveDisplayText", () => {
  it("resolves tokens and inline {{tone:label}} cues in the same line", () => {
    const tokens = resolveCoachTokens(baseContext);
    const segments = resolveDisplayText(
      "Well {{tone:playful tone}} no seriously, hey {seller_name}",
      tokens,
    );
    expect(segments).toEqual([
      { kind: "text", value: "Well " },
      { kind: "tone", label: "playful tone" },
      { kind: "text", value: " no seriously, hey " },
      { kind: "token", token: "seller_name", resolved: { value: "Jane", isPlaceholder: false } },
    ]);
  });

  it("handles a tone-only line with no tokens", () => {
    const tokens = resolveCoachTokens(baseContext);
    expect(resolveDisplayText("{{tone:sigh}}", tokens)).toEqual([{ kind: "tone", label: "sigh" }]);
  });

  it("handles plain text with neither tokens nor tone cues", () => {
    const tokens = resolveCoachTokens(baseContext);
    expect(resolveDisplayText("Thank you for your time.", tokens)).toEqual([
      { kind: "text", value: "Thank you for your time." },
    ]);
  });
});
