import type { RuntimeCache } from "@vercel/functions";
import { describe, expect, it, vi } from "vitest";

import { createRuntimeCacheCoachRecommendationLimiter } from "./recommendation-runtime-limiter";

function fakeCache(): RuntimeCache & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key);
    }),
    expireTag: vi.fn(async () => {}),
  };
}

describe("Runtime Cache coach recommendation limiter", () => {
  it("enforces the exact mode-specific per-owner call ceiling", async () => {
    const cache = fakeCache();
    const limiter = createRuntimeCacheCoachRecommendationLimiter(cache);
    const automatic = { userId: "user-1", callId: "call-1", mode: "automatic" as const, limit: 2 };

    await expect(limiter.consume(automatic)).resolves.toEqual({ allowed: true });
    await expect(limiter.consume(automatic)).resolves.toEqual({ allowed: true });
    await expect(limiter.consume(automatic)).resolves.toEqual({ allowed: false });
    await expect(limiter.consume({ ...automatic, mode: "follow_up" })).resolves.toEqual({ allowed: true });
    await expect(limiter.consume({ ...automatic, callId: "call-2" })).resolves.toEqual({ allowed: true });
    await expect(limiter.consume({ ...automatic, userId: "user-2" })).resolves.toEqual({ allowed: true });
  });

  it("serializes concurrent consumption for the same key", async () => {
    const cache = fakeCache();
    const limiter = createRuntimeCacheCoachRecommendationLimiter(cache);
    const input = { userId: "user-1", callId: "call-1", mode: "follow_up" as const, limit: 2 };

    const results = await Promise.all([
      limiter.consume(input),
      limiter.consume(input),
      limiter.consume(input),
      limiter.consume(input),
    ]);

    expect(results.filter((result) => result.allowed)).toHaveLength(2);
  });

  it("fails closed when Runtime Cache is unavailable", async () => {
    const cache = fakeCache();
    vi.mocked(cache.get).mockRejectedValueOnce(new Error("cache unavailable"));
    const limiter = createRuntimeCacheCoachRecommendationLimiter(cache);

    await expect(
      limiter.consume({ userId: "user-1", callId: "call-1", mode: "automatic", limit: 40 }),
    ).resolves.toEqual({ allowed: false });
  });

  it("fails closed when Runtime Cache swallows transport errors as null reads and silent writes", async () => {
    const cache = fakeCache();
    vi.mocked(cache.get).mockResolvedValue(null);
    vi.mocked(cache.set).mockResolvedValue(undefined);
    const limiter = createRuntimeCacheCoachRecommendationLimiter(cache);

    await expect(
      limiter.consume({ userId: "user-1", callId: "call-1", mode: "automatic", limit: 40 }),
    ).resolves.toEqual({ allowed: false });
    expect(cache.get).toHaveBeenCalledTimes(2);
  });
});
