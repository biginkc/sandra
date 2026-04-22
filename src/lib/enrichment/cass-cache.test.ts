import { describe, expect, it } from "vitest";

import {
  buildCassCacheKey,
  CASS_CACHE_STALE_DAYS,
  isStale,
} from "./cass-cache";

describe("buildCassCacheKey", () => {
  it("lowercases, trims, and pipe-joins the four parts", () => {
    expect(
      buildCassCacheKey({
        address: "  123 Main St  ",
        city: "KANSAS CITY",
        state: "MO",
        zip: "64108",
      }),
    ).toBe("123 main st|kansas city|mo|64108");
  });

  it("collapses repeated whitespace inside each part", () => {
    expect(
      buildCassCacheKey({
        address: "123   Main   St",
        city: "Kansas  City",
        state: "MO",
        zip: "64108",
      }),
    ).toBe("123 main st|kansas city|mo|64108");
  });

  it("accepts null/undefined for optional parts", () => {
    expect(
      buildCassCacheKey({
        address: "123 Main St",
        city: null,
        state: null,
        zip: null,
      }),
    ).toBe("123 main st|||");
  });

  it("produces the same key regardless of input casing", () => {
    const a = buildCassCacheKey({
      address: "123 Main St",
      city: "Kansas City",
      state: "MO",
      zip: "64108",
    });
    const b = buildCassCacheKey({
      address: "123 MAIN ST",
      city: "kansas city",
      state: "mo",
      zip: "64108",
    });
    expect(a).toBe(b);
  });
});

describe("isStale", () => {
  it("returns false for a fresh timestamp", () => {
    const now = new Date("2026-04-21T12:00:00Z");
    const fresh = new Date("2026-04-20T12:00:00Z");
    expect(isStale(fresh, now)).toBe(false);
  });

  it("returns true once past the TTL window", () => {
    const now = new Date("2026-04-21T12:00:00Z");
    const oneDayOver = new Date(now);
    oneDayOver.setDate(oneDayOver.getDate() - (CASS_CACHE_STALE_DAYS + 1));
    expect(isStale(oneDayOver, now)).toBe(true);
  });

  it("treats exactly-at-TTL as still fresh (inclusive)", () => {
    const now = new Date("2026-04-21T12:00:00Z");
    const exact = new Date(
      now.getTime() - CASS_CACHE_STALE_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(isStale(exact, now)).toBe(false);
  });

  it("accepts ISO string input", () => {
    const now = new Date("2026-04-21T12:00:00Z");
    expect(isStale("2026-04-20T12:00:00Z", now)).toBe(false);
    expect(isStale("2020-01-01T00:00:00Z", now)).toBe(true);
  });
});
