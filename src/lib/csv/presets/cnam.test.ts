import { describe, expect, it } from "vitest";

import { cnamPreset } from "./cnam";

describe("cnamPreset.detect", () => {
  it("returns 1.0 for exactly two columns: phones + cnam", () => {
    const r = cnamPreset.detect(["phones", "cnam"], []);
    expect(r?.id).toBe("cnam");
    expect(r?.confidence).toBe(1.0);
  });
  it("returns null when other columns are present", () => {
    expect(cnamPreset.detect(["phones", "cnam", "extra"], [])).toBeNull();
  });
  it("returns null when only one of the two headers is present", () => {
    expect(cnamPreset.detect(["phones"], [])).toBeNull();
  });
  it("empty headers → null", () => {
    expect(cnamPreset.detect([], [])).toBeNull();
  });
});

describe("cnamPreset", () => {
  it("is flagged non-importable", () => {
    expect(cnamPreset.importable).toBe(false);
  });
  it("transform passes input through unchanged with redirect note", () => {
    const rows = [{ phones: "+18165551001", cnam: "Jane Smith" }];
    const r = cnamPreset.transform(rows, ["phones", "cnam"]);
    expect(r.rows).toEqual(rows);
    expect(r.stats.notes.some((n) => /enrichment/i.test(n))).toBe(true);
  });
});
