import { afterEach, describe, expect, it, vi } from "vitest";
import { assertNoUnacknowledgedCanaryFailure } from "./canary-failure-latch";

afterEach(() => vi.unstubAllGlobals());

function mockHistory(conclusion: string, ack = "") {
  const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(
    url.includes("FAILURE_ACK_RUN_ID") ? { value: ack } : {
      workflow_runs: [{ id: 99, event: "schedule", status: "completed", conclusion }],
      total_count: 1,
    },
  ), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("canary failure latch", () => {
  it.each(["failure", "cancelled", "timed_out"])("blocks after a %s full run", async conclusion => {
    mockHistory(conclusion);
    await expect(assertNoUnacknowledgedCanaryFailure("100", "token"))
      .rejects.toThrow(/prior full run/);
  });
  it("ignores a skipped schedule whose full job never started", async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.includes("/jobs?") ? { total_count: 1, jobs: [
        { name: "Sequences V1 Prod Canary", status: "completed", conclusion: "skipped", started_at: null },
      ] } : { total_count: 2, workflow_runs: [
        { id: 99, event: "schedule", status: "completed", conclusion: "skipped" },
        { id: 98, event: "schedule", status: "completed", conclusion: "success" },
      ] },
    )));
    vi.stubGlobal("fetch", fetchMock);
    await expect(assertNoUnacknowledgedCanaryFailure("100", "token")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("blocks a cancelled full run even if its job never started", async () => {
    mockHistory("cancelled");
    await expect(assertNoUnacknowledgedCanaryFailure("100", "token"))
      .rejects.toThrow(/prior full run 99/);
  });
  it("blocks a skipped full run whose job started", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
      url.includes("/jobs?") ? { total_count: 1, jobs: [
        { name: "Sequences V1 Prod Canary", status: "completed", conclusion: "skipped", started_at: "2026-09-30T14:17:00Z" },
      ] } : url.includes("FAILURE_ACK_RUN_ID") ? { value: "" } : { total_count: 1, workflow_runs: [
        { id: 99, event: "schedule", status: "completed", conclusion: "skipped" },
      ] },
    ))));
    await expect(assertNoUnacknowledgedCanaryFailure("100", "token"))
      .rejects.toThrow(/prior full run 99/);
  });
  it("allows a matching operator acknowledgement", async () => {
    mockHistory("failure", "99");
    await expect(assertNoUnacknowledgedCanaryFailure("100", "token")).resolves.toBeUndefined();
  });
  it("allows a prior success", async () => {
    mockHistory("success");
    await expect(assertNoUnacknowledgedCanaryFailure("100", "token")).resolves.toBeUndefined();
  });
  it("skips a completed preflight and checks the preceding full run", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ workflow_runs: [
      { id: 101, event: "workflow_dispatch", display_title: "Sequences V1 Prod Canary preflight-only", status: "completed", conclusion: "success" },
      { id: 99, event: "schedule", status: "completed", conclusion: "failure" },
    ], total_count: 2 }))));
    await expect(assertNoUnacknowledgedCanaryFailure("102", "token"))
      .rejects.toThrow(/prior full run/);
  });
  it("blocks an ambiguous legacy manual run until its ID is acknowledged", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
      url.includes("FAILURE_ACK_RUN_ID") ? { value: "" } : { workflow_runs: [
        { id: 99, event: "workflow_dispatch", display_title: "old title", status: "completed", conclusion: "success" },
      ], total_count: 1 },
    ))));
    await expect(assertNoUnacknowledgedCanaryFailure("100", "token"))
      .rejects.toThrow(/ambiguous mode/);
  });
  it("fails closed on lookup error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    await expect(assertNoUnacknowledgedCanaryFailure("100", "token"))
      .rejects.toThrow(/history unavailable/);
  });
});
