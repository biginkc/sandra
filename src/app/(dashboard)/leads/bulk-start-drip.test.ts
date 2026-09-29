import { describe, expect, it, vi } from "vitest";
import { groupBulkDripResults, startBulkDrip } from "./bulk-start-drip";

vi.mock("@/app/(dashboard)/sequences/actions", () => ({ startDripForLeads: vi.fn() }));

describe("startBulkDrip", () => {
  it("waits for each chunk before issuing the next one", async () => {
    const leads = Array.from({ length: 250 }, (_, index) => ({ id: `id-${index}`, address: `${index} Main St` }));
    type Success = { ok: true; data: { results: { propertyId: string; status: "enrolled"; reason: string }[] } };
    const enrolled = (ids: string[]): Success => ({
      ok: true,
      data: { results: ids.map((propertyId) => ({ propertyId, status: "enrolled", reason: "Enrolled" })) },
    });
    let resolveFirst!: (value: Success) => void;
    let resolveSecond!: (value: Success) => void;
    const first = new Promise<Success>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<Success>((resolve) => { resolveSecond = resolve; });
    const start = vi.fn((_sequence: string, ids: string[]) => {
      if (ids[0] === "id-0") return first;
      if (ids[0] === "id-100") return second;
      return Promise.resolve(enrolled(ids));
    });

    const pending = startBulkDrip("drip", leads, vi.fn(), start);
    expect(start).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);

    resolveFirst(enrolled(leads.slice(0, 100).map((lead) => lead.id)));
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start).toHaveBeenNthCalledWith(2, "drip", leads.slice(100, 200).map((lead) => lead.id));
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(2);

    resolveSecond(enrolled(leads.slice(100, 200).map((lead) => lead.id)));
    const results = await pending;
    expect(start).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(250);
  });

  it("runs 250 leads in ordered 100, 100, 50 batches and preserves earlier results after a failed batch", async () => {
    const leads = Array.from({ length: 250 }, (_, index) => ({ id: `id-${index}`, address: `${index} Main St` }));
    const calls: string[][] = [];
    const progress: number[] = [];
    const start = vi.fn(async (_sequence: string, ids: string[]) => {
      calls.push(ids);
      if (calls.length === 2) return { ok: false as const, error: { code: "FAILED", message: "Batch unavailable" } };
      return { ok: true as const, data: { results: ids.map((propertyId) => ({ propertyId, status: "enrolled" as const, reason: "Enrolled" })) } };
    });
    const results = await startBulkDrip("drip", leads, (done) => progress.push(done), start);
    expect(calls.map((ids) => ids.length)).toEqual([100, 100, 50]);
    expect(calls[0][0]).toBe("id-0");
    expect(calls[1][0]).toBe("id-100");
    expect(calls[2][0]).toBe("id-200");
    expect(progress).toEqual([100, 200, 250]);
    expect(results.filter((result) => result.status === "enrolled")).toHaveLength(150);
    expect(results.slice(100, 200).every((result) => result.reason === "Batch unavailable")).toBe(true);
  });

  it.each(["UNAUTHENTICATED", "SESSION_EXPIRED"])("stops after %s and fails unattempted leads", async (code) => {
    const leads = Array.from({ length: 250 }, (_, index) => ({ id: `id-${index}`, address: `${index} Main St` }));
    const progress: number[] = [];
    const start = vi.fn(async (_sequence: string, ids: string[]) => {
      if (ids[0] === "id-100") return { ok: false as const, error: { code, message: "Not signed in" } };
      return { ok: true as const, data: { results: ids.map((propertyId) => ({ propertyId, status: "enrolled" as const, reason: "Enrolled" })) } };
    });

    const results = await startBulkDrip("drip", leads, (done) => progress.push(done), start);
    expect(start).toHaveBeenCalledTimes(2);
    expect(progress).toEqual([100, 250]);
    expect(results).toHaveLength(250);
    expect(results.slice(0, 100).every((result) => result.status === "enrolled")).toBe(true);
    expect(results.slice(100, 200).every((result) => result.status === "failed" && result.reason === "Not signed in")).toBe(true);
    expect(results.slice(200).every((result) => result.status === "failed" && result.reason === "Stopped: your session ended. Sign in and try again.")).toBe(true);
  });

  it("groups skipped and failed reasons with their addresses", () => {
    const groups = groupBulkDripResults([
      { propertyId: "a", address: "1 Main", status: "enrolled", reason: "Enrolled" },
      { propertyId: "b", address: "2 Main", status: "skipped", reason: "Already in this drip" },
      { propertyId: "c", address: "3 Main", status: "skipped", reason: "Already in this drip" },
      { propertyId: "d", address: "4 Main", status: "failed", reason: "Could not enroll" },
    ]);
    expect(groups.map((group) => [group.status, group.reason, group.leads.map((lead) => lead.address)])).toEqual([
      ["skipped", "Already in this drip", ["2 Main", "3 Main"]],
      ["failed", "Could not enroll", ["4 Main"]],
    ]);
  });
});
