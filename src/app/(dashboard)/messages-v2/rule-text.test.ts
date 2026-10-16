import { describe, expect, it } from "vitest";

import { formatConfidence, formatRuleText, parseConfidenceInput } from "./rule-text";

describe("formatRuleText", () => {
  it("renders the outcome, the cutoff and on/off exactly", () => {
    expect(formatRuleText({ outcome: "not_interested", minConfidence: 0.9, automationEnabled: true })).toBe(
      "not_interested: auto-apply at native confidence ≥ 0.90 (ON)",
    );
    expect(formatRuleText({ outcome: "new_lead", minConfidence: 0.925, automationEnabled: false })).toBe(
      "new_lead: auto-apply at native confidence ≥ 0.925 (OFF)",
    );
  });
});

describe("formatConfidence", () => {
  it("keeps at least two decimals and never rounds", () => {
    expect(formatConfidence(0.9)).toBe("0.90");
    expect(formatConfidence(0.95)).toBe("0.95");
    expect(formatConfidence(0.925)).toBe("0.925");
    expect(formatConfidence(1)).toBe("1.00");
    expect(formatConfidence(0)).toBe("0.00");
  });
});

describe("parseConfidenceInput", () => {
  it("accepts plain decimals from 0 to 1 with up to three places", () => {
    for (const [raw, value] of [["0.9", 0.9], ["0.95", 0.95], [" 0.925 ", 0.925], ["1", 1], ["0", 0], [".5", 0.5], ["1.000", 1]] as const) {
      expect(parseConfidenceInput(raw)).toEqual({ ok: true, value });
    }
  });

  it("rejects everything else instead of guessing", () => {
    for (const raw of ["", "  ", "abc", "1.1", "-0.1", "0.9999", "2", "90%", "1e-1", "0,9", "NaN", "Infinity"]) {
      expect(parseConfidenceInput(raw).ok).toBe(false);
    }
  });
});
