import { describe, expect, it } from "vitest";

import { checkQuietHours } from "./quiet-hours";

// Fix a known moment so Intl.DateTimeFormat produces stable output across
// machines. 2026-06-15 is mid-daylight-saving in both Central (CDT=UTC-5)
// and Eastern (EDT=UTC-4) zones — avoids DST edge cases.

/** 17:00 UTC on a summer day → 12:00 CDT (Missouri) / 13:00 EDT (Ohio). */
const MID_DAY = new Date("2026-06-15T17:00:00Z");
/** 04:00 UTC → 23:00 CDT prior day — outside 8am–9pm window. */
const LATE_NIGHT = new Date("2026-06-15T04:00:00Z");
/** 12:00 UTC → 07:00 CDT — pre-8am, still in quiet hours. */
const EARLY_MORNING = new Date("2026-06-15T12:00:00Z");

describe("checkQuietHours", () => {
  it("returns ok for midday in a BMH market state (MO)", () => {
    const result = checkQuietHours("MO", MID_DAY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.zone).toBe("America/Chicago");
      expect(result.localTime).toBe("12:00");
    }
  });

  it("returns ok for midday in Ohio (America/New_York)", () => {
    const result = checkQuietHours("OH", MID_DAY);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.zone).toBe("America/New_York");
  });

  it("blocks at 23:00 local (late night, past 21:00 cutoff)", () => {
    const result = checkQuietHours("MO", LATE_NIGHT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("outside_window");
      expect(result.localTime).toBe("23:00");
    }
  });

  it("blocks at 07:00 local (early morning, before 08:00)", () => {
    const result = checkQuietHours("MO", EARLY_MORNING);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("outside_window");
      expect(result.localTime).toBe("07:00");
    }
  });

  it("blocks on exactly 21:00 (end of window is exclusive)", () => {
    // 26:00 UTC doesn't exist, but 2am UTC on June 16 = 21:00 CDT June 15
    const at21 = new Date("2026-06-16T02:00:00Z");
    const result = checkQuietHours("MO", at21);
    expect(result.ok).toBe(false);
  });

  it("accepts state in lowercase / with whitespace", () => {
    expect(checkQuietHours("  mo ", MID_DAY).ok).toBe(true);
  });

  it("returns unknown_state when state is null, empty, or unmapped", () => {
    expect(checkQuietHours(null, MID_DAY)).toEqual({
      ok: false,
      reason: "unknown_state",
      localTime: null,
      zone: null,
    });
    const empty = checkQuietHours("", MID_DAY);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toBe("unknown_state");

    const unmapped = checkQuietHours("ZZ", MID_DAY);
    expect(unmapped.ok).toBe(false);
    if (!unmapped.ok) expect(unmapped.reason).toBe("unknown_state");
  });

  // US territories previously fell through STATE_TO_TZ as unmapped and
  // failed closed (unknown_state) on every property — not a window
  // block, a total refusal to send. Table-driven so all five codes are
  // independently protected: an earlier version of this test covered
  // only GU and PR, so removing AS, MP, or VI from STATE_TO_TZ left every
  // test green (see the per-code mutation check this file's PR describes).
  // Each zone's 12:00-local and 23:00-local instants below were computed
  // directly from its fixed UTC offset (none of the five observe DST) and
  // verified against Node's Intl before being hardcoded here.
  const TERRITORY_CASES: Array<{
    code: string;
    zone: string;
    openUtc: string;
    closedUtc: string;
  }> = [
    { code: "GU", zone: "Pacific/Guam", openUtc: "2026-06-15T02:00:00Z", closedUtc: "2026-06-15T13:00:00Z" },
    { code: "MP", zone: "Pacific/Saipan", openUtc: "2026-06-15T02:00:00Z", closedUtc: "2026-06-15T13:00:00Z" },
    { code: "AS", zone: "Pacific/Pago_Pago", openUtc: "2026-06-15T23:00:00Z", closedUtc: "2026-06-16T10:00:00Z" },
    { code: "PR", zone: "America/Puerto_Rico", openUtc: "2026-06-15T16:00:00Z", closedUtc: "2026-06-16T03:00:00Z" },
    { code: "VI", zone: "America/St_Thomas", openUtc: "2026-06-15T16:00:00Z", closedUtc: "2026-06-16T03:00:00Z" },
  ];

  it.each(TERRITORY_CASES)("$code ($zone): ok at 12:00 local", ({ code, zone, openUtc }) => {
    const result = checkQuietHours(code, new Date(openUtc));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.zone).toBe(zone);
      expect(result.localTime).toBe("12:00");
    }
  });

  it.each(TERRITORY_CASES)("$code ($zone): blocks at 23:00 local", ({ code, zone, closedUtc }) => {
    const result = checkQuietHours(code, new Date(closedUtc));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.zone).toBe(zone);
      expect(result.reason).toBe("outside_window");
      expect(result.localTime).toBe("23:00");
    }
  });

  it("still returns unknown_state for an unmapped code after the territory additions (fail-closed default intact)", () => {
    const result = checkQuietHours("XX", MID_DAY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown_state");
  });
});
