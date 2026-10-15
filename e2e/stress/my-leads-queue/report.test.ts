import { describe, expect, it } from "vitest";

import { buildReport, type ScaleSize } from "./report";
import type { FamilyRun } from "./runner";

const run = (over: Partial<FamilyRun> = {}): FamilyRun => ({ family: "f", title: "f", worlds: 1, leads: 3, checks: 10, mismatches: [], errors: [], timings: {}, ms: 1, variantLeads: {}, variantFailures: {}, ...over });
const size = (leads: number, p95: number, n = 3): ScaleSize => ({ leads, messagesPerLead: [4, 12], messages: 1, seedMs: 1, worstP95Ms: p95, budgetMs: 1500,
  timings: { "page:all:all": { n, p50: p95, p95, max: p95 } } });
const base = { mode: "full" as const, seed: 1, repeats: 1, sha: "x", database: "127.0.0.1:1", startedAt: "", lanes: [{ id: "race:dispatch_x", title: "", runs: 1, failures: 0, samples: [] }] };
const families = Array.from({ length: 31 }, (_, i) => run({ family: `f${i}` }));

describe("report gating", () => {
  it("passes a real run within budget", () => {
    expect(buildReport({ ...base, runs: families, scale: [size(400, 300), size(2000, 900)] }).verdict).toBe("PASS");
  });
  it("fails a zero-work run: families with no worlds or checks", () => {
    const r = buildReport({ ...base, runs: families.map((f) => ({ ...f, worlds: 0, checks: 0, leads: 0 })), scale: [size(400, 300), size(2000, 900)] });
    expect(r.verdict).toBe("FAIL");
    expect(r.failReasons.join("\n")).toMatch(/executed 0 worlds/);
  });
  it("fails a scale size with no samples, empty timings or non-finite numbers", () => {
    for (const bad of [size(2000, 0, 0), { ...size(2000, 0), timings: {} }, size(2000, Number.NaN)])
      expect(buildReport({ ...base, runs: families, scale: [size(400, 300), bad] }).verdict).toBe("FAIL");
  });
  it("fails when either required size is over budget or missing", () => {
    expect(buildReport({ ...base, runs: families, scale: [size(400, 300), size(2000, 8400)] }).verdict).toBe("FAIL");
    expect(buildReport({ ...base, runs: families, scale: [size(400, 300)] }).verdict).toBe("FAIL");
  });
  it("fails a lane that executed nothing", () => {
    const r = buildReport({ ...base, lanes: [...base.lanes, { id: "race:stamped_send_vs_inbound", title: "", runs: 0, failures: 0, samples: [] }], runs: families, scale: [size(400, 300), size(2000, 900)] });
    expect(r.verdict).toBe("FAIL");
  });
});
