import { describe, expect, it } from "vitest";

import type { LooseSupabase } from "@/app/(dashboard)/messages-v2/queries";

import { createSupabaseDeliveryStore } from "./store";

type Call = { method: string; args: unknown[] };

function fake(pages: Array<Array<{ id: string; property_id: string | null; hold_key: string }>>) {
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const selects: Call[][] = [];
  const client: LooseSupabase = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      return Promise.resolve({ data: (args.p_ids as string[]).length, error: null });
    },
    from() {
      const calls: Call[] = [];
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "not", "order", "limit", "gt"]) {
        q[m] = (...args: unknown[]) => {
          calls.push({ method: m, args });
          return q;
        };
      }
      q.then = (resolve: (v: unknown) => unknown) => {
        selects.push(calls);
        return resolve({ data: pages[selects.length - 1] ?? [], error: null });
      };
      return q;
    },
  };
  return { client, rpcs, selects };
}

describe("DeliveryStore.archiveClosed", () => {
  it("archives closed rows in ONE set-based call per page and skips still-open properties", async () => {
    const t = fake([
      [
        { id: "r1", property_id: "open", hold_key: "open:draft_held" },
        { id: "r2", property_id: "gone", hold_key: "gone:draft_held" },
        { id: "r3", property_id: "gone2", hold_key: "gone2:draft_held" },
      ],
    ]);
    const n = await createSupabaseDeliveryStore(t.client).archiveClosed("org", ["open"]);
    expect(n).toBe(2);
    expect(t.rpcs).toEqual([{ fn: "hold_alert_archive_rows", args: { p_org_id: "org", p_ids: ["r2", "r3"] } }]);
  });

  it("selects per-hold rows only: org scoped, property set, not already archived", async () => {
    const t = fake([[]]);
    await createSupabaseDeliveryStore(t.client).archiveClosed("org", []);
    expect(t.rpcs).toHaveLength(0);
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
    const t = fake([page1, page2]);
    const n = await createSupabaseDeliveryStore(t.client).archiveClosed("org", ["open"]);
    expect(n).toBe(1);
    expect(t.rpcs).toEqual([{ fn: "hold_alert_archive_rows", args: { p_org_id: "org", p_ids: ["b0001"] } }]);
    expect(t.selects).toHaveLength(2);
    expect(t.selects[1]).toContainEqual({ method: "gt", args: ["id", "a0499"] });
  });

  it("with candidates, archives only candidate properties that are not open", async () => {
    const t = fake([
      [
        { id: "r1", property_id: "open", hold_key: "open:k" },
        { id: "r2", property_id: "gone", hold_key: "gone:k" },
        { id: "r3", property_id: "newcomer", hold_key: "newcomer:k" },
      ],
    ]);
    const n = await createSupabaseDeliveryStore(t.client).archiveClosed("org", ["open"], ["open", "gone"]);
    expect(n).toBe(1);
    expect(t.rpcs).toEqual([{ fn: "hold_alert_archive_rows", args: { p_org_id: "org", p_ids: ["r2"] } }]);
  });

  it("surfaces an archive RPC error", async () => {
    const t = fake([[{ id: "r2", property_id: "gone", hold_key: "k" }]]);
    t.client.rpc = () => Promise.resolve({ data: null, error: { message: "boom" } });
    await expect(createSupabaseDeliveryStore(t.client).archiveClosed("org", [])).rejects.toThrow(/archive update failed: boom/);
  });
});

describe("DeliveryStore.deliveredPropertyIds", () => {
  it("returns distinct property ids from live per-hold rows, complete when the last page is short", async () => {
    const t = fake([
      [
        { id: "r1", property_id: "a", hold_key: "a:x" },
        { id: "r2", property_id: "a", hold_key: "a:y" },
        { id: "r3", property_id: "b", hold_key: "b:x" },
      ],
    ]);
    const got = await createSupabaseDeliveryStore(t.client).deliveredPropertyIds("org");
    expect(got).toEqual({ ids: ["a", "b"], complete: true });
    expect(t.selects[0]).toContainEqual({ method: "not", args: ["hold_key", "like", "%:closed:%"] });
  });

  it("is incomplete when the page cap is hit", async () => {
    const page = (n: number) =>
      Array.from({ length: 500 }, (_, i) => ({ id: `r${n}-${String(i).padStart(4, "0")}`, property_id: `p${n}-${i}`, hold_key: "k" }));
    const t = fake(Array.from({ length: 20 }, (_, n) => page(n)));
    expect((await createSupabaseDeliveryStore(t.client).deliveredPropertyIds("org")).complete).toBe(false);
  });
});

describe("DeliveryStore.countSentSince", () => {
  it("counts in-flight (sending) as well as sent deliveries, each by its own timestamp", async () => {
    const calls: Call[] = [];
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "or"]) {
      q[m] = (...args: unknown[]) => {
        calls.push({ method: m, args });
        return q;
      };
    }
    q.then = (resolve: (v: unknown) => unknown) => resolve({ count: 4, error: null });
    const client = { from: () => q } as unknown as LooseSupabase;
    const n = await createSupabaseDeliveryStore(client).countSentSince({
      orgId: "org",
      channel: "slack",
      sinceIso: "2026-10-08T09:00:00.000Z",
    });
    expect(n).toBe(4);
    const or = calls.find((c) => c.method === "or")!.args[0] as string;
    expect(or).toContain("and(status.eq.sent,sent_at.gte.2026-10-08T09:00:00.000Z)");
    expect(or).toContain("and(status.eq.sending,sending_at.gte.2026-10-08T09:00:00.000Z)");
  });
});
