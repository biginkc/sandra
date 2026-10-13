import { describe, expect, it } from "vitest";

import { lunaEligibility } from "./eligibility";

const base = { enabled: true, jevOutcome: "nurture" as const, inboundBody: "maybe check back next spring" };

describe("lunaEligibility", () => {
  it("asks for a plain below-threshold hold", () => {
    expect(lunaEligibility(base)).toEqual({ ask: true });
    for (const jevOutcome of ["new_lead", "nurture", "not_interested", "wrong_number"] as const) {
      expect(lunaEligibility({ ...base, jevOutcome })).toEqual({ ask: true });
    }
  });
  it("does nothing when disabled", () => {
    expect(lunaEligibility({ ...base, enabled: false })).toEqual({ ask: false, reason: "disabled" });
  });
  it("never asks about Jev's own opted_out / dnc", () => {
    expect(lunaEligibility({ ...base, jevOutcome: "opted_out" })).toEqual({ ask: false, reason: "jev_opted_out" });
    expect(lunaEligibility({ ...base, jevOutcome: "dnc" })).toEqual({ ask: false, reason: "jev_dnc" });
  });
  it("does not ask for outcomes with nothing to apply", () => {
    expect(lunaEligibility({ ...base, jevOutcome: "unclear" })).toEqual({ ask: false, reason: "jev_outcome_not_askable" });
    expect(lunaEligibility({ ...base, jevOutcome: "bad_number" })).toEqual({ ask: false, reason: "jev_outcome_not_askable" });
  });
  it.each(["STOP", "please leave me alone", "don't text me again", "unsubscribe", "Do not contact me", "no more texts please"])(
    "does not ask when the text carries a stop / do-not-contact signal: %s",
    (inboundBody) => {
      expect(lunaEligibility({ ...base, inboundBody })).toEqual({ ask: false, reason: "stop_signal" });
    },
  );
  it.each(["I will call my attorney", "what is your offer", "she passed away", "$150k"])(
    "does not ask when an escalation keyword fired: %s",
    (inboundBody) => {
      expect(lunaEligibility({ ...base, inboundBody })).toEqual({ ask: false, reason: "escalation_keyword" });
    },
  );
  it("honors the org's own escalation keyword list like the gate does", () => {
    expect(lunaEligibility({ ...base, inboundBody: "I will call my attorney", escalationKeywords: ["probate"] })).toEqual({ ask: true });
  });
});
