import { afterEach, describe, expect, it, vi } from "vitest";
import { createInboxServerTiming, type InboxTimingSummary } from "./server-timing";

afterEach(() => vi.unstubAllEnvs());

describe("Inbox baseline server timing", () => {
  it("is off by default and preserves the original promise without consulting telemetry", async () => {
    vi.stubEnv("INBOX_TIMING_ENABLED", "");
    const now = vi.fn();
    const id = vi.fn();
    const emit = vi.fn();
    const timing = createInboxServerTiming({ now, id, emit });
    const promise = Promise.resolve({ ok: false });
    expect(timing.measure("list", () => promise)).toBe(promise);
    timing.finish("returned");
    expect(now).not.toHaveBeenCalled();
    expect(id).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("measures concurrent branches and emits one bounded summary without payloads", async () => {
    let clock = 0;
    const emit = vi.fn();
    const timing = createInboxServerTiming({ enabled: true, now: () => clock, id: () => "request-1", emit });
    timing.setSurface("inbox");
    let resolve!: (value: string) => void;
    const detail = timing.measure("detail", () => new Promise<string>((done) => { resolve = done; }));
    clock = 3;
    const secret = { customer: "private", ok: false };
    expect(await timing.measure("queue_stats", async () => secret)).toBe(secret);
    clock = 12;
    resolve("private message text");
    await detail;
    clock = 15;
    timing.finish("returned");
    timing.finish("returned");
    await timing.measure("detail", async () => "later");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toEqual({
      event: "inbox.page.server_timing.v1", requestId: "request-1", surface: "inbox", totalMs: 15, outcome: "returned",
      spans: [
        { stage: "detail", durationMs: 12, status: "resolved" },
        { stage: "queue_stats", durationMs: 0, status: "resolved" },
      ],
    });
    expect(JSON.stringify(emit.mock.calls)).not.toContain("private");
  });

  it("preserves rejection identity and snapshots pending siblings without waiting", async () => {
    const summaries: InboxTimingSummary[] = [];
    const timing = createInboxServerTiming({ enabled: true, now: () => 1, emit: (s) => summaries.push(s) });
    let resolve!: () => void;
    const sibling = timing.measure("unknown", () => new Promise<void>((done) => { resolve = done; }));
    const original = new Error("sensitive failure");
    await expect(timing.measure("detail", async () => { throw original; })).rejects.toBe(original);
    timing.finish("interrupted");
    resolve();
    await sibling;
    expect(summaries).toHaveLength(1);
    expect(summaries[0].spans).toEqual([
      { stage: "unknown", durationMs: null, status: "pending" },
      { stage: "detail", durationMs: 0, status: "rejected" },
    ]);
    expect(JSON.stringify(summaries)).not.toContain("sensitive");
  });

  it("preserves synchronous throws including redirect signals", () => {
    const timing = createInboxServerTiming({ enabled: true });
    const signal = { digest: "NEXT_REDIRECT" };
    try { timing.measure("auth", () => { throw signal; }); }
    catch (error) { expect(error).toBe(signal); return; }
    throw new Error("Expected original signal");
  });

  it("ignores broken clocks, emitters and correlation generators", async () => {
    const timing = createInboxServerTiming({ enabled: true, now: () => { throw new Error(); }, emit: () => { throw new Error(); } });
    expect(await timing.measure("auth", async () => 42)).toBe(42);
    expect(() => timing.finish("returned")).not.toThrow();
    const brokenId = createInboxServerTiming({ enabled: true, id: () => { throw new Error(); } });
    expect(await brokenId.measure("auth", async () => 43)).toBe(43);
    expect(() => brokenId.finish("returned")).not.toThrow();
  });

  it("enables only on the explicit server flag and uses distinct random request IDs", async () => {
    vi.stubEnv("INBOX_TIMING_ENABLED", "1");
    const emit = vi.fn();
    for (let i = 0; i < 2; i++) {
      const timing = createInboxServerTiming({ emit });
      for (let j = 0; j < 20; j++) await timing.measure("list", async () => j);
      timing.finish("returned");
    }
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[0][0].requestId).not.toBe(emit.mock.calls[1][0].requestId);
    expect(emit.mock.calls[0][0].spans).toHaveLength(1);
  });
});
