import { describe, expect, it } from "vitest";

import { permitsPreset } from "./permits";

const HEADERS = [
  "PermitNum", "AppliedDate", "IssuedDate",
  "StatusCurrent", "StatusPrevious", "Comments",
];

describe("permitsPreset.detect", () => {
  it("returns 1.0 for the full signature", () => {
    const r = permitsPreset.detect(HEADERS, []);
    expect(r?.id).toBe("permits");
    expect(r?.confidence).toBe(1.0);
  });
  it("missing one signature header → null", () => {
    expect(permitsPreset.detect(["PermitNum", "AppliedDate"], [])).toBeNull();
  });
  it("empty headers → null", () => {
    expect(permitsPreset.detect([], [])).toBeNull();
  });
});

describe("permitsPreset", () => {
  it("is flagged non-importable", () => {
    expect(permitsPreset.importable).toBe(false);
  });
  it("transform passes input through unchanged with redirect note", () => {
    const rows = [{ PermitNum: "123", AppliedDate: "2026-01-01" }];
    const r = permitsPreset.transform(rows, HEADERS);
    expect(r.rows).toEqual(rows);
    expect(r.headers).toEqual(HEADERS);
    expect(r.stats.notes.some((n) => /enrichment/i.test(n))).toBe(true);
  });
});
