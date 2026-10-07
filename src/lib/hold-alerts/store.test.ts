import { describe, expect, it } from "vitest";

import type { LooseSupabase } from "@/app/(dashboard)/messages-v2/queries";

import { createSupabaseDeliveryStore } from "./store";

type Call = { method: string; args: unknown[] };

function fake(rows: Array<{ id: string; property_id: string | null; hold_key: string }>) {
  const updates: Array<{ patch: unknown; calls: Call[] }> = [];
  const selects: Call[][] = [];
  const client: LooseSupabase = {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from() {
      const calls: Call[] = [];
      let patch: unknown = null;
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "not", "order", "limit", "update", "gt"]) {
        q[m] = (...args: unknown[]) => {
          calls.push({ method: m, args });
          if (m === "update") patch = args[0];
          return q;
        };
      }
      q.then = (resolve: (v: unknown) => unknown) => {
        const isUpdate = calls.some((c) => c.method === "update");
        if (isUpdate) {
          updates.push({ patch, calls });
          return resolve({ data: [{ id: "x" }], error: null });
        }
        selects.push(calls);
        return resolve({ data: rows, error: null });
      };
      return q;
    },
  };
  return { client, updates, selects };
}

describe("DeliveryStore.archiveClosed", () => {
  it("archives only rows whose property is not open, appending :closed:<id> guarded on the old key", async () => {
    const t = fake([
      { id: "r1", property_id: "open", hold_key: "open:draft_held" },
      { id: "r2", property_id: "gone", hold_key: "gone:draft_held" },
    ]);
    const n = await createSupabaseDeliveryStore(t.client).archiveClosed("org", ["open"]);
    expect(n).toBe(1);
    expect(t.updates).toHaveLength(1);
    expect(t.updates[0]!.patch).toEqual({ hold_key: "gone:draft_held:closed:r2" });
    expect(t.updates[0]!.calls).toContainEqual({ method: "eq", args: ["id", "r2"] });
    expect(t.updates[0]!.calls).toContainEqual({ method: "eq", args: ["hold_key", "gone:draft_held"] });
  });

  it("selects per-hold rows only: org scoped, property set, not already archived", async () => {
    const t = fake([]);
    await createSupabaseDeliveryStore(t.client).archiveClosed("org", []);
    expect(t.selects[0]).toContainEqual({ method: "eq", args: ["org_id", "org"] });
    expect(t.selects[0]).toContainEqual({ method: "not", args: ["property_id", "is", null] });
    expect(t.selects[0]).toContainEqual({ method: "not", args: ["hold_key", "like", "%:closed:%"] });
  });

  it("pages by id cursor so closed rows past the first window still get archived", async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => ({
      id: `a${String(i).padStart(4, "0")}`,
      property_id: "open",
      hold_key: "open:draft_held",
    }));
    const page2 = [{ id: "b0001", property_id: "gone", hold_key: "gone:draft_held" }];
    const pages = [page1, page2];
    const selects: Call[][] = [];
    const updates: unknown[] = [];
    const client: LooseSupabase = {
      rpc: () => Promise.resolve({ data: null, error: null }),
      from() {
        const calls: Call[] = [];
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "not", "order", "limit", "update", "gt"]) {
          q[m] = (...args: unknown[]) => {
            calls.push({ method: m, args });
            if (m === "update") updates.push(args[0]);
            return q;
          };
        }
        q.then = (resolve: (v: unknown) => unknown) => {
          if (calls.some((c) => c.method === "update")) return resolve({ data: [{ id: "x" }], error: null });
          selects.push(calls);
          return resolve({ data: pages[selects.length - 1] ?? [], error: null });
        };
        return q;
      },
    };
    const n = await createSupabaseDeliveryStore(client).archiveClosed("org", ["open"]);
    expect(n).toBe(1);
    expect(updates).toEqual([{ hold_key: "gone:draft_held:closed:b0001" }]);
    expect(selects).toHaveLength(2);
    expect(selects[1]).toContainEqual({ method: "gt", args: ["id", "a0499"] });
  });
});
