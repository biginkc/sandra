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

const NY = "America/New_York";
const CHI = "America/Chicago";
const DEN = "America/Denver";
const LA = "America/Los_Angeles";

/**
 * Area codes whose recipients are NOT all in their state's dominant zone in
 * `STATE_TO_TZ`. A code that spans two zones lists EVERY zone it covers and the
 * send window must be open in all of them (a text at 8:30pm Eastern to an 850
 * number is 7:30pm Central, but the Tallahassee recipient is still past 8pm).
 *
 * Source: the time-zone boundary counties of 49 CFR Part 71 (US DOT), matched
 * to NANPA area-code geography and overlays. Audited state by state: only the
 * states below have a time-zone line that cuts across an area code. Informal
 * local-time practices (e.g. Kenton OK, Jackpot NV, Phenix City AL) are not
 * legal zones and are not listed. Entries are deliberately conservative: when a
 * code reaches even one county in a second zone, both zones are required.
 *
 *   FL 850/448   panhandle: Eastern (Tallahassee) + Central (Pensacola, Panama City)
 *   ID 208/986   Boise south = Mountain, north panhandle = Pacific
 *   IN 574/812/930  Eastern + the Central counties (Starke, Pulaski; Evansville area)
 *   MI 906       Upper Peninsula: Eastern + 4 Central counties on the Wisconsin line
 *   KY 270/364   Eastern (Hardin, Meade, Larue...) + western Central counties
 *   TN 423       Eastern + Central (Marion, Bledsoe, Sequatchie counties)
 *   TN 931       Central + Eastern (Cumberland County / Crossville)
 *   KY 606       Eastern + Central (Clinton County / Albany)
 *   KS 620/785   Central + the four western Mountain counties
 *   NE 308       Central + Mountain panhandle
 *   SD 605       Central (east river) + Mountain (west river)
 *   ND 701       Central + the southwestern Mountain counties
 *   OR 541/458   Pacific + Malheur County (Mountain)
 *   NV 775       Pacific + West Wendover (Mountain)
 *   AZ 928       Phoenix (no DST) + the Navajo Nation (observes DST = Mountain)
 *   AK 907       Alaska + the Aleutians west of 169 30 W (Hawaii-Aleutian)
 * Whole-code single-zone corrections to the state default:
 *   IN 219 Central, TN 865 Eastern, TX 915 Mountain (El Paso, Hudspeth).
 */
const AREA_CODE_ZONES: Readonly<Record<string, readonly string[]>> = {
  "850": [NY, CHI],
  "448": [NY, CHI], // 850 overlay
  "208": ["America/Boise", LA],
  "986": ["America/Boise", LA], // 208 overlay
  "574": ["America/Indianapolis", CHI],
  "812": ["America/Indianapolis", CHI],
  "930": ["America/Indianapolis", CHI], // 812 overlay
  "219": [CHI], // NW Indiana (Lake, Porter, LaPorte, Newton, Jasper)
  "906": ["America/Detroit", CHI],
  "270": [CHI, NY],
  "364": [CHI, NY], // 270 overlay
  "423": [NY, CHI],
  "931": [CHI, NY], // TN: Cumberland County (Crossville) is Eastern
  "606": [NY, CHI], // KY: Clinton County (Albany) is Central
  "865": [NY],
  "620": [CHI, DEN],
  "785": [CHI, DEN],
  "308": [CHI, DEN],
  "605": [CHI, DEN],
  "701": [CHI, DEN],
  "541": [LA, DEN],
  "458": [LA, DEN], // 541 overlay
  "775": [LA, DEN],
  "928": ["America/Phoenix", DEN],
  "907": ["America/Anchorage", "America/Adak"],
  "915": [DEN], // El Paso, Hudspeth
};

/** Exported for the audit test: the time zones a recipient with this area code may be in. */
export function zonesForAreaCode(code: string): readonly string[] | null {
  const override = AREA_CODE_ZONES[code];
  if (override) return override;
  const state = STATE_BY_AREA_CODE.get(code);
  const zone = state ? STATE_TO_TZ[state] : undefined;
  return zone ? [zone] : null;
}

/** Exported for the audit test. */
export const MULTI_ZONE_AREA_CODES: readonly string[] = Object.entries(AREA_CODE_ZONES)
  .filter(([, zones]) => zones.length > 1)
  .map(([code]) => code);

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
  | {
      ok: true;
      state: string;
      /** Local time in the first zone (display only; every zone was checked). */
      localTime: string;
      zone: string;
      /** Every zone the recipient's area code may be in; the window is open in all of them. */
      zones: readonly string[];
      florida: boolean;
    }
  | {
      ok: false;
      reason: "outside_window" | "unknown_recipient_state";
      state: string | null;
      /** Local time in the zone that is closed (outside_window), else null. */
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
 * 8am-8pm when any part of the area code is Florida. An area code that spans
 * time zones must be open in EVERY zone it covers. Unknown state or zone fails
 * closed.
 */
export function checkRecipientQuietHours(
  phone: string | null | undefined,
  now: Date = new Date(),
): RecipientQuietHoursCheck {
  const code = areaCodeOf(phone);
  const state = code ? (STATE_BY_AREA_CODE.get(code) ?? null) : null;
  const zones = code ? zonesForAreaCode(code) : null;
  if (!state || !zones || zones.length === 0) {
    return { ok: false, reason: "unknown_recipient_state", state: null, localTime: null };
  }
  const florida = state === "FL";
  const close = florida ? FLORIDA_QUIET_HOURS_CLOSE_HOUR : RECIPIENT_QUIET_HOURS_CLOSE_HOUR;
  let firstLocalTime: string | null = null;
  for (const zone of zones) {
    const clock = localClock(zone, now);
    if (!clock) {
      return { ok: false, reason: "unknown_recipient_state", state, localTime: null };
    }
    if (clock.hour < RECIPIENT_QUIET_HOURS_OPEN_HOUR || clock.hour >= close) {
      return { ok: false, reason: "outside_window", state, localTime: clock.localTime };
    }
    firstLocalTime ??= clock.localTime;
  }
  return { ok: true, state, localTime: firstLocalTime ?? "", zone: zones[0]!, zones, florida };
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
