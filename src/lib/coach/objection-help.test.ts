import { describe, expect, it } from "vitest";

import { CLOSR_SCRIPT } from "./script-block";
import { resolveCoachTokens } from "./token-resolver";
import type { CoachCallContext } from "./types";
import { findObjectionHelp } from "./objection-help";

const context: CoachCallContext = {
  sellerName: "Jane Homeowner",
  propertyAddress: "123 Main St",
  propertyCounty: "Jackson",
  repName: "Alex Rep",
  authenticatedRepName: "Alex Rep",
  repPhoneE164: "+18165551234",
  motivation: "move closer to family",
  leadId: "lead-1",
  sellerPhoneE164: "+18165559876",
  coldCallerName: null,
  yearBuilt: "1987",
  leadSource: "cold_call",
  occupancy: "owner_occupied",
};

const tokens = resolveCoachTokens(context);

describe("findObjectionHelp", () => {
  it("uses only finalized seller speech and returns all three approved beats", () => {
    const result = findObjectionHelp([
      { speaker: "rep", text: "I do not trust that estimate.", isFinal: true },
      { speaker: "seller", text: "I don't trust wholesalers.", isFinal: false },
      { speaker: "seller", text: "I don't trust wholesalers because I heard bad things.", isFinal: true },
    ], tokens, context.occupancy);

    expect(result).toMatchObject({
      kind: "match",
      objectionId: "dont_trust",
      label: "Dont Trust",
      matchedTrigger: "heard bad things",
      acknowledge: "Yeah, you're completely right.",
    });
    if (result.kind === "match") {
      expect(result.disarm).toContain("don't know enough about us");
      expect(result.overcome).toContain("What would make you feel more confident");
    }
  });

  it("returns a truthful no-clear-objection result instead of guessing", () => {
    expect(findObjectionHelp([
      { speaker: "seller", text: "The kitchen was updated last year and looks great.", isFinal: true },
      { speaker: "seller", text: "Okay, thanks.", isFinal: true },
    ], tokens, context.occupancy)).toEqual({
      kind: "no_match",
      message: "No clear objection was found in the finalized homeowner speech.",
    });
  });

  it("uses the occupancy-specific approved track and resolves seller tokens", () => {
    const result = findObjectionHelp([
      { speaker: "seller", text: "I need to talk to my spouse before deciding.", isFinal: true },
    ], tokens, context.occupancy);

    expect(result).toMatchObject({ kind: "match", objectionId: "talk_to_spouse" });
    if (result.kind === "match") {
      expect(result.disarm).toContain("Jane, I have two available slots");
      expect(result.disarm).not.toContain("{seller_name}");
    }

    const tenantTokens = resolveCoachTokens({ ...context, occupancy: "tenant_occupied" });
    const tenant = findObjectionHelp([
      { speaker: "seller", text: "There is no rush to sell this rental.", isFinal: true },
    ], tenantTokens, "tenant_occupied");
    expect(tenant).toMatchObject({ kind: "match", objectionId: "not_in_rush" });
    if (tenant.kind === "match") expect(tenant.overcome).toContain("landlord duties");
  });

  it("keeps every authored trigger connected to the click-driven catalog matcher", () => {
    for (const objection of CLOSR_SCRIPT.objections) {
      const result = findObjectionHelp([
        { speaker: "seller", text: `I want to say ${objection.match.triggers[0]}.`, isFinal: true },
      ], tokens, null);
      expect(result, objection.id).toMatchObject({ kind: "match", objectionId: objection.id });
    }
  });

  it("prefers a more specific cue before a shorter overlapping cue", () => {
    const result = findObjectionHelp([
      { speaker: "seller", text: "Just give me the offer — what's your offer?", isFinal: true },
    ], tokens, null);
    expect(result).toMatchObject({ kind: "match", objectionId: "straight_to_offer", matchedTrigger: "just give me the offer" });
  });
});
