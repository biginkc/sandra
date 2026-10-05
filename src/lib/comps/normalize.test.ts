import { describe, expect, it } from "vitest";

import { classifyLegal, normalizeProviderResult } from "./normalize";
import type { ProviderCompResult } from "./types";

const base: ProviderCompResult = {
  providerPropertyId: "x", asIs: { value: 200000, low: 190000, high: 210000, score: 90, fsdPct: 5 },
  comps: [1, 2, 3].map((i) => ({ address: `${i} A St`, saleDate: "2026-01-01", salePrice: 200000, sqft: null, beds: null, baths: null, yearBuilt: null, distanceMiles: null, providerId: null, renovatedHint: null })),
  ownerOfRecord: "O", legal: { text: "SUB BLK 1 LOT 2 PLUS SOME MORE TEXT", complete: true }, billedCalls: 2, raw: {},
};

describe("normalizeProviderResult", () => {
  it.each([
    [5, "high", false], [7.5, "high", false], [7.6, "medium", false], [15, "medium", false], [15.1, "low", true], [null, "low", true],
  ])("fsd %s → %s (verify %s)", (fsd, confidence, verify) => {
    const row = normalizeProviderResult({ ...base, asIs: { ...base.asIs, fsdPct: fsd } }, "attom");
    expect(row.confidence).toBe(confidence);
    expect(row.verify_first).toBe(verify);
  });
  it("no AVM → low, verify_first with no_avm", () => {
    const row = normalizeProviderResult({ ...base, asIs: { value: null, low: null, high: null, score: null, fsdPct: null } }, "attom");
    expect(row.confidence).toBe("low");
    expect(row.verify_reasons).toContain("no_avm");
    expect(row.as_is_value).toBeNull();
  });
  it("few comps and incomplete legal add reasons", () => {
    const row = normalizeProviderResult({ ...base, comps: base.comps.slice(0, 2), legal: { text: "SUB", complete: false } }, "attom");
    expect(row.verify_reasons).toEqual(["few_comps", "legal_incomplete"]);
  });
  it("never writes an ARV (Jarrad's own number)", () => {
    const row = normalizeProviderResult(base, "fixture");
    expect(row.arv_estimate).toBeNull();
    expect(row.arv_method).toBe("none");
  });
  it("orders a flipped range", () => {
    const row = normalizeProviderResult({ ...base, asIs: { ...base.asIs, low: 210000, high: 190000 } }, "attom");
    expect(row.as_is_low).toBe(190000);
    expect(row.as_is_high).toBe(210000);
  });
});

describe("classifyLegal", () => {
  it("subdivision-only is incomplete", () => expect(classifyLegal("SAMPLE HEIGHTS").complete).toBe(false));
  it("short lot text is incomplete", () => expect(classifyLegal("SH LOT 12").complete).toBe(false));
  it("lot/block text ≥ 25 chars is complete", () => expect(classifyLegal("SAMPLE HEIGHTS BLK 4 LOT 12 EXC N 5FT").complete).toBe(true));
  it("blank → null", () => expect(classifyLegal("  ")).toEqual({ text: null, complete: false }));
});
