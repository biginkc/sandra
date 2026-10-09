import { describe, expect, it } from "vitest";

import { getPipelineCoverage, sweepStalePipelineRuns } from "./maintenance";

describe("sweepStalePipelineRuns", () => {
  it("marks old running rows as error/stale_running", async () => {
    const calls: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {};
    builder.update = (p: unknown) => ((calls.payload = p), builder);
    builder.eq = (c: string, v: unknown) => ((calls.eq = [c, v]), builder);
    builder.lt = (c: string, v: unknown) => ((calls.lt = [c, v]), builder);
    builder.select = async () => ({ data: [{ id: "a" }, { id: "b" }], error: null });
    const now = new Date("2026-10-08T12:00:00.000Z");
    const result = await sweepStalePipelineRuns({ from: () => builder } as never, {
      olderThanMinutes: 30,
      now,
    });
    expect(result).toEqual({ swept: 2 });
    expect(calls.payload).toMatchObject({ status: "error", reason: "stale_running" });
    expect(calls.eq).toEqual(["status", "running"]);
    expect(calls.lt).toEqual(["started_at", "2026-10-08T11:30:00.000Z"]);
  });

  it("throws on db error", async () => {
    const builder: Record<string, unknown> = {};
    builder.update = () => builder;
    builder.eq = () => builder;
    builder.lt = () => builder;
    builder.select = async () => ({ data: null, error: { message: "nope" } });
    await expect(sweepStalePipelineRuns({ from: () => builder } as never)).rejects.toThrow("nope");
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
