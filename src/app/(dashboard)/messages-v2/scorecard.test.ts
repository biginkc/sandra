import { describe, expect, it } from "vitest";

import {
  buildScorecard,
  formatRuleText,
  parseScorecardRows,
  SCORECARD_OUTCOMES,
  suggestThreshold,
  type ScorecardRow,
  type Sample,
} from "./scorecard";

/** n samples at confidence c, `agreed` of them agreeing. */
const batch = (c: number, n: number, agreed: number): Sample[] =>
  Array.from({ length: n }, (_, i) => [c, i < agreed ? 1 : 0] as Sample);

describe("suggestThreshold", () => {
  it("is insufficient under 30 samples", () => {
    expect(suggestThreshold(batch(0.99, 29, 29))).toEqual({
      kind: "insufficient",
      samples: 29,
    });
  });

  it("suggests the lowest cutoff whose tail agreement is at least 95%", () => {
    const samples = [
      ...batch(0.7, 20, 10), // noisy low band
      ...batch(0.9, 30, 28), // 28/30 = 93%
      ...batch(0.95, 40, 40),
    ];
    // >=0.9 : 68/70 = 97.1% and n>=30 -> qualifies; >=0.7 : 78/90 = 86.7% no
    expect(suggestThreshold(samples)).toMatchObject({
      kind: "suggested",
      threshold: 0.9,
      samples: 70,
      agreement: 68 / 70,
    });
  });

  it("accepts exactly 95% and rejects just under", () => {
    expect(suggestThreshold(batch(0.8, 40, 38))).toMatchObject({
      kind: "suggested",
      threshold: 0.8,
    });
    expect(suggestThreshold(batch(0.8, 40, 37))).toMatchObject({
      kind: "none",
    });
  });

  it("requires 30 samples in the tail, not just overall", () => {
    const samples = [...batch(0.6, 30, 10), ...batch(0.99, 10, 10)];
    expect(suggestThreshold(samples)).toMatchObject({ kind: "none" });
  });

  it("rounds the cutoff UP to 3 decimals and re-checks the tail it implies", () => {
    // 29 perfect samples at 0.9504 plus one disagreement at 0.9501: the raw
    // cutoff 0.9501 would include the miss (29/30 = 96.7%, ok) but the
    // rounded cutoff 0.951 excludes everything (n=0) -> must not suggest it.
    const samples: Sample[] = [...batch(0.9504, 29, 29), [0.9501, 0]];
    const s = suggestThreshold(samples);
    if (s.kind === "suggested") {
      expect(s.threshold).toBeGreaterThanOrEqual(0.951);
      expect(s.samples).toBeGreaterThanOrEqual(30);
    } else {
      expect(s.kind).toBe("none");
    }
  });

  it("reports none when enough data exists but no cutoff reaches 95%", () => {
    expect(suggestThreshold(batch(0.9, 50, 40))).toEqual({
      kind: "none",
      samples: 50,
    });
  });

  it("ignores samples with an invalid confidence", () => {
    const bad = [[Number.NaN, 1], [2, 1], [-1, 0]] as Sample[];
    expect(suggestThreshold([...batch(0.9, 30, 30), ...bad])).toMatchObject({
      kind: "suggested",
      samples: 30,
    });
  });
});

describe("suggestThreshold vs the current threshold", () => {
  it("does not loosen on one stray low-confidence agreement (29 @0.96 + 1 @0.40, current 0.95)", () => {
    const samples: Sample[] = [...batch(0.96, 29, 29), [0.4, 1]];
    expect(suggestThreshold(samples, 0.95)).toEqual({ kind: "keep_current", samples: 30 });
  });

  it("loosens only with >=30 samples at >=95% in the band [suggestion, current)", () => {
    const samples: Sample[] = [...batch(0.8, 30, 30), ...batch(0.96, 30, 30)];
    expect(suggestThreshold(samples, 0.95)).toMatchObject({
      kind: "suggested",
      threshold: 0.8,
      direction: "loosens",
    });
  });

  it("does not loosen when the band agrees under 95%", () => {
    const samples: Sample[] = [...batch(0.8, 30, 27), ...batch(0.96, 30, 30)];
    const s = suggestThreshold(samples, 0.95);
    expect(s).not.toMatchObject({ direction: "loosens" });
  });

  it("labels a higher suggestion as raises and an equal one as same", () => {
    const samples: Sample[] = [...batch(0.8, 30, 20), ...batch(0.96, 30, 30)];
    expect(suggestThreshold(samples, 0.9)).toMatchObject({ threshold: 0.96, direction: "raises" });
    expect(suggestThreshold(samples, 0.96)).toMatchObject({ threshold: 0.96, direction: "same" });
    expect(suggestThreshold(samples, null)).toMatchObject({ threshold: 0.96, direction: "new" });
  });

  it("reports auto and held agreement separately for the suggested tail", () => {
    const samples: Sample[] = [
      ...Array.from({ length: 20 }, () => [0.97, 1, "a"] as Sample),
      ...Array.from({ length: 10 }, (_, i) => [0.97, i < 9 ? 1 : 0, "h"] as Sample),
      ...Array.from({ length: 10 }, () => [0.5, 0, "a"] as Sample),
    ];
    expect(suggestThreshold(samples, null)).toMatchObject({
      kind: "suggested",
      auto: { agreed: 20, n: 20 },
      held: { agreed: 9, n: 10 },
    });
  });
});

describe("formatRuleText", () => {
  it("renders the exact approval text", () => {
    expect(formatRuleText("nurture", 0.9)).toBe(
      "nurture: auto-apply at native confidence ≥ 0.900",
    );
    expect(formatRuleText("opted_out", 0.9504)).toBe(
      "opted_out: auto-apply at native confidence ≥ 0.951",
    );
  });
});

const row = (over: Partial<ScorecardRow> = {}): ScorecardRow => ({
  outcome: "nurture",
  runs: 0,
  auto_applied: 0,
  held: 0,
  auto_settled: 0,
  auto_agreed: 0,
  held_decided: 0,
  held_agreed: 0,
  threshold: null,
  automation_enabled: null,
  samples: [],
  ...over,
});

describe("buildScorecard", () => {
  it("returns one entry per outcome in canonical order, zero-filled", () => {
    const out = buildScorecard([row({ outcome: "opted_out", runs: 3 })]);
    expect(out.map((o) => o.outcome)).toEqual([...SCORECARD_OUTCOMES]);
    expect(out.find((o) => o.outcome === "new_lead")).toMatchObject({
      runs: 0,
      autoAgreementRate: null,
      heldAgreementRate: null,
      suggestion: { kind: "insufficient", samples: 0 },
    });
    expect(out.find((o) => o.outcome === "opted_out")?.runs).toBe(3);
  });

  it("computes agreement rates from settled/decided denominators", () => {
    const [nurture] = buildScorecard([
      row({
        runs: 20,
        auto_applied: 12,
        held: 8,
        auto_settled: 10,
        auto_agreed: 9,
        held_decided: 4,
        held_agreed: 3,
        threshold: 0.9,
        automation_enabled: true,
      }),
    ]).filter((o) => o.outcome === "nurture");
    expect(nurture.autoAgreementRate).toBeCloseTo(0.9);
    expect(nurture.heldAgreementRate).toBeCloseTo(0.75);
    expect(nurture.threshold).toBe(0.9);
    expect(nurture.automationEnabled).toBe(true);
  });

  it("ignores rows for unknown outcomes", () => {
    const out = buildScorecard([row({ outcome: "dnc", runs: 9 })]);
    expect(out).toHaveLength(SCORECARD_OUTCOMES.length);
    expect(out.every((o) => o.runs === 0)).toBe(true);
  });
});

describe("parseScorecardRows", () => {
  it("coerces bigint strings and numerics, drops malformed samples", () => {
    const rows = parseScorecardRows([
      {
        outcome: "nurture",
        runs: "12",
        auto_applied: "5",
        held: 7,
        auto_settled: "4",
        auto_agreed: "4",
        held_decided: "3",
        held_agreed: "2",
        threshold: "0.900",
        automation_enabled: true,
        samples: [[0.95, 1], [0.8, 0], ["x", 1], [0.7], null, [0.6, 2]],
      },
    ]);
    expect(rows).toEqual([
      {
        outcome: "nurture",
        runs: 12,
        auto_applied: 5,
        held: 7,
        auto_settled: 4,
        auto_agreed: 4,
        held_decided: 3,
        held_agreed: 2,
        threshold: 0.9,
        automation_enabled: true,
        samples: [
          [0.95, 1],
          [0.8, 0],
        ],
      },
    ]);
  });

  it("returns [] for non-array input", () => {
    expect(parseScorecardRows(null)).toEqual([]);
    expect(parseScorecardRows({})).toEqual([]);
  });
});
