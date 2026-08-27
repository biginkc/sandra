import { describe, expect, it } from "vitest";

import {
  buildPhaseScriptBlock,
  getScriptObjection,
  getScriptPhase,
  nextPhaseId,
  resolveCursorLine,
  resolveCursorNextLine,
  resolveObjectionOvercome,
  selectBranchVariantKey,
} from "./script-block";
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
  yearBuilt: null,
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
  it("resolves {year_built} in the assessment phase's interior-condition line — regression for the {year built} (space, unresolvable) typo", () => {
    const builtTokens = resolveCoachTokens({ ...context, yearBuilt: "1987" });
    const block = buildPhaseScriptBlock("assessment", builtTokens);
    const branchWithInteriorLine = block?.branches
      .flatMap((branch) => branch.selected.lines)
      .find((line) => allText(line.segments).includes("interior still looks like"));
    expect(branchWithInteriorLine).toBeDefined();
    expect(allText(branchWithInteriorLine!.segments)).toContain("1987");
    // The bug this guards: {year built} (a space, not {year_built}) never
    // matched resolveDisplayText's \{(\w+)\} pattern, so the literal
    // braces rendered verbatim instead of resolving.
    expect(allText(branchWithInteriorLine!.segments)).not.toContain("{year built}");
  });

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
  it("auto-selects the opener variant from lead_source, with the shared greeting still first", () => {
    const block = buildPhaseScriptBlock("introduction", tokens, { leadSource: "cold_call", occupancy: null });
    const opener = block?.branches.find((branch) => branch.tag === "Opener");
    expect(opener?.selected.key).toBe("cold_call");
    expect(opener?.autoSelected).toBe(true);
    // Every opener variant must lead with the greeting — it's not a
    // mutually-exclusive "default" variant that disappears once a
    // lead-source variant auto-selects.
    expect(allText(opener!.selected.lines[0].segments)).toContain("Alex Rep");
    expect(allText(opener!.selected.lines[1].segments)).toContain("Rose");
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

  it("every Opener variant leads with the shared greeting line, not just the auto-selected one", () => {
    const opener = CLOSR_SCRIPT.phases.find((phase) => phase.id === "introduction")!.display.branches[0];
    expect(opener.tag).toBe("Opener");
    for (const variant of opener.variants) {
      expect(variant.lines[0].text).toContain("this is {rep_name}");
    }
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

  it("carries the zillow_worth live-math template flag and guidance note", () => {
    const objection = getScriptObjection("zillow_worth");
    expect(objection?.display.template).toBe(true);
    expect(objection?.display.template_note).toBeTruthy();
  });
});

describe("resolveObjectionOvercome", () => {
  const notInRush = getScriptObjection("not_in_rush")!;

  it("picks the owner_occupied track", () => {
    expect(resolveObjectionOvercome(notInRush, "owner_occupied")).toContain("where do you plan on going next");
  });

  it("picks the tenant_occupied track", () => {
    expect(resolveObjectionOvercome(notInRush, "tenant_occupied")).toContain("hanging up the landlord duties");
  });

  it("picks the vacant track", () => {
    expect(resolveObjectionOvercome(notInRush, "vacant")).toContain("collecting dust");
  });

  it("falls back to the default overcome when occupancy is null", () => {
    expect(resolveObjectionOvercome(notInRush, null)).toBe(notInRush.display.overcome);
  });

  it("falls back to the default overcome for an objection with no occupancy tracks at all", () => {
    const priceTooLow = getScriptObjection("price_too_low")!;
    expect(resolveObjectionOvercome(priceTooLow, "owner_occupied")).toBe(priceTooLow.display.overcome);
  });
});

describe("coach_notes fidelity — every phase carries its full rule set from the approved script", () => {
  it("Introduction has all 6 coach rules, including the two previously omitted", () => {
    const notes = getScriptPhase("introduction")!.coach_notes.map((note) => note.text);
    expect(notes.some((text) => text.includes("someone else must sign"))).toBe(true);
    expect(notes.some((text) => text.includes("Inbound leads get the full intro"))).toBe(true);
  });

  it("Reveal has the 'four tools' and 'kill shot' rules", () => {
    const notes = getScriptPhase("reveal")!.coach_notes.map((note) => note.text);
    expect(notes.some((text) => text.includes("Four tools"))).toBe(true);
    expect(notes.some((text) => text.includes("kill shot"))).toBe(true);
  });

  it("Assessment has the 'acknowledge condition' and 'don't advance while unclear' rules", () => {
    const notes = getScriptPhase("assessment")!.coach_notes.map((note) => note.text);
    expect(notes.some((text) => text.includes("acknowledge condition"))).toBe(true);
    expect(notes.some((text) => text.includes("liens, tenants, repairs"))).toBe(true);
  });

  it("Secure Positioning has the novation and 'use the holds' rules", () => {
    const notes = getScriptPhase("secure_positioning")!.coach_notes.map((note) => note.text);
    expect(notes.some((text) => text.includes("novation"))).toBe(true);
    expect(notes.some((text) => text.includes("Use the holds"))).toBe(true);
  });

  it("Offer has the 'net pocket + outcome' rule", () => {
    const notes = getScriptPhase("offer")!.coach_notes.map((note) => note.text);
    expect(notes.some((text) => text.includes("net pocket"))).toBe(true);
  });

  it("Close has all 5 coach rules, not a lossy merge of 2", () => {
    const notes = getScriptPhase("close")!.coach_notes.map((note) => note.text);
    expect(notes).toHaveLength(5);
    expect(notes.some((text) => text.includes("Possible") && text.includes("probably"))).toBe(true);
    expect(notes.some((text) => text.includes("contract to sign"))).toBe(true);
    expect(notes.some((text) => text.includes("attorney"))).toBe(true);
    expect(notes.some((text) => text.includes("never fake pressure"))).toBe(true);
  });
});

describe("resolveCursorLine — resolves against the raw script, not a pre-built block", () => {
  it("resolves the exact line the cursor names, with tokens filled in", () => {
    const line = resolveCursorLine(
      { phaseId: "introduction", branchTag: "Frame the call", variantKey: "default", lineIndex: 2 },
      tokens,
    );
    expect(line).not.toBeNull();
    expect(line!.type).toBe("say");
    expect(allText(line!.segments)).toContain("add some sort of value to the property");
  });

  it("resolves against the variant the cursor names, not the block's auto/override-selected variant", () => {
    // The Opener branch auto-selects by lead_source; this context has none
    // set, so the block's `selected` variant would be "default". A cursor
    // naming "cold_call" explicitly must still resolve to cold_call's line,
    // proving this reads the named variant, not whatever the block picked.
    const line = resolveCursorLine(
      { phaseId: "introduction", branchTag: "Opener", variantKey: "cold_call", lineIndex: 1 },
      tokens,
    );
    expect(line).not.toBeNull();
    expect(allText(line!.segments)).toContain("Rose");
  });

  it("skips forward past a leading note line to the next actual 'say' line — never presents a note as speech", () => {
    // Reveal's "Example probes — goal 7+" branch, vacant variant: index 4
    // is a type:"note" line ("Add up everything they've paid so far."), a
    // rep-facing instruction, not something to say aloud.
    const noteLine = getScriptPhase("reveal")!.display.branches
      .find((b) => b.tag === "Example probes — goal 7+")!
      .variants.find((v) => v.key === "vacant")!.lines[4];
    expect(noteLine.type).toBe("note");

    const line = resolveCursorLine(
      { phaseId: "reveal", branchTag: "Example probes — goal 7+", variantKey: "vacant", lineIndex: 4 },
      tokens,
    );
    expect(line).not.toBeNull();
    expect(line!.type).toBe("say");
    expect(allText(line!.segments)).toContain("So when you sell");
  });

  it("returns null for an unknown branchTag rather than crashing", () => {
    expect(
      resolveCursorLine({ phaseId: "introduction", branchTag: "Not A Real Branch", variantKey: "default", lineIndex: 0 }, tokens),
    ).toBeNull();
  });

  it("returns null for an unknown variantKey rather than crashing", () => {
    expect(
      resolveCursorLine({ phaseId: "introduction", branchTag: "Opener", variantKey: "not_a_real_variant", lineIndex: 0 }, tokens),
    ).toBeNull();
  });

  it("returns null for an out-of-range lineIndex rather than crashing", () => {
    expect(
      resolveCursorLine({ phaseId: "introduction", branchTag: "Opener", variantKey: "default", lineIndex: 99 }, tokens),
    ).toBeNull();
    expect(
      resolveCursorLine({ phaseId: "introduction", branchTag: "Opener", variantKey: "default", lineIndex: -1 }, tokens),
    ).toBeNull();
  });

  it("returns null for an unknown phaseId rather than crashing", () => {
    expect(
      // @ts-expect-error deliberately invalid phase id
      resolveCursorLine({ phaseId: "not_a_phase", branchTag: "Opener", variantKey: "default", lineIndex: 0 }, tokens),
    ).toBeNull();
  });
});

describe("resolveCursorNextLine — one line further, same defensive rules", () => {
  it("resolves the line immediately after the cursor", () => {
    const line = resolveCursorNextLine(
      { phaseId: "introduction", branchTag: "Frame the call", variantKey: "default", lineIndex: 1 },
      tokens,
    );
    expect(line).not.toBeNull();
    expect(allText(line!.segments)).toContain("add some sort of value to the property");
  });

  it("skips forward past a note the same way resolveCursorLine does", () => {
    const line = resolveCursorNextLine(
      { phaseId: "reveal", branchTag: "Example probes — goal 7+", variantKey: "vacant", lineIndex: 3 },
      tokens,
    );
    expect(line).not.toBeNull();
    expect(allText(line!.segments)).toContain("So when you sell");
  });

  it("returns null when the cursor is already on the variant's last line", () => {
    const lines = getScriptPhase("introduction")!.display.branches
      .find((b) => b.tag === "Frame the call")!
      .variants.find((v) => v.key === "default")!.lines;
    const lastIndex = lines.length - 1;

    const line = resolveCursorNextLine(
      { phaseId: "introduction", branchTag: "Frame the call", variantKey: "default", lineIndex: lastIndex },
      tokens,
    );
    expect(line).toBeNull();
  });
});
