import { describe, expect, it } from "vitest";

import { buildReport, type ScaleSize } from "./report";
import type { FamilyRun } from "./runner";
import { requiredFullLanes } from "./reps";

const run = (over: Partial<FamilyRun> = {}): FamilyRun => ({ family: "f", title: "f", worlds: 1, leads: 3, checks: 10, mismatches: [], errors: [], timings: {}, ms: 1, variantLeads: {}, variantFailures: {}, ...over });
const size = (leads: number, p95: number, n = 10): ScaleSize => ({ leads, messagesPerLead: [4, 12], messages: 1, seedMs: 1, worstP95Ms: p95, budgetMs: 1500,
  timings: { "page:all:all": { n, p50: p95, p95, max: p95 } } });
const allLanes = requiredFullLanes().map((r) => ({ id: r.id, title: "", runs: r.minRuns, failures: 0, samples: [] as unknown[] }));
const base = { mode: "full" as const, seed: 1, repeats: 20, sha: "x", database: "127.0.0.1:1", startedAt: "", lanes: allLanes };
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
  it("fails a full run below the volume floors (repeats, race reps, bind reps, scale samples) and records them", () => {
    const ok = { ...base, runs: families, scale: [size(400, 300), size(2000, 900)] };
    expect(buildReport({ ...ok, repeats: 19 }).verdict).toBe("FAIL");
    const short = (id: string, runs: number) => ok.lanes.map((l) => (l.id === id ? { ...l, runs } : l));
    expect(buildReport({ ...ok, lanes: short("race:stamped_send_vs_inbound", 199) }).verdict).toBe("FAIL");
    expect(buildReport({ ...ok, lanes: short("race:dispatch_bind_failure", 19) }).verdict).toBe("FAIL");
    expect(buildReport({ ...ok, scale: [size(400, 300, 9), size(2000, 900)] }).verdict).toBe("FAIL");
    const r = buildReport({ ...ok, raceReps: 200, scaleSamples: 10 });
    expect(r.verdict).toBe("PASS");
    expect([r.raceReps, r.scaleSamples]).toEqual([200, 10]);
  });
  it.each(requiredFullLanes().map((r) => r.id))("a full run without required lane %s FAILS, naming it", (id) => {
    const r = buildReport({ ...base, lanes: base.lanes.filter((l) => l.id !== id), runs: families, scale: [size(400, 300), size(2000, 900)] });
    expect(r.verdict).toBe("FAIL");
    expect(r.failReasons.join("\n")).toContain(`required lane ${id} is missing`);
  });
  it("a full run with a required lane skipped, or a scale size missing, FAILS", () => {
    const lanes = base.lanes.map((l, i) => (i === 0 ? { ...l, skipped: "no" } : l));
    expect(buildReport({ ...base, lanes, runs: families, scale: [size(400, 300), size(2000, 900)] }).verdict).toBe("FAIL");
    expect(buildReport({ ...base, runs: families, scale: [size(400, 300)] }).failReasons.join("\n")).toContain("required scale size 2000 is missing");
  });
});
