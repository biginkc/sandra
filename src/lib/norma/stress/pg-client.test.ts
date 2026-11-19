import { describe, expect, it } from "vitest";

import { parseLogicList } from "./pg-client";

// The stress harness's stand-in for supabase-js .or() must fail loudly on
// anything PostgREST would reject or that it does not decode.
describe("pg-client or() parser", () => {
  it("parses the stop filter", () => {
    expect(parseLogicList("status.eq.active,and(status.eq.paused,pause_reason.eq.reconciliation_required)")).toEqual([
      { kind: "cond", col: "status", op: "eq", value: "active" },
      {
        kind: "and",
        items: [
          { kind: "cond", col: "status", op: "eq", value: "paused" },
          { kind: "cond", col: "pause_reason", op: "eq", value: "reconciliation_required" },
        ],
      },
    ]);
  });

  it.each([
    ["trailing comma", "status.eq.active,"],
    ["leading comma", ",status.eq.active"],
    ["double comma", "status.eq.active,,status.eq.paused"],
    ["empty nested clause", "and(status.eq.paused,)"],
    ["empty expression", ""],
  ])("rejects an empty clause (%s)", (_label, expr) => {
    expect(() => parseLogicList(expr)).toThrow(/empty clause/);
  });

  it.each(["and(status.eq.paused", "status.eq.active)", ")(", "and(status.eq.paused))"])(
    "rejects unbalanced parentheses: %s",
    (expr) => {
      expect(() => parseLogicList(expr)).toThrow(/unbalanced/);
    },
  );

  it.each(["status.gt.1", "status.in.(a,b)", "status.like.*x*", "not.status.eq.active", "status.is.unknown", "status"])(
    "rejects an unsupported operator: %s",
    (expr) => {
      expect(() => parseLogicList(expr)).toThrow(/not modelled/);
    },
  );

  it.each(['status.eq."active"', 'pause_reason.eq."a,b"', "status.eq.a\\,b", "status.eq."])(
    "rejects a quoted, escaped or empty value: %s",
    (expr) => {
      expect(() => parseLogicList(expr)).toThrow();
    },
  );
});
