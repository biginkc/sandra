import { describe, expect, it } from "vitest";

import { getPipelineCoverage, sweepStalePipelineRuns } from "./maintenance";

type Step = { run_id: string; created_at: string; detail: Record<string, unknown> };

function sweepAdmin(runIds: string[], steps: Step[], opts: { error?: string } = {}) {
  const calls: { candidateFilters: unknown[]; updatedIds: string[] | null; payload: unknown; stepNames: unknown } = {
    candidateFilters: [],
    updatedIds: null,
    payload: null,
    stepNames: null,
  };
  const admin = {
    from(table: string) {
      const b: Record<string, unknown> = {};
      let isUpdate = false;
      let ids: string[] = [];
      b.select = () => b;
      b.update = (p: unknown) => ((isUpdate = true), (calls.payload = p), b);
      b.eq = (c: string, v: unknown) => (!isUpdate && table === "pipeline_runs" && calls.candidateFilters.push([c, v]), b);
      b.lt = (c: string, v: unknown) => (calls.candidateFilters.push([c, v]), b);
      b.in = (c: string, v: unknown) => {
        if (c === "name") calls.stepNames = v;
        if (c === "id" || c === "run_id") ids = v as string[];
        if (isUpdate && c === "id") calls.updatedIds = ids;
        return b;
      };
      b.then = (resolve: (v: unknown) => void) => {
        if (opts.error) return resolve({ data: null, error: { message: opts.error } });
        if (table === "pipeline_run_steps") {
          return resolve({ data: steps.filter((s) => ids.includes(s.run_id)), error: null });
        }
        if (isUpdate) return resolve({ data: ids.map((id) => ({ id })), error: null });
        return resolve({ data: runIds.map((id) => ({ id })), error: null });
      };
      return b;
    },
  };
  return { admin: admin as never, calls };
}

describe("sweepStalePipelineRuns", () => {
  const now = new Date("2026-10-21T06:00:00.000Z");

  it("marks a plain stuck running row error/stale_running at 30 min", async () => {
    const { admin, calls } = sweepAdmin(["a", "b"], []);
    const result = await sweepStalePipelineRuns(admin, { olderThanMinutes: 30, now });
    expect(result).toEqual({ swept: 2 });
    expect(calls.payload).toMatchObject({ status: "error", reason: "stale_running" });
    expect(calls.candidateFilters).toContainEqual(["status", "running"]);
    expect(calls.candidateFilters).toContainEqual(["started_at", "2026-10-21T05:30:00.000Z"]);
    expect(calls.updatedIds).toEqual(["a", "b"]);
    expect(calls.stepNames).toEqual(["retry_scheduled", "nine_reply_deferred", "reply_delay_scheduled"]);
  });

  it("leaves a run deferred to the send window alone before wake + margin", async () => {
    // Deferred at 02:07 for ~11h; wake 13:07, so untouched at 06:00 and at 13:30.
    const steps = [{ run_id: "deferred", created_at: "2026-10-21T02:07:00.000Z", detail: { delaySeconds: 11 * 3600 } }];
    const early = sweepAdmin(["deferred", "stuck"], steps);
    expect(await sweepStalePipelineRuns(early.admin, { now })).toEqual({ swept: 1 });
    expect(early.calls.updatedIds).toEqual(["stuck"]);
    const nearWake = sweepAdmin(["deferred"], steps);
    expect(await sweepStalePipelineRuns(nearWake.admin, { now: new Date("2026-10-21T13:30:00.000Z") })).toEqual({ swept: 0 });
    expect(nearWake.calls.updatedIds).toBeNull();
  });

  it("sweeps a waiting run once it is past wake + margin", async () => {
    const steps = [{ run_id: "deferred", created_at: "2026-10-21T02:07:00.000Z", detail: { delaySeconds: 11 * 3600 } }];
    const late = sweepAdmin(["deferred"], steps);
    expect(await sweepStalePipelineRuns(late.admin, { now: new Date("2026-10-21T13:38:00.000Z") })).toEqual({ swept: 1 });
    expect(late.calls.updatedIds).toEqual(["deferred"]);
  });

  it("uses the latest wake when a run has several wait steps", async () => {
    const steps = [
      { run_id: "r", created_at: "2026-10-21T04:00:00.000Z", detail: { delaySeconds: 60 } },
      { run_id: "r", created_at: "2026-10-21T05:00:00.000Z", detail: { delaySeconds: 3600 } },
    ];
    const { admin } = sweepAdmin(["r"], steps);
    expect(await sweepStalePipelineRuns(admin, { now })).toEqual({ swept: 0 });
  });

  it("throws on db error", async () => {
    const { admin } = sweepAdmin(["a"], [], { error: "nope" });
    await expect(sweepStalePipelineRuns(admin)).rejects.toThrow("nope");
  });
});

describe("getPipelineCoverage", () => {
  it("returns inbound message and run counts for the window", async () => {
    const admin = {
      from: (table: string) => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = () => b;
        b.then = (resolve: (v: unknown) => void) =>
          resolve({ count: table === "messages" ? 5 : 4, error: null });
        b.gte = () => b;
        return b;
      },
    } as never;
    expect(await getPipelineCoverage(admin, "org-1", { sinceMinutes: 60 })).toEqual({
      inboundMessages: 5,
      runs: 4,
    });
  });
});
