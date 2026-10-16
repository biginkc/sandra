import { describe, expect, it } from "vitest";

import { parseScorecardRows } from "./scorecard";

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

