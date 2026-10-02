import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import {
  NORMA_NOTIFICATION_LEASE_MS,
  NORMA_NOTIFICATION_MAX_ATTEMPTS,
  drainNormaNotifications,
  normaNotificationBackoffMs,
  readNormaSlackConfig,
} from "./slack-worker";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

type Row = Record<string, unknown>;

/** In-memory double: records every write so tests can prove only the outbox is touched. */
function makeClient(tables: Record<string, Row[]>, failWrite?: (values: Row) => boolean) {
  const writes: { table: string; values: Row }[] = [];
  function from(table: string) {
    let rows = tables[table] ?? [];
    let pending: Row | null = null;
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (col: string, val: unknown) => ((rows = rows.filter((r) => r[col] === val)), api),
      lte: (col: string, val: string) => ((rows = rows.filter((r) => String(r[col]) <= val)), api),
      order: () => api,
      limit: (n: number) => ((rows = rows.slice(0, n)), api),
      update: (values: Row) => ((pending = values), api),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        if (pending && failWrite?.(pending)) return resolve({ data: null, error: { message: "db down" } });
        if (pending) {
          writes.push({ table, values: pending });
          for (const row of rows) Object.assign(row, pending);
          return resolve({ data: rows.map((r) => ({ id: r.id })), error: null });
        }
        return resolve({ data: rows, error: null });
      },
    };
    return api;
  }
  return { client: { from } as unknown as SupabaseClient<Database>, writes, tables };
}

const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function fixture(notificationOverrides: Row[] = [{}], failWrite?: (values: Row) => boolean) {
  return makeClient({
    norma_notifications: notificationOverrides.map((o, i) => ({
      id: `n${i}`, request_id: `r${i}`, kind: "call_completed", status: "pending", attempts: 0,
      next_attempt_at: iso(NOW - 1000), slack_ts: null, last_error: null, ...o,
    })),
    norma_call_requests: notificationOverrides.map((_, i) => ({
      id: `r${i}`, property_id: "p1", contact_id: "c1", outcome: "callback_requested", summary: "s",
      qualification: { price_expectation: "200k" }, callback_raw: "after 5",
    })),
    properties: [{ id: "p1", address: "12 Oak St", city: "KC", state: "MO" }],
    contacts: [{ id: "c1", contact_type: "person", first_name: "Pat", last_name: "Seller", entity_name: null }],
  }, failWrite);
}

describe("readNormaSlackConfig", () => {
  it("is null unless both values are set", () => {
    expect(readNormaSlackConfig({})).toBeNull();
    expect(readNormaSlackConfig({ NORMA_SLACK_BOT_TOKEN: "t" })).toBeNull();
    expect(readNormaSlackConfig({ NORMA_SLACK_CHANNEL_ID: "C1" })).toBeNull();
    expect(readNormaSlackConfig({ NORMA_SLACK_BOT_TOKEN: "t", NORMA_SLACK_CHANNEL_ID: "C1" })).toEqual({ botToken: "t", channelId: "C1" });
  });
});

describe("drainNormaNotifications", () => {
  it("is a no-op that leaves rows pending when Slack is not configured", async () => {
    const f = fixture();
    const summary = await drainNormaNotifications({ client: f.client, post: null, now: NOW });
    expect(summary).toMatchObject({ configured: false, scanned: 0, sent: 0 });
    expect(f.writes).toEqual([]);
    expect(f.tables.norma_notifications[0]).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("posts once, stores the Slack ts and marks the row sent", async () => {
    const f = fixture();
    const post = vi.fn().mockResolvedValue({ ts: "1700000000.000100" });
    const summary = await drainNormaNotifications({ client: f.client, post, now: NOW, env: { APP_URL: "https://app.test" } });
    expect(summary.sent).toBe(1);
    expect(post).toHaveBeenCalledTimes(1);
    const message = post.mock.calls[0][0];
    expect(JSON.stringify(message.blocks)).toContain("https://app.test/leads/p1");
    expect(JSON.stringify(message.blocks)).toContain("Pat Seller");
    expect(f.tables.norma_notifications[0]).toMatchObject({ status: "sent", slack_ts: "1700000000.000100", attempts: 1 });
  });

  it("includes the converted callback time for a callback", async () => {
    const f = fixture();
    Object.assign(f.tables.norma_call_requests[0]!, { callback_requested_for: "2026-10-06T20:00:00.000Z", callback_timezone: "America/Chicago" });
    const post = vi.fn().mockResolvedValue({ ts: "6.6" });
    await drainNormaNotifications({ client: f.client, post, now: NOW });
    expect(JSON.stringify(post.mock.calls[0][0].blocks)).toContain("Converted callback time (unconfirmed):* Tue, Oct 6, 3:00 PM CDT");
  });

  it("does not post again for a sent row, and posts once per pending row", async () => {
    const f = fixture([{}, { status: "sent", slack_ts: "x" }, {}]);
    const post = vi.fn().mockResolvedValue({ ts: "1.1" });
    await drainNormaNotifications({ client: f.client, post, now: NOW });
    expect(post).toHaveBeenCalledTimes(2);
    const again = await drainNormaNotifications({ client: f.client, post, now: NOW + 1000 });
    expect(again.scanned).toBe(0);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("skips rows that are not yet due", async () => {
    const f = fixture([{ next_attempt_at: iso(NOW + 60_000) }]);
    const post = vi.fn();
    expect((await drainNormaNotifications({ client: f.client, post, now: NOW })).scanned).toBe(0);
    expect(post).not.toHaveBeenCalled();
  });

  it("backs off on failure, keeps the row pending, and writes nothing but the outbox", async () => {
    const f = fixture();
    const post = vi.fn().mockRejectedValue(new Error("slack_post_failed:channel_not_found"));
    const summary = await drainNormaNotifications({ client: f.client, post, now: NOW });
    expect(summary).toMatchObject({ failed: 1, sent: 0 });
    const row = f.tables.norma_notifications[0];
    expect(row).toMatchObject({ status: "pending", attempts: 1, last_error: "slack_post_failed:channel_not_found" });
    expect(Date.parse(String(row.next_attempt_at))).toBe(NOW + normaNotificationBackoffMs(1));
    expect(f.writes.every((w) => w.table === "norma_notifications")).toBe(true);
    expect(f.writes.some((w) => w.table === "norma_call_requests" || w.table === "tasks" || w.table === "properties")).toBe(false);
  });

  it("is not retried until its backoff has elapsed, then succeeds", async () => {
    const f = fixture();
    const post = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ ts: "2.2" });
    await drainNormaNotifications({ client: f.client, post, now: NOW });
    await drainNormaNotifications({ client: f.client, post, now: NOW + 10_000 });
    expect(post).toHaveBeenCalledTimes(1);
    await drainNormaNotifications({ client: f.client, post, now: NOW + normaNotificationBackoffMs(1) + 1 });
    expect(post).toHaveBeenCalledTimes(2);
    expect(f.tables.norma_notifications[0]).toMatchObject({ status: "sent", slack_ts: "2.2", attempts: 2, last_error: null });
  });

  it("gives up after the maximum number of attempts", async () => {
    const f = fixture([{ attempts: NORMA_NOTIFICATION_MAX_ATTEMPTS - 1 }]);
    const summary = await drainNormaNotifications({ client: f.client, post: vi.fn().mockRejectedValue(new Error("x")), now: NOW });
    expect(summary.gaveUp).toBe(1);
    expect(f.tables.norma_notifications[0]).toMatchObject({ status: "failed" });
  });

  it("leases a row before posting so an overlapping run cannot double post", async () => {
    const f = fixture();
    let leasedDuringPost: unknown;
    const post = vi.fn().mockImplementation(async () => {
      leasedDuringPost = f.tables.norma_notifications[0].next_attempt_at;
      return { ts: "3.3" };
    });
    await drainNormaNotifications({ client: f.client, post, now: NOW });
    expect(Date.parse(String(leasedDuringPost))).toBe(NOW + NORMA_NOTIFICATION_LEASE_MS);
  });

  it("does not back a posted row off into a re-post when the sent-write fails", async () => {
    const f = fixture([{}], (values) => values.status === "sent");
    const post = vi.fn().mockResolvedValue({ ts: "4.4" });
    const summary = await drainNormaNotifications({ client: f.client, post, now: NOW });
    expect(summary).toMatchObject({ sent: 0, failed: 0, unrecorded: 1 });
    const row = f.tables.norma_notifications[0];
    // Still pending, still leased, no backoff write, no attempt recorded as a failure.
    expect(row).toMatchObject({ status: "pending", attempts: 0 });
    expect(Date.parse(String(row.next_attempt_at))).toBe(NOW + NORMA_NOTIFICATION_LEASE_MS);
    expect(f.writes.some((w) => w.values.last_error !== undefined)).toBe(false);
    const again = await drainNormaNotifications({ client: f.client, post, now: NOW + 1000 });
    expect(again.scanned).toBe(0);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("stops starting posts when the run budget is spent and leaves the rest pending", async () => {
    const f = fixture([{}, {}, {}, {}]);
    let t = 0;
    const post = vi.fn().mockImplementation(async () => {
      t += 15_000; // each post is slow
      return { ts: "5.5" };
    });
    const summary = await drainNormaNotifications({ client: f.client, post, now: NOW, clock: () => t, budgetMs: 45_000 });
    // 45s budget minus the 13s per-row reserve: rows start at t=0, 15s, 30s; the 4th (t=45s) is deferred.
    expect(summary).toMatchObject({ sent: 3, deferred: 1 });
    expect(f.tables.norma_notifications[3]).toMatchObject({ status: "pending", attempts: 0 });
    expect(Date.parse(String(f.tables.norma_notifications[3].next_attempt_at))).toBe(NOW - 1000);
    // The next run picks the deferred row up.
    const next = await drainNormaNotifications({ client: f.client, post, now: NOW + 1000, clock: () => 0 });
    expect(next.sent).toBe(1);
  });

  it("never exceeds the 60s function limit even when every post hits its timeout", async () => {
    const f = fixture(Array.from({ length: 10 }, () => ({})));
    let t = 0;
    const post = vi.fn().mockImplementation(async () => {
      t += 10_000;
      throw new Error("timeout");
    });
    await drainNormaNotifications({ client: f.client, post, now: NOW, clock: () => t });
    expect(t).toBeLessThanOrEqual(60_000 - 10_000);
  });

  it("treats an unreadable request as a failure, not a post", async () => {
    const f = fixture();
    f.tables.norma_call_requests.length = 0;
    const post = vi.fn();
    const summary = await drainNormaNotifications({ client: f.client, post, now: NOW });
    expect(post).not.toHaveBeenCalled();
    expect(summary.failed).toBe(1);
  });
});

describe("normaNotificationBackoffMs", () => {
  it("grows then caps", () => {
    expect(normaNotificationBackoffMs(1)).toBeLessThan(normaNotificationBackoffMs(2));
    expect(normaNotificationBackoffMs(99)).toBe(normaNotificationBackoffMs(6));
  });
});
