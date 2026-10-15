import { describe, expect, it } from "vitest";

import type { LooseSupabase } from "./queries";
import { loadRunThreads, previousDayWindow } from "./tape-data";

describe("previousDayWindow", () => {
  it("is the 24 hours before the boundary, with no gap or overlap", () => {
    expect(previousDayWindow("2026-10-14T12:00:00.000Z")).toEqual({ from: "2026-10-13T12:00:00.000Z", to: "2026-10-14T12:00:00.000Z" });
  });
  it("rejects a bad boundary", () => {
    expect(previousDayWindow("nope")).toBeNull();
  });
});

describe("loadRunThreads", () => {
  it("pairs each run with the newest outbound text sent before its inbound, and its own reply", async () => {
    const rows: Record<string, unknown[]> = {
      byId: [{ id: "out-reply", body: "Thanks, take care." }],
      byConv: [
        { conversation_id: "c1", body: "newer than the run", created_at: "2026-10-14T13:00:00Z" },
        { conversation_id: "c1", body: "Still own the place?", created_at: "2026-10-14T11:00:00Z" },
        { conversation_id: "c1", body: "older", created_at: "2026-10-13T11:00:00Z" },
      ],
    };
    const supabase = {
      from: () => {
        let mode: "byId" | "byConv" = "byId";
        const q: Record<string, unknown> = {};
        q.select = (cols: string) => { mode = cols.includes("conversation_id") ? "byConv" : "byId"; return q; };
        for (const m of ["in", "eq", "order", "limit"]) q[m] = () => q;
        q.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows[mode], error: null });
        return q;
      },
    } as unknown as LooseSupabase;
    const out = await loadRunThreads(supabase, [
      { id: "r1", conversation_id: "c1", outbound_message_id: "out-reply", started_at: "2026-10-14T12:00:00Z" },
      { id: "r2", conversation_id: null, outbound_message_id: null, started_at: "2026-10-14T12:00:00Z" },
    ]);
    expect(out.get("r1")).toEqual({ lastOutbound: "Still own the place?", reply: "Thanks, take care." });
    expect(out.get("r2")).toEqual({ lastOutbound: null, reply: null });
  });
});
