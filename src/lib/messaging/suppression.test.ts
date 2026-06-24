import { describe, expect, it } from "vitest";

import { evaluateSuppression, isSuppressed, SUPPRESSED_DISPOS } from "./suppression";

describe("messaging suppression", () => {
  it.each([
    "wrong_number",
    "bad_number",
    "dnc",
    "opted_out",
  ])("suppresses terminal outreach_dispo %s", (outreachDispo) => {
    expect(evaluateSuppression({ outreachDispo })).toMatchObject({
      suppressed: true,
      source: "outreach_dispo",
      outreachDispo,
    });
  });

  it("does not suppress not_interested", () => {
    expect(isSuppressed({ outreachDispo: "not_interested" })).toBe(false);
  });

  it("suppresses contact-level SMS opt-outs", () => {
    expect(evaluateSuppression({ smsOptedOut: true })).toMatchObject({
      suppressed: true,
      source: "sms_opted_out",
    });
    expect(evaluateSuppression({ consentState: "opted_out" })).toMatchObject({
      suppressed: true,
      source: "consent_state",
    });
  });

  it("keeps the exported terminal set narrow", () => {
    expect(Array.from(SUPPRESSED_DISPOS).sort()).toEqual([
      "bad_number",
      "dnc",
      "opted_out",
      "wrong_number",
    ]);
  });
});
