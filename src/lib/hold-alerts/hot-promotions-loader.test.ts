import { describe, expect, it, vi } from "vitest";

import { HOT_FAILED_SOURCE_TYPE, HOT_HANDOFF_SOURCE_TYPE, HOT_TEXT_SOURCE_TYPE } from "@/lib/hot-sellers/assign";

import { runHoldAlertsForOrg } from "./core";
import { HOT_ALERT_LOOKBACK_MS, loadHotPromotions } from "./index";
import { FakeStore, makeDeps, ORG, OWNER } from "./test-support";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

type EventRow = {
  id: string;
  org_id: string;
  property_id: string;
  event_type: string;
  source_type: string;
  source_id: string;
  created_at: string;
  payload: { to?: string; reason?: string; inbound?: string; covered_by_hold?: boolean; flag_at?: string | null };
};
type DeliveryRow = { hold_key: string; channel: string; status: string; attempts: number; recipient_user_id?: string };

const NOW = "2026-10-15T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const MARK = "2026-10-15T00:00:00.000Z";
const HOUR = 60 * 60 * 1000;

/**
 * A fake db that honours exactly what loadHotPromotions asks of lead_events
 * (.eq, .in, .gte, .or keyset in DESCENDING order, .order x2, .limit),
 * hold_alert_deliveries (.eq, .in on hold_key) and properties (.in), and counts the calls.
 */
function fakeDb(
  events: EventRow[],
  opts: {
    deliveries?: () => DeliveryRow[];
    failPropertiesAt?: number;
    failDeliveriesAt?: number;
    failEventsAt?: number;
    assignees?: Record<string, string | null>;
    /** inbound message id -> messages.created_at (default: the event's own time); null = no such message. */
    inboundTimes?: Record<string, string | null>;
    failMessagesAt?: number;
  } = {},
) {
  // Newest first, id descending on ties: sorted once, then filtered in order.
  const sorted = [...events].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : -1));
  const calls = { eventPages: 0, deliveryBatches: [] as number[], propertyBatches: [] as number[], messageBatches: 0 };
  const db = {
    from(table: string) {
      const eq: Array<[string, unknown]> = [];
      const inn: Array<[string, unknown[]]> = [];
      let gte: string | null = null;
      let keyset: { at: string; id: string } | null = null;
      let limit = Infinity;
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (eq.push([c, v]), q),
        in: (c: string, v: unknown[]) => (inn.push([c, v]), q),
        gte: (_c: string, v: string) => ((gte = v), q),
        or: (expr: string) => {
          const m = expr.match(/^created_at\.lt\.(.+),and\(created_at\.eq\.(.+),id\.lt\.(.+)\)$/);
          if (!m || m[1] !== m[2]) throw new Error(`unsupported or(): ${expr}`);
          keyset = { at: m[1]!, id: m[3]! };
          return q;
        },
        order: () => q,
        limit: (n: number) => ((limit = n), q),
        then(resolve: (v: { data: unknown[] | null; error: { message: string } | null }) => void) {
          if (table === "messages") {
            const ids = inn.find(([c]) => c === "id")![1] as string[];
            calls.messageBatches += 1;
            if (opts.failMessagesAt === calls.messageBatches) return resolve({ data: null, error: { message: "boom" } });
            const timeOf = (id: string): string | null =>
              opts.inboundTimes && id in opts.inboundTimes ? opts.inboundTimes[id]! : (events.find((e) => e.source_id === id)?.created_at ?? null);
            return resolve({ data: ids.map((id) => ({ id, created_at: timeOf(id) })).filter((m) => m.created_at !== null), error: null });
          }
          if (table === "properties") {
            const ids = inn.find(([c]) => c === "id")![1] as string[];
            calls.propertyBatches.push(ids.length);
            if (opts.failPropertiesAt === calls.propertyBatches.length) return resolve({ data: null, error: { message: "boom" } });
            return resolve({ data: ids.map((id) => ({ id, address: `${id} Main St`, assigned_user_id: opts.assignees && id in opts.assignees ? opts.assignees[id] : OWNER.userId, city: "Kansas City", contacts: { first_name: `N-${id}` } })), error: null });
          }
          if (table === "hold_alert_deliveries") {
            const keys = new Set(inn.find(([c]) => c === "hold_key")![1] as string[]);
            calls.deliveryBatches.push(keys.size);
            if (opts.failDeliveriesAt === calls.deliveryBatches.length) return resolve({ data: null, error: { message: "boom" } });
            return resolve({ data: (opts.deliveries?.() ?? []).filter((d) => keys.has(d.hold_key)), error: null });
          }
          calls.eventPages += 1;
          if (opts.failEventsAt === calls.eventPages) return resolve({ data: null, error: { message: "boom" } });
          let rows = sorted.filter(
            (r) =>
              eq.every(([c, v]) => (r as Record<string, unknown>)[c] === v) &&
              inn.every(([c, vs]) => vs.includes((r as Record<string, unknown>)[c])) &&
              (gte === null || r.created_at >= gte),
          );
          const k = keyset;
          if (k) rows = rows.filter((r) => r.created_at < k.at || (r.created_at === k.at && r.id < k.id));
          resolve({ data: rows.slice(0, limit), error: null });
        },
      };
      return q;
    },
  };
  return { db: db as never, calls };
}

// Five rows per timestamp, so page boundaries (200) split a tie group and the id tie-break matters.
const events = (n: number, over: { to?: string; base?: string; sourceType?: string } = {}): EventRow[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `e${String(i).padStart(5, "0")}`,
    org_id: ORG,
    property_id: `prop-${i}`,
    event_type: "assigned",
    source_type: over.sourceType ?? HOT_HANDOFF_SOURCE_TYPE,
    source_id: `in-${i}`,
    created_at: new Date(Date.parse(over.base ?? "2026-10-15T01:00:00.000Z") + Math.floor(i / 5) * 1000).toISOString(),
    payload: { to: over.to ?? OWNER.userId },
  }));

describe("loadHotPromotions keyset paging", () => {
  it("returns every one of 250 promotions (two pages), each once, newest first, with names, even when a page boundary splits equal timestamps", async () => {
    const { db, calls } = fakeDb(events(250));
    const { promotions, complete } = await loadHotPromotions(db, ORG, MARK, NOW_MS);
    expect(complete).toBe(true);
    expect(promotions).toHaveLength(250);
    expect(new Set(promotions.map((p) => p.propertyId)).size).toBe(250);
    // Newest first: the last event written comes first.
    expect(promotions[0]).toMatchObject({ propertyId: "prop-249", name: "N-prop-249", assigneeUserId: OWNER.userId, kind: "handoff", key: "hot_handoff:in-249" });
    expect(promotions[249]).toMatchObject({ propertyId: "prop-0" });
    expect(calls.eventPages).toBe(2);
    expect(Math.max(...calls.propertyBatches)).toBeLessThanOrEqual(200);
    expect(Math.max(...calls.deliveryBatches)).toBeLessThanOrEqual(200);
  });

  it("an exact multiple of the page size costs one extra empty page and loses nothing", async () => {
    const { db, calls } = fakeDb(events(400));
    const { promotions, complete } = await loadHotPromotions(db, ORG, MARK, NOW_MS);
    expect(promotions).toHaveLength(400);
    expect(complete).toBe(true);
    expect(calls.eventPages).toBe(3);
  });

  it("has no cap: 5,100 events come back in one load, each key once, load complete", async () => {
    const { db, calls } = fakeDb(events(5100));
    const { promotions, complete } = await loadHotPromotions(db, ORG, MARK, NOW_MS);
    expect(complete).toBe(true);
    expect(promotions).toHaveLength(5100);
    expect(new Set(promotions.map((p) => p.key)).size).toBe(5100);
    expect(calls.eventPages).toBe(26);
  });

  it("ignores rows before the watermark and events that are not hot hand-offs or hot texts", async () => {
    const rows = [...events(3), { ...events(1)[0]!, id: "other", source_type: "something_else" }, { ...events(1)[0]!, id: "early", created_at: "2026-10-14T00:00:00.000Z" }];
    const { db } = fakeDb(rows);
    expect((await loadHotPromotions(db, ORG, MARK, NOW_MS)).promotions).toHaveLength(3);
  });

  it("looks back at most 7 days, even when the watermark is older", async () => {
    expect(HOT_ALERT_LOOKBACK_MS).toBe(7 * 24 * HOUR);
    const at = (msAgo: number) => new Date(NOW_MS - msAgo).toISOString();
    const rows: EventRow[] = [
      { ...events(1)[0]!, id: "old", property_id: "p-old", source_id: "in-old", created_at: at(8 * 24 * HOUR) },
      { ...events(1)[0]!, id: "three", property_id: "p-three", source_id: "in-three", created_at: at(3 * 24 * HOUR) },
      { ...events(1)[0]!, id: "edge", property_id: "p-edge", source_id: "in-edge", created_at: at(6 * 24 * HOUR) },
      { ...events(1)[0]!, id: "new", property_id: "p-new", source_id: "in-new", created_at: at(HOUR) },
    ];
    const { db } = fakeDb(rows);
    const monthAgo = new Date(NOW_MS - 30 * 24 * HOUR).toISOString();
    // 8 days old: never loaded. 3 days old (undelivered, after the cutoff): still loads.
    expect((await loadHotPromotions(db, ORG, monthAgo, NOW_MS)).promotions.map((p) => p.propertyId)).toEqual(["p-new", "p-three", "p-edge"]);
    // A watermark newer than the look-back wins.
    expect((await loadHotPromotions(db, ORG, at(2 * HOUR), NOW_MS)).promotions.map((p) => p.propertyId)).toEqual(["p-new"]);
  });

  it("hot_text events become kind 'hot_text' keyed by the inbound message; hand-offs are keyed hot_handoff:<inbound>", async () => {
    const handoff = events(1)[0]!;
    const text: EventRow = { ...handoff, id: "t1", property_id: "prop-0", source_type: HOT_TEXT_SOURCE_TYPE, source_id: "inbound-1", event_type: "ai_escalated", created_at: "2026-10-15T02:00:00.000Z" };
    const text2: EventRow = { ...text, id: "t2", source_id: "inbound-2", created_at: "2026-10-15T03:00:00.000Z" };
    const { db } = fakeDb([handoff, text, text2]);
    const { promotions } = await loadHotPromotions(db, ORG, MARK, NOW_MS);
    // Address is loaded for hot texts only, never for hand-offs.
    expect(promotions.map((p) => [p.kind, !!p.address])).toEqual([["hot_text", true], ["hot_text", true], ["handoff", false]]);
    expect(promotions.map((p) => [p.kind, p.key, p.propertyId])).toEqual([
      ["hot_text", "hot_text:inbound-2", "prop-0"],
      ["hot_text", "hot_text:inbound-1", "prop-0"],
      ["handoff", "hot_handoff:in-0", "prop-0"],
    ]);
  });

  it("drops keys whose Slack and text deliveries are both finished (sent, skipped, or failed out of attempts), keeps the rest", async () => {
    const d = (key: string, channel: string, status: string, attempts = 1): DeliveryRow => ({ hold_key: key, channel, status, attempts });
    const deliveries: DeliveryRow[] = [
      d("hot_handoff:in-0", "slack", "sent"), d("hot_handoff:in-0", "sms", "sent"), // finished
      d("hot_handoff:in-1", "slack", "sent"), // sms missing -> kept
      d("hot_handoff:in-2", "slack", "sent"), d("hot_handoff:in-2", "sms", "failed", 3), // out of attempts -> finished
      d("hot_handoff:in-3", "slack", "sent"), d("hot_handoff:in-3", "sms", "failed", 1), // retryable -> kept
      d("hot_handoff:in-4", "slack", "skipped"), d("hot_handoff:in-4", "sms", "skipped"), // finished
      d("hot_handoff:in-5", "slack", "sent"), d("hot_handoff:in-5", "sms", "pending", 0), // kept
      d("hot_handoff:in-6", "slack", "sent"), d("hot_handoff:in-6", "sms", "sending", 1), // kept
    ];
    const { db } = fakeDb(events(8), { deliveries: () => deliveries });
    const { promotions, complete } = await loadHotPromotions(db, ORG, MARK, NOW_MS);
    expect(complete).toBe(true);
    expect(promotions.map((p) => p.propertyId).sort()).toEqual(["prop-1", "prop-3", "prop-5", "prop-6", "prop-7"]);
  });

  it("finished means finished for the CURRENT owner: another recipient's terminal rows do not drop the event; a null owner lets any recipient's rows drop it", async () => {
    const d = (key: string, recipient: string, channel: string, status = "sent", attempts = 1): DeliveryRow => ({ hold_key: key, channel, status, attempts, recipient_user_id: recipient });
    const deliveries: DeliveryRow[] = [
      d("hot_handoff:in-0", "user-A", "slack"), d("hot_handoff:in-0", "user-A", "sms", "skipped"), // A finished, B owner -> kept
      d("hot_handoff:in-1", "user-B", "slack"), d("hot_handoff:in-1", "user-B", "sms", "failed", 3), // B finished -> dropped
      d("hot_handoff:in-2", "user-A", "slack"), d("hot_handoff:in-2", "user-B", "sms"), // split across recipients -> kept
    ];
    const keep = async (owner: string | null) => {
      const { db } = fakeDb(events(3), { deliveries: () => deliveries });
      return (await loadHotPromotions(db, ORG, MARK, NOW_MS, owner)).promotions.map((p) => p.propertyId).sort();
    };
    expect(await keep("user-B")).toEqual(["prop-0", "prop-2"]);
    expect(await keep("user-A")).toEqual(["prop-1", "prop-2"]);
    // Unresolved owner: any recipient's rows count (A+B split on in-2 still fills both channels).
    expect(await keep(null)).toEqual([]);
  });

  it("a failed deliveries lookup keeps everything (nothing dropped) and marks the load incomplete", async () => {
    const { db } = fakeDb(events(3), { failDeliveriesAt: 1, deliveries: () => [] });
    const { promotions, complete } = await loadHotPromotions(db, ORG, MARK, NOW_MS);
    expect(complete).toBe(false);
    expect(promotions).toHaveLength(3);
  });

  it("a failed event page returns nothing and says incomplete", async () => {
    const { db } = fakeDb(events(3), { failEventsAt: 1 });
    expect(await loadHotPromotions(db, ORG, MARK, NOW_MS)).toEqual({ promotions: [], complete: false });
  });

  it("a failed name lookup keeps the promotion (as 'Unknown sender') and marks the load incomplete", async () => {
    const { db } = fakeDb(events(3), { failPropertiesAt: 1 });
    const { promotions, complete } = await loadHotPromotions(db, ORG, MARK, NOW_MS);
    expect(complete).toBe(false);
    expect(promotions.map((p) => p.name)).toEqual(["Unknown sender", "Unknown sender", "Unknown sender"]);
  });
});

/** A store whose lookups are O(1) / O(log n), so thousands of passes over thousands of keys stay fast. Same semantics as FakeStore. */
class IndexedStore extends FakeStore {
  private idx = new Map<string, FakeStore["rows"][number]>();
  private sentLog: Record<string, string[]> = { slack: [], sms: [], email: [] };
  private inFlight = new Map<string, string>();
  async ensure(input: Parameters<FakeStore["ensure"]>[0]) {
    const k = `${input.holdKey}|${input.recipientUserId}|${input.channel}|${input.stage}`;
    let live = this.idx.get(k);
    if (!live) {
      await super.ensure(input);
      live = this.rows[this.rows.length - 1]!;
      this.idx.set(k, live);
    }
    return { ...live };
  }
  async claim(row: Parameters<FakeStore["claim"]>[0]) {
    const ok = await super.claim(row);
    if (ok) this.inFlight.set(row.id, row.channel);
    return ok;
  }
  async release(id: string) {
    this.inFlight.delete(id);
    return super.release(id);
  }
  /** O(log n) cap check (FakeStore's scans every row): same count as countSentSince, then the plain claim. */
  async claimWithCap(row: Parameters<FakeStore["claim"]>[0], cap: Parameters<FakeStore["claimWithCap"]>[1]) {
    const n = await this.countSentSince({ orgId: cap.orgId, channel: cap.channel, sinceIso: cap.sinceIso });
    if (n >= cap.cap) return "capped" as const;
    return (await this.claim(row)) ? ("claimed" as const) : ("lost" as const);
  }
  async markSent(id: string) {
    this.inFlight.delete(id);
    await super.markSent(id);
    const r = this.rows.find((x) => x.id === id)!;
    this.sentLog[r.channel]!.push(r.sentAt!);
  }
  async markSkipped(id: string, reason: string) {
    this.inFlight.delete(id);
    return super.markSkipped(id, reason);
  }
  async markFailed(id: string, error: string, terminal?: boolean) {
    this.inFlight.delete(id);
    return super.markFailed(id, error, terminal);
  }
  async countSentSince(q: { orgId: string; channel: string; recipientUserId?: string; sinceIso: string }) {
    const log = this.sentLog[q.channel] ?? [];
    let lo = 0;
    let hi = log.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (log[mid]! < q.sinceIso) lo = mid + 1;
      else hi = mid;
    }
    let sending = 0;
    for (const ch of this.inFlight.values()) if (ch === q.channel) sending += 1;
    return log.length - lo + sending;
  }
}

describe("loadHotPromotions: keys and assignee guard", () => {
  it("a hand-off is keyed hot_handoff:<its inbound>, a hot text hot_text:<its inbound>", async () => {
    const [a, b] = events(2);
    b!.source_type = HOT_TEXT_SOURCE_TYPE;
    const { db } = fakeDb([a!, b!]);
    const { promotions } = await loadHotPromotions(db, ORG, MARK, NOW_MS);
    expect(promotions.map((p) => p.key).sort()).toEqual(["hot_handoff:in-0", "hot_text:in-1"]);
  });

  it("an event covered by an open hot hold (payload.covered_by_hold) never becomes a promotion", async () => {
    const [a, b] = events(2);
    a!.payload = { to: OWNER.userId, covered_by_hold: true };
    const { db } = fakeDb([a!, b!]);
    const { promotions } = await loadHotPromotions(db, ORG, MARK, NOW_MS);
    expect(promotions.map((p) => p.key)).toEqual(["hot_handoff:in-1"]);
  });

  it("drops a hand-off whose property is now assigned to someone else (or nobody); hot texts are not dropped", async () => {
    const hand = events(3);
    const text = events(1, { sourceType: HOT_TEXT_SOURCE_TYPE }).map((e) => ({ ...e, id: "t0", property_id: "prop-t", source_id: "in-t" }));
    const { db } = fakeDb([...hand, ...text], { assignees: { "prop-0": "rep-1", "prop-1": null, "prop-t": "rep-1" } });
    const { promotions } = await loadHotPromotions(db, ORG, MARK, NOW_MS);
    expect(promotions.map((p) => p.propertyId).sort()).toEqual(["prop-2", "prop-t"]);
  });
});

describe("hot promotions through the alert pass", () => {
  const storeRowsAsDeliveries = (store: FakeStore) => () =>
    store.rows.map((r) => ({ hold_key: r.holdKey, channel: r.channel, status: r.status, attempts: r.attempts }));

  it("250 promotions: every one gets exactly one Slack and one SMS across passes (SMS cap 10/hr, DM cap 20/hr), none twice", async () => {
    const holder: { store?: FakeStore } = {};
    const { db } = fakeDb(events(250), { deliveries: () => storeRowsAsDeliveries(holder.store!)() });
    const t = makeDeps({ holds: [], recipients: [OWNER], nowIso: "2026-10-15T12:00:00.000Z" });
    holder.store = t.store;
    t.deps.loadHotPromotions = (org, since) => loadHotPromotions(db, org, since, NOW_MS);
    let ms = NOW_MS;
    for (let pass = 0; pass < 40; pass++) {
      t.setNow(new Date(ms).toISOString());
      await runHoldAlertsForOrg(t.deps, ORG);
      ms += 61 * 60 * 1000;
      if (t.store.rows.length === 500 && t.store.rows.every((r) => r.status === "sent")) break;
    }
    expect(t.sent.filter((s) => s.channel === "slack")).toHaveLength(250);
    expect(t.sent.filter((s) => s.channel === "sms")).toHaveLength(250);
    expect(new Set(t.store.rows.map((r) => `${r.holdKey}|${r.channel}`)).size).toBe(500);
    expect(t.store.rows.every((r) => r.status === "sent" && r.attempts === 1)).toBe(true);
    // A further pass changes nothing.
    t.setNow(new Date(ms).toISOString());
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.filter((s) => s.channel !== "email")).toHaveLength(500);
  });

  it("5,100 events across clock-advance passes (SMS cap 10/hr): all alerted exactly once, none twice, nothing left pending", async () => {
    const clock = { now: new Date(NOW_MS) };
    const store = new IndexedStore(() => clock.now);
    const { db } = fakeDb(events(5100), { deliveries: () => storeRowsAsDeliveries(store)() });
    const t = makeDeps({ holds: [], recipients: [OWNER], nowIso: NOW, store });
    // The look-back is held at the first pass's clock so this exercises paging and draining, not 21 days of aging.
    t.deps.loadHotPromotions = (org, since) => loadHotPromotions(db, org, since, NOW_MS);
    let ms = NOW_MS;
    let passes = 0;
    for (; passes < 600; passes++) {
      clock.now = new Date(ms);
      t.setNow(clock.now.toISOString());
      await runHoldAlertsForOrg(t.deps, ORG);
      ms += 61 * 60 * 1000;
      if (store.rows.length === 10200 && store.rows.every((r) => r.status === "sent")) break;
    }
    expect(passes).toBeLessThan(600);
    expect(t.sent.filter((s) => s.channel === "slack")).toHaveLength(5100);
    expect(t.sent.filter((s) => s.channel === "sms")).toHaveLength(5100);
    expect(new Set(t.sent.map((s) => `${s.channel}|${s.text}`)).size).toBe(10200); // every text names its own lead link
    expect(store.rows.every((r) => r.status === "sent" && r.attempts === 1)).toBe(true);
    // One more pass changes nothing.
    clock.now = new Date(ms);
    t.setNow(clock.now.toISOString());
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toHaveLength(10200);
  }, 300_000);

  it("the newest promotion is delivered in the very first pass even behind a large already-delivered history and an undelivered backlog", async () => {
    const old = events(3000, { base: "2026-10-14T01:00:00.000Z" });
    const backlog = events(300, { base: "2026-10-15T02:00:00.000Z" }).map((e) => ({ ...e, id: `b${e.id}`, property_id: `back-${e.property_id}`, source_id: `back-${e.source_id}` }));
    const newest: EventRow = { ...events(1)[0]!, id: "z-newest", property_id: "prop-newest", source_id: "in-newest", created_at: "2026-10-15T11:30:00.000Z" };
    const holder: { store?: FakeStore } = {};
    const { db } = fakeDb([...old, ...backlog, newest], { deliveries: () => storeRowsAsDeliveries(holder.store!)() });
    const t = makeDeps({ holds: [], recipients: [OWNER], nowIso: NOW });
    holder.store = t.store;
    // The 3,000 old ones are already fully delivered (long ago, outside the SMS-cap hour).
    for (const e of old) {
      for (const channel of ["slack", "sms"] as const) {
        t.store.rows.push({
          id: `h-${e.id}-${channel}`, orgId: ORG, propertyId: null, holdKey: `hot_handoff:${e.source_id}`, recipientUserId: OWNER.userId,
          channel, stage: "first", status: "sent", attempts: 1, lastError: null, createdAt: e.created_at, sentAt: e.created_at,
        });
      }
    }
    t.deps.loadHotPromotions = (org, since) => loadHotPromotions(db, org, since, NOW_MS);
    const loaded = await t.deps.loadHotPromotions(ORG, "2026-10-13T00:00:00.000Z");
    // Finished history never reaches the pass: only the backlog and the newest.
    expect(loaded.promotions).toHaveLength(301);
    expect(loaded.promotions[0]!.propertyId).toBe("prop-newest");

    t.store.watermarks.set(ORG, "2026-10-13T00:00:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.filter((s) => s.channel === "sms")).toHaveLength(301); // backlog + newest, all under the runaway cap
    const newestRows = t.store.rows.filter((r) => r.holdKey === "hot_handoff:in-newest");
    expect(newestRows.map((r) => [r.channel, r.status]).sort()).toEqual([["slack", "sent"], ["sms", "sent"]]);
  });

  it("a hot_text promotion sends 'Hot text on your lead', keyed per inbound message, once", async () => {
    const text: EventRow = { ...events(1)[0]!, id: "t1", property_id: "prop-0", event_type: "ai_escalated", source_type: HOT_TEXT_SOURCE_TYPE, source_id: "inbound-1", created_at: "2026-10-15T11:00:00.000Z" };
    const holder: { store?: FakeStore } = {};
    const { db } = fakeDb([text], { deliveries: () => storeRowsAsDeliveries(holder.store!)() });
    const t = makeDeps({ holds: [], recipients: [OWNER], nowIso: NOW });
    holder.store = t.store;
    t.deps.loadHotPromotions = (org, since) => loadHotPromotions(db, org, since, NOW_MS);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.map((s) => [s.channel, s.text])).toEqual([
      ["slack", "Hot text on your lead: N-prop-0, prop-0 Main St, Kansas City. https://app.example.com/leads/prop-0"],
      ["sms", "Hot text on your lead: N-prop-0, prop-0 Main St, Kansas City. https://app.example.com/leads/prop-0"],
    ]);
    expect(t.store.rows.map((r) => r.holdKey)).toEqual(["hot_text:inbound-1", "hot_text:inbound-1"]);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toHaveLength(2);
  });
});

describe("failed hand-offs (hot_seller_failed)", () => {
  const failed = (over: Partial<EventRow> = {}): EventRow => ({
    id: "f1", org_id: ORG, property_id: "prop-f", event_type: "ai_escalated", source_type: HOT_FAILED_SOURCE_TYPE,
    source_id: "inbound-f", created_at: "2026-10-15T02:00:00.000Z", payload: { reason: "hot_lead_assign_failed", covered_by_hold: false }, ...over,
  });

  it("becomes kind hot_failed keyed hot_failed:<inbound>, with no assignee needed and the reason carried", async () => {
    const { db } = fakeDb([failed()]);
    const { promotions } = await loadHotPromotions(db, ORG, MARK, NOW_MS);
    expect(promotions).toHaveLength(1);
    expect(promotions[0]).toMatchObject({ kind: "hot_failed", key: "hot_failed:inbound-f", propertyId: "prop-f", reason: "hot_lead_assign_failed", assigneeUserId: "" });
  });

  it("a failure whose payload carries flag_at is keyed hot_flag:<property>:<flag_at> (the same key as its hold)", async () => {
    const { db } = fakeDb([failed({ payload: { reason: "hot_lead_assign_failed", covered_by_hold: false, flag_at: "2026-10-15T02:00:00.000Z" } })]);
    const { promotions } = await loadHotPromotions(db, ORG, MARK, NOW_MS);
    expect(promotions).toHaveLength(1);
    expect(promotions[0]).toMatchObject({ kind: "hot_failed", key: "hot_flag:prop-f:2026-10-15T02:00:00.000Z" });
  });

  it("a failure already covered by an alerted hot hold is dropped", async () => {
    const { db } = fakeDb([failed({ payload: { reason: "hot_lead_assign_failed", covered_by_hold: true } })]);
    expect((await loadHotPromotions(db, ORG, MARK, NOW_MS)).promotions).toEqual([]);
  });

  it("a failure is kept even when the lead is currently owned by someone else (the sender skips it, not the loader)", async () => {
    const { db } = fakeDb([failed()], { assignees: { "prop-f": "rep-1" } });
    expect((await loadHotPromotions(db, ORG, MARK, NOW_MS)).promotions.map((p) => p.key)).toEqual(["hot_failed:inbound-f"]);
  });
});

describe("a promotion's time is its INBOUND text's arrival", () => {
  const ev = (over: Partial<EventRow> = {}): EventRow => ({
    id: "h1", org_id: ORG, property_id: "prop-h", event_type: "assigned", source_type: HOT_HANDOFF_SOURCE_TYPE,
    source_id: "inbound-h", created_at: "2026-10-15T05:00:00.000Z", payload: { to: OWNER.userId }, ...over,
  });

  it("assignedAt is messages.created_at, not the event row time", async () => {
    const { db } = fakeDb([ev()], { inboundTimes: { "inbound-h": "2026-10-15T04:30:00.000Z" } });
    const { promotions, complete } = await loadHotPromotions(db, ORG, MARK, NOW_MS);
    expect(complete).toBe(true);
    expect(promotions[0]).toMatchObject({ key: "hot_handoff:inbound-h", assignedAt: "2026-10-15T04:30:00.000Z" });
  });

  it("a pre-cutoff inbound retried after the cutoff (event written after, inbound before) does not page through the alert pass", async () => {
    const { db } = fakeDb([ev({ created_at: "2026-10-15T05:00:00.000Z" })], { inboundTimes: { "inbound-h": "2026-10-14T23:00:00.000Z" } });
    const t = makeDeps({ holds: [], recipients: [OWNER], nowIso: NOW });
    t.deps.loadHotPromotions = (org, since) => loadHotPromotions(db, org, since, NOW_MS);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toEqual([]);
    expect(t.store.rows).toEqual([]);
  });

  it("an event whose inbound time cannot be loaded (missing message) is dropped and the load is incomplete", async () => {
    const { db } = fakeDb([ev()], { inboundTimes: { "inbound-h": null } });
    const { promotions, complete } = await loadHotPromotions(db, ORG, MARK, NOW_MS);
    expect(promotions).toEqual([]);
    expect(complete).toBe(false);
  });

  it("a failed messages lookup drops the batch (fail closed) and marks the load incomplete", async () => {
    const { db } = fakeDb([ev()], { failMessagesAt: 1 });
    const { promotions, complete } = await loadHotPromotions(db, ORG, MARK, NOW_MS);
    expect(promotions).toEqual([]);
    expect(complete).toBe(false);
  });
});
