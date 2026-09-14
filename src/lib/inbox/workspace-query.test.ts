import { describe, expect, it, vi } from "vitest";
import { createInboxQueryCache } from "./workspace-query";
const identity = { orgId: "org", userId: "user", sessionId: "session", accessEpoch: "1" };
describe("bounded inbox Query ownership", () => {
  it("revisits without refetching and evicts the least recently opened detail beyond twenty", async () => {
    const cache = createInboxQueryCache(identity), load = vi.fn(async () => ({ messages: [] }));
    for (let i = 0; i < 20; i++) await cache.read("detail", String(i), load);
    await cache.read("detail", "0", load);
    await cache.read("detail", "20", load);
    expect(load).toHaveBeenCalledTimes(21);
    expect(cache.client.getQueryCache().getAll()).toHaveLength(20);
    await cache.read("detail", "1", load);
    expect(load).toHaveBeenCalledTimes(22);
    cache.close();
  });
  it("bounds search counts and receipts independently of conversation history", async () => {
    const cache = createInboxQueryCache(identity);
    for (let i = 0; i < 25; i++) {
      await cache.read("counts", String(i), async () => i);
      await cache.read("receipt", String(i), async () => i);
    }
    expect(cache.client.getQueryCache().getAll()).toHaveLength(11);
    expect(cache.client.getQueryCache().getAll().every(q => JSON.stringify(q.queryKey).includes('"session","1"'))).toBe(true);
    cache.close();
  });
  it("aborts pending requests and cannot repopulate after an access boundary", async () => {
    const cache = createInboxQueryCache(identity);
    let finish!: (value: string) => void, signal!: AbortSignal;
    const pending = cache.read("detail", "A", s => { signal = s; return new Promise(resolve => { finish = resolve; }); });
    const rejected = expect(pending).rejects.toBeDefined();
    cache.close(); finish("late private data");
    await rejected;
    expect(signal.aborted).toBe(true);
    expect(cache.client.getQueryCache().getAll()).toHaveLength(0);
    await expect(cache.read("detail", "A", async () => "bad")).rejects.toThrow("Inbox access ended");
  });
});
