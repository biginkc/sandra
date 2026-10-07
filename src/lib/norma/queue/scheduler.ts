import {
  addCivilDays,
  civilDateKey,
  isDialingDay,
  localParts,
  nextDialingDateAfter,
  nextWindowStart,
  zonedTimeToInstant,
  zoneForState,
  type CivilDate,
} from "./dialing-window";

// Pure mirror of fn_norma_queue_next_slot_for (plan v8 rule 10 + C26). Oracle: scheduler.fixtures.ts.
// Phase A: first 3 dialing dates with a send; A_am [09:00,14:00) and A_pm [14:00,19:30); one send per interval;
//          next send >= previous send + 3h. Phase B: next 12 dates with a send, one per date, 09:00.
// Phase C: last send date + 1 month (clamped), 09:00, rolled to a dialing day; 6 sends, then exhausted.

export const MAX_QUEUE_ATTEMPTS = 24; // 6 (A) + 12 (B) + 6 (C)
const PHASE_A_DATES = 3;
const PHASE_B_DATES = 12;
const PHASE_C_SENDS = 6;
const SPACING_MS = 3 * 60 * 60_000;

export type QueueSlot =
  | { kind: "slot"; phase: "A" | "B" | "C"; slot: "A_am" | "A_pm" | "B" | "C"; at: Date }
  | { kind: "exhausted" }
  | { kind: "unknown_state" };

type Send = { at: Date; date: CivilDate; key: string; minutes: number };

function aSlotLabel(zone: string, at: Date): "A_am" | "A_pm" {
  const p = localParts(at, zone);
  return p.hour < 14 ? "A_am" : "A_pm";
}

function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

function addOneMonthClamped(date: CivilDate): CivilDate {
  const month = date.month === 12 ? 1 : date.month + 1;
  const year = date.month === 12 ? date.year + 1 : date.year;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { year, month, day: Math.min(date.day, lastDay) };
}

export function nextAttemptSlot(input: { state: string | null | undefined; sends: Date[]; now: Date }): QueueSlot {
  const zone = zoneForState(input.state);
  if (!zone) return { kind: "unknown_state" };
  const { now } = input;

  const sends: Send[] = [...input.sends]
    .sort((a, b) => a.getTime() - b.getTime())
    .map((at) => {
      const p = localParts(at, zone);
      const date = { year: p.year, month: p.month, day: p.day };
      return { at, date, key: civilDateKey(date), minutes: p.hour * 60 + p.minute };
    });

  // First call: the next window open.
  if (sends.length === 0) {
    const at = nextWindowStart(input.state, now);
    return at ? { kind: "slot", phase: "A", slot: aSlotLabel(zone, at), at } : { kind: "unknown_state" };
  }

  const dateKeys: string[] = [];
  for (const s of sends) if (!dateKeys.includes(s.key)) dateKeys.push(s.key);
  const lastSend = sends[sends.length - 1];
  const nowP = localParts(now, zone);
  const today: CivilDate = { year: nowP.year, month: nowP.month, day: nowP.day };
  const todayKey = civilDateKey(today);

  // The earliest instant on the date after `date` (never earlier than now) that is inside the window.
  const nextFreshDate = (date: CivilDate): Date => {
    const start = zonedTimeToInstant(zone, nextDialingDateAfter(date), 9, 0);
    const open = nextWindowStart(input.state, now) ?? start;
    return maxDate(start, open);
  };

  // ---- Phase C ----
  if (dateKeys.length >= PHASE_A_DATES + PHASE_B_DATES) {
    const early = new Set(dateKeys.slice(0, PHASE_A_DATES + PHASE_B_DATES));
    const cSends = sends.filter((s) => !early.has(s.key)).length;
    if (cSends >= PHASE_C_SENDS) return { kind: "exhausted" };
    let target = addOneMonthClamped(lastSend.date);
    while (!isDialingDay(target)) target = addCivilDays(target, 1);
    const at = maxDate(zonedTimeToInstant(zone, target, 9, 0), nextWindowStart(input.state, now) ?? now);
    return { kind: "slot", phase: "C", slot: "C", at };
  }

  // ---- Phase A (still running) ----
  if (dateKeys.length <= PHASE_A_DATES) {
    const dateKey = lastSend.key;
    if (dateKey === todayKey && isDialingDay(today)) {
      const onDate = sends.filter((s) => s.key === dateKey);
      const usedAm = onDate.some((s) => s.minutes < 14 * 60);
      const usedPm = onDate.some((s) => s.minutes >= 14 * 60);
      const earliest = maxDate(now, new Date(lastSend.at.getTime() + SPACING_MS));
      const intervals = [
        { used: usedAm, slot: "A_am" as const, from: [9, 0], to: [14, 0] },
        { used: usedPm, slot: "A_pm" as const, from: [14, 0], to: [19, 30] },
      ];
      for (const interval of intervals) {
        if (interval.used) continue;
        const start = zonedTimeToInstant(zone, today, interval.from[0], interval.from[1]);
        const end = zonedTimeToInstant(zone, today, interval.to[0], interval.to[1]);
        const at = maxDate(start, earliest);
        if (at.getTime() < end.getTime()) return { kind: "slot", phase: "A", slot: interval.slot, at };
      }
    }
    // The last send's date is finished (or has passed).
    const at = nextFreshDate(lastSend.date);
    if (dateKeys.length < PHASE_A_DATES) return { kind: "slot", phase: "A", slot: aSlotLabel(zone, at), at };
    return { kind: "slot", phase: "B", slot: "B", at };
  }

  // ---- Phase B ----
  return { kind: "slot", phase: "B", slot: "B", at: nextFreshDate(lastSend.date) };
}
