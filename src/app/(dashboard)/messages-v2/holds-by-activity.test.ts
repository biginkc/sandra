import { describe, expect, it } from "vitest";

import { collectHoldPropertyIds, loadHoldsSlice } from "./holds-by-activity";
import type { LooseSupabase } from "./queries";

/** A fake RPC serving two buckets of property ids, plus empty tables for everything else. */
function client(newIds: string[], backlogIds: string[]): LooseSupabase {
  const empty = () => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "is", "gte", "lt", "order", "limit"]) q[m] = () => q;
    q.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
    return q;
  };
  return {
    from: () => empty(),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn !== "messages_v2_hold_buckets") return { data: [], error: null };
      const ids = args.p_bucket === "new" ? newIds : backlogIds;
      const off = Number(args.p_offset);
      const lim = Number(args.p_limit);
      return {
        data: {
          cutover: "2026-10-08T00:00:00Z",
          new_total: newIds.length,
          backlog_total: backlogIds.length,
          rows: ids.slice(off, off + lim).map((property_id) => ({ property_id })),
        },
        error: null,
      };
    },
  } as unknown as LooseSupabase;
}

describe("collectHoldPropertyIds", () => {
  it("gathers every New id (past the old 300 page) and then every Backlog id", async () => {
    const newIds = Array.from({ length: 650 }, (_, i) => `n${i}`);
    const out = await collectHoldPropertyIds(client(newIds, ["b1", "b2"]), "org");
    expect(out?.ids).toHaveLength(652);
    expect(out?.ids).toContain("n649");
    expect(out?.ids).toContain("b2");
    expect(out?.capped).toBe(false);
  });

  it("reports a failed classification as null, never as 'no holds'", async () => {
    const bad = { from: () => ({}), rpc: async () => ({ data: null, error: { message: "x" } }) } as unknown as LooseSupabase;
    expect(await collectHoldPropertyIds(bad, "org")).toBeNull();
    expect(await loadHoldsSlice(bad, "org", 0, 10)).toBeNull();
  });
});
