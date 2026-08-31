import { describe, expect, it } from "vitest";

import { resolveCoachTokens, resolveDisplayText, resolveFileNumber, resolveScriptText } from "./token-resolver";
import type { CoachCallContext, CoachEntryFields } from "./types";

const baseContext: CoachCallContext = {
  sellerName: "Jane Homeowner",
  propertyAddress: "123 Main St",
  propertyCounty: "Jackson",
  repName: "Alex Rep",
  authenticatedRepName: "Alex Rep",
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

  it("pre-fills the dream outcome from known motivation while allowing a typed outcome to override it", () => {
    expect(resolveCoachTokens(baseContext).dream_outcome).toEqual({
      value: "Job relocation",
      isPlaceholder: false,
    });
    expect(resolveCoachTokens(baseContext, entryFields).dream_outcome).toEqual({
      value: "move closer to family",
      isPlaceholder: false,
    });
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

  it("treats the outcome and every deal-panel token as an unset placeholder when neither context nor entry can resolve them", () => {
    const tokens = resolveCoachTokens({ ...baseContext, motivation: null });
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
  it("uses authenticated rep first/last initials plus the final six property ID characters", () => {
    const result = resolveFileNumber(baseContext);
    expect(result).toEqual({ value: "AR-567890", isPlaceholder: false });
  });

  it("renders the required JH format for the known authenticated production rep", () => {
    expect(resolveFileNumber({ ...baseContext, authenticatedRepName: "Jarrad Henry", leadId: "c1c524" })).toEqual({
      value: "JH-c1c524",
      isPlaceholder: false,
    });
  });

  it("uses the first and last name components for a multi-part authenticated rep name", () => {
    expect(resolveFileNumber({ ...baseContext, authenticatedRepName: "Alex Morgan Rep" })).toEqual({
      value: "AR-567890",
      isPlaceholder: false,
    });
  });

  it("does not use county or seller phone fallbacks", () => {
    expect(resolveFileNumber({ ...baseContext, propertyCounty: null })).toEqual({
      value: "AR-567890",
      isPlaceholder: false,
    });
    expect(resolveFileNumber({ ...baseContext, sellerPhoneE164: null })).toEqual({
      value: "AR-567890",
      isPlaceholder: false,
    });
  });

  it("uses a safe placeholder when trusted rep identity is missing or incomplete", () => {
    expect(resolveFileNumber({ ...baseContext, authenticatedRepName: null })).toEqual({ value: "—", isPlaceholder: true });
    expect(resolveFileNumber({ ...baseContext, authenticatedRepName: "Alex" })).toEqual({ value: "—", isPlaceholder: true });
  });

  it("uses a safe placeholder when the property ID is missing, too short, or has an invalid suffix", () => {
    expect(resolveFileNumber({ ...baseContext, leadId: null })).toEqual({ value: "—", isPlaceholder: true });
    expect(resolveFileNumber({ ...baseContext, leadId: "p1" })).toEqual({ value: "—", isPlaceholder: true });
    expect(resolveFileNumber({ ...baseContext, leadId: "abc-12" })).toEqual({ value: "—", isPlaceholder: true });
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
