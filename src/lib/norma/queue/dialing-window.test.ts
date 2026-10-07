import { describe, expect, it } from "vitest";

import { checkQuietHours, STATE_TO_TZ } from "@/lib/messaging/quiet-hours";

import { isWithinDialingWindow, nextWindowStart, zoneForState } from "./dialing-window";

// Oracle: every expected instant is hand-written with its explicit UTC offset.
// Window (Jarrad 2026-10-07): 09:00 <= local < 19:30, Monday–Saturday, seller zone = STATE_TO_TZ[property.state].
const at = (iso: string) => new Date(iso);

describe("zoneForState", () => {
  it("uses the existing state map and fails closed on unknown states", () => {
    expect(zoneForState("MO")).toBe("America/Chicago");
    expect(zoneForState("az")).toBe("America/Phoenix");
    expect(zoneForState("ZZ")).toBeNull();
    expect(zoneForState(null)).toBeNull();
    expect(zoneForState("")).toBeNull();
  });
});

describe("isWithinDialingWindow", () => {
  it.each([
    ["opens at 09:00:00", "2026-10-07T09:00:00-05:00", true],
    ["closed one second before open", "2026-10-07T08:59:59-05:00", false],
    ["open one second before close", "2026-10-07T19:29:59-05:00", true],
    ["closed at 19:30:00", "2026-10-07T19:30:00-05:00", false],
    ["Saturday is a dialing day", "2026-10-10T12:00:00-05:00", true],
    ["Sunday is never a dialing day", "2026-10-11T12:00:00-05:00", false],
  ])("MO: %s", (_label, iso, expected) => {
    expect(isWithinDialingWindow("MO", at(iso))).toBe(expected);
  });

  it("evaluates in the seller's zone, not the server's", () => {
    // 15:00Z = 10:00 CDT (open) but 08:00 PDT (closed).
    expect(isWithinDialingWindow("MO", at("2026-10-07T15:00:00Z"))).toBe(true);
    expect(isWithinDialingWindow("CA", at("2026-10-07T15:00:00Z"))).toBe(false);
  });

  it("fails closed for an unknown state", () => {
    expect(isWithinDialingWindow("ZZ", at("2026-10-07T17:00:00Z"))).toBe(false);
  });

  it("is always inside the existing 08:00–21:00 quiet-hours window", () => {
    const start = Date.parse("2026-10-05T00:00:00Z");
    let inWindowSeen = 0;
    for (const state of Object.keys(STATE_TO_TZ)) {
      for (let minute = 0; minute < 7 * 24 * 60; minute += 15) {
        const now = new Date(start + minute * 60_000);
        if (isWithinDialingWindow(state, now)) {
          inWindowSeen += 1;
          expect(checkQuietHours(state, now).ok).toBe(true);
        }
      }
    }
    // Guard against a vacuous pass: the sweep must actually have seen open-window instants.
    expect(inWindowSeen).toBeGreaterThan(0);
  });
});

describe("nextWindowStart", () => {
  it.each([
    ["inside the window returns now", "MO", "2026-10-07T10:30:00-05:00", "2026-10-07T10:30:00-05:00"],
    ["Wednesday after close → Thursday 09:00", "MO", "2026-10-07T20:00:00-05:00", "2026-10-08T09:00:00-05:00"],
    ["Saturday 19:31 → Monday 09:00", "MO", "2026-10-10T19:31:00-05:00", "2026-10-12T09:00:00-05:00"],
    ["Sunday midday → Monday 09:00", "MO", "2026-10-11T11:00:00-05:00", "2026-10-12T09:00:00-05:00"],
    ["Saturday before open → Saturday 09:00", "MO", "2026-10-10T08:00:00-05:00", "2026-10-10T09:00:00-05:00"],
    ["spring forward: Sat 20:00 CST → Mon 09:00 CDT", "MO", "2027-03-13T20:00:00-06:00", "2027-03-15T09:00:00-05:00"],
    ["fall back: Sat 20:00 CDT → Mon 09:00 CST", "MO", "2026-10-31T20:00:00-05:00", "2026-11-02T09:00:00-06:00"],
    ["Arizona has no DST (October)", "AZ", "2026-10-07T20:00:00-07:00", "2026-10-08T09:00:00-07:00"],
    ["Arizona has no DST (March)", "AZ", "2027-03-13T20:00:00-07:00", "2027-03-15T09:00:00-07:00"],
  ])("%s", (_label, state, now, expected) => {
    expect(nextWindowStart(state, at(now))?.toISOString()).toBe(at(expected).toISOString());
  });

  it("returns null for an unknown state", () => {
    expect(nextWindowStart("ZZ", at("2026-10-07T12:00:00Z"))).toBeNull();
  });
});
