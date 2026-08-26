import { describe, expect, it } from "vitest";

import { buildPhaseScriptBlock, getScriptObjection, nextPhaseId } from "./script-block";
import { resolveCoachTokens } from "./token-resolver";
import type { CoachCallContext } from "./types";

const tokens = resolveCoachTokens({
  sellerName: "Jane Homeowner",
  propertyAddress: "123 Main St",
  propertyCounty: "Jackson",
  repName: "Alex Rep",
  repPhoneE164: "+18165551234",
  motivation: "Job relocation",
  leadId: "abcd1234-ef56-7890-abcd-ef1234567890",
  sellerPhoneE164: "+18165559876",
} satisfies CoachCallContext);

describe("buildPhaseScriptBlock", () => {
  it("resolves tokens inline for the introduction phase lines", () => {
    const block = buildPhaseScriptBlock("introduction", tokens);
    expect(block).not.toBeNull();
    expect(block?.phaseName).toBe("Introduction");
    const openerLine = block?.advanceLines.find((line) => line.id === "opener_said");
    const hasResolvedRepName = openerLine?.segments.some(
      (segment) => segment.kind === "token" && segment.token === "rep_name" && segment.resolved.value === "Alex Rep",
    );
    expect(hasResolvedRepName).toBe(true);
  });

  it("separates phase_enter cues from situational (runtime-triggered) cues", () => {
    const block = buildPhaseScriptBlock("reveal", tokens);
    expect(block?.openingCues.length).toBeGreaterThan(0);
    expect(block?.situationalCues.some((cue) => cue.trigger === "pain_word")).toBe(true);
  });

  it("attaches a landmark-specific tone cue to the matching line", () => {
    const block = buildPhaseScriptBlock("introduction", tokens);
    const positionCheckLine = block?.advanceLines.find((line) => line.id === "position_check");
    expect(positionCheckLine?.toneCue).toContain("cut the call");
  });

  it("exposes the reveal-phase probe counter", () => {
    const block = buildPhaseScriptBlock("reveal", tokens);
    expect(block?.counter).toEqual({ label: "Probes {n}/7", goal: 7 });
  });

  it("exposes the secure_positioning no-concerns gate", () => {
    const block = buildPhaseScriptBlock("secure_positioning", tokens);
    expect(block?.gates).toEqual([
      { id: "no_concerns", display: "No-concerns gate NOT cleared — stay here" },
    ]);
  });

  it("returns null for an unknown phase id", () => {
    // @ts-expect-error deliberately invalid phase id
    expect(buildPhaseScriptBlock("not_a_phase", tokens)).toBeNull();
  });
});

describe("nextPhaseId", () => {
  it("walks the fixed phase order and terminates after close", () => {
    expect(nextPhaseId("introduction")).toBe("reveal");
    expect(nextPhaseId("secure_positioning")).toBe("offer");
    expect(nextPhaseId("close")).toBeNull();
  });
});

describe("getScriptObjection", () => {
  it("finds the three-beat objection content by id", () => {
    const objection = getScriptObjection("price_too_low");
    expect(objection?.acknowledge).toBeTruthy();
    expect(objection?.disarm).toBeTruthy();
    expect(objection?.overcome).toBeTruthy();
  });

  it("returns undefined for an unknown objection id", () => {
    expect(getScriptObjection("does_not_exist")).toBeUndefined();
  });
});
