import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  getCoachSections,
  getScriptObjection, getScriptPhase, nextPhaseId, resolveCoachTokens,
  resolveCursorLine, resolveCursorNextLine, resolveObjectionOvercome,
  splitDisplaySentences,
} from "@biginkc/coach";
import type { CoachCallContext } from "@biginkc/coach";
import { closrOutbound123Bundle } from "@biginkc/coach/fixtures";
import { buildCoachSectionScriptBlock, buildPhaseScriptBlock } from "./script-block";

const LEAD: Array<CoachCallContext["leadSource"]> = [null, "cold_call", "fsbo", "sms", "d4d", "other"];
const OCC: Array<CoachCallContext["occupancy"]> = [null, "unknown", "owner_occupied", "tenant_occupied", "vacant"];
const ENTRY_TOKENS = ["motivation", "dream_outcome", "cold_caller_name", "closing_date", "offer_price", "net_to_seller"];
const EF_EMPTY = Object.fromEntries(ENTRY_TOKENS.map((token) => [token, null]));
const EF_FULL = Object.fromEntries(ENTRY_TOKENS.map((token) => [token, `M-${token}`]));
const CTX_NULL = { sellerName: null, propertyAddress: null, propertyCounty: null, repName: null, repPhoneE164: null, motivation: null, leadId: null, sellerPhoneE164: null, coldCallerName: null, yearBuilt: null, leadSource: null, occupancy: null };
const CTX_FULL = { sellerName: "Jane Homeowner", propertyAddress: "123 Main St", propertyCounty: "Jackson", repName: "Alex Rep", authenticatedRepName: "Alex Rep", repPhoneE164: "+18165551234", motivation: "Job relocation", leadId: "abcd1234-ef56-7890-abcd-ef1234567890", sellerPhoneE164: "+18165559876", coldCallerName: "Rose", yearBuilt: "1987", leadSource: null, occupancy: null };

function lineText(line: { segments?: Array<{ kind: string; value?: string; token?: string; label?: string }> }): string {
  return (line.segments ?? []).map((segment) => segment.kind === "text" ? segment.value : segment.kind === "token" ? `{${segment.token}}` : `[${segment.label ?? ""}]`).join("");
}

function enumerateRuntime() {
  const phases = closrOutbound123Bundle.script.phases.map((phase) => phase.id);
  const sections = getCoachSections(closrOutbound123Bundle);
  const out: Record<string, unknown> = { version: closrOutbound123Bundle.script.version, phases, sections, objections: {}, next: {}, scriptPhases: {}, tokens: {}, sectionBlocks: {}, phaseBlocks: {}, overrides: {}, cursors: {}, sentences: {} };
  const objections = out.objections as Record<string, unknown>;
  const next = out.next as Record<string, unknown>;
  const scriptPhases = out.scriptPhases as Record<string, unknown>;
  const tokenOutput = out.tokens as Record<string, unknown>;
  const sectionBlocks = out.sectionBlocks as Record<string, unknown>;
  const phaseBlocks = out.phaseBlocks as Record<string, unknown>;
  const overrides = out.overrides as Record<string, unknown>;
  const cursors = out.cursors as Record<string, unknown>;
  const sentences = out.sentences as Record<string, unknown>;

  for (const id of closrOutbound123Bundle.script.objections.map((objection) => objection.id)) {
    const objection = getScriptObjection(closrOutbound123Bundle, id);
    objections[id] = { raw: objection, overcome: Object.fromEntries(OCC.map((occupancy) => [String(occupancy), objection ? resolveObjectionOvercome(objection, occupancy) : null])) };
  }
  for (const phase of phases) { next[phase] = nextPhaseId(closrOutbound123Bundle, phase); scriptPhases[phase] = getScriptPhase(closrOutbound123Bundle, phase); }

  const contexts = ["null", "full"].flatMap((base) => LEAD.flatMap((leadSource) => OCC.map((occupancy) => ({ key: `${base}|${leadSource}|${occupancy}`, context: { ...(base === "null" ? CTX_NULL : CTX_FULL), leadSource, occupancy } }))));
  for (const { key, context } of contexts) for (const [entryKey, entryFields] of [["empty", EF_EMPTY], ["full", EF_FULL]] as const) {
    const tokens = resolveCoachTokens(closrOutbound123Bundle.script.tokens, context, entryFields);
    const select = { leadSource: context.leadSource, occupancy: context.occupancy };
    tokenOutput[`${key}|${entryKey}`] = tokens;
    for (const section of sections) {
      sectionBlocks[`${section.id}|${key}|${entryKey}`] = buildCoachSectionScriptBlock(closrOutbound123Bundle, section.id, tokens, select, {}, null);
      if (section.content.length > 1) for (const content of section.content) sectionBlocks[`${section.id}|${key}|${entryKey}|sel=${content.branch_tag}`] = buildCoachSectionScriptBlock(closrOutbound123Bundle, section.id, tokens, select, {}, content.branch_tag);
    }
    for (const phase of phases) phaseBlocks[`${phase}|${key}|${entryKey}`] = buildPhaseScriptBlock(closrOutbound123Bundle, phase, tokens, select, {});
  }
  const subset = contexts.filter(({ key }) => key.startsWith("full|") && ["null", "cold_call", "sms"].includes(key.split("|")[1]!) && ["null", "vacant", "owner_occupied"].includes(key.split("|")[2]!));
  for (const { key, context } of subset) {
    const tokens = resolveCoachTokens(closrOutbound123Bundle.script.tokens, context, EF_FULL); const select = { leadSource: context.leadSource, occupancy: context.occupancy };
    for (const phase of phases) {
      const raw = getScriptPhase(closrOutbound123Bundle, phase); if (!raw) continue;
      for (const branch of raw.display.branches) for (const variant of branch.variants) {
        const override = { [branch.tag]: variant.key };
        overrides[`phase|${phase}|${key}|${branch.tag}=${variant.key}`] = buildPhaseScriptBlock(closrOutbound123Bundle, phase, tokens, select, override);
        for (const section of sections.filter((item) => item.phaseId === phase)) overrides[`section|${section.id}|${key}|${branch.tag}=${variant.key}`] = buildCoachSectionScriptBlock(closrOutbound123Bundle, section.id, tokens, select, override, null);
      }
      const block = buildPhaseScriptBlock(closrOutbound123Bundle, phase, tokens, select, {}); if (!block) continue;
      for (const branch of block.branches) for (let index = 0; index < 5; index += 1) {
        const actual = branch.selected.lines[index] ? lineText(branch.selected.lines[index]) : "";
        for (const [textKey, text] of [["actual", actual], ["mismatch", "MISMATCH"], ["empty", ""]] as const) {
          const cursor = { phaseId: phase, branchTag: branch.tag, variantKey: branch.selected.key, lineIndex: index, lineText: text, scriptVersion: closrOutbound123Bundle.script.version };
          cursors[`${phase}|${key}|${branch.tag}|${branch.selected.key}|${index}|${textKey}`] = { line: resolveCursorLine(closrOutbound123Bundle, cursor, block, {}, tokens), next: resolveCursorNextLine(closrOutbound123Bundle, cursor, block, {}, tokens) };
        }
      }
    }
  }
  for (const section of sections) {
    const block = buildCoachSectionScriptBlock(closrOutbound123Bundle, section.id, resolveCoachTokens(closrOutbound123Bundle.script.tokens, CTX_FULL, EF_FULL), { leadSource: null, occupancy: null }, {}, null);
    if (!block) continue;
    for (const branch of block.branches) sentences[`${section.id}|${branch.tag}`] = (branch.selected.lines ?? []).map((line) => splitDisplaySentences(line));
  }
  return out;
}

describe("coach runtime parity", () => {
  it("enumerates the bound bundle identically to the pre-refactor runtime", () => {
    const canonicalJson = JSON.stringify(enumerateRuntime(), null, 1);
    expect(createHash("sha256").update(canonicalJson).digest("hex")).toBe("8280d028a995e1886e18b4684f31550ff1eaa4cac9184d7cd56a806a85317cd1");
  });
});
