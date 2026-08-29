import { getCache, type RuntimeCache } from "@vercel/functions";

import type {
  CoachRecommendationLimitInput,
  CoachRecommendationLimiter,
} from "./recommendation-server";

const USAGE_TTL_SECONDS = 8 * 60 * 60;

type StoredUsage = { count: number };

function isStoredUsage(value: unknown): value is StoredUsage {
  return (
    typeof value === "object" &&
    value !== null &&
    "count" in value &&
    Number.isSafeInteger((value as StoredUsage).count) &&
    (value as StoredUsage).count >= 0
  );
}

function usageKey(input: CoachRecommendationLimitInput): string {
  return `${input.userId}:${input.callId}:${input.mode}`;
}

/**
 * Server-side v1 ceiling without a new table or migration. Runtime Cache is
 * deliberately ephemeral and regional; the browser cap remains the first
 * layer. The per-key queue closes same-instance read/write races, while the
 * shared cache carries usage across function invocations in the region.
 * Cache failure is fail-closed so provider spend never becomes unbounded.
 */
export function createRuntimeCacheCoachRecommendationLimiter(
  cache: RuntimeCache = getCache({ namespace: "coach-recommendations-v1" }),
): CoachRecommendationLimiter {
  const queues = new Map<string, Promise<void>>();

  return {
    async consume(input) {
      const key = usageKey(input);
      const previous = queues.get(key) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const queued = previous.then(() => gate);
      queues.set(key, queued);
      await previous;

      try {
        const stored = await cache.get(key);
        const count = isStoredUsage(stored) ? stored.count : 0;
        if (count >= input.limit) return { allowed: false };
        const nextCount = count + 1;
        await cache.set(
          key,
          { count: nextCount },
          {
            ttl: USAGE_TTL_SECONDS,
            tags: ["coach-recommendations"],
            name: "coach-recommendation-call-usage",
          },
        );
        // Runtime Cache intentionally converts transport failures into null
        // reads / silent writes. Verify the write was observable before
        // allowing provider use; otherwise a degraded cache would turn the
        // server ceiling into an unlimited pass-through without throwing.
        const verified = await cache.get(key);
        if (!isStoredUsage(verified) || verified.count !== nextCount) {
          return { allowed: false };
        }
        return { allowed: true };
      } catch {
        return { allowed: false };
      } finally {
        release();
        if (queues.get(key) === queued) queues.delete(key);
      }
    },
  };
}
