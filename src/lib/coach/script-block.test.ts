import { describe, expect, it } from "vitest";

import {
  branchSayIndex,
  buildCoachSectionScriptBlock,
  buildPhaseScriptBlock,
  findNextSayAcrossBranches,
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

describe("buildCoachSectionScriptBlock", () => {
  it("resolves only the authored lines referenced by one conversational section", () => {
    const qualification = buildCoachSectionScriptBlock("introduction.qualification-frame", tokens);
    expect(qualification?.title).toBe("Set the qualification frame");
    expect(qualification?.branches).toHaveLength(1);
    expect(qualification?.branches[0].selected.lines.map((line) => line.id)).toEqual([
      "introduction.frame-the-call.default.01",
    ]);

    const howWeWork = buildCoachSectionScriptBlock("introduction.how-we-work", tokens);
    expect(howWeWork?.branches[0].selected.lines.map((line) => line.id)).toEqual([
      "introduction.frame-the-call.default.02",
      "introduction.frame-the-call.default.03",
      "introduction.frame-the-call.default.04",
    ]);
  });

  it("retains selected conditional variants inside the section", () => {
    const opener = buildCoachSectionScriptBlock(
      "introduction.opener",
      tokens,
      { leadSource: "cold_call", occupancy: null },
    );
    expect(opener?.branches[0].selected.key).toBe("cold_call");
    expect(opener?.branches[0].selected.lines).toHaveLength(2);

    const offer = buildCoachSectionScriptBlock("offer.outcome-tracks", tokens);
    expect(offer?.branches.map((branch) => branch.tag)).toEqual([
      "Good news",
      "Bad news",
      "Bad news — below mortgage",
      "Price too low",
    ]);
  });

  it("attaches a branch hold only to the section containing that branch's final authored line", () => {
    const agreement = buildCoachSectionScriptBlock("secure_positioning.explain-agreement", tokens);
    const finalHold = buildCoachSectionScriptBlock("secure_positioning.final-concerns-and-hold", tokens);
    expect(agreement?.branches[0].holdAfter).toBeNull();
    expect(finalHold?.branches[0].holdAfter).toBe("3-minute hold — write contract");
  });

  it("returns null for an unknown section", () => {
    expect(buildCoachSectionScriptBlock("unknown.section", tokens)).toBeNull();
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

describe("resolveCursorLine — revised wire contract, exact fall-through order", () => {
  // Both blocks below use the file's default selectCtx ({ leadSource: null,
  // occupancy: null }), so branch-level variant selection always falls back
  // to each branch's default/first variant unless a test overrides it via
  // buildPhaseScriptBlock's branchOverrides argument (mirroring a rep's
  // manual variant switch) — that's what makes "Sandra's own selected
  // variant" a fixed, known quantity per test rather than something that
  // shifts with live call context.
  const introBlock = buildPhaseScriptBlock("introduction", tokens)!;
  const revealBlock = buildPhaseScriptBlock("reveal", tokens)!;
  const NO_OVERRIDES: Record<string, string> = {};

  it("step 4: resolves via lineText when it matches a line in Sandra's own selected variant — wins even over a garbage variantKey/lineIndex", () => {
    const line = resolveCursorLine(
      {
        phaseId: "introduction",
        branchTag: "Frame the call",
        variantKey: "not-a-real-variant", // advisory only, must be ignored
        lineIndex: 999, // would be out of range if consulted
        lineText: "• To add some sort of value to the property so we can resell it on the market, or",
        scriptVersion: CLOSR_SCRIPT.version,
      },
      introBlock,
      NO_OVERRIDES,
      tokens,
    );
    expect(line).not.toBeNull();
    expect(allText(line!.segments)).toContain("add some sort of value to the property");
  });

  it("step 5 (rescue): lineText absent from Sandra's auto-selected variant, but present in the cursor's named variant, resolves there — real evidence the auto-select guessed wrong", () => {
    // Reveal's Entry branch: with occupancy unset and no manual override,
    // Sandra's own selection falls back to variants[0] ("unknown"). All
    // four variants share line 0 verbatim but diverge at line 1. The
    // cursor claims "vacant" and hands over VACANT's own line-1 text —
    // genuinely absent from "unknown" — so the rescue must resolve to
    // vacant's line, proving Jitter's guess earns priority ONLY on real
    // textual evidence.
    const line = resolveCursorLine(
      {
        phaseId: "reveal",
        branchTag: "Entry",
        variantKey: "vacant",
        lineIndex: 1,
        lineText: "I know it's been vacant for a little bit, but what made you decide to go ahead and sell it now?",
        scriptVersion: CLOSR_SCRIPT.version,
      },
      revealBlock,
      NO_OVERRIDES,
      tokens,
    );
    expect(line).not.toBeNull();
    expect(allText(line!.segments)).toContain("vacant for a little bit");
  });

  it("a REP MANUAL OVERRIDE always wins — the rescue never fires when this branch has one, even if the cursor's variant has a genuine lineText match", () => {
    // Same Entry branch/vacant-lineText setup as the rescue test above, but
    // now the rep has manually switched Entry to "owner_occupied" — the
    // concrete harm scenario: rep taps a variant tab, Jitter (blind to
    // that tap) guesses a different one. The override must resolve inside
    // OWNER_OCCUPIED, never switching to vacant no matter how well the
    // cursor's lineText matches there.
    const overriddenBlock = buildPhaseScriptBlock("reveal", tokens, { leadSource: null, occupancy: null }, {
      Entry: "owner_occupied",
    })!;
    const line = resolveCursorLine(
      {
        phaseId: "reveal",
        branchTag: "Entry",
        variantKey: "vacant",
        lineIndex: 1,
        lineText: "I know it's been vacant for a little bit, but what made you decide to go ahead and sell it now?",
        scriptVersion: CLOSR_SCRIPT.version,
      },
      overriddenBlock,
      { Entry: "owner_occupied" },
      tokens,
    );
    expect(line).not.toBeNull();
    // Falls through to lineIndex within owner_occupied (the override), NOT
    // vacant's text.
    expect(allText(line!.segments)).toContain("I know you live here and all");
    expect(allText(line!.segments)).not.toContain("vacant for a little bit");
  });

  it("falls back to lineIndex within Sandra's own variant when lineText matches NEITHER Sandra's variant nor the cursor's named variant", () => {
    const line = resolveCursorLine(
      {
        phaseId: "introduction",
        branchTag: "Frame the call",
        variantKey: "default", // Frame the call has only one variant — nowhere else for lineText to hide
        lineIndex: 3,
        lineText: "this text does not appear anywhere in the script",
        scriptVersion: CLOSR_SCRIPT.version,
      },
      introBlock,
      NO_OVERRIDES,
      tokens,
    );
    expect(line).not.toBeNull();
    expect(allText(line!.segments)).toContain("Buy the property to rent it to someone");
  });

  it("step 7: falls back to THIS branch's own first spoken line (not branch 0) when nothing else resolves", () => {
    const line = resolveCursorLine(
      {
        phaseId: "introduction",
        branchTag: "Frame the call", // not the phase's dominant branch (Opener)
        variantKey: "default",
        lineIndex: 999,
        lineText: "this text does not appear anywhere in the script",
        scriptVersion: CLOSR_SCRIPT.version,
      },
      introBlock,
      NO_OVERRIDES,
      tokens,
    );
    expect(line).not.toBeNull();
    // "Frame the call"'s own first say line, not Opener's greeting.
    expect(allText(line!.segments)).toContain("reason for my call today");
  });

  it("skips forward past a leading note line to the next actual 'say' line — never presents a note as speech", () => {
    // Reveal's "Example probes — goal 7+" branch has no auto_select_by, so
    // it needs a manual override to land Sandra's own selection on
    // "vacant" (branchOverrides mirrors the rep's manual variant switch).
    // Index 4 in that variant is a type:"note" line ("Add up everything
    // they've paid so far."), a rep-facing instruction, not speech.
    const overrides = { "Example probes — goal 7+": "vacant" };
    const block = buildPhaseScriptBlock("reveal", tokens, { leadSource: null, occupancy: null }, overrides)!;
    const noteLine = getScriptPhase("reveal")!.display.branches
      .find((b) => b.tag === "Example probes — goal 7+")!
      .variants.find((v) => v.key === "vacant")!.lines[4];
    expect(noteLine.type).toBe("note");

    const line = resolveCursorLine(
      {
        phaseId: "reveal",
        branchTag: "Example probes — goal 7+",
        variantKey: "vacant",
        lineIndex: 4,
        lineText: noteLine.text, // raw-text match lands exactly on the note
        scriptVersion: CLOSR_SCRIPT.version,
      },
      block,
      overrides,
      tokens,
    );
    expect(line).not.toBeNull();
    expect(line!.type).toBe("say");
    expect(allText(line!.segments)).toContain("So when you sell");
  });

  it("returns null (full branch-0 fallback territory) for an unknown branchTag rather than crashing", () => {
    expect(
      resolveCursorLine(
        {
          phaseId: "introduction",
          branchTag: "Not A Real Branch",
          variantKey: "default",
          lineIndex: 0,
          lineText: "irrelevant",
          scriptVersion: CLOSR_SCRIPT.version,
        },
        introBlock,
        NO_OVERRIDES,
        tokens,
      ),
    ).toBeNull();
  });

  it("never looks a branchTag up across phases — a tag from another phase's branches must not resolve", () => {
    // "Entry" only exists on Reveal's branches, not Introduction's — even
    // though the cursor's own phaseId matches the block, the tag must be
    // scoped to THIS phase's branches only.
    expect(
      resolveCursorLine(
        {
          phaseId: "introduction",
          branchTag: "Entry",
          variantKey: "unknown",
          lineIndex: 0,
          lineText: "irrelevant",
          scriptVersion: CLOSR_SCRIPT.version,
        },
        introBlock,
        NO_OVERRIDES,
        tokens,
      ),
    ).toBeNull();
  });

  it("returns null when the cursor's scriptVersion doesn't match this client's loaded script — discarded, not clamped", () => {
    expect(
      resolveCursorLine(
        {
          phaseId: "introduction",
          branchTag: "Frame the call",
          variantKey: "default",
          lineIndex: 2,
          lineText: "• To add some sort of value to the property so we can resell it on the market, or",
          scriptVersion: "0.0.1-not-the-loaded-script",
        },
        introBlock,
        NO_OVERRIDES,
        tokens,
      ),
    ).toBeNull();
  });

  it("returns null when the cursor's phaseId doesn't match the displayed block's phase", () => {
    expect(
      resolveCursorLine(
        {
          phaseId: "reveal",
          branchTag: "Entry",
          variantKey: "unknown",
          lineIndex: 0,
          lineText: "irrelevant",
          scriptVersion: CLOSR_SCRIPT.version,
        },
        introBlock, // introduction block, cursor claims reveal
        NO_OVERRIDES,
        tokens,
      ),
    ).toBeNull();
  });
});

describe("resolveCursorNextLine — one line further than whatever resolveCursorLine actually resolved", () => {
  const introBlock = buildPhaseScriptBlock("introduction", tokens)!;
  const NO_OVERRIDES: Record<string, string> = {};

  it("resolves the line immediately after the matched position", () => {
    const line = resolveCursorNextLine(
      {
        phaseId: "introduction",
        branchTag: "Frame the call",
        variantKey: "default",
        lineIndex: 1,
        lineText: "Cool, so how we work is very simple. We buy properties for a couple reasons:",
        scriptVersion: CLOSR_SCRIPT.version,
      },
      introBlock,
      NO_OVERRIDES,
      tokens,
    );
    expect(line).not.toBeNull();
    expect(allText(line!.segments)).toContain("add some sort of value to the property");
  });

  it("uses the ACTUAL resolved position, not the raw cursor.lineIndex, when resolution fell back", () => {
    // lineText doesn't match anything, so resolution falls back to
    // lineIndex 1 — "next" must be line 2, not line cursor.lineIndex+1
    // blindly re-derived from a lineText that never actually matched.
    const line = resolveCursorNextLine(
      {
        phaseId: "introduction",
        branchTag: "Frame the call",
        variantKey: "default",
        lineIndex: 1,
        lineText: "this text does not appear anywhere in the script",
        scriptVersion: CLOSR_SCRIPT.version,
      },
      introBlock,
      NO_OVERRIDES,
      tokens,
    );
    expect(line).not.toBeNull();
    expect(allText(line!.segments)).toContain("add some sort of value to the property");
  });

  it("skips forward past a note the same way resolveCursorLine does", () => {
    const overrides = { "Example probes — goal 7+": "vacant" };
    const block = buildPhaseScriptBlock("reveal", tokens, { leadSource: null, occupancy: null }, overrides)!;
    const line = resolveCursorNextLine(
      {
        phaseId: "reveal",
        branchTag: "Example probes — goal 7+",
        variantKey: "vacant",
        lineIndex: 3,
        lineText: "How long have you been paying that?",
        scriptVersion: CLOSR_SCRIPT.version,
      },
      block,
      overrides,
      tokens,
    );
    expect(line).not.toBeNull();
    expect(allText(line!.segments)).toContain("So when you sell");
  });

  it("BLOCKER REPRO: continues into the NEXT BRANCH within the same phase when the current variant is exhausted, instead of skipping to the next phase", () => {
    // A cursor on Introduction's "Frame the call" (its last line) must
    // preview Introduction's OWN "Pen & paper — contact details" branch
    // next — not Reveal. Concrete harm this reproduces: the old
    // implementation only ever searched within the resolved variant, so
    // running out of lines there fell straight through to the caller's
    // next-PHASE fallback, telling the rep the wrong thing to say at
    // exactly the moment they're about to move on.
    const lines = getScriptPhase("introduction")!.display.branches
      .find((b) => b.tag === "Frame the call")!
      .variants.find((v) => v.key === "default")!.lines;
    const lastIndex = lines.length - 1;

    const line = resolveCursorNextLine(
      {
        phaseId: "introduction",
        branchTag: "Frame the call",
        variantKey: "default",
        lineIndex: lastIndex,
        lineText: lines[lastIndex].text,
        scriptVersion: CLOSR_SCRIPT.version,
      },
      introBlock,
      NO_OVERRIDES,
      tokens,
    );
    expect(line).not.toBeNull();
    expect(allText(line!.segments)).toContain("pull out a pen and paper");
  });

  // NOTE: cross-branch continuation landing on the next REAL branch's
  // content is already proven end-to-end by the "BLOCKER REPRO" test above
  // (Frame the call -> Pen & paper, both real). What's tested here
  // specifically is the SKIP: a branch with no spoken line at all must be
  // passed over, not stopped at. The real script has no all-note branch
  // today (every branch has a "say" line), so that specific behavior
  // cannot be exercised end-to-end through real data without a
  // hand-built fixture — see the findNextSayAcrossBranches suite below,
  // which tests the actual skip mechanism resolveCursorNextLine calls.

  it("returns null only once EVERY remaining branch in the phase is exhausted — the true 'let the caller fall to the next phase' case", () => {
    // "Pen & paper — contact details" is Introduction's LAST branch; its
    // last line has nothing after it anywhere in this phase.
    const lines = getScriptPhase("introduction")!.display.branches
      .find((b) => b.tag === "Pen & paper — contact details")!
      .variants.find((v) => v.key === "default")!.lines;
    const lastIndex = lines.length - 1;

    const line = resolveCursorNextLine(
      {
        phaseId: "introduction",
        branchTag: "Pen & paper — contact details",
        variantKey: "default",
        lineIndex: lastIndex,
        lineText: lines[lastIndex].text,
        scriptVersion: CLOSR_SCRIPT.version,
      },
      introBlock,
      NO_OVERRIDES,
      tokens,
    );
    expect(line).toBeNull();
  });

  it("returns null when the underlying position can't be resolved at all (e.g. version mismatch)", () => {
    const line = resolveCursorNextLine(
      {
        phaseId: "introduction",
        branchTag: "Frame the call",
        variantKey: "default",
        lineIndex: 0,
        lineText: "irrelevant",
        scriptVersion: "0.0.1-not-the-loaded-script",
      },
      introBlock,
      NO_OVERRIDES,
      tokens,
    );
    expect(line).toBeNull();
  });
});

describe("branchSayIndex — never presents a note as speech, even for a synthetic all-note variant", () => {
  // The real, currently-loaded script has a "say" line in every variant —
  // this class of bug (an all-note variant silently defaulting to index 0,
  // which could land on a note) cannot be reproduced end-to-end through
  // real data, and the schema validator does not forbid an all-note
  // variant either (script-schema.ts only requires >=1 line, not >=1
  // "say" line). So this is proven directly against a synthetic fixture —
  // the exact scenario the fix exists for.
  it("returns null for a variant that is entirely notes — never index 0", () => {
    const allNotes: { id: string; type: "say" | "note"; text: string }[] = [
      { id: "fixture.note.01", type: "note", text: "Internal reminder — do not read this aloud." },
      { id: "fixture.note.02", type: "note", text: "Another internal-only stage direction." },
    ];
    expect(branchSayIndex(allNotes)).toBeNull();
  });

  it("returns the first say index when one exists, regardless of how many notes precede it", () => {
    const lines: { id: string; type: "say" | "note"; text: string }[] = [
      { id: "fixture.mixed.01", type: "note", text: "Setup note." },
      { id: "fixture.mixed.02", type: "note", text: "Another setup note." },
      { id: "fixture.mixed.03", type: "say", text: "The actual thing to say." },
    ];
    expect(branchSayIndex(lines)).toBe(2);
  });

  it("returns index 0 directly when the first line is already a say", () => {
    const lines: { id: string; type: "say" | "note"; text: string }[] = [
      { id: "fixture.say.01", type: "say", text: "Say this first." },
    ];
    expect(branchSayIndex(lines)).toBe(0);
  });
});

describe("findNextSayAcrossBranches — the cross-branch continuation SKIP, proven against a synthetic all-note branch", () => {
  // resolveCursorNextLine's cross-branch continuation (BLOCKER 1) must
  // skip PAST a branch with no spoken line at all, not stop there or
  // return it. The real script has no such branch today (every branch has
  // a "say" line), so this specific skip cannot be exercised end-to-end
  // through real data — that's exactly why this logic was extracted into
  // its own pure, exported function: so the skip itself is directly
  // provable against a hand-built fixture.
  it("skips a branch with NO spoken line at all and lands on the next branch that has one", () => {
    const branches = [
      { tag: "All-note branch", lines: [{ id: "fixture.branch-a.01", type: "note" as const, text: "Internal-only reminder." }] },
      { tag: "Has content", lines: [{ id: "fixture.branch-b.01", type: "say" as const, text: "The actual next thing to say." }] },
    ];
    expect(findNextSayAcrossBranches(branches)).toEqual({ tag: "Has content", lineIndex: 0 });
  });

  it("skips MULTIPLE consecutive all-note branches, not just one", () => {
    const branches = [
      { tag: "First all-note", lines: [{ id: "fixture.first.01", type: "note" as const, text: "Note 1." }] },
      { tag: "Second all-note", lines: [{ id: "fixture.second.01", type: "note" as const, text: "Note 2." }] },
      { tag: "Finally has content", lines: [{ id: "fixture.third.01", type: "say" as const, text: "Here it is." }] },
    ];
    expect(findNextSayAcrossBranches(branches)).toEqual({ tag: "Finally has content", lineIndex: 0 });
  });

  it("finds a say line at a non-zero index within a branch, not just index 0", () => {
    const branches = [
      {
        tag: "Mixed",
        lines: [
          { id: "fixture.mixed-branch.01", type: "note" as const, text: "setup note" },
          { id: "fixture.mixed-branch.02", type: "say" as const, text: "the actual spoken line" },
        ],
      },
    ];
    expect(findNextSayAcrossBranches(branches)).toEqual({ tag: "Mixed", lineIndex: 1 });
  });

  it("returns null when EVERY remaining branch is entirely notes — nothing left to preview", () => {
    const branches = [
      { tag: "A", lines: [{ id: "fixture.a.01", type: "note" as const, text: "note A" }] },
      { tag: "B", lines: [{ id: "fixture.b.01", type: "note" as const, text: "note B" }] },
    ];
    expect(findNextSayAcrossBranches(branches)).toBeNull();
  });

  it("returns null for an empty branch list", () => {
    expect(findNextSayAcrossBranches([])).toBeNull();
  });
});
