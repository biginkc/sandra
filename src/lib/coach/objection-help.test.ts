import { describe, expect, it } from "vitest";

import { CLOSR_SCRIPT } from "./script-block";
import { resolveCoachTokens } from "./token-resolver";
import type { CoachCallContext } from "./types";
import { buildObjectionHelp } from "./objection-help";

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

// This module no longer decides WHICH objection was raised — that decision
// now comes from the server-side classifier (recommendation-server.ts,
// tested there with a mocked model boundary). buildObjectionHelp only turns
// an already-decided objectionId into the approved display card, so these
// tests exercise that pure mapping: known id -> full guidance, unknown/null
// id -> a truthful no-match, occupancy-specific tracks, and token
// resolution. It never invents an objection and never lets the model write
// guidance text.
describe("buildObjectionHelp", () => {
  it("resolves a classified objectionId into all three approved beats and the evidence quote", () => {
    const result = buildObjectionHelp(
      { objectionId: "dont_trust", evidenceQuote: "heard bad things" },
      tokens,
      context.occupancy,
    );

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

  it("returns a truthful no-clear-objection result when the classifier found nothing", () => {
    expect(buildObjectionHelp({ objectionId: null, evidenceQuote: null }, tokens, context.occupancy)).toEqual({
      kind: "no_match",
      message: "No clear objection was found in the finalized homeowner speech.",
    });
  });

  it("never trusts a classified id that isn't in the catalog, even if evidenceQuote is present", () => {
    // Defense in depth: the server already validates objectionId against
    // the catalog before this ever runs, but a client-visible id must never
    // be assumed safe just because it arrived over the wire.
    expect(buildObjectionHelp(
      { objectionId: "made_up_objection", evidenceQuote: "anything" },
      tokens,
      context.occupancy,
    )).toEqual({
      kind: "no_match",
      message: "No clear objection was found in the finalized homeowner speech.",
    });
  });

  it("uses the occupancy-specific approved track and resolves seller tokens", () => {
    const result = buildObjectionHelp(
      { objectionId: "talk_to_spouse", evidenceQuote: "talk to my spouse" },
      tokens,
      context.occupancy,
    );
    expect(result).toMatchObject({ kind: "match", objectionId: "talk_to_spouse" });
    if (result.kind === "match") {
      expect(result.disarm).toContain("Jane, I have two available slots");
      expect(result.disarm).not.toContain("{seller_name}");
    }

    const tenantTokens = resolveCoachTokens({ ...context, occupancy: "tenant_occupied" });
    const tenant = buildObjectionHelp(
      { objectionId: "not_in_rush", evidenceQuote: "not in a rush" },
      tenantTokens,
      "tenant_occupied",
    );
    expect(tenant).toMatchObject({ kind: "match", objectionId: "not_in_rush" });
    if (tenant.kind === "match") expect(tenant.overcome).toContain("landlord duties");
  });

  it("keeps every catalog objection resolvable to its full guidance card", () => {
    for (const objection of CLOSR_SCRIPT.objections) {
      const result = buildObjectionHelp(
        { objectionId: objection.id, evidenceQuote: objection.match.triggers[0] },
        tokens,
        null,
      );
      expect(result, objection.id).toMatchObject({
        kind: "match",
        objectionId: objection.id,
        label: expect.any(String),
        matchedTrigger: objection.match.triggers[0],
        acknowledge: expect.any(String),
        disarm: expect.any(String),
        overcome: expect.any(String),
      });
    }
  });

  it("never lets the model's evidence quote leak into the guidance text — guidance always comes from the catalog by id", () => {
    const result = buildObjectionHelp(
      { objectionId: "dont_trust", evidenceQuote: "this is a made-up hallucinated quote the model invented" },
      tokens,
      context.occupancy,
    );
    if (result.kind !== "match") throw new Error("expected a match");
    expect(result.acknowledge).toBe("Yeah, you're completely right.");
    expect(result.acknowledge).not.toContain("hallucinated");
    expect(result.disarm).not.toContain("hallucinated");
    expect(result.overcome).not.toContain("hallucinated");
  });
});
