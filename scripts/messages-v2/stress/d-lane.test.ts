import { describe, expect, it } from "vitest";

import { compareSnapshots, type Snapshot } from "./cleanup";
import { assertCanaryOrg, assertRunId, BMH_ORG_ID, CANARY_ORG_ID, runTag } from "./d-lane-fixture";
import { chicagoYesterday, HOLD_REASONS } from "./load-seed";

const snap = (tables: Snapshot["tables"]): Snapshot => ({ at: "", tag: "STRESS t-1", orgId: CANARY_ORG_ID, tables, sha256: "" });

describe("Messages v2 stress D lane (Runs 4, 6, 7): pure guards", () => {
  it("refuses BMH's org and any org other than the canary org", () => {
    expect(() => assertCanaryOrg(BMH_ORG_ID)).toThrow(/BMH/);
    expect(() => assertCanaryOrg("00000000-0000-0000-0000-000000000ccc")).toThrow(/not the stress canary org/);
    expect(() => assertCanaryOrg(CANARY_ORG_ID)).not.toThrow();
  });

  it("refuses run ids that could widen the tag match", () => {
    for (const bad of ["", "abc", "a%b-1", "x_y-12", "a b-12", "abc'--", "x".repeat(41)]) expect(() => assertRunId(bad)).toThrow();
    expect(() => assertRunId("ui-r4b")).not.toThrow();
    expect(runTag("ui-r4b")).toBe("STRESS ui-r4b");
  });

  it("cleanup verdict: ok only when every untagged count is unchanged and no tagged row is left", () => {
    const before = snap({ properties: { total: 10, tagged: 0, untagged: 10 }, messages: { total: 5, tagged: 0, untagged: 5 } });
    expect(compareSnapshots(before, snap({ properties: { total: 10, tagged: 0, untagged: 10 }, messages: { total: 5, tagged: 0, untagged: 5 } }))).toEqual({ ok: true, changedUntagged: [], taggedLeft: [] });
    expect(compareSnapshots(before, snap({ properties: { total: 9, tagged: 0, untagged: 9 }, messages: { total: 5, tagged: 0, untagged: 5 } }))).toEqual({ ok: false, changedUntagged: ["properties"], taggedLeft: [] });
    expect(compareSnapshots(before, snap({ properties: { total: 11, tagged: 1, untagged: 10 }, messages: { total: 5, tagged: 0, untagged: 5 } }))).toEqual({ ok: false, changedUntagged: [], taggedLeft: ["properties"] });
  });

  it("seeds inside one America/Chicago day and over a real reason set", () => {
    expect(chicagoYesterday(Date.parse("2026-10-16T04:30:00Z"))).toBe("2026-10-14");
    expect(chicagoYesterday(Date.parse("2026-10-16T06:30:00Z"))).toBe("2026-10-15");
    expect(new Set(HOLD_REASONS).size).toBe(HOLD_REASONS.length);
  });
});
