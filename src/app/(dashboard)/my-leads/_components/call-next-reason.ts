import type { CallNextReason } from "@/lib/my-leads/call-next";

/**
 * One plain-English line for why a lead is in the Call next strip. Interface copy only: the
 * ranking itself lives in the database. All clock times are America/Chicago.
 */
const timeOnly = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  hour: "numeric",
  minute: "2-digit",
});
const dayKey = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const dateTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function elapsedMs(at: string | null, now: Date): number | null {
  if (!at) return null;
  const t = Date.parse(at);
  return Number.isFinite(t) ? now.getTime() - t : null;
}

/** "5m", "2h", "3d" (whole units, rounded down; never negative). */
export function compactAge(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < HOUR) return `${Math.max(1, Math.floor(safe / MINUTE))}m`;
  if (safe < DAY) return `${Math.floor(safe / HOUR)}h`;
  return `${Math.floor(safe / DAY)}d`;
}

/** "5 minutes", "1 hour", "2 days" (singular and plural). */
export function longAge(ms: number): string {
  const safe = Math.max(0, ms);
  const [n, unit] =
    safe < HOUR
      ? [Math.max(1, Math.floor(safe / MINUTE)), "minute"]
      : safe < DAY
        ? [Math.floor(safe / HOUR), "hour"]
        : [Math.floor(safe / DAY), "day"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

export function reasonLabel(
  reason: CallNextReason,
  reasonAt: string | null,
  now: Date,
): string {
  const ms = elapsedMs(reasonAt, now);
  switch (reason) {
    case "pinned_call_today":
      return "Pinned: call today";
    case "appointment_due": {
      if (!reasonAt || ms === null) return "Callback due soon";
      const due = new Date(reasonAt);
      const sameDay = dayKey.format(due) === dayKey.format(now);
      return `Callback due ${sameDay ? timeOnly.format(due) : dateTime.format(due)}`;
    }
    case "appointment_overdue":
      return ms === null || ms < MINUTE
        ? "Callback overdue"
        : `Callback ${longAge(ms)} overdue`;
    case "inbound_text":
      return ms === null ? "Texted you" : `Texted you ${compactAge(ms)} ago`;
    case "inbound_call":
      return ms === null ? "Called you" : `Called you ${compactAge(ms)} ago`;
    case "needs_offer":
      return ms === null || ms < DAY
        ? "Needs an offer"
        : `Needs an offer · waiting ${compactAge(ms)}`;
    case "offer_follow_up_overdue":
      return ms === null || ms < MINUTE
        ? "Offer follow-up overdue"
        : `Offer follow-up ${compactAge(ms)} overdue`;
    case "hot_going_cold":
      return ms === null ? "Hot, not touched yet" : `Hot, no touch in ${compactAge(ms)}`;
    case "warm_going_cold":
      return ms === null ? "Warm, not touched yet" : `Warm, no touch in ${compactAge(ms)}`;
    case "longest_since_touch":
      return ms === null
        ? "Not touched yet"
        : `Longest since last touch · ${compactAge(ms)}`;
  }
}
