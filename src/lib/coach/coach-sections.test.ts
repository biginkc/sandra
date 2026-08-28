import { describe, expect, it } from "vitest";

import manifestJson from "./closr-sections-v1.json";
import scriptJson from "./closr-script-v0.json";
import {
  COACH_SECTIONS,
  FIRST_COACH_SECTION_ID,
  getCoachSectionById,
  getFirstCoachSectionIdForPhase,
  getNextCoachSectionId,
  getPreviousCoachSectionId,
} from "./coach-sections";
import {
  assertValidCoachSectionManifest,
  assertValidClosrScript,
  type ClosrScript,
} from "./script-schema";

assertValidClosrScript(scriptJson);
const script: ClosrScript = scriptJson;

function validManifest(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(manifestJson));
}

describe("coach section manifest", () => {
  it("accepts the real PDF-aligned manifest with complete, single-reference authored-line coverage", () => {
    expect(() => assertValidCoachSectionManifest(manifestJson, script)).not.toThrow();
    expect(COACH_SECTIONS).toHaveLength(26);
  });

  it("rejects script-version drift", () => {
    const manifest = validManifest();
    manifest.script_version = "different-script";
    expect(() => assertValidCoachSectionManifest(manifest, script)).toThrow(/does not match/);
  });

  it("rejects duplicate section ids and line references", () => {
    const duplicateSection = validManifest();
    const duplicateSections = duplicateSection.sections as { id: string }[];
    duplicateSections[1].id = duplicateSections[0].id;
    expect(() => assertValidCoachSectionManifest(duplicateSection, script)).toThrow(/duplicate section id/);

    const duplicateLine = validManifest();
    const sections = duplicateLine.sections as { content: { variants: { line_ids: string[] }[] }[] }[];
    sections[0].content[0].variants[0].line_ids.push(sections[0].content[0].variants[0].line_ids[0]);
    expect(() => assertValidCoachSectionManifest(duplicateLine, script)).toThrow(/referenced more than once/);
  });

  it("rejects unknown, misplaced, and uncovered authored-line references", () => {
    const unknown = validManifest();
    const unknownSections = unknown.sections as { content: { variants: { line_ids: string[] }[] }[] }[];
    unknownSections[0].content[0].variants[0].line_ids[0] = "not.a.real.line";
    expect(() => assertValidCoachSectionManifest(unknown, script)).toThrow(/unknown line/);

    const misplaced = validManifest();
    const misplacedSections = misplaced.sections as { content: { variants: { line_ids: string[] }[] }[] }[];
    misplacedSections[0].content[0].variants[0].line_ids[0] = "introduction.frame-the-call.default.01";
    expect(() => assertValidCoachSectionManifest(misplaced, script)).toThrow(/wrong phase, branch, or variant/);

    const uncovered = validManifest();
    const uncoveredSections = uncovered.sections as { content: { variants: { line_ids: string[] }[] }[] }[];
    uncoveredSections[0].content[0].variants[1].line_ids.pop();
    expect(() => assertValidCoachSectionManifest(uncovered, script)).toThrow(/coverage is incomplete/);
  });

  it("keeps conditional paths inside their conversational section", () => {
    expect(getCoachSectionById("introduction.opener")?.content[0].variants).toHaveLength(5);
    expect(getCoachSectionById("offer.outcome-tracks")?.content.map((item) => item.branch_tag)).toEqual([
      "Good news",
      "Bad news",
      "Bad news — below mortgage",
      "Price too low",
    ]);
    expect(getCoachSectionById("close.decision-tracks")?.content.map((item) => item.branch_tag)).toEqual([
      "If far apart — program pivot",
      "They accept",
    ]);
  });

  it("rejects a conditional branch split across manual sections", () => {
    const manifest = validManifest();
    const sections = manifest.sections as {
      content: { branch_tag: string; variants: { variant_key: string; line_ids: string[] }[] }[];
    }[];
    sections[0].content[0].variants.pop();

    expect(() => assertValidCoachSectionManifest(manifest, script)).toThrow(/keep every variant/);
  });

  it("rejects same-phase sections that are out of conversational order", () => {
    const manifest = validManifest();
    const sections = manifest.sections as unknown[];
    [sections[1], sections[2]] = [sections[2], sections[1]];

    expect(() => assertValidCoachSectionManifest(manifest, script)).toThrow(/not ordered by authored script content/);
  });

  it("rejects duplicate branch panels inside one section", () => {
    const manifest = validManifest();
    const sections = manifest.sections as { content: unknown[] }[];
    sections[0].content.push(JSON.parse(JSON.stringify(sections[0].content[0])));

    expect(() => assertValidCoachSectionManifest(manifest, script)).toThrow(/repeats branch/);
  });

  it("requires spoken content in every selectable variant", () => {
    const manifest = validManifest();
    const sections = manifest.sections as {
      content: { variants: { variant_key: string; line_ids: string[] }[] }[];
    }[];
    const openerVariant = sections[0].content[0].variants[0];
    expect(openerVariant.variant_key).toBe("default");
    const scriptWithNoteOnlyVariant = JSON.parse(JSON.stringify(script)) as ClosrScript;
    const noteOnlyLine = scriptWithNoteOnlyVariant.phases
      .flatMap((phase) => phase.display.branches)
      .flatMap((branch) => branch.variants)
      .flatMap((variant) => variant.lines)
      .find((line) => line.id === "introduction.opener.default.01");
    if (!noteOnlyLine) throw new Error("test fixture line missing");
    noteOnlyLine.type = "note";

    expect(() => assertValidCoachSectionManifest(manifest, scriptWithNoteOnlyVariant)).toThrow(/has no spoken line/);
  });

  it("locks the intentional ordered section map", () => {
    expect(COACH_SECTIONS.map((section) => section.id)).toEqual([
      "introduction.opener",
      "introduction.qualification-frame",
      "introduction.how-we-work",
      "introduction.call-outcomes",
      "introduction.decision-position",
      "introduction.contact-details",
      "reveal.situation-rundown",
      "reveal.probe-options",
      "reveal.motivation",
      "assessment.outside",
      "assessment.inside",
      "secure_positioning.remaining-questions",
      "secure_positioning.deadline-and-decision-makers",
      "secure_positioning.net-and-mortgage",
      "secure_positioning.anchor",
      "secure_positioning.no-concerns-gate",
      "secure_positioning.first-underwriting-hold",
      "secure_positioning.final-property-questions",
      "secure_positioning.final-commitment",
      "secure_positioning.explain-agreement",
      "secure_positioning.explain-walkthroughs",
      "secure_positioning.final-concerns-and-hold",
      "offer.outcome-tracks",
      "close.decision-tracks",
      "close.contract-confirmation",
      "close.esign-and-wrap",
    ]);
  });
});

describe("manual section navigation API", () => {
  it("moves only through the ordered manifest and stops at both ends", () => {
    expect(FIRST_COACH_SECTION_ID).toBe("introduction.opener");
    expect(getPreviousCoachSectionId(FIRST_COACH_SECTION_ID)).toBeNull();
    expect(getNextCoachSectionId(FIRST_COACH_SECTION_ID)).toBe("introduction.qualification-frame");
    expect(getNextCoachSectionId(COACH_SECTIONS.at(-1)!.id)).toBeNull();
    expect(getPreviousCoachSectionId("unknown")).toBeNull();
    expect(getNextCoachSectionId("unknown")).toBeNull();
  });

  it("selects the first manual section for every script phase", () => {
    expect(getFirstCoachSectionIdForPhase("introduction")).toBe("introduction.opener");
    expect(getFirstCoachSectionIdForPhase("reveal")).toBe("reveal.situation-rundown");
    expect(getFirstCoachSectionIdForPhase("assessment")).toBe("assessment.outside");
    expect(getFirstCoachSectionIdForPhase("secure_positioning")).toBe("secure_positioning.remaining-questions");
    expect(getFirstCoachSectionIdForPhase("offer")).toBe("offer.outcome-tracks");
    expect(getFirstCoachSectionIdForPhase("close")).toBe("close.decision-tracks");
  });
});
