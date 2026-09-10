import { describe, expect, it } from "vitest";
import {
  EMPTY_SETUP,
  SETUP_SELECTORS,
  parseSetupDraft,
  setupDefaults,
  setupOptions,
  setupStorageKey,
  setupValues,
} from "./precall-setup";
import { resolveCoachTokens } from "./token-resolver";
import type { CoachCallContext } from "./types";
const context: CoachCallContext = {
  sellerName: "Jordan Ellis",
  repName: "Alex Rep",
  authenticatedRepName: "Alex Rep",
  propertyAddress: "123 Fictional Lane",
  propertyCounty: null,
  repPhoneE164: "+18165550100",
  sellerPhoneE164: "+18165550101",
  leadId: "abcdef12-3456-7890-abcd-123456ABC789",
  motivation: "move closer to family",
  coldCallerName: null,
  yearBuilt: "1962",
  leadSource: "sms",
  occupancy: "owner_occupied",
};
describe("pre-call contract", () => {
  it("has exactly the approved selector choices, sourced from the script", () => {
    expect(SETUP_SELECTORS.map(({ key }) => setupOptions(key).length)).toEqual([
      4, 4, 3, 3, 4, 2,
    ]);
    expect(setupOptions("Opener").map((x) => x.value)).toEqual([
      "cold_call",
      "fsbo",
      "sms",
      "d4d",
    ]);
  });
  it("defaults Mel without substituting motivation for desired outcome", () => {
    expect(setupValues(context, {})).toMatchObject({
      cold_caller_name: "Mel",
      motivation: "move closer to family",
      dream_outcome: "",
    });
    expect(
      setupValues(context, { cold_caller_name: "" }).cold_caller_name,
    ).toBe("");
  });
  it("keeps trusted file identity separate from spoken name and forbidden draft values", () => {
    const parsed = parseSetupDraft(
      JSON.stringify({
        version: 1,
        edits: {
          rep_name: "Other Person",
          file_number: "FAKE",
          authenticatedRepName: "Fake Person",
          leadId: "FAKE123456",
        },
        branches: {},
      }),
    );
    expect(parsed.edits).toEqual({ rep_name: "Other Person" });
    expect(
      resolveCoachTokens(context, undefined, parsed.edits).file_number.value,
    ).toBe("AR-ABC789");
    expect(
      resolveCoachTokens({ ...context, leadId: null }, undefined, parsed.edits)
        .file_number.isPlaceholder,
    ).toBe(true);
  });
  it.each([null, "", "abc", "abc-12"])(
    "does not invent a suffix for %s",
    (leadId) => {
      expect(
        resolveCoachTokens({ ...context, leadId }).file_number.isPlaceholder,
      ).toBe(true);
    },
  );
  it("preserves explicit blanks over automatic values", () => {
    const tokens = resolveCoachTokens(context, undefined, {
      seller_name: "",
      rep_name: "",
      motivation: "",
      dream_outcome: "",
      cold_caller_name: "",
    });
    for (const key of [
      "seller_name",
      "rep_name",
      "motivation",
      "dream_outcome",
      "cold_caller_name",
    ] as const)
      expect(tokens[key].isPlaceholder).toBe(true);
  });
  it("uses full desired outcome independently of motivation", () => {
    expect(
      resolveCoachTokens(context, undefined, {
        dream_outcome: "buy a smaller home",
      }).dream_outcome.value,
    ).toBe("buy a smaller home");
  });
  it("rejects stale versions, corrupt values and nonexistent branches", () => {
    expect(parseSetupDraft("broken")).toEqual(EMPTY_SETUP);
    expect(parseSetupDraft('{"version":2}')).toEqual(EMPTY_SETUP);
    expect(
      parseSetupDraft(
        JSON.stringify({
          version: 1,
          edits: { seller_name: 4 },
          branches: { Opener: "default", Entry: "vacant" },
        }),
      ),
    ).toEqual({ version: 1, edits: {}, branches: { Entry: "vacant" } });
  });
  it("partitions rep, lead and manual drafts independently", () => {
    expect(
      new Set(
        ["rep1", "rep2"].flatMap((rep) =>
          ["lead:a", "lead:b", "phone:+18165550100"].map((target) =>
            setupStorageKey(rep, target),
          ),
        ),
      ).size,
    ).toBe(6);
  });
  it("does not infer occupancy and keeps later stages unset", () => {
    expect(setupDefaults({ ...context, occupancy: "unknown" })).toEqual({
      Opener: "sms",
      Entry: "unknown",
    });
  });
});
