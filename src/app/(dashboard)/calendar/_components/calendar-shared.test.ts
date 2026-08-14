import { describe, expect, it } from "vitest";

import { formatTimeRange } from "./calendar-shared";

const CHI = "America/Chicago";

describe("formatTimeRange", () => {
  it("renders a normal same-day range unchanged (no marker, no zone abbreviation)", () => {
    expect(
      formatTimeRange("2026-05-05T15:00:00.000Z", "2026-05-05T15:30:00.000Z", CHI),
    ).toBe("10:00 AM–10:30 AM");
  });

  it("appends a next-day marker when the zone-local calendar date rolls over (cross-midnight block)", () => {
    // 11:30 PM CDT (May 5) -> 12:15 AM CDT (May 6).
    expect(
      formatTimeRange("2026-05-06T04:30:00.000Z", "2026-05-06T05:15:00.000Z", CHI),
    ).toBe("11:30 PM–12:15 AM → Wed");
  });

  it("disambiguates an America/Chicago DST fall-back hour with zone abbreviations (2026-11-01)", () => {
    // Clocks fall back from 2:00 AM CDT to 1:00 AM CST at 2026-11-01
    // 07:00 UTC. 06:30 UTC = 1:30 AM CDT (pre-fallback); 07:30 UTC =
    // 1:30 AM CST (post-fallback) — same wall-clock label, one real hour
    // apart.
    expect(
      formatTimeRange("2026-11-01T06:30:00.000Z", "2026-11-01T07:30:00.000Z", CHI),
    ).toBe("1:30 AM CDT–1:30 AM CST");
  });

  it("disambiguates when the DST fall-back makes the end's wall-clock label appear to precede the start's", () => {
    // 1:45 AM CDT (pre-fallback, 06:45 UTC) -> 1:15 AM CST (post-fallback,
    // 07:15 UTC) — 30 real minutes later, but the bare wall-clock labels
    // would read as going backwards without the zone abbreviations.
    expect(
      formatTimeRange("2026-11-01T06:45:00.000Z", "2026-11-01T07:15:00.000Z", CHI),
    ).toBe("1:45 AM CDT–1:15 AM CST");
  });

  it("leaves a zero-length range (defensive end_at === due_at fallback) unmarked", () => {
    expect(
      formatTimeRange("2026-05-05T15:00:00.000Z", "2026-05-05T15:00:00.000Z", CHI),
    ).toBe("10:00 AM–10:00 AM");
  });
});
