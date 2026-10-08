import { describe, expect, it } from "vitest";

import { loadReplayBatchId } from "./replay-batch";
import type { LooseSupabase } from "./queries";

function client(result: unknown, calls: Array<[string, unknown[]]> = []) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) {
    q[m] = (...a: unknown[]) => {
      calls.push([m, a]);
      return q;
    };
  }
  q.maybeSingle = () =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  return { from: () => q, rpc: () => null } as unknown as LooseSupabase;
}

describe("loadReplayBatchId", () => {
  it("returns the newest batch id for the org", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const id = await loadReplayBatchId(
      client({ data: { id: "b1" }, error: null }, calls),
      "org-1",
    );
    expect(id).toBe("b1");
    expect(calls).toContainEqual(["eq", ["org_id", "org-1"]]);
    expect(calls).toContainEqual(["order", ["created_at", { ascending: false }]]);
    expect(calls).toContainEqual(["limit", [1]]);
  });
  it("returns null when no row", async () => {
    expect(
      await loadReplayBatchId(client({ data: null, error: null }), "o"),
    ).toBeNull();
  });
  it("returns null on error or throw", async () => {
    expect(
      await loadReplayBatchId(
        client({ data: null, error: { message: "no table" } }),
        "o",
      ),
    ).toBeNull();
    expect(await loadReplayBatchId(client(new Error("boom")), "o")).toBeNull();
  });
});
