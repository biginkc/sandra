import { describe, expect, it } from "vitest";

import {
  isThresholdableOutcome,
  loadOrgThresholdMap,
  resolveThresholdDecision,
  THRESHOLDABLE_OUTCOMES,
  type ThresholdMap,
} from "./thresholds";

const THRESHOLDS: ThresholdMap = {
  new_lead: 0.9,
  wrong_number: 0.9,
  not_interested: 0.95,
  nurture: 0.95,
  opted_out: 0.95,
};

describe("resolveThresholdDecision", () => {
  it("auto-applies exactly at the threshold (>=, not strictly >)", () => {
    const result = resolveThresholdDecision(
      { outcome: "not_interested", outcomeConfidence: 0.95 },
      THRESHOLDS,
    );
    expect(result).toEqual({
      status: "auto_apply",
      outcome: "not_interested",
      confidence: 0.95,
      minConfidence: 0.95,
    });
  });

  it("sends a decision just below the threshold to needs_decision", () => {
    const result = resolveThresholdDecision(
      { outcome: "not_interested", outcomeConfidence: 0.949999 },
      THRESHOLDS,
    );
    expect(result).toEqual({
      status: "needs_decision",
      outcome: "not_interested",
      confidence: 0.949999,
      minConfidence: 0.95,
    });
  });

  it("auto-applies confidence above the threshold", () => {
    const result = resolveThresholdDecision(
      { outcome: "new_lead", outcomeConfidence: 0.99 },
      THRESHOLDS,
    );
    expect(result.status).toBe("auto_apply");
  });

  it("is human-gated when native confidence is missing (null)", () => {
    const result = resolveThresholdDecision(
      { outcome: "new_lead", outcomeConfidence: null },
      THRESHOLDS,
    );
    expect(result).toEqual({
      status: "human_gated",
      reason: "missing_confidence",
      outcome: "new_lead",
    });
  });

  it("is human-gated when native confidence is undefined", () => {
    const result = resolveThresholdDecision(
      { outcome: "new_lead" },
      THRESHOLDS,
    );
    expect(result).toEqual({
      status: "human_gated",
      reason: "missing_confidence",
      outcome: "new_lead",
    });
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative", -0.1],
    ["above 1", 1.1],
  ])("is human-gated when native confidence is invalid (%s)", (_label, value) => {
    const result = resolveThresholdDecision(
      { outcome: "new_lead", outcomeConfidence: value },
      THRESHOLDS,
    );
    expect(result).toEqual({
      status: "human_gated",
      reason: "invalid_confidence",
      outcome: "new_lead",
    });
  });

  it("never auto-applies dnc regardless of confidence", () => {
    const result = resolveThresholdDecision(
      { outcome: "dnc", outcomeConfidence: 1 },
      THRESHOLDS,
    );
    expect(result).toEqual({ status: "human_gated", reason: "dnc", outcome: "dnc" });
  });

  it("never auto-applies unclear regardless of confidence", () => {
    const result = resolveThresholdDecision(
      { outcome: "unclear", outcomeConfidence: 1 },
      THRESHOLDS,
    );
    expect(result).toEqual({
      status: "human_gated",
      reason: "not_applicable",
      outcome: "unclear",
    });
  });

  it("never auto-applies bad_number regardless of confidence", () => {
    const result = resolveThresholdDecision(
      { outcome: "bad_number", outcomeConfidence: 1 },
      THRESHOLDS,
    );
    expect(result).toEqual({
      status: "human_gated",
      reason: "not_applicable",
      outcome: "bad_number",
    });
  });

  it("is human-gated (not defaulted to 0 or 1) when no threshold is configured for the outcome", () => {
    const result = resolveThresholdDecision(
      { outcome: "opted_out", outcomeConfidence: 0.999 },
      {},
    );
    expect(result).toEqual({
      status: "human_gated",
      reason: "no_threshold_configured",
      outcome: "opted_out",
    });
  });

  it("treats confidence 0 as valid and comparable, not as missing", () => {
    const result = resolveThresholdDecision(
      { outcome: "new_lead", outcomeConfidence: 0 },
      THRESHOLDS,
    );
    expect(result).toEqual({
      status: "needs_decision",
      outcome: "new_lead",
      confidence: 0,
      minConfidence: 0.9,
    });
  });

  for (const outcome of THRESHOLDABLE_OUTCOMES) {
    it(`treats ${outcome} as a thresholdable outcome`, () => {
      expect(isThresholdableOutcome(outcome)).toBe(true);
    });
  }

  it("does not treat dnc/unclear/bad_number as thresholdable", () => {
    expect(isThresholdableOutcome("dnc")).toBe(false);
    expect(isThresholdableOutcome("unclear")).toBe(false);
    expect(isThresholdableOutcome("bad_number")).toBe(false);
  });
});

describe("loadOrgThresholdMap", () => {
  function stubSupabase(rows: Array<{ outcome: string; min_confidence: number }> | null, error: { message: string } | null = null) {
    const builder = {
      select: () => builder,
      eq: async () => ({ data: rows, error }),
    };
    return { from: () => builder } as any;
  }

  it("builds a map from the org's threshold rows", async () => {
    const supabase = stubSupabase([
      { outcome: "new_lead", min_confidence: 0.9 },
      { outcome: "nurture", min_confidence: 0.95 },
    ]);
    const map = await loadOrgThresholdMap(supabase, "org-1");
    expect(map).toEqual({ new_lead: 0.9, nurture: 0.95 });
  });

  it("drops non-thresholdable outcome rows defensively (dnc/unclear should never appear, but must not crash if they do)", async () => {
    const supabase = stubSupabase([
      { outcome: "dnc", min_confidence: 0.5 },
      { outcome: "not_interested", min_confidence: 0.95 },
    ]);
    const map = await loadOrgThresholdMap(supabase, "org-1");
    expect(map).toEqual({ not_interested: 0.95 });
  });

  it("returns an empty map (never throws) on a DB error", async () => {
    const supabase = stubSupabase(null, { message: "connection reset" });
    const map = await loadOrgThresholdMap(supabase, "org-1");
    expect(map).toEqual({});
  });

  it("returns an empty map when the org has no threshold rows yet", async () => {
    const supabase = stubSupabase([]);
    const map = await loadOrgThresholdMap(supabase, "org-1");
    expect(map).toEqual({});
  });
});
