import { describe, expect, it } from "vitest";

import {
  evaluateAutomatedSuppression,
  evaluateSuppression,
  HUMAN_OWNED_DISPOS,
  isSuppressed,
  shouldSuppressAutomatedSend,
  SUPPRESSED_DISPOS,
} from "./suppression";

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
    expect(evaluateSuppression({ doNotContact: true })).toMatchObject({
      suppressed: true,
      source: "do_not_contact",
    });
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

describe("shouldSuppressAutomatedSend (outbound suppression boundary)", () => {
  it.each(["nurture", "callback_requested", "booked_appointment"])(
    "blocks automated senders on human-owned dispo %s",
    (outreachDispo) => {
      expect(shouldSuppressAutomatedSend({ outreachDispo })).toBe(true);
    },
  );

  it.each(["wrong_number", "bad_number", "dnc", "opted_out"])(
    "still blocks automated senders on every SUPPRESSED_DISPOS value (%s)",
    (outreachDispo) => {
      expect(shouldSuppressAutomatedSend({ outreachDispo })).toBe(true);
    },
  );

  it("does not block automated senders on a non-terminal, non-human-owned dispo", () => {
    expect(shouldSuppressAutomatedSend({ outreachDispo: "not_interested" })).toBe(false);
    expect(shouldSuppressAutomatedSend({ outreachDispo: null })).toBe(false);
  });

  it.each(["nurture", "callback_requested", "booked_appointment"])(
    "does NOT block the manual reply path (isSuppressed) on human-owned dispo %s — a human agent can still text them",
    (outreachDispo) => {
      expect(isSuppressed({ outreachDispo })).toBe(false);
    },
  );

  it("keeps HUMAN_OWNED_DISPOS narrow", () => {
    expect(Array.from(HUMAN_OWNED_DISPOS).sort()).toEqual([
      "booked_appointment",
      "callback_requested",
      "nurture",
    ]);
  });
});

describe("evaluateAutomatedSuppression (the decision shouldSuppressAutomatedSend is built on)", () => {
  it("surfaces a distinct source for a human-owned dispo", () => {
    expect(
      evaluateAutomatedSuppression({ outreachDispo: "booked_appointment" }),
    ).toMatchObject({
      suppressed: true,
      source: "human_owned_dispo",
      outreachDispo: "booked_appointment",
    });
  });

  it("still surfaces the original source for a SUPPRESSED_DISPOS/consent/DNC hit — human-owned check never masks it", () => {
    expect(evaluateAutomatedSuppression({ outreachDispo: "dnc" })).toMatchObject({
      suppressed: true,
      source: "outreach_dispo",
    });
    expect(
      evaluateAutomatedSuppression({ consentState: "opted_out" }),
    ).toMatchObject({
      suppressed: true,
      source: "consent_state",
    });
  });

  it("is not suppressed when nothing applies", () => {
    expect(evaluateAutomatedSuppression({ outreachDispo: "not_interested" })).toEqual({
      suppressed: false,
    });
  });
});
