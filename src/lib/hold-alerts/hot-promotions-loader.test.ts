import { describe, expect, it, vi } from "vitest";

import { HOT_HANDOFF_SOURCE_TYPE } from "@/lib/hot-sellers/assign";

import { runHoldAlertsForOrg } from "./core";
import { loadHotPromotions } from "./index";
import { makeDeps, ORG, OWNER } from "./test-support";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

type EventRow = { id: string; org_id: string; property_id: string; event_type: string; source_type: string; created_at: string; payload: { to: string } };

/**
 * A fake db that honours exactly what loadHotPromotions asks of lead_events
 * (.eq, .gte, .or keyset, .order x2, .limit) and of properties (.in), and counts the calls.
 */
function fakeDb(events: EventRow[], opts: { failPropertiesAt?: number } = {}) {
  const calls = { eventPages: 0, propertyBatches: [] as number[] };
  const db = {
    from(table: string) {
      if (table === "properties") {
        return {
          select: () => ({
            in: async (_col: string, ids: string[]) => {
              calls.propertyBatches.push(ids.length);
              if (opts.failPropertiesAt === calls.propertyBatches.length) return { data: null, error: { message: "boom" } };
              return { data: ids.map((id) => ({ id, contacts: { first_name: `N-${id}` } })), error: null };
            },
          }),
        };
      }
      const eq: Array<[string, unknown]> = [];
      let gte: string | null = null;
      let keyset: { at: string; id: string } | null = null;
      let limit = Infinity;
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (eq.push([c, v]), q),
        gte: (_c: string, v: string) => ((gte = v), q),
        or: (expr: string) => {
          const m = expr.match(/^created_at\.gt\.(.+),and\(created_at\.eq\.(.+),id\.gt\.(.+)\)$/);
          if (!m || m[1] !== m[2]) throw new Error(`unsupported or(): ${expr}`);
          keyset = { at: m[1]!, id: m[3]! };
          return q;
        },
        order: () => q,
        limit: (n: number) => ((limit = n), q),
        then(resolve: (v: { data: EventRow[]; error: null }) => void) {
          calls.eventPages += 1;
          let rows = events.filter((r) => eq.every(([c, v]) => (r as Record<string, unknown>)[c] === v) && (gte === null || r.created_at >= gte));
          const k = keyset;
          if (k) rows = rows.filter((r) => r.created_at > k.at || (r.created_at === k.at && r.id > k.id));
          rows = [...rows].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1));
          resolve({ data: rows.slice(0, limit), error: null });
        },
      };
      return q;
    },
  };
  return { db: db as never, calls };
}

// Five rows per timestamp, so page boundaries (200) split a tie group and the id tie-break matters.
const events = (n: number, to = OWNER.userId): EventRow[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `e${String(i).padStart(4, "0")}`,
    org_id: ORG,
    property_id: `prop-${i}`,
    event_type: "assigned",
    source_type: HOT_HANDOFF_SOURCE_TYPE,
    created_at: new Date(Date.parse("2026-10-15T01:00:00.000Z") + Math.floor(i / 5) * 1000).toISOString(),
    payload: { to },
  }));

describe("loadHotPromotions keyset paging", () => {
  it("returns every one of 250 promotions (two pages), each once, in order, with names, even when a page boundary splits equal timestamps", async () => {
    const { db, calls } = fakeDb(events(250));
    const { promotions, complete } = await loadHotPromotions(db, ORG, "2026-10-15T00:00:00.000Z");
    expect(complete).toBe(true);
    expect(promotions).toHaveLength(250);
    expect(new Set(promotions.map((p) => p.propertyId)).size).toBe(250);
    expect(promotions[0]).toMatchObject({ propertyId: "prop-0", name: "N-prop-0", assigneeUserId: OWNER.userId });
    expect(calls.eventPages).toBe(2);
    expect(Math.max(...calls.propertyBatches)).toBeLessThanOrEqual(200);
  });

  it("an exact multiple of the page size costs one extra empty page and loses nothing", async () => {
    const { db, calls } = fakeDb(events(400));
    const { promotions, complete } = await loadHotPromotions(db, ORG, "2026-10-15T00:00:00.000Z");
    expect(promotions).toHaveLength(400);
    expect(complete).toBe(true);
    expect(calls.eventPages).toBe(3);
  });

  it("stops at 5,000 and says the load is incomplete", async () => {
    const { db } = fakeDb(events(5200));
    const { promotions, complete } = await loadHotPromotions(db, ORG, "2026-10-15T00:00:00.000Z");
    expect(complete).toBe(false);
    expect(promotions.length).toBe(5000);
  });

  it("ignores rows before the watermark and events that are not hot hand-offs", async () => {
    const rows = [...events(3), { ...events(1)[0]!, id: "other", source_type: "something_else" }, { ...events(1)[0]!, id: "early", created_at: "2026-10-14T00:00:00.000Z" }];
    const { db } = fakeDb(rows);
    expect((await loadHotPromotions(db, ORG, "2026-10-15T00:00:00.000Z")).promotions).toHaveLength(3);
  });

  it("a failed name lookup keeps the promotion (as 'Unknown sender') and marks the load incomplete", async () => {
    const { db } = fakeDb(events(3), { failPropertiesAt: 1 });
    const { promotions, complete } = await loadHotPromotions(db, ORG, "2026-10-15T00:00:00.000Z");
    expect(complete).toBe(false);
    expect(promotions.map((p) => p.name)).toEqual(["Unknown sender", "Unknown sender", "Unknown sender"]);
  });
});

describe("250 hot promotions through the alert pass", () => {
  it("every one gets exactly one Slack and one SMS across passes (SMS cap 10/hr, DM cap 20/hr), none twice", async () => {
    const { db } = fakeDb(events(250));
    const t = makeDeps({ holds: [], recipients: [OWNER], nowIso: "2026-10-15T12:00:00.000Z" });
    t.deps.loadHotPromotions = (org, since) => loadHotPromotions(db, org, since);
    let ms = Date.parse("2026-10-15T12:00:00.000Z");
    for (let pass = 0; pass < 40; pass++) {
      t.setNow(new Date(ms).toISOString());
      await runHoldAlertsForOrg(t.deps, ORG);
      ms += 61 * 60 * 1000;
      if (t.store.rows.length === 500 && t.store.rows.every((r) => r.status === "sent")) break;
    }
    const slack = t.sent.filter((s) => s.channel === "slack");
    const sms = t.sent.filter((s) => s.channel === "sms");
    expect(slack).toHaveLength(250);
    expect(sms).toHaveLength(250);
    expect(new Set(t.store.rows.map((r) => `${r.holdKey}|${r.channel}`)).size).toBe(500);
    expect(t.store.rows.every((r) => r.status === "sent" && r.attempts === 1)).toBe(true);
    // A further pass changes nothing.
    t.setNow(new Date(ms).toISOString());
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.filter((s) => s.channel !== "email")).toHaveLength(500);
  });
});
