export type UrgencyFilter = "all" | "overdue" | "today" | "scheduled" | "none";

export type UrgencyLead = {
  id: string;
  next_task_due_at: string | null;
};

function dueMs(lead: UrgencyLead): number | null {
  if (!lead.next_task_due_at) return null;
  const value = Date.parse(lead.next_task_due_at);
  return Number.isFinite(value) ? value : null;
}

function calendarDayOrdinal(value: string, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date(value));
  const part = (type: "year" | "month" | "day") =>
    Number(parts.find((entry) => entry.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day")) / 86_400_000;
}

export function urgencyBucket(
  lead: UrgencyLead,
  dayStartIso: string,
  dayEndIso: string,
): 0 | 1 | 2 | 3 {
  const due = dueMs(lead);
  if (due === null) return 3;
  if (due < Date.parse(dayStartIso)) return 0;
  if (due < Date.parse(dayEndIso)) return 1;
  return 2;
}

export function compareLeadUrgency<T extends UrgencyLead>(
  a: T,
  b: T,
  dayStartIso: string,
  dayEndIso: string,
): number {
  const bucketDelta =
    urgencyBucket(a, dayStartIso, dayEndIso) -
    urgencyBucket(b, dayStartIso, dayEndIso);
  if (bucketDelta !== 0) return bucketDelta;
  const aDue = dueMs(a);
  const bDue = dueMs(b);
  if (aDue !== null && bDue !== null && aDue !== bDue) return aDue - bDue;
  return a.id.localeCompare(b.id);
}

export function matchesUrgencyFilter(
  lead: UrgencyLead,
  filter: UrgencyFilter,
  dayStartIso: string,
  dayEndIso: string,
): boolean {
  if (filter === "all") return true;
  const bucket = urgencyBucket(lead, dayStartIso, dayEndIso);
  return (
    (filter === "overdue" && bucket === 0) ||
    (filter === "today" && bucket === 1) ||
    (filter === "scheduled" && bucket === 2) ||
    (filter === "none" && bucket === 3)
  );
}

export function formatNextAction(
  dueAt: string | null,
  dayStartIso: string,
  dayEndIso: string,
  timezone = "America/Chicago",
): {
  tone: "overdue" | "today" | "scheduled" | "none";
  label: string;
} {
  if (!dueAt || !Number.isFinite(Date.parse(dueAt))) {
    return { tone: "none", label: "No next action" };
  }
  const due = Date.parse(dueAt);
  const start = Date.parse(dayStartIso);
  const end = Date.parse(dayEndIso);
  if (due < start) {
    const days = Math.max(
      1,
      calendarDayOrdinal(dayStartIso, timezone) - calendarDayOrdinal(dueAt, timezone),
    );
    return { tone: "overdue", label: `Overdue ${days}d` };
  }
  if (due < end) {
    const time = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(dueAt));
    return { tone: "today", label: `Today ${time}` };
  }
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(dueAt));
  return { tone: "scheduled", label: date };
}
