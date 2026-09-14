import { describe, expect, it } from "vitest";
import baseline from "../../../e2e/synthetic/fixtures/precall-approved/script.json";
import manifest from "../../../e2e/synthetic/fixtures/precall-approved/sections.json";
import { precallProfiles } from "../../../e2e/synthetic/fixtures/precall-profiles";
import { buildCoachSectionScriptBlock } from "./script-block";
import { resolveCoachTokens } from "./token-resolver";
import { setupValues } from "./precall-setup";

const dimensions = [
  ["cold_call", "fsbo", "sms", "d4d"],
  ["unknown", "owner_occupied", "tenant_occupied", "vacant"],
  ["homeowner", "investor", "vacant"],
  ["clear_no_urgency", "clear_with_urgency", "no_clear_motivation"],
  ["Good news", "Bad news", "Bad news — below mortgage", "Price too low"],
  ["If far apart — program pivot", "They accept"],
];
const keys = [
  "Opener",
  "Entry",
  "Example probes — goal 7+",
  "Motivation",
  "offer.outcome-tracks",
  "close.decision-tracks",
];
function verify(profile: number, choices: string[]) {
  const { context } = precallProfiles[profile];
  const edits = {
    dream_outcome: "buy a smaller home",
    offer_price: "$125,000",
    net_to_seller: "$95,000",
    closing_date: "October 15",
  };
  const tokens = resolveCoachTokens(
    context,
    undefined,
    setupValues(context, edits),
  );
  const name = context.authenticatedRepName?.split(/\s+/);
  const expectedTokens: Record<string, string> = {
    seller_name: context.sellerName?.trim().split(/\s+/)[0] || "—",
    rep_name: context.repName || "—",
    property_address: context.propertyAddress || "—",
    rep_phone: context.repPhoneE164 || "—",
    cold_caller_name: "Mel",
    year_built: context.yearBuilt || "—",
    motivation: context.motivation || "—",
    ...edits,
    file_number:
      name && name.length >= 2 && context.leadId
        ? `${name[0][0]}${name.at(-1)![0]}-${context.leadId.slice(-6)}`
        : "—",
  };
  const selected = Object.fromEntries(keys.map((key, i) => [key, choices[i]]));
  // The expected order and line IDs come from the independently frozen approved baseline.
  for (const section of [
    ...manifest.sections,
    ...manifest.sections.toReversed(),
  ]) {
    const ref =
      section.content.find((c) => c.branch_tag === selected[section.id]) ??
      section.content[0];
    const branch = baseline.phases
      .find((p) => p.id === section.phase_id)!
      .display.branches.find((b) => b.tag === ref.branch_tag)!;
    const variant =
      branch.variants.find((v) => v.key === selected[branch.tag]) ??
      branch.variants[0];
    const ids = ref.variants.find(
      (v) => v.variant_key === variant.key,
    )!.line_ids;
    const expected = variant.lines
      .filter((line) => ids.includes(line.id))
      .map((line) => ({
        id: line.id,
        type: line.type,
        text: line.text
          .replace(/\{\{tone:[^}]+\}\}/g, "")
          .replace(
            /\{(\w+)\}/g,
            (_, key: string) => expectedTokens[key] ?? `{${key}}`,
          ),
      }));
    const block = buildCoachSectionScriptBlock(
      section.id,
      tokens,
      { leadSource: null, occupancy: null },
      selected,
      selected[section.id],
    );
    const actual = block!.branches.flatMap((b) =>
      b.selected.lines.map((line) => ({
        id: line.id,
        type: line.type,
        text: line.segments
          .map((s) =>
            s.kind === "tone"
              ? ""
              : s.kind === "text"
                ? s.value
                : s.resolved.value,
          )
          .join(""),
      })),
    );
    expect(actual, `${profile}:${choices.join("/")}:${section.id}`).toEqual(
      expected,
    );
  }
}

describe("approved pre-call script matrix", () => {
  for (let profile = 0; profile < 8; profile++) {
    for (let dimension = 0; dimension < 6; dimension++)
      for (const choice of dimensions[dimension])
        it(`profile${profile} individual ${keys[dimension]}=${choice}`, () => {
          const choices = dimensions.map((d) => d[0]);
          choices[dimension] = choice;
          verify(profile, choices);
        });
    for (const opener of dimensions[0])
      for (const occupancy of dimensions[1])
        it(`profile${profile} opener/occupancy ${opener}/${occupancy}`, () =>
          verify(profile, [
            opener,
            occupancy,
            ...dimensions.slice(2).map((d) => d[0]),
          ]));
    for (const offer of dimensions[4])
      for (const closing of dimensions[5])
        it(`profile${profile} offer/closing ${offer}/${closing}`, () =>
          verify(profile, [
            ...dimensions.slice(0, 4).map((d) => d[0]),
            offer,
            closing,
          ]));
  }
  // Every value-pair for all 15 dimension pairs, including later-stage interactions.
  for (let left = 0; left < 6; left++)
    for (let right = left + 1; right < 6; right++)
      for (const a of dimensions[left])
        for (const b of dimensions[right])
          it(`pairwise ${keys[left]}=${a}/${keys[right]}=${b}`, () => {
            const choices = dimensions.map((d) => d[0]);
            choices[left] = a;
            choices[right] = b;
            for (let p = 0; p < 8; p++) verify(p, choices);
          });
});
