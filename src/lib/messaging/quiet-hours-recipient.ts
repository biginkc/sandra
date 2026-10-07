/**
 * Recipient-local quiet hours for automated template sends (Messages v2 plan
 * §4.10 / §4.13).
 *
 * `quiet-hours.ts` keys the TCPA window to the PROPERTY's state. The legal
 * test follows the RECIPIENT, and absentee owners are common, so a template
 * auto-send resolves the recipient's state from the phone's area code and
 * checks 8am-9pm there. Florida recipients get the stricter state rule: an
 * 8am-8pm window and at most 3 texts per rolling 24 hours.
 *
 * Area codes are imperfect (numbers port). That is accepted: the check can only
 * be stricter than nothing, and an unresolvable number fails CLOSED (the
 * caller holds the reply for a human), never "assume open".
 *
 * Pure and dependency-free apart from `quiet-hours.ts`'s zone table, so it is
 * safe to import from anywhere (no Node-only imports).
 */

import { STATE_TO_TZ } from "./quiet-hours";

/** Geographic NANP area codes by US state / territory. */
const AREA_CODES_BY_STATE: Record<string, readonly string[]> = {
  AL: ["205", "251", "256", "334", "659", "938"],
  AK: ["907"],
  AZ: ["480", "520", "602", "623", "928"],
  AR: ["479", "501", "870"],
  CA: ["209", "213", "279", "310", "323", "341", "350", "369", "408", "415", "424", "442", "510", "530", "559", "562", "619", "626", "628", "650", "657", "661", "669", "707", "714", "747", "760", "805", "818", "820", "831", "840", "858", "909", "916", "925", "949", "951"],
  CO: ["303", "719", "720", "970", "983"],
  CT: ["203", "475", "860", "959"],
  DE: ["302"],
  DC: ["202", "771"],
  FL: ["239", "305", "321", "324", "352", "386", "407", "448", "561", "645", "656", "689", "727", "728", "754", "772", "786", "813", "850", "863", "904", "941", "954"],
  GA: ["229", "404", "470", "478", "678", "706", "762", "770", "912", "943"],
  HI: ["808"],
  ID: ["208", "986"],
  IL: ["217", "224", "309", "312", "331", "447", "464", "618", "630", "708", "730", "773", "779", "815", "847", "872"],
  IN: ["219", "260", "317", "463", "574", "765", "812", "930"],
  IA: ["319", "515", "563", "641", "712"],
  KS: ["316", "620", "785", "913"],
  KY: ["270", "364", "502", "606", "859"],
  LA: ["225", "318", "337", "504", "985"],
  ME: ["207"],
  MD: ["240", "301", "410", "443", "667"],
  MA: ["339", "351", "413", "508", "617", "774", "781", "857", "978"],
  MI: ["231", "248", "269", "313", "517", "586", "616", "734", "810", "906", "947", "989"],
  MN: ["218", "320", "507", "612", "651", "763", "952"],
  MS: ["228", "601", "662", "769"],
  MO: ["314", "417", "557", "573", "636", "660", "816", "975"],
  MT: ["406"],
  NE: ["308", "402", "531"],
  NV: ["702", "725", "775"],
  NH: ["603"],
  NJ: ["201", "551", "609", "640", "732", "848", "856", "862", "908", "973"],
  NM: ["505", "575"],
  NY: ["212", "315", "332", "347", "363", "516", "518", "585", "607", "624", "631", "646", "680", "718", "838", "845", "914", "917", "929", "934"],
  NC: ["252", "336", "704", "743", "828", "910", "919", "980", "984"],
  ND: ["701"],
  OH: ["216", "220", "234", "326", "330", "380", "419", "440", "513", "567", "614", "740", "937"],
  OK: ["405", "539", "580", "918"],
  OR: ["458", "503", "541", "971"],
  PA: ["215", "223", "267", "272", "412", "445", "484", "570", "610", "717", "724", "814", "835", "878"],
  RI: ["401"],
  SC: ["803", "839", "843", "854", "864"],
  SD: ["605"],
  TN: ["423", "615", "629", "731", "865", "901", "931"],
  TX: ["210", "214", "254", "281", "325", "346", "361", "409", "430", "432", "469", "512", "682", "713", "726", "737", "806", "817", "830", "832", "903", "915", "936", "940", "945", "956", "972", "979"],
  UT: ["385", "435", "801"],
  VT: ["802"],
  VA: ["276", "434", "540", "571", "703", "757", "804", "826", "948"],
  WA: ["206", "253", "360", "425", "509", "564"],
  WV: ["304", "681"],
  WI: ["262", "274", "414", "534", "608", "715", "920"],
  WY: ["307"],
  PR: ["787", "939"],
  VI: ["340"],
  GU: ["671"],
  MP: ["670"],
  AS: ["684"],
};

const STATE_BY_AREA_CODE: ReadonlyMap<string, string> = new Map(
  Object.entries(AREA_CODES_BY_STATE).flatMap(([state, codes]) =>
    codes.map((code) => [code, state] as const),
  ),
);

/**
 * Area codes whose zone differs from their state's dominant zone in
 * `STATE_TO_TZ`. Without these a Central-time recipient in a mostly-Eastern
 * state could be texted at 7am local.
 */
const AREA_CODE_TZ_OVERRIDES: Readonly<Record<string, string>> = {
  "850": "America/Chicago", // Florida panhandle
  "219": "America/Chicago", // NW Indiana
  "270": "America/Chicago", // western Kentucky
  "364": "America/Chicago", // western Kentucky
  "423": "America/New_York", // east Tennessee
  "865": "America/New_York", // east Tennessee
  "915": "America/Denver", // El Paso, Texas
};

function areaCodeOf(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  const national =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return national.length === 10 ? national.slice(0, 3) : null;
}

/** The recipient's USPS state from the phone's area code, or null. */
export function stateForPhone(phone: string | null | undefined): string | null {
  const code = areaCodeOf(phone);
  return code ? (STATE_BY_AREA_CODE.get(code) ?? null) : null;
}

export const RECIPIENT_QUIET_HOURS_OPEN_HOUR = 8;
export const RECIPIENT_QUIET_HOURS_CLOSE_HOUR = 21;
export const FLORIDA_QUIET_HOURS_CLOSE_HOUR = 20;
export const FLORIDA_MAX_TEXTS_PER_24H = 3;

export type RecipientQuietHoursCheck =
  | { ok: true; state: string; localTime: string; zone: string; florida: boolean }
  | {
      ok: false;
      reason: "outside_window" | "unknown_recipient_state";
      state: string | null;
      localTime: string | null;
    };

function localClock(zone: string, now: Date): { hour: number; localTime: string } | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const hour = Number.parseInt(parts.find((p) => p.type === "hour")?.value ?? "", 10);
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  if (Number.isNaN(hour)) return null;
  const h = hour % 24;
  return { hour: h, localTime: `${String(h).padStart(2, "0")}:${minute}` };
}

/**
 * Is `now` inside the send window where the RECIPIENT is? 8am-9pm local,
 * 8am-8pm for Florida. Unknown state or zone fails closed.
 */
export function checkRecipientQuietHours(
  phone: string | null | undefined,
  now: Date = new Date(),
): RecipientQuietHoursCheck {
  const code = areaCodeOf(phone);
  const state = code ? (STATE_BY_AREA_CODE.get(code) ?? null) : null;
  const zone = code ? (AREA_CODE_TZ_OVERRIDES[code] ?? (state ? STATE_TO_TZ[state] : undefined)) : undefined;
  if (!state || !zone) {
    return { ok: false, reason: "unknown_recipient_state", state: null, localTime: null };
  }
  const clock = localClock(zone, now);
  if (!clock) {
    return { ok: false, reason: "unknown_recipient_state", state, localTime: null };
  }
  const florida = state === "FL";
  const close = florida ? FLORIDA_QUIET_HOURS_CLOSE_HOUR : RECIPIENT_QUIET_HOURS_CLOSE_HOUR;
  if (clock.hour < RECIPIENT_QUIET_HOURS_OPEN_HOUR || clock.hour >= close) {
    return { ok: false, reason: "outside_window", state, localTime: clock.localTime };
  }
  return { ok: true, state, localTime: clock.localTime, zone, florida };
}

export type FloridaCapCheck =
  | { ok: true }
  | { ok: false; reason: "florida_cap" | "florida_cap_unknown"; sentLast24h: number | null };

/** Florida: no more than 3 texts to a recipient in a rolling 24 hours. */
export function checkFloridaCap(sentLast24h: number | null): FloridaCapCheck {
  if (sentLast24h === null || !Number.isFinite(sentLast24h)) {
    return { ok: false, reason: "florida_cap_unknown", sentLast24h: null };
  }
  return sentLast24h >= FLORIDA_MAX_TEXTS_PER_24H
    ? { ok: false, reason: "florida_cap", sentLast24h }
    : { ok: true };
}
