import { STATE_TO_TZ, QUIET_HOURS_CLOSE_HOUR, QUIET_HOURS_OPEN_HOUR } from "@/lib/messaging/quiet-hours";
import { wallTimeToUtc } from "@/lib/time/zoned";

/**
 * Turns what a seller said about a callback ("Tuesday after 3, Central",
 * "tomorrow morning") into a concrete instant, or null. Pure and deterministic
 * apart from the optional AI fallback, which is injected (tests never call a
 * real model).
 *
 * Order of trust:
 *   1. An exact `callback_time` extraction variable (ISO 8601).
 *   2. A deterministic parse of `follow_up_preference`.
 *   3. Only when the parser recognised nothing at all: an AI fallback that
 *      returns a local date/time which is validated by the SAME guards.
 * Anything ambiguous, contradictory, vague, in the past, or outside calling
 * hours is null. Null is always safe: the task is simply due now with the
 * seller's own words.
 *
 * Documented defaults (a vague part resolves to these, never to a guess):
 *   morning 09:00 | afternoon 14:00 | evening 17:00 | tonight 18:00
 *   noon 12:00 | a day with no time 09:00 | "next week" Monday 09:00
 *   bare hour with no am/pm: 1-7 -> pm, 8-11 -> am, 12 -> noon
 *   "after 3" / "around 3" / "at 3" -> 15:00 (the stated hour itself)
 *   a time with no day: today if still ahead, otherwise tomorrow
 */
export const NORMA_CALLBACK_TIME_VARIABLE = "callback_time";

export const CALLBACK_DEFAULT_TIMEZONE = "America/Chicago";
export const CALLBACK_DAYPART_HOURS = { morning: 9, afternoon: 14, evening: 17, tonight: 18 } as const;
export const CALLBACK_DEFAULT_HOUR = 9;
export const CALLBACK_MIN_CONFIDENCE = 0.7;
export const CALLBACK_AI_MIN_CONFIDENCE = 0.8;
export const CALLBACK_HORIZON_DAYS = 60;
export const CALLBACK_EXACT_HORIZON_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export type CallbackTimeSource = "exact" | "parsed" | "ai";
export type CallbackTime = { at: string; timezone: string; confidence: number; source: CallbackTimeSource };

type Ymd = { y: number; m: number; d: number };
type Wall = { y: number; m: number; d: number; hour: number; minute: number; weekday: number };

/** Wall-clock date/time `instant` shows in `timeZone`. */
function zonedWall(instant: number, timeZone: string): Wall {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(instant));
  const map: Record<string, string> = {};
  for (const part of parts) if (part.type !== "literal") map[part.type] = part.value;
  const y = Number(map.year);
  const m = Number(map.month);
  const d = Number(map.day);
  return { y, m, d, hour: Number(map.hour) % 24, minute: Number(map.minute), weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

function addDays(date: Ymd, days: number): Ymd {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const pad = (n: number) => String(n).padStart(2, "0");

function toInstant(date: Ymd, hour: number, minute: number, timeZone: string): number | null {
  const result = wallTimeToUtc({ date: `${date.y}-${pad(date.m)}-${pad(date.d)}`, time: `${pad(hour)}:${pad(minute)}`, timeZone });
  return result.ok ? result.utc.getTime() : null;
}

/** Calling-hours window shared with the quiet-hours rule: [08:00, 21:00) local. */
function withinCallingHours(instant: number, timeZone: string): boolean {
  const wall = zonedWall(instant, timeZone);
  return wall.hour >= QUIET_HOURS_OPEN_HOUR && wall.hour < QUIET_HOURS_CLOSE_HOUR;
}

/** The seller's timezone from the property state, else Central. Never throws. */
export function sellerTimezoneForState(state: string | null | undefined): string {
  const zone = state ? STATE_TO_TZ[state.trim().toUpperCase()] : undefined;
  return zone ?? CALLBACK_DEFAULT_TIMEZONE;
}

const TZ_WORDS: { zone: string; pattern: RegExp }[] = [
  { zone: "America/Chicago", pattern: /\b(?:central|cst|cdt|ct)\b/ },
  { zone: "America/New_York", pattern: /\b(?:eastern|est|edt|et)\b/ },
  { zone: "America/Denver", pattern: /\b(?:mountain|mst|mdt|mt)\b/ },
  { zone: "America/Los_Angeles", pattern: /\b(?:pacific|pst|pdt|pt)\b/ },
];

/** `undefined` = none stated, `null` = conflicting zones, string = the one zone stated. */
export function detectStatedTimezone(text: string): string | null | undefined {
  const found = TZ_WORDS.filter(({ pattern }) => pattern.test(text)).map(({ zone }) => zone);
  if (found.length === 0) return undefined;
  return found.length === 1 ? found[0] : null;
}

// ---------------------------------------------------------------------------
// 1. Exact time
// ---------------------------------------------------------------------------

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const ISO_NO_OFFSET = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

/** ISO 8601 with an offset, or without one (read in the seller's timezone). Null if unparseable. */
export function parseExactCallbackTime(value: unknown, sellerTimezone: string): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (ISO_WITH_OFFSET.test(text)) {
    // "+0500" -> "+05:00" so Date.parse accepts it everywhere.
    const normalised = text.replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    const ms = Date.parse(normalised);
    return Number.isNaN(ms) ? null : ms;
  }
  const local = ISO_NO_OFFSET.exec(text);
  if (!local) return null;
  const result = wallTimeToUtc({ date: local[1]!, time: `${local[2]}${local[3] ? `:${local[3]}` : ""}`, timeZone: sellerTimezone });
  return result.ok ? result.utc.getTime() : null;
}

// ---------------------------------------------------------------------------
// 2. Deterministic parser for the seller's words
// ---------------------------------------------------------------------------

export type ParseOutcome =
  | { kind: "ok"; at: number; confidence: number }
  /** Recognised but unusable (ambiguous, past, out of hours...). Never goes to the AI. */
  | { kind: "reject"; reason: string }
  /** Nothing recognisable. Eligible for the AI fallback. */
  | { kind: "unrecognised" };

const WEEKDAYS: [RegExp, number][] = [
  [/\b(?:sunday|sun)\b/, 0],
  [/\b(?:monday|mon)\b/, 1],
  [/\b(?:tuesday|tues|tue)\b/, 2],
  [/\b(?:wednesday|wed)\b/, 3],
  [/\b(?:thursday|thurs|thur|thu)\b/, 4],
  [/\b(?:friday|fri)\b/, 5],
  [/\b(?:saturday|sat)\b/, 6],
];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_NAMES =
  "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";

const reject = (reason: string): ParseOutcome => ({ kind: "reject", reason });

function resolveHour(hourText: string, minuteText: string | undefined, suffix: string | undefined): { hour: number; minute: number } | null {
  const raw = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;
  if (!Number.isInteger(raw) || minute > 59) return null;
  if (suffix) {
    if (raw < 1 || raw > 12) return null;
    const pm = suffix.startsWith("p");
    return { hour: (raw % 12) + (pm ? 12 : 0), minute };
  }
  if (raw >= 13 && raw <= 23) return { hour: raw, minute };
  if (raw === 12) return { hour: 12, minute };
  if (raw >= 8 && raw <= 11) return { hour: raw, minute };
  if (raw >= 1 && raw <= 7) return { hour: raw + 12, minute };
  return null;
}

type TimeCandidate = { hour: number; minute: number; upperBound: boolean };

/** Parses the seller's callback words against a reference instant in `zone`. Pure. */
export function parseFollowUpText(rawText: string, referenceMs: number, notBeforeMs: number, zone: string): ParseOutcome {
  let text = ` ${rawText.toLowerCase().replace(/[“”"'’]/g, "").replace(/[,;()!?]/g, " ").replace(/\s+/g, " ").trim()} `;
  if (text.trim().length < 2) return { kind: "unrecognised" };
  const ref = zonedWall(referenceMs, zone);

  // Hedged or negated wording is not a commitment to any time.
  if (/\b(?:maybe|perhaps|possibly|probably|might|not sure|i think|hopefully|not|except|besides|other than|cant|cannot|never|dont|wont|if)\b/.test(text.replace(/['’]/g, ""))) {
    return reject("hedged_or_negated");
  }
  // Wording a rule parser would read wrongly ("a week from Monday", "second Thursday"):
  // left to the AI step, whose answer goes through the same guards.
  const withoutAfterTomorrow = text.replace(/\bday after tomorrow\b/g, " ");
  if (
    /\b(?:first|second|third|fourth|fifth|last|every|each|after next)\b/.test(withoutAfterTomorrow) ||
    /\b(?:weeks?|days?|months?) (?:from|after|before)\b/.test(withoutAfterTomorrow) ||
    /\bthe (?:\d{1,2}(?:st|nd|rd|th)?) (?:of|or)\b/.test(withoutAfterTomorrow)
  ) {
    return { kind: "unrecognised" };
  }
  // A date expression this parser does not understand ("the 15th", "2027-12-01",
  // "after the 20th") must never be read as "the remaining words": null, no AI.
  if (/\b\d{4}-\d{1,2}-\d{1,2}\b/.test(text)) return reject("unrecognised_date");
  // "3 or 5": two options, not a time.
  if (/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s+or\s+(?:maybe\s+|around\s+)?\d{1,2}\b/.test(text)) return reject("multiple_times");

  // ---- relative offsets: "in 2 days", "in 3 hours"
  const relative = [...text.matchAll(/\bin (?:about |around )?(\d{1,3}|an?|one|two|three|four|five|six) (minute|minutes|min|mins|hour|hours|hr|hrs|day|days|week|weeks)\b/g)];
  if (relative.length > 1) return reject("multiple_relative");
  const wordNumbers: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  let relativeInstant: number | null = null;
  let relativeDays: number | null = null;
  if (relative[0]) {
    const amount = wordNumbers[relative[0][1]!] ?? Number(relative[0][1]);
    const unit = relative[0][2]!;
    if (/^(minute|min)/.test(unit)) relativeInstant = referenceMs + amount * 60_000;
    else if (/^(hour|hr)/.test(unit)) relativeInstant = referenceMs + amount * 3_600_000;
    else if (/^day/.test(unit)) relativeDays = amount;
    else relativeDays = amount * 7;
    text = text.replace(relative[0][0], " ");
  }

  // ---- time zone words are consumed first so "ct"/"mt" are never read as anything else
  const stated = detectStatedTimezone(text);
  if (stated === null) return reject("conflicting_timezones");
  const tz = stated ?? zone;
  const refWall = stated && stated !== zone ? zonedWall(referenceMs, tz) : ref;
  const base: Ymd = { y: refWall.y, m: refWall.m, d: refWall.d };
  for (const { pattern } of TZ_WORDS) text = text.replace(new RegExp(pattern.source, "g"), " ");

  // ---- calendar dates: 10/15, 10/15/26, "oct 15th", "15th of october"
  const dates: Ymd[] = [];
  text = text.replace(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, (_m, a: string, b: string, yr?: string) => {
    let y = base.y;
    if (yr) y = Number(yr) < 100 ? 2000 + Number(yr) : Number(yr);
    dates.push({ y, m: Number(a), d: Number(b) });
    return " ";
  });
  text = text.replace(new RegExp(`\\b(${MONTH_NAMES})\\.? (\\d{1,2})(?:st|nd|rd|th)?\\b`, "g"), (_m, mo: string, day: string) => {
    dates.push({ y: base.y, m: MONTHS.indexOf(mo.slice(0, 3)) + 1, d: Number(day) });
    return " ";
  });
  text = text.replace(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? (?:of )?(${MONTH_NAMES})\\b`, "g"), (_m, day: string, mo: string) => {
    dates.push({ y: base.y, m: MONTHS.indexOf(mo.slice(0, 3)) + 1, d: Number(day) });
    return " ";
  });

  // Whatever date-like wording is left after the known forms were consumed.
  if (
    /\b\d{1,2}(?:st|nd|rd|th)\b/.test(text) ||
    /\bthe \d{1,2}\b(?!\s*(?::|am\b|pm\b|a\.m|p\.m))/.test(text)
  ) {
    return reject("unrecognised_date");
  }

  // ---- relative/named days
  type DayHit = { kind: "today" | "tomorrow" | "after_tomorrow" | "weekday" | "next_week"; weekday?: number; next?: boolean; nextWeek?: boolean };
  const days: DayHit[] = [];
  if (/\bday after tomorrow\b/.test(text)) {
    days.push({ kind: "after_tomorrow" });
    text = text.replace(/\bday after tomorrow\b/g, " ");
  }
  if (/\btomorrow\b/.test(text)) {
    days.push({ kind: "tomorrow" });
    text = text.replace(/\btomorrow\b/g, " ");
  }
  if (/\b(?:today|tonight|later today|this morning|this afternoon|this evening)\b/.test(text)) {
    days.push({ kind: "today" });
  }
  let nextWeek = false;
  if (/\bnext week\b/.test(text)) {
    nextWeek = true;
    text = text.replace(/\bnext week\b/g, " ");
    if (!WEEKDAYS.some(([p]) => p.test(text))) days.push({ kind: "next_week" });
  }
  for (const [pattern, weekday] of WEEKDAYS) {
    const match = new RegExp(`\\b(next |this |on )?${pattern.source.replace(/\\b/g, "")}\\b`).exec(text);
    if (match) days.push({ kind: "weekday", weekday, next: match[1] === "next ", nextWeek });
  }
  const dayCount = days.length + dates.length + (relativeDays !== null ? 1 : 0);
  if (dayCount > 1) return reject("multiple_days");

  // ---- dayparts
  const dayparts = new Set<keyof typeof CALLBACK_DAYPART_HOURS>();
  if (/\bmorning\b/.test(text)) dayparts.add("morning");
  if (/\bafternoon\b/.test(text)) dayparts.add("afternoon");
  if (/\bevening\b/.test(text)) dayparts.add("evening");
  if (/\btonight\b/.test(text)) dayparts.add("tonight");
  if (dayparts.size > 1) return reject("multiple_dayparts");

  // ---- explicit clock times
  const times: TimeCandidate[] = [];
  const bound = (before: string) => /\b(?:before|until|till|by)\s*$/.test(before);
  let scan = text;
  const range =
    /\b(between |from )?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*(?:-|to|and|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?![a-z])/.exec(scan);
  if (range && (range[1] || range[4] || range[7])) {
    // "2 to 4pm": the start inherits pm only when that keeps it before the end.
    let start = resolveHour(range[2]!, range[3], range[4] ?? range[7]);
    const end = resolveHour(range[5]!, range[6], range[7]);
    if (start && end && !range[4] && range[7] && start.hour * 60 + start.minute > end.hour * 60 + end.minute) {
      start = resolveHour(range[2]!, range[3], "am");
    }
    if (!start || !end) return reject("bad_time");
    times.push({ ...start, upperBound: false });
    scan = scan.replace(range[0], " ");
  }
  for (const m of scan.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?![a-z])/g)) {
    const t = resolveHour(m[1]!, m[2], m[3]);
    if (!t) return reject("bad_time");
    times.push({ ...t, upperBound: bound(scan.slice(0, m.index)) });
  }
  scan = scan.replace(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?![a-z])/g, " ");
  for (const m of scan.matchAll(/\b(\d{1,2}):(\d{2})\b/g)) {
    const t = resolveHour(m[1]!, m[2], undefined);
    if (!t) return reject("bad_time");
    times.push({ ...t, upperBound: bound(scan.slice(0, m.index)) });
  }
  scan = scan.replace(/\b(\d{1,2}):(\d{2})\b/g, " ");
  for (const m of scan.matchAll(/\b(at|after|around|about|before|by|until|till|from|@)\s*(\d{1,2})\b(?!\s*(?:st|nd|rd|th|\/|-|%|k\b|day|days|week|weeks|dollar))/g)) {
    const t = resolveHour(m[2]!, undefined, undefined);
    if (!t) return reject("bad_time");
    times.push({ ...t, upperBound: /^(?:before|by|until|till)$/.test(m[1]!) });
  }
  if (/\b(?:noon|midday)\b/.test(scan)) times.push({ hour: 12, minute: 0, upperBound: /\b(?:before|until|till|by) (?:noon|midday)\b/.test(scan) });
  if (/\bmidnight\b/.test(scan)) return reject("midnight");

  const lower = times.filter((t) => !t.upperBound);
  if (lower.length === 0 && times.length > 0 && dayCount === 0 && dayparts.size === 0) return reject("upper_bound_only");
  const distinct = new Set(lower.map((t) => t.hour * 60 + t.minute));
  if (distinct.size > 1) return reject("multiple_times");
  const explicit = lower[0] ?? null;

  if (explicit && dayparts.size === 1) {
    const part = [...dayparts][0]!;
    if (part === "morning" && explicit.hour >= 12) return reject("daypart_conflict");
    if (part !== "morning" && explicit.hour < 12) return reject("daypart_conflict");
  }

  // ---- anything recognised at all?
  const anything = dayCount > 0 || dayparts.size > 0 || explicit !== null || relativeInstant !== null || times.length > 0;
  if (!anything) {
    return /\b(?:week|weeks|weekdays?|weekends?|month|months|year|holiday|christmas|thanksgiving|easter|sometime|whenever|anytime|soon|later|eventually|couple|few)\b/.test(text) ||
      /^[\s\W]*$/.test(text)
      ? reject("vague")
      : { kind: "unrecognised" };
  }
  // Leftover vague periods ("this week", "next month") with no concrete day.
  if (dayCount === 0 && /\b(?:week|weeks|weekdays?|weekends?|month|months|year|holiday|christmas|thanksgiving|easter|sometime|whenever|anytime|soon|later|eventually|couple|few)\b/.test(text)) {
    return reject("vague");
  }

  // ---- relative hours/minutes are an instant already
  if (relativeInstant !== null) {
    if (explicit || dayparts.size > 0 || dayCount > 0) return reject("relative_with_clock");
    return finish(relativeInstant, 0.8, referenceMs, notBeforeMs, tz);
  }

  const partHour = dayparts.size === 1 ? CALLBACK_DAYPART_HOURS[[...dayparts][0]!] : null;
  const wantHour = explicit?.hour ?? partHour ?? CALLBACK_DEFAULT_HOUR;
  const wantMinute = explicit?.minute ?? 0;
  const hasTimeInfo = explicit !== null || partHour !== null;

  const aheadToday = (): boolean => {
    const at = toInstant(base, wantHour, wantMinute, tz);
    return at !== null && at > Math.max(referenceMs, notBeforeMs);
  };

  let date: Ymd;
  let confidence = hasTimeInfo ? 0.9 : 0.8;
  if (relativeDays !== null) {
    date = addDays(base, relativeDays);
  } else if (dates.length === 1) {
    const hit = dates[0]!;
    date = { ...hit };
    if (toInstant(date, 12, 0, tz) === null) return reject("bad_date");
    // A date already past this year means next year (e.g. "Jan 5" said in December).
    if (Date.UTC(date.y, date.m - 1, date.d) < Date.UTC(base.y, base.m - 1, base.d)) date = { ...date, y: date.y + 1 };
  } else if (days.length === 1) {
    const day = days[0]!;
    if (day.kind === "today") {
      date = base;
      if (!aheadToday()) return reject("past");
    } else if (day.kind === "tomorrow") date = addDays(base, 1);
    else if (day.kind === "after_tomorrow") date = addDays(base, 2);
    else if (day.kind === "next_week") {
      const toMonday = ((8 - refWall.weekday) % 7) || 7;
      date = addDays(base, toMonday);
      confidence = 0.7;
    } else {
      const delta = (day.weekday! - refWall.weekday + 7) % 7;
      const toNextMondayDays = ((8 - refWall.weekday) % 7) || 7;
      if (day.nextWeek) {
        // "Tuesday next week": that weekday within the next Monday-Sunday week.
        date = addDays(base, toNextMondayDays + ((day.weekday! + 6) % 7));
      } else if (day.next) {
        const toNextMonday = ((8 - refWall.weekday) % 7) || 7;
        if (delta === 0) date = addDays(base, 7);
        else if (delta >= toNextMonday) date = addDays(base, delta);
        else return reject("ambiguous_next_weekday");
      } else if (delta === 0) {
        date = base;
        if (!aheadToday()) return reject("past");
      } else date = addDays(base, delta);
    }
  } else if (hasTimeInfo) {
    // A time with no day: today if still ahead, otherwise the same time tomorrow.
    date = aheadToday() ? base : addDays(base, 1);
    confidence = 0.75;
  } else {
    return { kind: "unrecognised" };
  }

  const at = toInstant(date, wantHour, wantMinute, tz);
  if (at === null) return reject("nonexistent_time");
  return finish(at, confidence, referenceMs, notBeforeMs, tz);
}

function finish(at: number, confidence: number, referenceMs: number, notBeforeMs: number, zone: string): ParseOutcome {
  if (at <= Math.max(referenceMs, notBeforeMs)) return reject("past");
  if (at > referenceMs + CALLBACK_HORIZON_DAYS * DAY_MS) return reject("too_far");
  if (!withinCallingHours(at, zone)) return reject("outside_calling_hours");
  if (confidence < CALLBACK_MIN_CONFIDENCE) return reject("low_confidence");
  return { kind: "ok", at, confidence };
}

// ---------------------------------------------------------------------------
// 3. AI fallback (injected). It only reads the words; the guards stay in code.
// ---------------------------------------------------------------------------

export type CallbackAiInput = {
  text: string;
  timezone: string;
  /** The reference moment in the seller's zone, so relative words can be resolved. */
  reference: { date: string; time: string; weekday: string };
};
export type CallbackAiOutput = { local_date: string | null; local_time: string | null; confidence: number } | null;
export type CallbackTimeProvider = (input: CallbackAiInput, options: { signal: AbortSignal }) => Promise<CallbackAiOutput>;

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export type ResolveCallbackTimeInput = {
  variables: Record<string, unknown>;
  /** The call's completion time (ms). The "never in the past" reference. */
  completedAtMs: number;
  /** Wall clock now (ms); a result at or before it is also rejected. */
  nowMs?: number;
  /** Property state (USPS), for the seller's timezone. */
  state?: string | null;
  provider?: CallbackTimeProvider | null;
  /** Hard ceiling for the AI step. */
  aiTimeoutMs?: number;
};

export const CALLBACK_AI_TIMEOUT_MS = 4_000;

/** Never throws, never blocks longer than `aiTimeoutMs`. Null on any doubt. */
export async function resolveCallbackTime(input: ResolveCallbackTimeInput): Promise<CallbackTime | null> {
  try {
    const nowMs = input.nowMs ?? Date.now();
    const notBefore = Math.max(input.completedAtMs, nowMs);
    const sellerZone = sellerTimezoneForState(input.state);

    // 1. Exact time.
    const exactRaw = input.variables[NORMA_CALLBACK_TIME_VARIABLE];
    if (typeof exactRaw === "string" && exactRaw.trim()) {
      const exact = parseExactCallbackTime(exactRaw, sellerZone);
      if (exact !== null && exact > notBefore && exact <= input.completedAtMs + CALLBACK_EXACT_HORIZON_DAYS * DAY_MS) {
        return { at: new Date(exact).toISOString(), timezone: sellerZone, confidence: 1, source: "exact" };
      }
    }

    // 2. The seller's words.
    const followRaw = input.variables.follow_up_preference;
    const text = typeof followRaw === "string" ? followRaw.trim().slice(0, 1000) : "";
    if (!text) return null;
    const stated = detectStatedTimezone(text.toLowerCase());
    if (stated === null) return null;
    const zone = stated ?? sellerZone;

    const parsed = parseFollowUpText(text, input.completedAtMs, nowMs, zone);
    if (parsed.kind === "ok") {
      return { at: new Date(parsed.at).toISOString(), timezone: zone, confidence: parsed.confidence, source: "parsed" };
    }
    if (parsed.kind === "reject" || !input.provider) return null;

    // 3. AI fallback, only for wording the parser did not recognise at all.
    const ref = zonedWall(input.completedAtMs, zone);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.aiTimeoutMs ?? CALLBACK_AI_TIMEOUT_MS);
    let output: CallbackAiOutput;
    try {
      output = await Promise.race([
        input.provider(
          {
            text,
            timezone: zone,
            reference: { date: `${ref.y}-${pad(ref.m)}-${pad(ref.d)}`, time: `${pad(ref.hour)}:${pad(ref.minute)}`, weekday: WEEKDAY_NAMES[ref.weekday]! },
          },
          { signal: controller.signal },
        ),
        new Promise<null>((resolve) => controller.signal.addEventListener("abort", () => resolve(null))),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (!output || !output.local_date || !output.local_time) return null;
    if (typeof output.confidence !== "number" || !(output.confidence >= CALLBACK_AI_MIN_CONFIDENCE)) return null;
    const local = wallTimeToUtc({ date: output.local_date, time: output.local_time.slice(0, 5), timeZone: zone });
    if (!local.ok) return null;
    const at = local.utc.getTime();
    const checked = finish(at, CALLBACK_AI_MIN_CONFIDENCE, input.completedAtMs, nowMs, zone);
    if (checked.kind !== "ok") return null;
    return { at: new Date(at).toISOString(), timezone: zone, confidence: Math.min(output.confidence, 0.95), source: "ai" };
  } catch {
    return null;
  }
}
