import { describe, expect, it } from "vitest";

import { resolveMonth, resolveWeek } from "./range";

const CHI = "America/Chicago";

/** Asserts the day-bounds chain is gapless: each cell's endUtc is the next
 *  cell's startUtc, and every cell spans 23/24/25 real hours (DST days
 *  included, nothing else). */
function expectConsecutiveDstSafe(days: { startUtc: string; endUtc: string }[]) {
  for (let i = 0; i < days.length; i++) {
    const span =
      (new Date(days[i].endUtc).getTime() - new Date(days[i].startUtc).getTime()) /
      3_600_000;
    expect([23, 24, 25]).toContain(span);
    if (i > 0) expect(days[i].startUtc).toBe(days[i - 1].endUtc);
  }
}

describe("resolveMonth", () => {
  it("February 2026 in Chicago (28 days starting Sunday) is clamped to 35 consecutive cells, not 28", () => {
    const { monthKey, days } = resolveMonth("2026-02-10", CHI);
    expect(monthKey).toBe("2026-02");
    expect(days).toHaveLength(35);
    expect(days[0].date).toBe("2026-02-01");
    // Row 5 is the next month's first week, present and consecutive.
    expect(days[34].date).toBe("2026-03-07");
    expectConsecutiveDstSafe(days);
  });

  it("August 2026 in Chicago (31 days starting Saturday) fills 42 cells padded into July and September", () => {
    const { monthKey, weekStartDate, days } = resolveMonth("2026-08-14", CHI);
    expect(monthKey).toBe("2026-08");
    expect(days).toHaveLength(42);
    expect(weekStartDate).toBe("2026-07-26");
    expect(days[0].date).toBe("2026-07-26");
    expect(days[41].date).toBe("2026-09-05");
    expectConsecutiveDstSafe(days);
  });

  it("November 2026 in Chicago spans the DST fall-back (Nov 1 is a 25-hour Sunday) with gapless bounds", () => {
    const { days } = resolveMonth("2026-11-15", CHI);
    expect(days[0].date).toBe("2026-11-01");
    const nov1 = days[0];
    const hours =
      (new Date(nov1.endUtc).getTime() - new Date(nov1.startUtc).getTime()) /
      3_600_000;
    expect(hours).toBe(25);
    expectConsecutiveDstSafe(days);
  });

  it("March 2026 in Chicago spans the DST spring-forward (Mar 8 is a 23-hour day) with gapless bounds", () => {
    const { days } = resolveMonth("2026-03-20", CHI);
    const mar8 = days.find((d) => d.date === "2026-03-08");
    expect(mar8).toBeDefined();
    const hours =
      (new Date(mar8!.endUtc).getTime() - new Date(mar8!.startUtc).getTime()) /
      3_600_000;
    expect(hours).toBe(23);
    expectConsecutiveDstSafe(days);
  });

  it("an unparseable anchor falls back to the current month", () => {
    const { monthKey } = resolveMonth("not-a-date", CHI);
    expect(monthKey).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe("resolveWeek", () => {
  it("resolves any anchor day to its Sunday-start week (7 consecutive cells)", () => {
    const { weekStartDate, days } = resolveWeek("2026-08-14", CHI);
    expect(weekStartDate).toBe("2026-08-09");
    expect(days).toHaveLength(7);
    expect(days[6].date).toBe("2026-08-15");
    expectConsecutiveDstSafe(days);
  });
});
