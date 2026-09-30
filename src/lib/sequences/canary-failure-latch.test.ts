import { afterEach, describe, expect, it, vi } from "vitest";
import { assertNoUnacknowledgedCanaryFailure } from "./canary-failure-latch";

afterEach(() => vi.unstubAllGlobals());

function mockHistory(conclusion: string, ack = "") {
  const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(
    url.includes("FAILURE_ACK_RUN_ID") ? { value: ack } : {
      workflow_runs: [{ id: 99, run_number: 99, run_attempt: 1, event: "schedule", status: "completed", conclusion }],
      total_count: 1,
    },
  ), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("canary failure latch", () => {
  const run = (id: number, status: string, conclusion: string | null, run_attempt = 1) => ({
    id, run_number: id, created_at: `2026-09-30T00:${String(id).padStart(2, "0")}:00Z`,
    run_attempt, event: "schedule", status, conclusion,
  });

  function mockRuns(runs: ReturnType<typeof run>[], ack = "", attempts: Record<number, string> = {}) {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("FAILURE_ACK_RUN_ID")) return new Response(JSON.stringify({ value: ack }));
      const attempt = url.match(/\/attempts\/(\d+)$/);
      if (attempt) return new Response(JSON.stringify({
        id: runs[0]?.id, run_attempt: Number(attempt[1]), status: "completed",
        conclusion: attempts[Number(attempt[1])] ?? "success",
      }));
      return new Response(JSON.stringify({ workflow_runs: runs, total_count: runs.length }));
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("blocks run 100 while failed run 99 is queued for rerun after success 98", async () => {
    const fetchMock = mockRuns([run(98, "completed", "success"), run(99, "queued", null, 2)]);
    await expect(assertNoUnacknowledgedCanaryFailure("100", "token"))
      .rejects.toThrow(/prior full run unresolved/);
    expect(fetchMock.mock.calls[0][0]).not.toContain("status=completed");
  });
  it("blocks a prior in-progress full run", async () => {
    mockRuns([run(99, "in_progress", null)]);
    await expect(assertNoUnacknowledgedCanaryFailure("100", "token"))
      .rejects.toThrow(/prior full run unresolved/);
  });
  it("excludes the current run and checks the newest other run", async () => {
    mockRuns([run(100, "in_progress", null), run(99, "completed", "success")]);
    await expect(assertNoUnacknowledgedCanaryFailure("100", "token"))
      .resolves.toBeUndefined();
  });
  it("blocks a successful rerun after a failed earlier attempt", async () => {
    mockRuns([run(99, "completed", "success", 2)], "", { 1: "failure" });
    await expect(assertNoUnacknowledgedCanaryFailure("100", "token"))
      .rejects.toThrow(/prior full run 99/);
  });
  it("allows an acknowledged failed earlier attempt", async () => {
    mockRuns([run(99, "completed", "success", 2)], "99", { 1: "failure" });
    await expect(assertNoUnacknowledgedCanaryFailure("100", "token"))
      .resolves.toBeUndefined();
  });
  it("fails closed when an earlier attempt lookup fails", async () => {
    const fetchMock = mockRuns([run(99, "completed", "success", 2)]);
    fetchMock.mockImplementation(async (url: string) => new Response(JSON.stringify(
      url.includes("/attempts/1") ? { message: "error" } :
        { workflow_runs: [run(99, "completed", "success", 2)], total_count: 1 },
    ), { status: url.includes("/attempts/1") ? 500 : 200 }));
    await expect(assertNoUnacknowledgedCanaryFailure("100", "token"))
      .rejects.toThrow(/history unavailable/);
  });
  it("fails closed on incomplete pagination", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      workflow_runs: [run(99, "completed", "success")], total_count: 101,
    }))));
    await expect(assertNoUnacknowledgedCanaryFailure("100", "token"))
      .rejects.toThrow(/history unavailable/);
  });
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
        { id: 99, run_number: 99, run_attempt: 1, event: "schedule", status: "completed", conclusion: "skipped" },
        { id: 98, run_number: 98, run_attempt: 1, event: "schedule", status: "completed", conclusion: "success" },
      ] },
    )));
    vi.stubGlobal("fetch", fetchMock);
    await expect(assertNoUnacknowledgedCanaryFailure("100", "token")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  function mockSkippedRerun(firstConclusion: "failure" | "skipped", ack = "") {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("FAILURE_ACK_RUN_ID")) return new Response(JSON.stringify({ value: ack }));
      if (url.includes("/attempts/1/jobs") || url.includes("/attempts/2/jobs")) return new Response(JSON.stringify({ total_count: 1, jobs: [
        { name: "Sequences V1 Prod Canary", status: "completed", conclusion: "skipped", started_at: null },
      ] }));
      if (url.includes("/attempts/1")) return new Response(JSON.stringify({
        id: 99, run_attempt: 1, status: "completed", conclusion: firstConclusion,
      }));
      if (url.includes("/jobs?")) return new Response(JSON.stringify({ total_count: 1, jobs: [
        { name: "Sequences V1 Prod Canary", status: "completed", conclusion: "skipped", started_at: null },
      ] }));
      return new Response(JSON.stringify({ total_count: 2, workflow_runs: [
        run(99, "completed", "skipped", 2), run(98, "completed", "success"),
      ] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  it("blocks a skipped second attempt when its first attempt failed", async () => {
    const fetchMock = mockSkippedRerun("failure");
    await expect(assertNoUnacknowledgedCanaryFailure("100", "token"))
      .rejects.toThrow(/prior full run 99/);
    expect(fetchMock.mock.calls.some(([url]) => url.includes("/attempts/1"))).toBe(true);
  });
  it("allows a skipped second attempt only after verifying its first never-started skip", async () => {
    const fetchMock = mockSkippedRerun("skipped");
    await expect(assertNoUnacknowledgedCanaryFailure("100", "token")).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.some(([url]) => url.includes("/attempts/1/jobs"))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => url.includes("/attempts/2/jobs"))).toBe(true);
  });
  it("blocks a skipped second attempt when the first skipped job had started", async () => {
    const fetchMock = mockSkippedRerun("skipped");
    const originalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string) => url.includes("/attempts/1/jobs")
      ? new Response(JSON.stringify({ total_count: 1, jobs: [
        { name: "Sequences V1 Prod Canary", status: "completed", conclusion: "skipped", started_at: "2026-09-30T01:00:00Z" },
      ] })) : originalFetch(url));
    await expect(assertNoUnacknowledgedCanaryFailure("100", "token"))
      .rejects.toThrow(/prior full run 99/);
  });
  it("allows an acknowledged failure before a skipped second attempt", async () => {
    const fetchMock = mockSkippedRerun("failure", "99");
    await expect(assertNoUnacknowledgedCanaryFailure("100", "token")).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.some(([url]) => url.includes("FAILURE_ACK_RUN_ID"))).toBe(true);
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
        { id: 99, run_number: 99, run_attempt: 1, event: "schedule", status: "completed", conclusion: "skipped" },
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
      { id: 101, run_number: 101, run_attempt: 1, event: "workflow_dispatch", display_title: "Sequences V1 Prod Canary preflight-only", status: "completed", conclusion: "success" },
      { id: 99, run_number: 99, run_attempt: 1, event: "schedule", status: "completed", conclusion: "failure" },
    ], total_count: 2 }))));
    await expect(assertNoUnacknowledgedCanaryFailure("102", "token"))
      .rejects.toThrow(/prior full run/);
  });
  it("blocks an ambiguous legacy manual run until its ID is acknowledged", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
      url.includes("FAILURE_ACK_RUN_ID") ? { value: "" } : { workflow_runs: [
        { id: 99, run_number: 99, run_attempt: 1, event: "workflow_dispatch", display_title: "old title", status: "completed", conclusion: "success" },
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
