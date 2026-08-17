import { describe, expect, it } from "vitest";

import {
  deriveLeadSmsPresentation,
  type LeadSmsReadState,
} from "./lead-detail-state";

const allowed: LeadSmsReadState = {
  hasContact: true,
  hasUsablePhone: true,
  consentState: "can_send_marketing",
  contactSmsOptedOut: false,
  propertySmsOptedOut: false,
  phoneSuppressed: false,
  outreachDispo: null,
  phoneLineType: "mobile",
};

describe("deriveLeadSmsPresentation", () => {
  it.each([
    ["can_send_marketing", "OK to text"],
    ["can_send_informational_only", "Informational only"],
    ["no_consent", "No consent on file"],
  ] as const)("labels %s truthfully", (consentState, label) => {
    expect(
      deriveLeadSmsPresentation({ ...allowed, consentState }),
    ).toMatchObject({
      consentLabel: label,
      smsRestricted: false,
    });
  });

  it.each([
    { contactSmsOptedOut: true },
    { propertySmsOptedOut: true },
    { phoneSuppressed: true },
    { consentState: "opted_out" as const },
  ])("restricts SMS for an actual opt-out source: %o", (override) => {
    const result = deriveLeadSmsPresentation({ ...allowed, ...override });
    expect(result.consentLabel).toBe("Opted out");
    expect(result.smsRestricted).toBe(true);
    expect(result.consentDetail).toContain("not a permanent DNC");
  });

  it("shows a retryable read failure instead of guessing consent", () => {
    expect(
      deriveLeadSmsPresentation({ ...allowed, phoneSuppressed: null }),
    ).toMatchObject({
      consentLabel: "Could not verify",
      smsRestricted: true,
      readFailed: true,
    });
  });

  it("keeps a partial read failure visible even when another source proves opt-out", () => {
    expect(
      deriveLeadSmsPresentation({
        ...allowed,
        contactSmsOptedOut: true,
        phoneSuppressed: null,
      }),
    ).toMatchObject({
      consentLabel: "Opted out",
      smsRestricted: true,
      readFailed: true,
    });
  });

  it.each(["wrong_number", "bad_number"])(
    "restricts SMS for a %s property disposition",
    (outreachDispo) => {
      expect(
        deriveLeadSmsPresentation({ ...allowed, outreachDispo }),
      ).toMatchObject({
        consentLabel: "Number marked wrong",
        smsRestricted: true,
      });
    },
  );

  it("restricts SMS when the selected phone is a landline", () => {
    expect(
      deriveLeadSmsPresentation({
        ...allowed,
        hasUsablePhone: false,
        phoneLineType: "landline",
      }),
    ).toMatchObject({
      consentLabel: "Landline only",
      smsRestricted: true,
    });
  });
});
