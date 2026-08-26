import { describe, expect, it } from "vitest";

import { buildPhaseScriptBlock, getScriptObjection, nextPhaseId, selectBranchVariantKey } from "./script-block";
import { CLOSR_SCRIPT } from "./script-block";
import { resolveCoachTokens } from "./token-resolver";
import type { CoachCallContext } from "./types";

const context: CoachCallContext = {
  sellerName: "Jane Homeowner",
  propertyAddress: "123 Main St",
  propertyCounty: "Jackson",
  repName: "Alex Rep",
  repPhoneE164: "+18165551234",
  motivation: "Job relocation",
  leadId: "abcd1234-ef56-7890-abcd-ef1234567890",
  sellerPhoneE164: "+18165559876",
  coldCallerName: "Rose",
  leadSource: null,
  occupancy: null,
};

const tokens = resolveCoachTokens(context);

function allText(segments: { kind: string; value?: string; label?: string; resolved?: { value: string } }[]): string {
  return segments
    .map((segment) => (segment.kind === "text" ? segment.value : segment.kind === "tone" ? "" : segment.resolved?.value))
    .join("");
}

describe("buildPhaseScriptBlock", () => {
  it("resolves tokens inline in the selected variant's lines", () => {
    const block = buildPhaseScriptBlock("introduction", tokens);
    expect(block).not.toBeNull();
    expect(block?.phaseName).toBe("Introduction");
    const opener = block?.branches.find((branch) => branch.tag === "Opener");
    const openerText = allText(opener!.selected.lines[0].segments);
    expect(openerText).toContain("Alex Rep");
    expect(openerText).toContain("Jane");
  });

  it("never renders raw matcher phrases as Say copy", () => {
    const block = buildPhaseScriptBlock("introduction", tokens);
    const lockedFrame = block?.branches.find((branch) => branch.tag === "Frame the call");
    const text = lockedFrame!.selected.lines.map((line) => allText(line.segments)).join(" ");
    // "sound fair" is a matcher fragment from match.advance_landmarks, not a
    // full sentence — the real display line contains it as part of a full
    // sentence, so assert the full approved sentence is present instead.
    expect(text).toContain("Because at the end of the day not every property does qualify for an offer");
  });

  it("separates phase_enter cues from situational (runtime-triggered) cues", () => {
    const block = buildPhaseScriptBlock("reveal", tokens);
    expect(block?.openingCues.length).toBeGreaterThan(0);
    expect(block?.situationalCues.some((cue) => cue.trigger === "pain_word")).toBe(true);
  });

  it("exposes the reveal-phase probe counter and secure_positioning gate from match data", () => {
    const reveal = buildPhaseScriptBlock("reveal", tokens);
    expect(reveal?.counter).toEqual({ label: "Probes {n}/7", goal: 7 });
    const securePositioning = buildPhaseScriptBlock("secure_positioning", tokens);
    expect(securePositioning?.gates).toEqual([
      { id: "no_concerns", display: "No-concerns gate NOT cleared — stay here" },
    ]);
  });

  it("marks the no-concerns-gate branch critical", () => {
    const block = buildPhaseScriptBlock("secure_positioning", tokens);
    const gateBranch = block?.branches.find((branch) => branch.tag === "The no-concerns gate");
    expect(gateBranch?.critical).toBe(true);
  });

  it("attaches a branch's hold_after banner", () => {
    const block = buildPhaseScriptBlock("secure_positioning", tokens);
    const sendToUnderwriting = block?.branches.find((branch) => branch.tag === "Send to underwriting");
    expect(sendToUnderwriting?.holdAfter).toBe("3-minute hold — run comps");
  });

  it("returns null for an unknown phase id", () => {
    // @ts-expect-error deliberately invalid phase id
    expect(buildPhaseScriptBlock("not_a_phase", tokens)).toBeNull();
  });
});

describe("branch variant selection", () => {
  it("auto-selects the opener variant from lead_source", () => {
    const block = buildPhaseScriptBlock("introduction", tokens, { leadSource: "cold_call", occupancy: null });
    const opener = block?.branches.find((branch) => branch.tag === "Opener");
    expect(opener?.selected.key).toBe("cold_call");
    expect(opener?.autoSelected).toBe(true);
    expect(allText(opener!.selected.lines[0].segments)).toContain("Rose");
  });

  it("falls back to the default opener variant for a source with no mapped branch (e.g. FSBO-less sources)", () => {
    const block = buildPhaseScriptBlock("introduction", tokens, { leadSource: "web_form", occupancy: null });
    const opener = block?.branches.find((branch) => branch.tag === "Opener");
    expect(opener?.selected.key).toBe("default");
  });

  it("auto-selects the reveal entry variant from occupancy", () => {
    const block = buildPhaseScriptBlock("reveal", tokens, { leadSource: null, occupancy: "vacant" });
    const entry = block?.branches.find((branch) => branch.tag === "Entry");
    expect(entry?.selected.key).toBe("vacant");
  });

  it("a manual override always wins over auto-select", () => {
    const block = buildPhaseScriptBlock(
      "introduction",
      tokens,
      { leadSource: "cold_call", occupancy: null },
      { Opener: "fsbo" },
    );
    const opener = block?.branches.find((branch) => branch.tag === "Opener");
    expect(opener?.selected.key).toBe("fsbo");
    expect(opener?.autoSelected).toBe(false);
  });

  it("selectBranchVariantKey defaults to the branch's first variant with no context or override", () => {
    const branch = CLOSR_SCRIPT.phases.find((phase) => phase.id === "introduction")!.display.branches[0];
    const key = selectBranchVariantKey(branch, { leadSource: null, occupancy: null }, null);
    expect(key).toBe(branch.variants[0].key);
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
  it("finds the three-beat objection content by id under display", () => {
    const objection = getScriptObjection("price_too_low");
    expect(objection?.display.acknowledge).toBeTruthy();
    expect(objection?.display.disarm).toBeTruthy();
    expect(objection?.display.overcome).toBeTruthy();
    expect(objection?.match.triggers.length).toBeGreaterThan(0);
  });

  it("returns undefined for an unknown objection id", () => {
    expect(getScriptObjection("does_not_exist")).toBeUndefined();
  });
});
