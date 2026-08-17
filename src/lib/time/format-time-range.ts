/** Zone-local YYYY-MM-DD key used to detect overnight ranges without
 * trusting a locale string's shape. */
function zonedDateKey(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return `${map.year}-${map.month}-${map.day}`;
}

/** Zone-local minutes since midnight. Numeric comparison is required to
 * spot the repeated hour when daylight saving time falls back. */
function zonedMinutesOfDay(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return Number(map.hour) * 60 + Number(map.minute);
}

function zoneAbbreviation(instant: Date, timeZone: string): string {
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "short",
    })
      .formatToParts(instant)
      .find((part) => part.type === "timeZoneName")?.value ?? ""
  );
}

/**
 * Formats an instant range in the viewer's IANA timezone.
 *
 * Overnight ranges carry a next-day marker. Repeated-hour ranges carry
 * zone abbreviations, so two different real instants never appear to be
 * zero-length or backwards. A missing end degrades to the start label.
 */
export function formatTimeRange(
  dueAt: string,
  endAt: string | null,
  timeZone: string,
): string {
  const start = new Date(dueAt);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  });
  const startLabel = formatter.format(start);
  if (!endAt) return startLabel;

  const end = new Date(endAt);
  const endLabel = formatter.format(end);

  if (zonedDateKey(start, timeZone) !== zonedDateKey(end, timeZone)) {
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
    }).format(end);
    return `${startLabel}–${endLabel} → ${weekday}`;
  }

  if (
    end.getTime() > start.getTime() &&
    zonedMinutesOfDay(end, timeZone) <= zonedMinutesOfDay(start, timeZone)
  ) {
    return `${startLabel} ${zoneAbbreviation(start, timeZone)}–${endLabel} ${zoneAbbreviation(end, timeZone)}`;
  }

  return `${startLabel}–${endLabel}`;
}
