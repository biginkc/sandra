import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { closrOutbound123Bundle, closrOutbound123Ref } from "@biginkc/coach/fixtures";
import { buildCoachSectionScriptBlock, buildPhaseScriptBlock, getScriptObjection, resolveCursorLine, resolveObjectionOvercome, resolveCoachTokens } from "@biginkc/coach";
import { createCoachReducer, initialCoachState } from "./event-reducer";

const context = { sellerName: "Jane Homeowner", propertyAddress: "123 Main St", propertyCounty: "Jackson", repName: "Alex Rep", repPhoneE164: "+18165551234", motivation: "Job relocation", leadId: "abcd1234-ef56-7890-abcd-ef1234567890", sellerPhoneE164: "+18165559876", coldCallerName: "Rose", yearBuilt: "1987", leadSource: "cold_call", occupancy: "vacant" as const };
const tokens = resolveCoachTokens(closrOutbound123Bundle.script.tokens, context);

describe("runtime bundle golden parity — legacy scenarios A–G", () => {
  it("A: resolves the cold-call opener", () => expect(buildPhaseScriptBlock(closrOutbound123Bundle, "introduction", tokens, { leadSource: "cold_call", occupancy: null })?.branches[0]?.selected.key).toBe("cold_call"));
  it("B: resolves the vacant reveal path", () => expect(buildPhaseScriptBlock(closrOutbound123Bundle, "reveal", tokens, { leadSource: null, occupancy: "vacant" })?.branches.find((b) => b.tag === "Entry")?.selected.key).toBe("vacant"));
  it("C: preserves the price-too-low manual section", () => expect(buildCoachSectionScriptBlock(closrOutbound123Bundle, "offer.outcome-tracks", tokens, { leadSource: null, occupancy: null }, {}, "Price too low")?.selectedBranchTag).toBe("Price too low"));
  it("D: preserves the authored hold", () => expect(buildCoachSectionScriptBlock(closrOutbound123Bundle, "secure_positioning.final-concerns-and-hold", tokens)?.branches[0]?.holdAfter).toBe("3 Minute Hold - WRITE CONTRACT"));
  it("E: resolves a cursor against this exact bundle", () => {
    const block = buildPhaseScriptBlock(closrOutbound123Bundle, "introduction", tokens)!;
    expect(resolveCursorLine(closrOutbound123Bundle, { phaseId: "introduction", branchTag: "Frame the call", variantKey: "default", lineIndex: 0, lineText: "To add some sort of value to the property so we can resell it on the market or", scriptVersion: closrOutbound123Bundle.script.version }, block, {}, tokens)?.type).toBe("say");
  });
  it("F: finds the existing objection response", () => expect(resolveObjectionOvercome(getScriptObjection(closrOutbound123Bundle, "not_in_rush")!, "vacant")).toContain("collecting dust"));
  it("G: rejects a mismatched cursor version", () => {
    const reduce = createCoachReducer(closrOutbound123Bundle);
    const next = reduce(initialCoachState(), { type: "cursor", phaseId: "introduction", branchTag: "Opener", variantKey: "cold_call", lineIndex: 0, lineText: "x", scriptVersion: "wrong", matcherVersion: "3", ts: "t" });
    expect(next.cursor).toBeNull(); expect(closrOutbound123Ref.slug).toBe("closr-outbound");
  });
});

function sourceFiles(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? sourceFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]); }
describe("script source ownership", () => {
  const src = path.resolve(__dirname, "../..");
  it("forbids checked-in CLOSR JSON copies", () => expect(sourceFiles(src).filter((file) => /closr-(script|sections).*\.json$/i.test(file))).toEqual([]));
  it("allows package fixtures only in tests", () => {
    const offenders = sourceFiles(src).filter((file) => !/\.test\.[cm]?[jt]sx?$/.test(file) && readFileSync(file, "utf8").includes("@biginkc/coach/fixtures"));
    expect(offenders).toEqual([]);
  });
});
