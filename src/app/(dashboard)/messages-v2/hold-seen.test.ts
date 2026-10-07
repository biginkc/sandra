import { describe, expect, it } from "vitest";

import { loadFreshSeen, mergeSeen, withFreshSeen } from "./hold-seen";
import type { LooseSupabase } from "./queries";

type Call = { method: string; args: unknown[] };

/** Chainable fake: every table resolves with `rows(table, calls)`. */
function fake(rows: (table: string, calls: Call[]) => { data?: unknown; error?: unknown }) {
  const log: Array<{ table: string; calls: Call[] }> = [];
  const client: LooseSupabase = {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from(table: string) {
      const entry = { table, calls: [] as Call[] };
      log.push(entry);
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order", "limit"]) {
        q[m] = (...args: unknown[]) => {
          entry.calls.push({ method: m, args });
          return q;
        };
      }
      q.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: [], error: null, ...rows(table, entry.calls) });
      return q;
    },
  };
  return { client, log };
}

describe("loadFreshSeen", () => {
  it("takes the newest pending created_at across decisions, reviews and drafts, with no oldest-first window", async () => {
    const { client, log } = fake((table) => {
      if (table === "properties")
        return { data: [{ id: "p1", needs_human_attention: true, last_ai_escalation_reason: "draft_held", last_ai_escalation_at: "2026-10-07T11:00:00+00:00" }] };
      if (table === "jev_lead_decisions") return { data: [{ property_id: "p1", created_at: "2026-10-07T12:00:00.000001+00:00" }] };
      if (table === "ai_disposition_reviews") return { data: [{ property_id: "p1", created_at: "2026-10-07T13:00:00+00:00" }] };
      return { data: [{ property_id: "p1", created_at: "2026-10-07T12:30:00+00:00" }] };
    });
    const seen = await loadFreshSeen(client, "org", ["p1"]);
    expect(seen?.get("p1")).toEqual({
      through: "2026-10-07T13:00:00+00:00",
      flagReason: "draft_held",
      flagAt: "2026-10-07T11:00:00+00:00",
    });
    // Newest first, pending only, org scoped, property filtered, never oldest-first.
    for (const e of log.filter((l) => l.table !== "properties")) {
      expect(e.calls).toContainEqual({ method: "eq", args: ["status", "pending"] });
      expect(e.calls).toContainEqual({ method: "eq", args: ["org_id", "org"] });
      expect(e.calls.find((c) => c.method === "order")!.args[1]).toMatchObject({ ascending: false });
    }
  });

  it("reports no flag when the property is not flagged, and a null through when nothing is pending", async () => {
    const { client } = fake((table) =>
      table === "properties"
        ? { data: [{ id: "p1", needs_human_attention: false, last_ai_escalation_reason: "stale", last_ai_escalation_at: "2026-10-07T11:00:00+00:00" }] }
        : { data: [] },
    );
    expect((await loadFreshSeen(client, "org", ["p1"]))?.get("p1")).toEqual({ through: null, flagReason: null, flagAt: null });
  });

  it("returns null when any query fails, so the caller keeps its own value", async () => {
    const { client } = fake((table) => (table === "ai_reply_drafts" ? { error: { message: "boom" } } : {}));
    expect(await loadFreshSeen(client, "org", ["p1"])).toBeNull();
  });

  it("chunks the property ids", async () => {
    const { client, log } = fake(() => ({}));
    await loadFreshSeen(client, "org", Array.from({ length: 60 }, (_, i) => `p${i}`));
    expect(log.filter((l) => l.table === "properties")).toHaveLength(3);
  });
});

describe("withFreshSeen / mergeSeen", () => {
  it("a hold past the window gets the newer fresh version, never an older one", () => {
    const merged = mergeSeen(
      { through: "2026-10-07T09:00:00+00:00", flagReason: null, flagAt: null },
      { through: "2026-10-07T12:00:00+00:00", flagReason: "draft_held", flagAt: "2026-10-07T11:00:00+00:00" },
    );
    expect(merged).toEqual({ through: "2026-10-07T12:00:00+00:00", flagReason: "draft_held", flagAt: "2026-10-07T11:00:00+00:00" });
    expect(
      mergeSeen({ through: "2026-10-07T15:00:00+00:00", flagReason: null, flagAt: null }, { through: "2026-10-07T12:00:00+00:00", flagReason: null, flagAt: null }).through,
    ).toBe("2026-10-07T15:00:00+00:00");
  });

  it("replaces seen on holds with a property and leaves the rest and failures alone", async () => {
    const { client } = fake((table) =>
      table === "jev_lead_decisions" ? { data: [{ property_id: "p1", created_at: "2026-10-07T12:00:00+00:00" }] } : {},
    );
    const holds = [
      { property_id: "p1", seen: { through: "2026-10-07T01:00:00+00:00", flagReason: null, flagAt: null } },
      { property_id: null },
    ];
    const out = await withFreshSeen(client, "org", holds);
    expect(out[0]!.seen!.through).toBe("2026-10-07T12:00:00+00:00");
    expect(out[1]).toBe(holds[1]);

    const failing = fake(() => ({ error: { message: "x" } }));
    expect(await withFreshSeen(failing.client, "org", holds)).toEqual(holds);
  });
});
