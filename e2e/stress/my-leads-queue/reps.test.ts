import { describe, expect, it } from "vitest";

import { parsePositiveInt } from "./reps";

describe("rep count parsing", () => {
  it("accepts positive integers and falls back when unset", () => {
    expect(parsePositiveInt("12", 6, "X")).toBe(12);
    expect(parsePositiveInt(undefined, 6, "X")).toBe(6);
    expect(parsePositiveInt("", 6, "X")).toBe(6);
  });
  it.each(["0", "-1", "NaN", "1.5", "abc", "Infinity", " "])("refuses %j", (raw) => {
    expect(() => parsePositiveInt(raw, 6, "MYLEADS_STRESS_DISPATCH_REPS")).toThrow(/positive integer/);
  });
});
