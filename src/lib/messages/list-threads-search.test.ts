import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/supabase/types";
import { listThreadPage } from "./list-threads";
const opts = { filter: "all" as const, currentUserId: null, includeThreadId: null, hideNoise: true, page: 1 };
const document = { rows: [], total: 0, hidden_count: 0, limit: 200, offset: 0,
  counts: { all: 0, mine: 0, unassigned: 0, unread: 0, escalated: 0, dispo: 0, needs_outcome: 0 } };
describe("inbox search rollout", () => {
  it.each(["PGRST202", "PGRST203"])("retries %s once without search and exposes degradation", async (code) => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: null, error: { code, message: "missing" } })
      .mockResolvedValueOnce({ data: document, error: null });
    const result = await listThreadPage({ rpc } as unknown as SupabaseClient<Database>, { ...opts, search: "  Zephyrson  " });
    expect(result.degraded).toBe(true); expect(result.threads).toEqual([]);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][1].p_search).toBe("Zephyrson");
    expect(rpc.mock.calls[1][1]).not.toHaveProperty("p_search");
    const original = { ...rpc.mock.calls[0][1] };
    delete original.p_search;
    expect(rpc.mock.calls[1][1]).toEqual(original);
  });
  it.each([undefined, "ab", " a "])("explicitly sends null search for %s", async (search) => {
    const rpc = vi.fn().mockResolvedValue({ data: document, error: null });
    expect((await listThreadPage({ rpc } as unknown as SupabaseClient<Database>, { ...opts, search })).degraded).toBe(false);
    expect(rpc.mock.calls[0][1]).toHaveProperty("p_search", null);
  });
  it("does not hide SQL errors or retry indefinitely", async () => {
    for (const codes of [["XX000"], ["PGRST202", "PGRST202"]]) {
      const rpc = vi.fn();
      for (const code of codes) rpc.mockResolvedValueOnce({ data: null, error: { code, message: "broken" } });
      await expect(listThreadPage({ rpc } as unknown as SupabaseClient<Database>, opts)).rejects.toThrow("broken");
      expect(rpc).toHaveBeenCalledTimes(codes.length);
    }
  });
});
