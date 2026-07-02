/**
 * Quiet-hours enforcement — TCPA calls for no marketing SMS between
 * 9pm and 8am local to the recipient. We compute local time from the
 * linked property's `state` (not the phone's area code, which is
 * unreliable after porting; not the contact's mailing address, which
 * may live in a different zone than the property).
 *
 * Window: [08:00, 21:00) local. At 21:00:00 exactly we block.
 */

export const QUIET_HOURS_OPEN_HOUR = 8;
export const QUIET_HOURS_CLOSE_HOUR = 21;

/**
 * State (USPS 2-letter) -> IANA timezone string. Re-exported for cross-module
 * reuse by the dialer (Jitter Phase 1, migration 058).
 *
 * Covers BMH's four markets first, then
 * a fallback table for the rest of the US. States that span multiple
 * zones (AK, AZ, FL, ID, IN, KS, KY, MI, NE, ND, OR, SD, TN, TX) pick
 * the MOST-populated zone, which is wrong in border towns but a safe
 * default until we drive this off zip.
 */
export const STATE_TO_TZ: Record<string, string> = {
  // BMH markets (confirmed)
  MO: "America/Chicago", // Kansas City, St. Louis, Lake of the Ozarks
  OH: "America/New_York", // Dayton

  // Rest, in alpha order — pick dominant zone.
  AL: "America/Chicago",
  AK: "America/Anchorage",
  AZ: "America/Phoenix",
  AR: "America/Chicago",
  CA: "America/Los_Angeles",
  CO: "America/Denver",
  CT: "America/New_York",
  DE: "America/New_York",
  DC: "America/New_York",
  FL: "America/New_York",
  GA: "America/New_York",
  HI: "Pacific/Honolulu",
  ID: "America/Boise",
  IL: "America/Chicago",
  IN: "America/Indianapolis",
  IA: "America/Chicago",
  KS: "America/Chicago",
  KY: "America/New_York",
  LA: "America/Chicago",
  ME: "America/New_York",
  MD: "America/New_York",
  MA: "America/New_York",
  MI: "America/Detroit",
  MN: "America/Chicago",
  MS: "America/Chicago",
  MT: "America/Denver",
  NE: "America/Chicago",
  NV: "America/Los_Angeles",
  NH: "America/New_York",
  NJ: "America/New_York",
  NM: "America/Denver",
  NY: "America/New_York",
  NC: "America/New_York",
  ND: "America/Chicago",
  OK: "America/Chicago",
  OR: "America/Los_Angeles",
  PA: "America/New_York",
  RI: "America/New_York",
  SC: "America/New_York",
  SD: "America/Chicago",
  TN: "America/Chicago",
  TX: "America/Chicago",
  UT: "America/Denver",
  VT: "America/New_York",
  VA: "America/New_York",
  WA: "America/Los_Angeles",
  WV: "America/New_York",
  WI: "America/Chicago",
  WY: "America/Denver",
};

export type QuietHoursCheck =
  | { ok: true; localTime: string; zone: string }
  | {
      ok: false;
      reason: "outside_window" | "unknown_state";
      localTime: string | null;
      zone: string | null;
    };

export type QuietHoursLocalTime = {
  hour: number;
  localTime: string;
  minute: number;
  second: number;
  zone: string;
};

function currentQuietHoursTime(): Date {
  const override = process.env.E2E_QUIET_HOURS_NOW;
  if (override) {
    const parsed = new Date(override);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

export function getQuietHoursLocalTime(
  state: string | null | undefined,
  now: Date = currentQuietHoursTime(),
): QuietHoursLocalTime | null {
  if (!state) return null;
  const zone = STATE_TO_TZ[state.trim().toUpperCase()];
  if (!zone) return null;

  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minuteStr = parts.find((p) => p.type === "minute")?.value ?? "00";
  const secondStr = parts.find((p) => p.type === "second")?.value ?? "00";

  const parsedHour = parseInt(hourStr, 10);
  const parsedMinute = parseInt(minuteStr, 10);
  const parsedSecond = parseInt(secondStr, 10);
  const hour = Number.isNaN(parsedHour) ? 0 : parsedHour % 24;
  const minute = Number.isNaN(parsedMinute) ? 0 : parsedMinute;
  const second = Number.isNaN(parsedSecond) ? 0 : parsedSecond;

  return {
    hour,
    localTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    minute,
    second,
    zone,
  };
}

/**
 * Is `now` inside the send window for a property in `state`? Pass `now`
 * in unit tests to pin a specific moment; defaults to current time.
 */
export function checkQuietHours(
  state: string | null | undefined,
  now: Date = currentQuietHoursTime(),
): QuietHoursCheck {
  const local = getQuietHoursLocalTime(state, now);
  if (!local) {
    return {
      ok: false,
      reason: "unknown_state",
      localTime: null,
      zone: null,
    };
  }

  // Window: [08:00, 21:00).
  const withinWindow =
    local.hour >= QUIET_HOURS_OPEN_HOUR &&
    local.hour < QUIET_HOURS_CLOSE_HOUR;
  if (!withinWindow) {
    return {
      ok: false,
      reason: "outside_window",
      localTime: local.localTime,
      zone: local.zone,
    };
  }
  return { ok: true, localTime: local.localTime, zone: local.zone };
}
