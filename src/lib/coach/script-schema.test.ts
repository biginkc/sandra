import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { assertValidClosrScript, type ClosrScript } from "./script-schema";
import scriptJson from "./closr-script-v0.json";
import sectionsJson from "./closr-sections-v1.json";

function validScript(): Record<string, unknown> {
  // Deep-clone via JSON round-trip so mutation in one test never leaks.
  return JSON.parse(JSON.stringify(scriptJson));
}

const SELLER_EMAIL_REQUEST = "What's the best email address for you?";
const ESIGN_HANDOFF = "Awesome, I just sent it to your email. Please pull it up for me.";

const FORBIDDEN_ESIGN_PHRASES = [
  "share your screen",
  "share screen",
  "screen share",
  "screenshare",
  "click the link",
  "walk you through signing",
  "walk through signing",
  "view documents",
  "press sign",
  "red flashing box",
  "adopt and sign",
  "second red box",
  "second novation box",
  "share back",
  "esign steps",
] as const;

function normalizeForAcceptanceScan(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\p{Cf}+/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function isSellerEmailRequest(value: string): boolean {
  const text = normalizeForAcceptanceScan(value);
  if (!/\bemail(?: address)?\b/.test(text)) return false;
  return (
    /\b(?:what is|what s|whats|which)\b.{0,80}\bemail(?: address)?\b/.test(text) ||
    /\b(?:can|could|may)\b.{0,40}\b(?:i|we)\b.{0,40}\b(?:get|have|use)\b.{0,40}\b(?:your|the)\b.{0,20}\bemail(?: address)?\b/.test(text)
  );
}

function collectAllStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectAllStrings(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectAllStrings(item, out);
  }
  return out;
}

describe("assertValidClosrScript", () => {
  it("accepts the real closr-script-v0.json unmodified", () => {
    expect(() => assertValidClosrScript(scriptJson)).not.toThrow();
  });

  it("identifies the authoritative Google Doc and keeps the approved BMH substitutions", () => {
    const script = scriptJson as unknown as ClosrScript;
    expect(script.version).toBe("1.2.0");
    expect(sectionsJson).toMatchObject({ version: "1.2.0", script_version: "1.2.0" });
    expect(script.source).toContain("1ab9k0VIUQ4kkSTmdR5XV7qeuiRe2-czgmKGouM-lCag");
    expect(script.brand).toEqual({ company: "BMH Group", website: "bmhgroupkc.com" });
    expect(script.tokens).toContain("dream_outcome");

    const spokenText = script.phases
      .flatMap((phase) => phase.display.branches)
      .flatMap((branch) => branch.variants)
      .flatMap((variant) => variant.lines)
      .filter((line) => line.type === "say")
      .map((line) => line.text)
      .join("\n");
    expect(spokenText).toContain("Our Company Name is BMH Group");
    expect(spokenText).toContain("Our website is bmhgroupkc.com");
    expect(spokenText).not.toContain("Fast Cash Offer Now");
    expect(spokenText).not.toContain("fastcashoffernow.com");
  });

  it("locks every displayed phase purpose to the official document", () => {
    expect((scriptJson as unknown as ClosrScript).phases.map(({ id, purpose }) => ({ id, purpose }))).toEqual([
      { id: "introduction", purpose: "Build Minor Rapport - Break The Cycle of Traditional Sales Calls - Set Proper Expectations - Instill Scarcity… Can they qualify?" },
      { id: "reveal", purpose: "Make them FEEL their pain" },
      { id: "assessment", purpose: "Avoid “How Can You Buy My House Over The Phone?” Objection. Makes them feel like you are the real deal." },
      { id: "secure_positioning", purpose: "Avoid all smokescreens and objections after the offer by prehandling them upfront, and get the seller to confirm they want to move forward with our process before we present price." },
      { id: "offer", purpose: "Make the seller feel like they’ve qualified for our program — reinforcing that they need us, not the other way around. Step 1 is complete, and now it’s only about finalizing the minor details." },
      { id: "close", purpose: "Price is only an objection in the absence of value… how does our offer solve their problem?" },
    ]);
  });

  it("rejects a non-object root", () => {
    expect(() => assertValidClosrScript(null)).toThrow(/root is not an object/);
    expect(() => assertValidClosrScript("nope")).toThrow(/root is not an object/);
  });

  it("rejects a script missing phases", () => {
    const script = validScript();
    delete script.phases;
    expect(() => assertValidClosrScript(script)).toThrow(/missing phases/);
  });

  it("rejects a phase missing display.branches", () => {
    const script = validScript();
    delete (script.phases as Record<string, unknown>[])[0].display;
    expect(() => assertValidClosrScript(script)).toThrow(/missing display\.branches/);
  });

  it("rejects a branch with zero variants", () => {
    const script = validScript();
    const branches = (script.phases as { display: { branches: Record<string, unknown>[] } }[])[0].display.branches;
    branches[0].variants = [];
    expect(() => assertValidClosrScript(script)).toThrow(/malformed branch/);
  });

  it("rejects a variant line with an invalid type", () => {
    const script = validScript();
    const phases = script.phases as { display: { branches: { variants: { lines: Record<string, unknown>[] }[] }[] } }[];
    phases[0].display.branches[0].variants[0].lines[0].type = "sing";
    expect(() => assertValidClosrScript(script)).toThrow(/malformed line/);
  });

  it("rejects missing and duplicate stable authored-line ids", () => {
    const missing = validScript();
    const missingLines = (missing.phases as { display: { branches: { variants: { lines: Record<string, unknown>[] }[] }[] } }[])[0]
      .display.branches[0].variants[0].lines;
    delete missingLines[0].id;
    expect(() => assertValidClosrScript(missing)).toThrow(/malformed line/);

    const duplicate = validScript();
    const variants = (duplicate.phases as { display: { branches: { variants: { lines: Record<string, unknown>[] }[] }[] } }[])[0]
      .display.branches[0].variants;
    variants[1].lines[0].id = variants[0].lines[0].id;
    expect(() => assertValidClosrScript(duplicate)).toThrow(/duplicate line id/);
  });

  it("locks the approved authored line text while ids and grouping evolve independently", () => {
    const text = (scriptJson as unknown as ClosrScript).phases
      .flatMap((phase) => phase.display.branches)
      .flatMap((branch) => branch.variants)
      .flatMap((variant) => variant.lines)
      .map((line) => line.text)
      .join("\u0000");
    expect(createHash("sha256").update(text).digest("hex")).toBe(
      "892ada1497695a760e96463d41417cb0def8872b644a0f2c88015fa66aeb5293",
    );
  });

  it("keeps exactly one seller email-address request, in the underwriting readiness section only", () => {
    const script = scriptJson as unknown as ClosrScript;
    const spokenEmailRequests = script.phases.flatMap((phase) =>
      phase.display.branches.flatMap((branch) =>
        branch.variants.flatMap((variant) =>
          variant.lines
            .filter((line) => isSellerEmailRequest(line.text))
            .map((line) => ({ phaseId: phase.id, branchTag: branch.tag, line })),
        ),
      ),
    );

    expect(spokenEmailRequests).toHaveLength(1);
    expect(spokenEmailRequests[0]).toMatchObject({
      phaseId: "secure_positioning",
      branchTag: "Back from hold — final questions",
      line: {
        id: "secure_positioning.back-from-hold-final-questions.default.08",
        type: "say",
        text: SELLER_EMAIL_REQUEST,
      },
    });

    const sectionsWithRequest = sectionsJson.sections.filter((section) =>
      section.content.some((content) =>
        content.variants.some((variant) => variant.line_ids.includes(spokenEmailRequests[0]!.line.id)),
      ),
    );
    expect(sectionsWithRequest).toEqual([
      expect.objectContaining({
        id: "secure_positioning.final-commitment",
        phase_id: "secure_positioning",
        title: "Confirm readiness and email",
      }),
    ]);

    const goodNews = script.phases.find((phase) => phase.id === "offer")?.display.branches.find((branch) => branch.tag === "Good news");
    const sellerAccepts = script.phases.find((phase) => phase.id === "close")?.display.branches.find((branch) => branch.tag === "They accept");
    const proofOfFunds = script.objections.find((objection) => objection.id === "proof_of_funds");
    const introductionCopy = script.phases.find((phase) => phase.id === "introduction")!.display.branches.flatMap((branch) =>
        branch.variants.flatMap((variant) => variant.lines.map((line) => line.text)),
      );
    const goodNewsCopy = goodNews!.variants.flatMap((variant) => variant.lines.map((line) => line.text));
    const sellerAcceptsCopy = sellerAccepts!.variants.flatMap((variant) => variant.lines.map((line) => line.text));
    const proofOfFundsCopy = [
      proofOfFunds!.display.acknowledge,
      proofOfFunds!.display.disarm,
      proofOfFunds!.display.overcome,
    ];
    expect(introductionCopy.filter(isSellerEmailRequest), "Introduction must contain no seller email request").toEqual([]);
    expect(goodNewsCopy.filter(isSellerEmailRequest), "Good News must contain no seller email request").toEqual([]);
    expect(sellerAcceptsCopy.filter(isSellerEmailRequest), "They accept must contain no seller email request").toEqual([]);
    expect(proofOfFundsCopy.filter(isSellerEmailRequest), "Proof of Funds must contain no seller email request").toEqual([]);
  });

  it.each([
    "What's your email?",
    "What is the best email address for you?",
    "Which email should we use?",
    "Can I get your email address?",
    "Could we have the email address you use?",
    "What is your e\u200bmail address?",
  ])("recognizes seller email-address request wording %j", (wording) => {
    expect(isSellerEmailRequest(wording)).toBe(true);
  });

  it("keeps prohibited e-sign walkthrough semantics out of every script and section-manifest string", () => {
    const normalizedStrings = [...collectAllStrings(scriptJson), ...collectAllStrings(sectionsJson)]
      .map(normalizeForAcceptanceScan);
    for (const phrase of FORBIDDEN_ESIGN_PHRASES) {
      expect(
        normalizedStrings.some((value) => value.includes(phrase)),
        `forbidden e-sign phrase "${phrase}" found in the script or section manifest`,
      ).toBe(false);
    }
  });

  it.each([
    "click.the/link",
    "walk—you_through/signing",
    "share your screen",
    "share/screen",
    "screen-share",
    "view_documents",
    "press/sign",
    "adopt & sign",
    "cl\u200bick the li\u2060nk",
    "walk you through sign\u200ding",
    "screen\u200bshare",
    "view docu\u2060ments",
  ])("normalizes prohibited walkthrough evasion %j into a rejected phrase", (wording) => {
    const normalized = normalizeForAcceptanceScan(wording);
    expect(FORBIDDEN_ESIGN_PHRASES.some((phrase) => normalized.includes(phrase))).toBe(true);
  });

  it("uses the exact replacement handoff once, at the final Close handoff line", () => {
    const script = scriptJson as unknown as ClosrScript;
    const replacementMatches = script.phases.flatMap((phase) =>
      phase.display.branches.flatMap((branch) =>
        branch.variants.flatMap((variant) =>
          variant.lines
            .filter((line) => line.type === "say" && line.text === ESIGN_HANDOFF)
            .map((line) => ({ phaseId: phase.id, branchTag: branch.tag, line })),
        ),
      ),
    );
    expect(replacementMatches).toEqual([
      expect.objectContaining({
        phaseId: "close",
        branchTag: "Going over the contract",
        line: expect.objectContaining({ id: "close.going-over-the-contract.default.03" }),
      }),
    ]);
  });

  it("rejects a phase missing match.entry_landmarks/advance_landmarks", () => {
    const script = validScript();
    delete (script.phases as Record<string, unknown>[])[0].match;
    expect(() => assertValidClosrScript(script)).toThrow(/missing match/);
  });

  it("rejects a coach_note missing text", () => {
    const script = validScript();
    const notes = (script.phases as { coach_notes: Record<string, unknown>[] }[])[0].coach_notes;
    delete notes[0].text;
    expect(() => assertValidClosrScript(script)).toThrow(/malformed coach_note/);
  });

  it("rejects a script missing objections", () => {
    const script = validScript();
    delete script.objections;
    expect(() => assertValidClosrScript(script)).toThrow(/missing objections/);
  });

  it("rejects an objection missing match.triggers", () => {
    const script = validScript();
    delete (script.objections as Record<string, unknown>[])[0].match;
    expect(() => assertValidClosrScript(script)).toThrow(/missing match\.triggers/);
  });

  it("rejects an objection missing display.overcome", () => {
    const script = validScript();
    const objection = (script.objections as { display: Record<string, unknown> }[])[0];
    delete objection.display.overcome;
    expect(() => assertValidClosrScript(script)).toThrow(/missing\/malformed display fields/);
  });

  it("rejects a script line referencing an unknown {token} placeholder", () => {
    const script = validScript();
    const phases = script.phases as { display: { branches: { variants: { lines: Record<string, unknown>[] }[] }[] } }[];
    phases[0].display.branches[0].variants[0].lines[0].text = "Something about {made_up_token} here.";
    expect(() => assertValidClosrScript(script)).toThrow(/unknown placeholder/);
  });

  it("rejects the exact {year built} (a space, not an underscore) shape — round-3's \\w+ pattern missed this entirely", () => {
    const script = validScript();
    const phases = script.phases as { display: { branches: { variants: { lines: Record<string, unknown>[] }[] }[] } }[];
    phases[0].display.branches[0].variants[0].lines[0].text = "Looks like the {year built}'s still.";
    expect(() => assertValidClosrScript(script)).toThrow(/unknown placeholder/);
  });

  it("tolerates {{tone:...}} markup — never mistaken for an unknown {token} placeholder", () => {
    const script = validScript();
    const phases = script.phases as { display: { branches: { variants: { lines: Record<string, unknown>[] }[] }[] } }[];
    phases[0].display.branches[0].variants[0].lines[0].text = "Say this {{tone:warm tone}} then continue.";
    expect(() => assertValidClosrScript(script)).not.toThrow();
  });

  it("rejects double-brace token bypasses plus empty and unmatched braces", () => {
    for (const text of ["Hello {{seller_name}}.", "Hello {}.", "Hello {seller_name.", "Hello seller_name}."]) {
      const script = validScript();
      const phases = script.phases as { display: { branches: { variants: { lines: Record<string, unknown>[] }[] }[] } }[];
      phases[0].display.branches[0].variants[0].lines[0].text = text;
      expect(() => assertValidClosrScript(script), text).toThrow(/brace|placeholder/i);
    }
  });

  it("rejects an unknown placeholder inside an objection's display.overcome", () => {
    const script = validScript();
    const objection = (script.objections as { display: Record<string, unknown> }[])[0];
    objection.display.overcome = "We can close by {made_up_token}.";
    expect(() => assertValidClosrScript(script)).toThrow(/unknown placeholder/);
  });

  it("rejects an unknown placeholder inside an objection's overcome_by_occupancy value", () => {
    const script = validScript();
    const objection = (script.objections as { id: string; display: Record<string, unknown> }[]).find(
      (o) => o.id === "not_in_rush",
    )!;
    (objection.display.overcome_by_occupancy as Record<string, string>).owner_occupied = "About {made_up_token}.";
    expect(() => assertValidClosrScript(script)).toThrow(/unknown placeholder/);
  });

  it("rejects overcome_by_occupancy with an unrecognized occupancy key", () => {
    const script = validScript();
    const objection = (script.objections as { id: string; display: Record<string, unknown> }[]).find(
      (o) => o.id === "not_in_rush",
    )!;
    (objection.display.overcome_by_occupancy as Record<string, string>).renting = "some text";
    expect(() => assertValidClosrScript(script)).toThrow(/overcome_by_occupancy has a malformed entry/);
  });

  it("rejects an entry_landmark with an invalid speaker — the exact shape that used to slip past a bare Array.isArray check", () => {
    const script = validScript();
    const phases = script.phases as { id: string; match: { entry_landmarks: Record<string, unknown>[] } }[];
    const reveal = phases.find((p) => p.id === "reveal")!;
    reveal.match.entry_landmarks[0].speaker = "narrator";
    expect(() => assertValidClosrScript(script)).toThrow(/match\.entry_landmarks\[0\] is malformed/);
  });

  it("rejects a gate missing clear_on.phrases — the exact shape a v0 gates[] was never checked for", () => {
    const script = validScript();
    const phases = script.phases as { id: string; match: { gates: { clear_on: Record<string, unknown> }[] } }[];
    const securePositioning = phases.find((p) => p.id === "secure_positioning")!;
    delete securePositioning.match.gates[0].clear_on.phrases;
    expect(() => assertValidClosrScript(script)).toThrow(/match\.gates\[0\] is malformed/);
  });

  it("rejects a counter with a non-numeric goal", () => {
    const script = validScript();
    const phases = script.phases as { id: string; match: { counters: Record<string, unknown>[] } }[];
    const reveal = phases.find((p) => p.id === "reveal")!;
    reveal.match.counters[0].goal = "seven";
    expect(() => assertValidClosrScript(script)).toThrow(/match\.counters\[0\] is malformed/);
  });

  it("rejects a timer missing duration_s", () => {
    const script = validScript();
    const phases = script.phases as { id: string; match: { timers: Record<string, unknown>[] } }[];
    const securePositioning = phases.find((p) => p.id === "secure_positioning")!;
    delete securePositioning.match.timers[0].duration_s;
    expect(() => assertValidClosrScript(script)).toThrow(/match\.timers\[0\] is malformed/);
  });

  it("rejects pain_words that aren't a string array", () => {
    const script = validScript();
    const phases = script.phases as { id: string; match: Record<string, unknown> }[];
    const reveal = phases.find((p) => p.id === "reveal")!;
    reveal.match.pain_words = "not an array";
    expect(() => assertValidClosrScript(script)).toThrow(/match\.pain_words is not a string\[\]/);
  });

  describe("consumer contract — the app's actual assumptions about the script, not just its own internal shape", () => {
    it("rejects tokens[] declaring a token COACH_TOKENS doesn't support", () => {
      const script = validScript();
      (script.tokens as string[]).push("made_up_token");
      expect(() => assertValidClosrScript(script)).toThrow(/doesn't support/);
    });

    it("rejects a script missing the introduction phase — the app's default starting phase", () => {
      const script = validScript();
      script.phases = (script.phases as { id: string }[]).filter((p) => p.id !== "introduction");
      expect(() => assertValidClosrScript(script)).toThrow(/missing required phase 'introduction'/);
    });

    it("rejects duplicate phase ids", () => {
      const script = validScript();
      const phases = script.phases as { id: string }[];
      phases[1].id = phases[0].id;
      expect(() => assertValidClosrScript(script)).toThrow(/duplicate phase id/);
    });

    it("rejects reordered or extra phases so producer and client start/progress through the exact same contract", () => {
      const reordered = validScript();
      const reorderedPhases = reordered.phases as Record<string, unknown>[];
      [reorderedPhases[0], reorderedPhases[1]] = [reorderedPhases[1], reorderedPhases[0]];
      expect(() => assertValidClosrScript(reordered)).toThrow(/exactly match COACH_PHASE_ORDER/);

      const extra = validScript();
      (extra.phases as Record<string, unknown>[]).push({
        ...(extra.phases as Record<string, unknown>[])[0],
        id: "bonus_phase",
      });
      expect(() => assertValidClosrScript(extra)).toThrow(/exactly match COACH_PHASE_ORDER/);
    });

    it("rejects duplicate branch tags and duplicate variant keys", () => {
      const duplicateTag = validScript();
      const tagBranches = (duplicateTag.phases as { display: { branches: Record<string, unknown>[] } }[])[0].display.branches;
      tagBranches.push(JSON.parse(JSON.stringify(tagBranches[0])));
      expect(() => assertValidClosrScript(duplicateTag)).toThrow(/duplicate branch tag/);

      const duplicateVariant = validScript();
      const variants = (duplicateVariant.phases as { display: { branches: { variants: Record<string, unknown>[] }[] } }[])[0].display.branches[0].variants;
      variants.push(JSON.parse(JSON.stringify(variants[0])));
      expect(() => assertValidClosrScript(duplicateVariant)).toThrow(/duplicate variant key/);
    });

    it("rejects a phase's match.exit_to pointing at a phase id that doesn't exist", () => {
      const script = validScript();
      const phases = script.phases as { id: string; match: { exit_to: string | null } }[];
      phases.find((p) => p.id === "introduction")!.match.exit_to = "phase_that_does_not_exist";
      expect(() => assertValidClosrScript(script)).toThrow(/exit_to references nonexistent phase/);
    });

    it("rejects a non-string, non-null variant label", () => {
      const script = validScript();
      const phases = script.phases as { display: { branches: { variants: Record<string, unknown>[] }[] } }[];
      phases[0].display.branches[0].variants[0].label = 42;
      expect(() => assertValidClosrScript(script)).toThrow(/non-string, non-null label/);
    });
  });
});
