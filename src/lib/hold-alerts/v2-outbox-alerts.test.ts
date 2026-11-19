import { describe, expect, it, vi } from "vitest";

import { runHoldAlertsForOrg } from "./core";
import { hotPromotionSlackText, hotPromotionSmsText } from "./messages";
import { makeDeps, ORG, OWNER } from "./test-support";
import type { HotPromotion } from "./types";
import { loadV2OutboxAlerts } from "./v2-outbox-alerts";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

const NOW = Date.parse("2026-10-30T12:00:00Z");
type Tables = Record<string, unknown[]>;
function fakeDb(tables: Tables) {
  const queries: string[] = [];
  const chain = (table: string) => {
    queries.push(table);
    let rows = tables[table] ?? [];
    let limit = Infinity;
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "is", "gte", "order"]) c[m] = () => c;
    if (table === "routing_v2_outbox") {
      // Honors the query's own .order(...) calls (column + direction) and the `or` keyset cursor,
      // so an ascending + limit query really gets the OLDEST rows, as a database would.
      const orders: Array<{ col: "created_at" | "id"; asc: boolean }> = [];
      c.order = (col: "created_at" | "id", o?: { ascending?: boolean }) => { orders.push({ col, asc: o?.ascending !== false }); return c; };
      c.or = (f: string) => {
        const m = /created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.lt\.([^)]+)\)/.exec(f)!;
        rows = rows.filter((r) => { const x = r as { created_at: string; id: string }; return x.created_at < m[1]! || (x.created_at === m[2] && x.id < m[3]!); });
        return c;
      };
      c.then = (res: (v: unknown) => unknown) => {
        const sorted = [...rows].sort((a, b) => {
          for (const { col, asc } of orders) {
            const x = (a as Record<string, string>)[col]!, y = (b as Record<string, string>)[col]!;
            if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
          }
          return 0;
        });
        return res({ data: sorted.slice(0, limit), error: null });
      };
    }
    c.limit = (n: number) => { limit = n; return c; };
    c.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
    if (!c.then) c.then = (res: (v: unknown) => unknown) => res({ data: rows.slice(0, limit), error: null });
    return c;
  };
  return { db: { from: chain } as never, queries };
}
const ON = { questions_live: true, replies: true, canary_percent: 100 };
const alert = (id: string, reason: string, key: string, over: Record<string, unknown> = {}) => ({
  id, property_id: "p1", inbound_message_id: "in1", created_at: "2026-10-30T11:00:00Z", status: "pending",
  payload: { reason, dedupe_key: key }, ...over,
});
const base = (rows: unknown[], flags: unknown = ON) => ({
  ai_responder_configs: [{ routing_v2_flags: flags }],
  routing_v2_outbox: rows,
  properties: [{ id: "p1", address: "1 Main St", contacts: { first_name: "Dana" } }],
  messages: [{ id: "in1", created_at: "2026-10-30T10:59:00Z" }],
});

describe("routing v2 outbox owner alerts", () => {
  it("flags off: nothing, after one config read", async () => {
    const { db, queries } = fakeDb(base([alert("o1", "call_me", "hot_text:in1")], { questions_live: true }));
    expect(await loadV2OutboxAlerts(db, ORG, "2026-10-01T00:00:00Z", NOW, OWNER.userId)).toEqual({ promotions: [], complete: true });
    expect(queries).toEqual(["ai_responder_configs"]);
  });
  it("call-me / yes reuse today's hot-text alert identity; other reasons carry their approved label", async () => {
    const { db } = fakeDb(base([alert("o1", "call_me", "hot_text:in1"), alert("o2", "haiku_unsure", "routing_v2:in1:haiku_unsure")]));
    const { promotions } = await loadV2OutboxAlerts(db, ORG, "2026-10-01T00:00:00Z", NOW, OWNER.userId);
    expect(promotions).toHaveLength(2);
    expect(promotions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "hot_text", key: "hot_text:in1", outboxId: "o1", name: "Dana", address: "1 Main St" }),
      expect.objectContaining({ kind: "routing_v2_alert", key: "routing_v2:in1:haiku_unsure", outboxId: "o2", label: "Couldn't tell what they meant — please check" }),
    ]));
  });
  it("one alert per delivery key; unknown reasons and malformed rows never alert", async () => {
    const { db } = fakeDb(base([alert("o1", "call_me", "hot_text:in1"), alert("o2", "hot_yes", "hot_text:in1"), alert("o3", "made_up", "k"), { ...alert("o4", "call_me", "x"), payload: null }]));
    const { promotions } = await loadV2OutboxAlerts(db, ORG, "2026-10-01T00:00:00Z", NOW, OWNER.userId);
    // One per key (the newest row of that key wins; both carry the same inbound).
    expect(promotions.map((p) => p.outboxId)).toEqual(["o2"]);
  });
  it("a busy week (> one page of sent alerts) never hides a new pending alert (review B2)", async () => {
    const sent = Array.from({ length: 450 }, (_, i) => alert(`s${String(i).padStart(4, "0")}`, "haiku_unsure", `routing_v2:old${i}:haiku_unsure`,
      { status: "sent", created_at: new Date(Date.parse("2026-10-27T00:00:00Z") + i * 60_000).toISOString() }));
    // The real B2 case: the new alert is NEWER than every one of the 450 already-sent alerts.
    const fresh = alert("new1", "call_me", "hot_text:in1", { created_at: "2026-10-30T11:30:00Z" });
    const { db } = fakeDb(base([...sent, fresh]));
    const { promotions, complete } = await loadV2OutboxAlerts(db, ORG, "2026-10-01T00:00:00Z", NOW, OWNER.userId);
    expect(complete).toBe(true);
    expect(promotions.map((p) => p.outboxId)).toContain("new1");
    expect(promotions).toHaveLength(451);
  });
  it("no hot owner: nothing", async () => {
    const { db } = fakeDb(base([alert("o1", "call_me", "hot_text:in1")]));
    expect((await loadV2OutboxAlerts(db, ORG, "2026-10-01T00:00:00Z", NOW, null)).promotions).toEqual([]);
  });
  it("copy: today's hold-alert sentence with the approved label, no seller text", () => {
    const p: HotPromotion = { propertyId: "p1", assigneeUserId: "u", name: "Dana", assignedAt: "x", kind: "routing_v2_alert", label: "Possible stop request — please check", key: "k" };
    expect(hotPromotionSlackText(p, "https://app")).toBe("New hold needs review: Dana (Possible stop request — please check). https://app/leads/p1");
    expect(hotPromotionSmsText(p, "https://app")).toBe("Hot hold: Dana (Possible stop request — please check). https://app/leads/p1");
  });
  it("each channel send passes the outbox gate first; a refused gate sends nothing (N2)", async () => {
    const promotion: HotPromotion = { propertyId: "p1", assigneeUserId: OWNER.userId, name: "Dana", assignedAt: "2026-10-15T10:01:00.000Z", kind: "routing_v2_alert", label: "Said they'll call", key: "routing_v2:in1:said_theyll_call", outboxId: "o1" };
    const gate = vi.fn(async () => "time_only_alert_disabled");
    const t = makeDeps({ holds: [], promotions: [promotion], v2OutboxAlertGate: gate });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(gate).toHaveBeenCalledWith("o1", "routing_v2:in1:said_theyll_call");
    expect(t.sent).toEqual([]);
    const ok = vi.fn(async () => "ok");
    const t2 = makeDeps({ holds: [], promotions: [promotion], v2OutboxAlertGate: ok });
    await runHoldAlertsForOrg(t2.deps, ORG);
    expect(t2.sent.map((s) => s.channel).sort()).toEqual(["slack", "sms"]);
  });
});
