import { describe, expect, it } from "vitest";

import {
  addDaysInZone,
  formatRelativeDay,
  getDayBoundsInZone,
  normalizeTimeZone,
  wallTimeToUtc,
} from "./zoned";

const CHI = "America/Chicago";

describe("wallTimeToUtc", () => {
  it("converts an ordinary (non-DST) wall time correctly", () => {
    // 2026-06-15 15:00 CDT (UTC-5) → 20:00Z
    const out = wallTimeToUtc({ date: "2026-06-15", time: "15:00", timeZone: CHI });
    expect(out).toEqual({ ok: true, utc: new Date("2026-06-15T20:00:00.000Z") });
  });

  it("flags a spring-forward DST gap as nonexistent (Chicago 2026-03-08 02:30)", () => {
    // Chicago springs forward 2:00am → 3:00am on 2026-03-08; 02:30 never happens.
    const out = wallTimeToUtc({ date: "2026-03-08", time: "02:30", timeZone: CHI });
    expect(out).toEqual({ ok: false, reason: "nonexistent" });
  });

  it("resolves a fall-back ambiguous time to the earlier offset (Chicago 2026-11-01 01:30)", () => {
    // Chicago falls back 2:00am CDT → 1:00am CST on 2026-11-01; 01:30 occurs
    // twice. Earlier occurrence is under CDT (UTC-5) → 06:30Z, not the later
    // CST (UTC-6) occurrence at 07:30Z.
    const out = wallTimeToUtc({ date: "2026-11-01", time: "01:30", timeZone: CHI });
    expect(out).toEqual({ ok: true, utc: new Date("2026-11-01T06:30:00.000Z") });
  });

  it("rejects malformed date/time strings", () => {
    expect(wallTimeToUtc({ date: "not-a-date", time: "10:00", timeZone: CHI })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(wallTimeToUtc({ date: "2026-06-15", time: "10:00am", timeZone: CHI })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects out-of-range calendar dates and times", () => {
    expect(wallTimeToUtc({ date: "2026-13-01", time: "10:00", timeZone: CHI })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(wallTimeToUtc({ date: "2026-02-30", time: "10:00", timeZone: CHI })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(wallTimeToUtc({ date: "2026-06-15", time: "25:00", timeZone: CHI })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects an unknown IANA zone", () => {
    expect(
      wallTimeToUtc({ date: "2026-06-15", time: "10:00", timeZone: "Not/AZone" }),
    ).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("getDayBoundsInZone", () => {
  it("gives a 23-hour day on the spring-forward transition (Chicago 2026-03-08)", () => {
    const { dayStart, dayEnd } = getDayBoundsInZone(new Date("2026-03-08T18:00:00Z"), CHI);
    expect(dayStart.toISOString()).toBe("2026-03-08T06:00:00.000Z"); // midnight CST
    expect(dayEnd.toISOString()).toBe("2026-03-09T05:00:00.000Z"); // next midnight CDT
    expect(dayEnd.getTime() - dayStart.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it("gives a 25-hour day on the fall-back transition (Chicago 2026-11-01)", () => {
    const { dayStart, dayEnd } = getDayBoundsInZone(new Date("2026-11-01T18:00:00Z"), CHI);
    expect(dayStart.toISOString()).toBe("2026-11-01T05:00:00.000Z"); // midnight CDT
    expect(dayEnd.toISOString()).toBe("2026-11-02T06:00:00.000Z"); // next midnight CST
    expect(dayEnd.getTime() - dayStart.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it("buckets by the zone's calendar day, not UTC's (evening Central = next day UTC)", () => {
    // 2026-06-15T03:00:00Z is 2026-06-14 22:00 CDT — UTC already reads June 15.
    const lateCentral = new Date("2026-06-15T03:00:00Z");
    const { dayStart, dayEnd } = getDayBoundsInZone(lateCentral, CHI);
    expect(dayStart.toISOString()).toBe("2026-06-14T05:00:00.000Z");
    expect(dayEnd.toISOString()).toBe("2026-06-15T05:00:00.000Z");
  });
});

describe("addDaysInZone", () => {
  it("steps a single day across the spring-forward boundary without +24h drift", () => {
    const marchSeventh = new Date("2026-03-07T06:00:00.000Z"); // midnight CST 3/7
    const next = addDaysInZone(marchSeventh, 1, CHI);
    // If this used naive +24h arithmetic it would land at 06:00Z, one hour
    // off from the real next midnight (05:00Z, now CDT).
    expect(next.toISOString()).toBe("2026-03-08T06:00:00.000Z");
    const dayAfter = addDaysInZone(next, 1, CHI);
    expect(dayAfter.toISOString()).toBe("2026-03-09T05:00:00.000Z");
  });

  it("steps multiple days independently (not days * 24h)", () => {
    const start = getDayBoundsInZone(new Date("2026-03-06T12:00:00Z"), CHI).dayStart;
    const plus3 = addDaysInZone(start, 3, CHI);
    // Spans the spring-forward transition inside the 3-day step.
    expect(plus3.toISOString()).toBe("2026-03-09T05:00:00.000Z");
  });
});

describe("formatRelativeDay", () => {
  it("returns Today / Tomorrow / Yesterday relative to now, in-zone", () => {
    const now = new Date("2026-05-06T18:00:00Z"); // 1pm CDT
    expect(formatRelativeDay(new Date("2026-05-06T22:00:00Z"), CHI, now)).toBe("Today");
    expect(formatRelativeDay(new Date("2026-05-07T14:00:00Z"), CHI, now)).toBe("Tomorrow");
    expect(formatRelativeDay(new Date("2026-05-05T14:00:00Z"), CHI, now)).toBe("Yesterday");
  });

  it("falls back to a weekday/date label further out", () => {
    const now = new Date("2026-05-06T18:00:00Z");
    const out = formatRelativeDay(new Date("2026-05-11T14:00:00Z"), CHI, now);
    expect(out).not.toBe("Today");
    expect(out).not.toBe("Tomorrow");
    expect(out).toMatch(/May/);
  });

  it("stays correct across the fall-back DST boundary (Chicago Nov 1 → Nov 2 is still exactly Tomorrow)", () => {
    const now = new Date("2026-11-01T05:30:00Z"); // Chicago Nov 1, 00:30 CDT
    const target = new Date("2026-11-02T12:00:00Z"); // Chicago Nov 2, 06:00 CST
    expect(formatRelativeDay(target, CHI, now)).toBe("Tomorrow");
  });

  it("disagrees with naive UTC bucketing across the zone/UTC day boundary", () => {
    // now and target are on the same Chicago calendar day (June 14) even
    // though their UTC dates differ (15th and 15th here — both already
    // rolled to the 15th in UTC while Chicago is still on the 14th).
    const now = new Date("2026-06-15T02:00:00Z"); // Chicago June 14, 21:00 CDT
    const target = new Date("2026-06-15T04:00:00Z"); // Chicago June 14, 23:00 CDT
    expect(formatRelativeDay(target, CHI, now)).toBe("Today");
  });
});

describe("normalizeTimeZone", () => {
  it("passes through a valid IANA zone unchanged", () => {
    expect(normalizeTimeZone("America/New_York")).toBe("America/New_York");
  });

  it("falls back to America/Chicago for a garbage zone string", () => {
    expect(normalizeTimeZone("Mars/Olympus")).toBe("America/Chicago");
  });

  it("falls back to America/Chicago for empty, null, and undefined", () => {
    expect(normalizeTimeZone("")).toBe("America/Chicago");
    expect(normalizeTimeZone(null)).toBe("America/Chicago");
    expect(normalizeTimeZone(undefined)).toBe("America/Chicago");
  });
});
