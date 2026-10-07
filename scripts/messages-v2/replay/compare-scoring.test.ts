import { describe, expect, it } from "vitest";

import { agreementAtCutoffs, cascadeAtCutoff, jevAlone, modelStats, percentile, type CascadeOptions, type Row } from "./compare-scoring";

let n = 0;
function row(o: { truth?: string | null; kind?: "explicit" | "implicit"; jev?: [string, number] | null; decision?: "auto_apply" | "hold"; reason?: string; luna?: [string, number] | null }): Row {
  n++;
  return {
    id: `m${n}`, text: "t",
    truth: o.truth === null || o.truth === undefined ? null : { label: o.truth, kind: o.kind ?? "explicit" },
    jev: o.jev === null ? null : o.jev ? { label: o.jev[0], confidence: o.jev[1] } : { label: "not_interested", confidence: 0.5 },
    jevDecision: { status: o.decision ?? "hold", reason: o.reason ?? (o.decision === "auto_apply" ? "auto_apply" : "needs_decision") },
    luna: o.luna ? { label: o.luna[0], confidence: o.luna[1] } : null,
    lunaErrored: false,
  };
}
const opts: CascadeOptions = { eligible: new Set(["not_interested", "wrong_number", "nurture", "opted_out"]), scope: "below_threshold", includeImplicit: false };

describe("cascadeAtCutoff", () => {
  const rows = [
    row({ truth: "not_interested", luna: ["not_interested", 0.97], jev: ["not_interested", 0.7] }), // right
    row({ truth: "wrong_number", luna: ["not_interested", 0.95], jev: ["wrong_number", 0.8] }), // wrong (key risk)
    row({ truth: "nurture", luna: ["nurture", 0.82] }), // below 0.9 cutoff
    row({ truth: "opted_out", luna: ["dnc", 0.99] }), // ineligible outcome, stays human
    row({ luna: ["nurture", 0.99] }), // resolved but no human decision
    row({ truth: "nurture", decision: "hold", reason: "dnc", luna: ["nurture", 0.99] }), // policy hold: out of scope
    row({ truth: "nurture", decision: "auto_apply", jev: ["nurture", 0.99] }),
  ];
  it("counts resolved, agreed, wrong and remaining at a cutoff", () => {
    const c = cascadeAtCutoff(rows, 0.9, opts);
    expect(c).toMatchObject({ scopeHolds: 5, resolved: 3, resolvedWithTruth: 2, agreed: 1, wrong: 1, noTruth: 1, remainingHuman: 2, jevAgreedOnResolved: 2 });
    expect(c.byOutcome.not_interested).toMatchObject({ resolved: 2, wrong: 1, agreed: 1 });
  });
  it("a lower cutoff resolves more", () => {
    expect(cascadeAtCutoff(rows, 0.8, opts).resolved).toBe(4);
    expect(cascadeAtCutoff(rows, null, opts).resolved).toBe(4);
  });
  it("all_holds scope includes policy holds; implicit truth excluded unless asked", () => {
    expect(cascadeAtCutoff(rows, 0.9, { ...opts, scope: "all_holds" }).scopeHolds).toBe(6);
    const imp = [row({ truth: "nurture", kind: "implicit", luna: ["nurture", 0.95] })];
    expect(cascadeAtCutoff(imp, 0.9, opts)).toMatchObject({ resolved: 1, resolvedWithTruth: 0, noTruth: 1 });
    expect(cascadeAtCutoff(imp, 0.9, { ...opts, includeImplicit: true })).toMatchObject({ resolvedWithTruth: 1, agreed: 1 });
  });
  it("an unscored Luna (error or missing confidence) never applies", () => {
    expect(cascadeAtCutoff([row({ truth: "nurture", luna: null })], null, opts).resolved).toBe(0);
  });
});

describe("jevAlone / modelStats / cutoffs", () => {
  const rows = [
    row({ decision: "auto_apply", truth: "not_interested", jev: ["not_interested", 0.95] }),
    row({ decision: "auto_apply", truth: "wrong_number", jev: ["not_interested", 0.92] }),
    row({ decision: "hold", reason: "dnc", truth: "dnc", jev: ["dnc", 0.99] }),
    row({ decision: "hold", reason: "jev_error", jev: null }),
  ];
  it("scores auto-applied calls and tallies hold reasons", () => {
    expect(jevAlone(rows, { includeImplicit: false })).toMatchObject({ autoApplied: 2, autoScored: 2, autoAgreed: 1, autoWrong: 1, autoAgreement: 0.5, heldForHuman: 2, holdReasons: { dnc: 1, jev_error: 1 } });
  });
  it("precision, recall, agreement and confusion", () => {
    const s = modelStats(rows, (r) => r.jev, { includeImplicit: false });
    expect(s).toMatchObject({ n: 3, agreed: 2 });
    expect(s.perOutcome.not_interested).toMatchObject({ predicted: 2, actual: 1, precision: 0.5, recall: 1 });
    expect(s.perOutcome.wrong_number).toMatchObject({ precision: null, recall: 0 });
    expect(s.confusion.wrong_number.not_interested).toBe(1);
  });
  it("agreement and coverage at each confidence cutoff", () => {
    const a = agreementAtCutoffs(rows, (r) => r.jev, { includeImplicit: false }, [0.8, 0.95]);
    expect(a[0]).toMatchObject({ n: 3, agreed: 2 });
    expect(a[1]).toMatchObject({ n: 2, agreed: 2, agreement: 1 });
    expect(a[1].coverage).toBeCloseTo(2 / 3);
  });
  it("percentile", () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
    expect(percentile([], 50)).toBeNull();
  });
});
