import { CALLBACK_DEFAULT_TIMEZONE } from "@/lib/norma/callback-time";

import type { FactsInput } from "./types";

/** A labelled turn of the (already redacted) transcript. */
export type Turn = { label: string; speaker: string | null; text: string };
export type AmountCandidate = { turn: Turn; raw: string };
export type DateCandidate = { turn: Turn; raw: string; date: string };

export const MAX_OPTIONS = 255;

/** T001, T002... in order. Lines are "Speaker: text"; with no transcript the summary lines are used. */
export function parseTurns(input: FactsInput): Turn[] {
  const source = input.transcript && input.transcript.trim() ? input.transcript : input.summary ?? "";
  const turns: Turn[] = [];
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = input.transcript && input.transcript.trim() ? /^([^:\n]{1,80}):\s?([\s\S]*)$/.exec(line) : null;
    const text = (m ? m[2] : line).trim();
    if (!text) continue;
    turns.push({ label: `T${String(turns.length + 1).padStart(3, "0")}`, speaker: m ? m[1].trim() : null, text });
  }
  return turns;
}

export const turnState = (turns: readonly Turn[]): string =>
  turns.map((t) => `${t.label} | ${t.speaker ? `${t.speaker}: ` : ""}${t.text}`).join("\n");

const AMOUNT_RE = /\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|thousand|million|mm|m)\b)?|\b\d+(?:\.\d+)?\s?(?:k|thousand|million)\b/gi;

/** Over-finds every dollar-looking amount, once per (turn, text). */
export function findAmountCandidates(turns: readonly Turn[]): AmountCandidate[] {
  const out: AmountCandidate[] = [];
  const seen = new Set<string>();
  for (const turn of turns) {
    for (const m of turn.text.matchAll(AMOUNT_RE)) {
      const raw = m[0].trim();
      const key = `${turn.label}|${raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ turn, raw });
    }
  }
  return out.slice(0, MAX_OPTIONS);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DATE_RE = new RegExp(
  [
    String.raw`\b\d{4}-\d{2}-\d{2}\b`,
    String.raw`\b(?:${MONTHS.join("|")})[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b`,
    String.raw`\b\d{1,2}/\d{1,2}(?:/\d{2,4})?\b`,
    String.raw`\b(?:next\s+)?(?:${WEEKDAYS.join("|")})\b`,
    String.raw`\b(?:tomorrow|today)\b`,
  ].join("|"),
  "gi",
);

type Ymd = { y: number; m: number; d: number };
const toDate = (v: Ymd) => new Date(Date.UTC(v.y, v.m - 1, v.d));
const fromDate = (d: Date): Ymd => ({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() });
const iso = (v: Ymd) => `${v.y}-${String(v.m).padStart(2, "0")}-${String(v.d).padStart(2, "0")}`;
const valid = (v: Ymd) => {
  const d = toDate(v);
  return d.getUTCFullYear() === v.y && d.getUTCMonth() === v.m - 1 && d.getUTCDate() === v.d;
};

export function centralToday(now: Date): Ymd {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: CALLBACK_DEFAULT_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/**
 * Resolves one date phrase to an ISO date relative to `today`, or null. A month/day with no year
 * means the next such day on or after today; a weekday means its next occurrence after today
 * ("next <weekday>" skips ahead a week when that occurrence is still in the current Mon-Sun week).
 */
export function resolveDatePhrase(raw: string, today: Ymd): string | null {
  const text = raw.trim().toLowerCase();
  const base = toDate(today);
  const addDays = (n: number) => iso(fromDate(new Date(base.getTime() + n * 86_400_000)));
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text))) {
    const v = { y: +m[1], m: +m[2], d: +m[3] };
    return valid(v) ? iso(v) : null;
  }
  if (text === "today") return addDays(0);
  if (text === "tomorrow") return addDays(1);
  if ((m = /^(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(text))) {
    const target = WEEKDAYS.indexOf(m[2]);
    let delta = (target - base.getUTCDay() + 7) % 7;
    if (delta === 0) delta = 7;
    if (m[1]) {
      const mondayOffset = (base.getUTCDay() + 6) % 7; // days since Monday
      if (delta + mondayOffset < 7) delta += 7;
    }
    return addDays(delta);
  }
  const withYear = (month: number, day: number, year?: number): string | null => {
    if (year !== undefined) {
      const y = year < 100 ? 2000 + year : year;
      return valid({ y, m: month, d: day }) ? iso({ y, m: month, d: day }) : null;
    }
    for (const y of [today.y, today.y + 1]) {
      const v = { y, m: month, d: day };
      if (valid(v) && toDate(v).getTime() >= base.getTime()) return iso(v);
    }
    return null;
  };
  if ((m = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/.exec(text))) {
    const month = MONTHS.indexOf(m[1].slice(0, 3)) + 1;
    return month > 0 ? withYear(month, +m[2], m[3] ? +m[3] : undefined) : null;
  }
  if ((m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(text))) return withYear(+m[1], +m[2], m[3] ? +m[3] : undefined);
  return null;
}

/** Every date phrase that resolves, once per (turn, phrase). Unresolvable phrases are never offered. */
export function findDateCandidates(turns: readonly Turn[], now: Date): DateCandidate[] {
  const today = centralToday(now);
  const out: DateCandidate[] = [];
  const seen = new Set<string>();
  for (const turn of turns) {
    for (const m of turn.text.matchAll(DATE_RE)) {
      const raw = m[0].trim();
      const key = `${turn.label}|${raw.toLowerCase()}`;
      if (seen.has(key)) continue;
      const date = resolveDatePhrase(raw, today);
      if (!date) continue;
      seen.add(key);
      out.push({ turn, raw, date });
    }
  }
  return out.slice(0, MAX_OPTIONS);
}
