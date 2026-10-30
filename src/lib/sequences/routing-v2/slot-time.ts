import { wallTimeToUtc } from "@/lib/time/zoned";

/**
 * Dynamic slot time for routing v2 booking drips (Jarrad 2026-10-30).
 *
 * The slot offered in a booking text is ~2 hours after the send, rounded UP to the next quarter
 * hour, inside business hours in the SELLER's time zone. When the slot would fall outside the
 * step's window, the step waits: until later the same day (slot too early) or until the next
 * morning (slot too late). The text is never sent late with a wrong time.
 *
 * Windows (local wall clock, slot times, inclusive):
 *   any       10:00 – 17:00
 *   morning   10:00 – 11:45   (texts that say "this morning")
 *   afternoon 12:00 – 17:00   (texts that say "this afternoon" / "afternoon spot")
 * Earliest send = window start − 2h, which never precedes 08:00 (the quiet-hours open).
 */
export const SLOT_TIME_TOKEN = "{{slot_time}}";
export const SLOT_LEAD_MINUTES = 120;

export type SlotWindow = "any" | "morning" | "afternoon";

const WINDOWS: Record<SlotWindow, { start: number; end: number }> = {
  any: { start: 10 * 60, end: 17 * 60 },
  morning: { start: 10 * 60, end: 11 * 60 + 45 },
  afternoon: { start: 12 * 60, end: 17 * 60 },
};

export type SlotPlan =
  | { kind: "send_now"; slotAt: Date; label: string }
  | { kind: "wait"; sendAt: Date; slotAt: Date; label: string };

type Wall = { y: number; m: number; d: number; minutes: number };

function wallOf(instant: Date, timeZone: string): Wall {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const map: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = Number(p.value);
  return { y: map.year!, m: map.month!, d: map.day!, minutes: (map.hour! % 24) * 60 + map.minute! };
}

const pad = (n: number) => String(n).padStart(2, "0");

function atWall(day: Omit<Wall, "minutes">, minutes: number, timeZone: string): Date {
  const res = wallTimeToUtc({
    date: `${day.y}-${pad(day.m)}-${pad(day.d)}`,
    time: `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`,
    timeZone,
  });
  if (!res.ok) throw new Error(`slot wall time ${res.reason} in ${timeZone}`);
  return res.utc;
}

function nextDay(day: Omit<Wall, "minutes">): Omit<Wall, "minutes"> {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d + 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** "2:00", "11:45", "12:15" — 12-hour clock, no am/pm (as the approved texts write it). */
export function formatSlotLabel(minutes: number): string {
  const h24 = Math.floor(minutes / 60);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${pad(minutes % 60)}`;
}

export function planSlot(now: Date, timeZone: string, window: SlotWindow = "any"): SlotPlan {
  return planSlotInZone(now, timeZone, window);
}

function planSlotInZone(now: Date, timeZone: string, window: SlotWindow): SlotPlan {
  const w = WINDOWS[window];
  const nowWall = wallOf(now, timeZone);
  const today = { y: nowWall.y, m: nowWall.m, d: nowWall.d };
  const raw = nowWall.minutes + SLOT_LEAD_MINUTES;
  const slotMinutes = Math.ceil(raw / 15) * 15;

  const scheduled = (day: Omit<Wall, "minutes">): SlotPlan => {
    const slotAt = atWall(day, w.start, timeZone);
    return {
      kind: "wait",
      sendAt: atWall(day, w.start - SLOT_LEAD_MINUTES, timeZone),
      slotAt,
      label: formatSlotLabel(w.start),
    };
  };

  // Never send before the earliest send (window start - lead, always >= 08:00): rounding up to
  // the quarter hour would otherwise offer the window start from a 7:46-7:59 send, which lands
  // in quiet hours and stalls the step a whole day.
  if (nowWall.minutes < w.start - SLOT_LEAD_MINUTES || slotMinutes < w.start) return scheduled(today);
  if (slotMinutes > w.end) return scheduled(nextDay(today));
  return { kind: "send_now", slotAt: atWall(today, slotMinutes, timeZone), label: formatSlotLabel(slotMinutes) };
}

export function hasSlotToken(body: string): boolean {
  return /\{\{\s*slot_time\s*\}\}/.test(body);
}

export function isSlotWindow(v: unknown): v is SlotWindow {
  return v === "any" || v === "morning" || v === "afternoon";
}
