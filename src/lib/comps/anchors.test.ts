import { describe, expect, it } from "vitest";

import { calculateClosr, DEFAULT_INPUTS } from "@/lib/calculators/closr-v1";
import fixtures from "@/lib/calculators/worksheet-fixtures.json";

import { ARV_ANCHOR_KEYS, AS_IS_ANCHOR_KEYS, computeAnchors } from "./anchors";

const numbers = (values: Record<string, { status: string; value?: number }>) => Object.values(values).filter((v) => v.status === "ok");

describe("computeAnchors suppression (NN2)", () => {
  it("arv=null → every ARV-dependent anchor unavailable/no_arv and no zero leaks", () => {
    const a = computeAnchors({ asIs: 200000, arv: null, rehab: 20000, verifyFirst: false });
    for (const key of ARV_ANCHOR_KEYS) expect(a.arvDependent[key]).toEqual({ status: "unavailable", reason: "no_arv" });
    expect(numbers(a.arvDependent)).toHaveLength(0);
    expect(JSON.stringify(a.arvDependent)).not.toContain('"value":0');
    expect(numbers(a.asIsDependent)).toHaveLength(4);
  });
  it("rehab=null with valid arv → no_rehab; explicit 0 rehab is valid", () => {
    expect(computeAnchors({ asIs: 200000, arv: 250000, rehab: null, verifyFirst: false }).arvDependent.arv70).toEqual({ status: "unavailable", reason: "no_rehab" });
    expect(computeAnchors({ asIs: 200000, arv: 250000, rehab: 0, verifyFirst: false }).arvDependent.arv70).toEqual({ status: "ok", value: 175000 });
  });
  it("arv < asIs → arv_invalid; arv out of bounds → arv_invalid", () => {
    expect(computeAnchors({ asIs: 200000, arv: 150000, rehab: 0, verifyFirst: false }).arvDependent.investor).toEqual({ status: "unavailable", reason: "arv_invalid" });
    expect(computeAnchors({ asIs: null, arv: 0, rehab: 0, verifyFirst: false }).arvDependent.investor.status).toBe("unavailable");
    expect(computeAnchors({ asIs: null, arv: 2e12, rehab: 0, verifyFirst: false }).arvDependent.investor).toEqual({ status: "unavailable", reason: "arv_invalid" });
  });
  it("asIs=null with valid arv+rehab → as-is anchors unavailable, ARV anchors are numbers", () => {
    const a = computeAnchors({ asIs: null, arv: 250000, rehab: 10000, verifyFirst: true });
    for (const key of AS_IS_ANCHOR_KEYS) expect(a.asIsDependent[key]).toEqual({ status: "unavailable", reason: "no_as_is" });
    expect(numbers(a.arvDependent)).toHaveLength(6);
    expect(a.verifyFirst).toBe(true);
  });
  it("asIs=null, arv=null → everything unavailable", () => {
    const a = computeAnchors({ asIs: null, arv: null, rehab: null, verifyFirst: false });
    expect(numbers(a.asIsDependent)).toHaveLength(0);
    expect(numbers(a.arvDependent)).toHaveLength(0);
  });
  it("with all inputs each anchor equals calculateClosr for the same inputs (worksheet fixtures)", () => {
    const rows = (fixtures as unknown as { inputs: { asIs: number | null; arv: number | null; rehab: number | null } }[]).filter(
      (f) => f.inputs && typeof f.inputs.asIs === "number" && typeof f.inputs.arv === "number" && f.inputs.arv >= (f.inputs.asIs ?? 0) && typeof f.inputs.rehab === "number",
    );
    // Worksheet rows plus one synthetic row so the loop always runs even if every fixture has arv < asIs.
    rows.push({ inputs: { asIs: 200000, arv: 260000, rehab: 35000 } });
    for (const row of rows) {
      const i = { asIs: row.inputs.asIs, arv: row.inputs.arv, rehab: row.inputs.rehab };
      const expected = calculateClosr({ ...DEFAULT_INPUTS, ...i });
      const a = computeAnchors({ ...i, verifyFirst: false });
      expect(a.asIsDependent.equity).toEqual({ status: "ok", value: expected.equity });
      expect(a.asIsDependent.family).toEqual({ status: "ok", value: expected.family });
      expect(a.asIsDependent.secure).toEqual({ status: "ok", value: expected.secure });
      expect(a.asIsDependent.rapid).toEqual({ status: "ok", value: expected.rapid });
      expect(a.arvDependent.arv70).toEqual({ status: "ok", value: expected.arv70 });
      expect(a.arvDependent.investor).toEqual({ status: "ok", value: expected.investor });
      expect(a.arvDependent.fee40000).toEqual({ status: "ok", value: expected.offers.fee40000 });
      expect(a.arvDependent.fee10000).toEqual({ status: "ok", value: expected.offers.fee10000 });
    }
  });
});
