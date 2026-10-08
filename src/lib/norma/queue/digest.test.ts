import { describe, expect, it, vi } from "vitest";

import { digestEditionFor, NORMA_QUEUE_DIGEST_MAX_ATTEMPTS, runNormaQueueDigestTick, type DigestRow, type DigestStore } from "./digest";

// PROPOSED (RED) shape for plan [B21]. Pure gate: `digestEditionFor(now, tz)` -> { edition, localDate } | null.
// Cron core: `runNormaQueueDigestTick({ now, tz, store, post })` inserts due editions (unique key dedupes), then drains
// pending rows under a lease with backoff, up to 8 attempts, independent of the edition window; at-least-once delivery.
// Windows are LOCAL to NORMA_QUEUE_CAP_TZ: morning [08:45, 09:15), evening [19:45, 20:15).

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

const CHI = "America/Chicago";
const at = (iso: string) => new Date(iso);

describe("digestEditionFor — local-time edition windows", () => {
  it.each([
    // CDT (-05:00), 2026-10-07
    ["CDT 08:44:59 is before the morning window", "2026-10-07T08:44:59-05:00", null],
    ["CDT 08:45:00 opens the morning window", "2026-10-07T08:45:00-05:00", { edition: "morning", localDate: "2026-10-07" }],
    ["CDT 09:14:59 is still morning", "2026-10-07T09:14:59-05:00", { edition: "morning", localDate: "2026-10-07" }],
    ["CDT 09:15:00 closes the morning window", "2026-10-07T09:15:00-05:00", null],
    ["CDT 19:44:59 is before the evening window", "2026-10-07T19:44:59-05:00", null],
    ["CDT 19:45:00 opens the evening window", "2026-10-07T19:45:00-05:00", { edition: "evening", localDate: "2026-10-07" }],
    ["CDT 20:14:59 is still evening", "2026-10-07T20:14:59-05:00", { edition: "evening", localDate: "2026-10-07" }],
    ["CDT 20:15:00 closes the evening window", "2026-10-07T20:15:00-05:00", null],
    ["midday is neither", "2026-10-07T12:00:00-05:00", null],
    // CST (-06:00), after fall-back on 2026-11-01
    ["CST 08:45 is morning (13:45 UTC would be 07:45 CST: not a window)", "2026-11-02T13:45:00Z", null],
    ["CST 08:45 = 14:45Z is morning", "2026-11-02T14:45:00Z", { edition: "morning", localDate: "2026-11-02" }],
    ["CST 19:45 = 01:45Z next day is evening of the LOCAL date", "2026-11-03T01:45:00Z", { edition: "evening", localDate: "2026-11-02" }],
    // Spring forward 2027-03-14: Sat 13th is CST, Mon 15th is CDT
    ["CST (day before spring-forward) 08:45 = 14:45Z is morning", "2027-03-13T14:45:00Z", { edition: "morning", localDate: "2027-03-13" }],
    ["CDT (after spring-forward) 08:45 = 13:45Z is morning", "2027-03-15T13:45:00Z", { edition: "morning", localDate: "2027-03-15" }],
    ["CDT (after spring-forward) 14:45Z is 09:45 local: not a window", "2027-03-15T14:45:00Z", null],
    ["the spring-forward day itself: 08:45 CDT = 13:45Z is morning", "2027-03-14T13:45:00Z", { edition: "morning", localDate: "2027-03-14" }],
  ])("%s", (_label, iso, expected) => {
    expect(digestEditionFor(at(iso), CHI)).toEqual(expected);
  });

  it("uses the configured zone, not the server's or UTC", () => {
    // 13:45Z = 08:45 CDT (open) but 09:45 EDT (closed)
    expect(digestEditionFor(at("2026-10-07T13:45:00Z"), "America/Chicago")).toMatchObject({ edition: "morning" });
    expect(digestEditionFor(at("2026-10-07T13:45:00Z"), "America/New_York")).toBeNull();
  });

  it("local date follows the zone (evening in Chicago is already the next UTC day)", () => {
    expect(digestEditionFor(at("2026-10-08T00:50:00Z"), CHI)).toEqual({ edition: "evening", localDate: "2026-10-07" });
  });

  it("15-minute UTC cron slots always hit exactly one window per edition per day, in both DST regimes", () => {
    for (const day of ["2026-07-15", "2026-12-15"]) {
      const hits: string[] = [];
      for (let minute = 0; minute < 24 * 60; minute += 15) {
        const now = new Date(Date.parse(`${day}T00:00:00Z`) + minute * 60_000);
        const r = digestEditionFor(now, CHI);
        if (r) hits.push(`${r.localDate}:${r.edition}`);
      }
      // each edition window is 30 minutes wide -> 2 slots of a 15-minute cron
      expect(hits.filter((h) => h.endsWith(":morning")).length).toBe(2);
      expect(hits.filter((h) => h.endsWith(":evening")).length).toBe(2);
    }
  });
});

// ---- in-memory store honouring the SQL contract (unique key, lease, attempts) ----
function memoryStore(opts: { activity?: Record<string, { activityCount: number; liveEntries: number }>; orgs?: string[]; markSentFails?: boolean } = {}) {
  const rows: DigestRow[] = [];
  const store: DigestStore = {
    listOrgIds: vi.fn(async () => opts.orgs ?? ["o1"]),
    dayActivity: vi.fn(async (orgId: string) => opts.activity?.[orgId] ?? { activityCount: 0, liveEntries: 0 }),
    buildPayload: vi.fn(async (orgId: string, localDate: string, edition: string) => ({ orgId, localDate, edition })),
    insertDigest: vi.fn(async (d: { orgId: string; localDate: string; edition: string; payload: unknown }) => {
      if (rows.some((r) => r.orgId === d.orgId && r.localDate === d.localDate && r.edition === d.edition)) return false;
      rows.push({ id: `d${rows.length + 1}`, ...d, status: "pending", attempts: 0, lockedUntil: null, nextAttemptAt: null, sentAt: null } as DigestRow);
      return true;
    }),
    claimDue: vi.fn(async (nowIso: string, leaseMs: number) => {
      const now = Date.parse(nowIso);
      const due = rows.filter((r) => r.status === "pending" && r.attempts < NORMA_QUEUE_DIGEST_MAX_ATTEMPTS
        && (!r.lockedUntil || Date.parse(r.lockedUntil) <= now) && (!r.nextAttemptAt || Date.parse(r.nextAttemptAt) <= now));
      for (const r of due) r.lockedUntil = new Date(now + leaseMs).toISOString();
      return due.map((r) => ({ ...r }));
    }),
    markSent: vi.fn(async (id: string, nowIso: string) => {
      if (opts.markSentFails) throw new Error("sent write failed");
      const r = rows.find((x) => x.id === id)!;
      r.status = "sent"; r.sentAt = nowIso;
    }),
    markFailed: vi.fn(async (id: string, f: { error: string; attempts: number; nextAttemptAt: string | null; gaveUp: boolean }) => {
      const r = rows.find((x) => x.id === id)!;
      r.attempts = f.attempts; r.nextAttemptAt = f.nextAttemptAt; r.lockedUntil = null; r.status = f.gaveUp ? "failed" : "pending";
    }),
  };
  return { rows, store };
}

const run = (m: ReturnType<typeof memoryStore>, nowIso: string, post = vi.fn(async () => ({ ts: "1.1" }))) =>
  runNormaQueueDigestTick({ now: () => Date.parse(nowIso), tz: CHI, store: m.store, post });

describe("runNormaQueueDigestTick — creation, dedupe, gating", () => {
  it("inside the morning window inserts a morning row for each org and posts it", async () => {
    const m = memoryStore({ orgs: ["o1", "o2"] });
    const post = vi.fn(async () => ({ ts: "1.1" }));
    await run(m, "2026-10-07T08:50:00-05:00", post);
    expect(m.rows.map((r) => `${r.orgId}:${r.localDate}:${r.edition}`).sort()).toEqual(["o1:2026-10-07:morning", "o2:2026-10-07:morning"]);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("outside both windows inserts nothing", async () => {
    const m = memoryStore();
    await run(m, "2026-10-07T12:00:00-05:00");
    expect(m.rows).toEqual([]);
    expect(m.store.insertDigest).not.toHaveBeenCalled();
  });

  it("dedupes by (org, local_date, edition): a second slot inside the same window posts nothing new", async () => {
    const m = memoryStore();
    const post = vi.fn(async () => ({ ts: "1.1" }));
    await run(m, "2026-10-07T08:50:00-05:00", post);
    await run(m, "2026-10-07T09:05:00-05:00", post);
    expect(m.rows).toHaveLength(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("morning and evening of the same local date are distinct rows", async () => {
    const m = memoryStore({ activity: { o1: { activityCount: 3, liveEntries: 1 } } });
    await run(m, "2026-10-07T08:50:00-05:00");
    await run(m, "2026-10-07T19:50:00-05:00");
    expect(m.rows.map((r) => r.edition).sort()).toEqual(["evening", "morning"]);
  });

  // Plan [B21]: both editions are inserted inside their local-time windows; the evening edition REPORTS activity counts
  // (it is not gated on them); the morning edition is unconditional. No suppression rule is encoded here.
  it("the evening edition is inserted inside its window and its payload is built from that local date's activity", async () => {
    const m = memoryStore({ activity: { o1: { activityCount: 2, liveEntries: 4 } } });
    await run(m, "2026-10-07T19:50:00-05:00");
    expect(m.rows.map((r) => r.edition)).toEqual(["evening"]);
    expect(m.store.dayActivity).toHaveBeenCalledWith("o1", "2026-10-07");
    expect(m.store.buildPayload).toHaveBeenCalledWith("o1", "2026-10-07", "evening");
  });

  it("the evening edition with ZERO activity and ZERO live entries is still inserted inside its window (guards against suppression)", async () => {
    const m = memoryStore({ activity: { o1: { activityCount: 0, liveEntries: 0 } } });
    await run(m, "2026-10-07T19:50:00-05:00");
    expect(m.rows.map((r) => `${r.localDate}:${r.edition}`)).toEqual(["2026-10-07:evening"]);
    expect(m.store.insertDigest).toHaveBeenCalledTimes(1);
  });

  it("activity is measured for the org's LOCAL date, not the UTC date", async () => {
    const m = memoryStore({ activity: { o1: { activityCount: 1, liveEntries: 0 } } });
    await run(m, "2026-10-08T00:50:00Z"); // 19:50 CDT on the 7th
    expect(m.store.dayActivity).toHaveBeenCalledWith("o1", "2026-10-07");
  });

  it("the morning edition is inserted unconditionally inside its window (no activity, no live entries)", async () => {
    const m = memoryStore({ activity: { o1: { activityCount: 0, liveEntries: 0 } } });
    await run(m, "2026-10-07T08:50:00-05:00");
    expect(m.rows.map((r) => `${r.localDate}:${r.edition}`)).toEqual(["2026-10-07:morning"]);
  });
});

describe("runNormaQueueDigestTick — lease, retry, at-least-once", () => {
  it("two overlapping runs post a row once (lease claim)", async () => {
    const m = memoryStore();
    await m.store.insertDigest({ orgId: "o1", localDate: "2026-10-07", edition: "morning", payload: {} });
    const post = vi.fn(async () => ({ ts: "1.1" }));
    await Promise.all([run(m, "2026-10-07T08:50:00-05:00", post), run(m, "2026-10-07T08:50:00-05:00", post)]);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("a post failure records the failure with backoff and leaves the row pending", async () => {
    const m = memoryStore();
    const post = vi.fn(async () => { throw new Error("slack down"); });
    await run(m, "2026-10-07T08:50:00-05:00", post);
    expect(m.rows[0]).toMatchObject({ status: "pending", attempts: 1 });
    expect(Date.parse(m.rows[0].nextAttemptAt!)).toBeGreaterThan(Date.parse("2026-10-07T08:50:00-05:00"));
  });

  it("a row still backing off is not re-posted early", async () => {
    const m = memoryStore();
    const post = vi.fn(async () => { throw new Error("slack down"); });
    await run(m, "2026-10-07T08:50:00-05:00", post);
    await run(m, "2026-10-07T08:50:30-05:00", post);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("backoff never shrinks as attempts grow", async () => {
    const m = memoryStore();
    const post = vi.fn(async () => { throw new Error("slack down"); });
    let now = Date.parse("2026-10-07T08:50:00-05:00");
    const gaps: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      await runNormaQueueDigestTick({ now: () => now, tz: CHI, store: m.store, post });
      const next = m.rows[0].nextAttemptAt ? Date.parse(m.rows[0].nextAttemptAt) : now;
      gaps.push(next - now);
      now = next;
    }
    for (let i = 1; i < gaps.length; i += 1) expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1]);
  });

  it("retries a failed row hours later, OUTSIDE the edition window (independent of the window)", async () => {
    const m = memoryStore();
    const failing = vi.fn(async () => { throw new Error("slack down"); });
    await run(m, "2026-10-07T08:50:00-05:00", failing);
    const ok = vi.fn(async () => ({ ts: "9.9" }));
    await run(m, "2026-10-07T15:00:00-05:00", ok); // far outside [08:45, 09:15)
    expect(ok).toHaveBeenCalledTimes(1);
    expect(m.rows[0].status).toBe("sent");
    expect(m.rows).toHaveLength(1);
  });

  it("gives up after exactly 8 attempts and never posts a 9th time for that row", async () => {
    expect(NORMA_QUEUE_DIGEST_MAX_ATTEMPTS).toBe(8);
    const m = memoryStore();
    const post = vi.fn(async () => { throw new Error("slack down"); });
    let now = Date.parse("2026-10-07T08:50:00-05:00");
    for (let i = 0; i < 12; i += 1) {
      await runNormaQueueDigestTick({ now: () => now, tz: CHI, store: m.store, post });
      now += 24 * 60 * 60_000; // far past any backoff; each new day also inserts its own unconditional edition row (B21)
    }
    // The first row is retried independent of its window and stops at exactly 8.
    expect(m.rows[0]).toMatchObject({ status: "failed", attempts: 8 });
    // No row is ever posted a 9th time, and every post is accounted for by a row attempt.
    expect(m.rows.every((r) => r.attempts <= 8)).toBe(true);
    expect(post).toHaveBeenCalledTimes(m.rows.reduce((n, r) => n + r.attempts, 0));
  });

  it("a failed sent-write leaves the row reclaimable after the lease (possible duplicate, accepted)", async () => {
    const m = memoryStore({ markSentFails: true });
    const post = vi.fn(async () => ({ ts: "1.1" }));
    await run(m, "2026-10-07T08:50:00-05:00", post);
    expect(m.rows[0].status).toBe("pending");
    await run(m, "2026-10-07T12:00:00-05:00", post); // lease long expired
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("one org's failing post does not block another org's digest", async () => {
    const m = memoryStore({ orgs: ["o1", "o2"] });
    const post = vi.fn(async (payload: { orgId?: string }) => {
      if (payload?.orgId === "o1") throw new Error("slack down");
      return { ts: "1.1" };
    });
    await run(m, "2026-10-07T08:50:00-05:00", post as never);
    expect(m.rows.find((r) => r.orgId === "o2")?.status).toBe("sent");
    expect(m.rows.find((r) => r.orgId === "o1")?.status).toBe("pending");
  });

  it("the tick never throws on a post failure", async () => {
    const m = memoryStore();
    await expect(run(m, "2026-10-07T08:50:00-05:00", vi.fn(async () => { throw new Error("x"); }))).resolves.toBeDefined();
  });
});
