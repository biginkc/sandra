import type { CSSProperties } from "react";
import Link from "next/link";

import { cn } from "@/lib/utils";

import type {
  CalendarAppointmentRow,
  CalendarDayBounds,
  CalendarViewerRole,
} from "../types";

import {
  appointmentHref,
  appointmentToneClass,
  appointmentVisualTone,
  dayIndexForAppointment,
  formatColumnHeader,
  formatDateKeyLong,
  isPastDueOpen,
} from "./calendar-shared";

type Props = {
  days: CalendarDayBounds[];
  appointments: CalendarAppointmentRow[];
  timezone: string;
  viewerRole: CalendarViewerRole;
  assignees: Record<string, string>;
  currentUserId: string;
  nowMs: number;
  todayKey: string;
};

type PositionedAppointment = {
  appointment: CalendarAppointmentRow;
  top: number;
  height: number;
  column: number;
  columnCount: number;
};

const START_MINUTE = 8 * 60;
const HOUR_HEIGHT = 44;
const GRID_HOURS = 11;
const GRID_HEIGHT = HOUR_HEIGHT * GRID_HOURS;
const HOURS = [
  "8 AM",
  "9 AM",
  "10 AM",
  "11 AM",
  "12 PM",
  "1 PM",
  "2 PM",
  "3 PM",
  "4 PM",
  "5 PM",
  "6 PM",
];

function minutesInZone(instant: string, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const values: Record<string, number> = {};
  for (const part of parts) {
    if (part.type === "hour" || part.type === "minute") {
      values[part.type] = Number(part.value);
    }
  }
  return (values.hour ?? 0) * 60 + (values.minute ?? 0);
}

function startTimeLabel(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(instant));
}

function eventGeometry(
  appointment: CalendarAppointmentRow,
  timeZone: string,
): { top: number; height: number } {
  const startMinute = minutesInZone(appointment.due_at, timeZone);
  const durationMinutes = Math.max(
    0,
    (new Date(appointment.end_at).getTime() -
      new Date(appointment.due_at).getTime()) /
      60_000,
  );
  return {
    top: ((startMinute - START_MINUTE) / 60) * HOUR_HEIGHT,
    height: Math.max(36, (durationMinutes / 60) * HOUR_HEIGHT - 4),
  };
}

function fitsTimeline(
  appointment: CalendarAppointmentRow,
  timeZone: string,
): boolean {
  const { top, height } = eventGeometry(appointment, timeZone);
  return top >= 0 && top + height <= GRID_HEIGHT;
}

/** Split each visually overlapping group into stable horizontal columns so
 * every event remains visible and focusable. The 36px minimum height is part
 * of the collision interval: back-to-back short events may still overlap on
 * screen even when their actual times do not. */
function layoutAppointments(
  appointments: CalendarAppointmentRow[],
  timeZone: string,
): PositionedAppointment[] {
  const sorted = appointments
    .filter((appointment) => fitsTimeline(appointment, timeZone))
    .map((appointment) => ({
      appointment,
      ...eventGeometry(appointment, timeZone),
    }))
    .sort((a, b) => {
      const start = a.top - b.top;
      if (start !== 0) return start;
      const end = a.top + a.height - (b.top + b.height);
      return end !== 0 ? end : a.appointment.id.localeCompare(b.appointment.id);
    });
  const result: PositionedAppointment[] = [];
  let group: Array<{
    appointment: CalendarAppointmentRow;
    top: number;
    height: number;
  }> = [];
  let groupEnd = Number.NEGATIVE_INFINITY;

  const flush = () => {
    if (group.length === 0) return;
    const columnEnds: number[] = [];
    const assignments = group.map((positioned) => {
      const end = positioned.top + positioned.height;
      let column = columnEnds.findIndex(
        (columnEnd) => columnEnd <= positioned.top,
      );
      if (column < 0) {
        column = columnEnds.length;
        columnEnds.push(end);
      } else {
        columnEnds[column] = end;
      }
      return { ...positioned, column };
    });
    const columnCount = Math.max(1, columnEnds.length);
    for (const { appointment, top, height, column } of assignments) {
      result.push({
        appointment,
        top,
        height,
        column,
        columnCount,
      });
    }
    group = [];
    groupEnd = Number.NEGATIVE_INFINITY;
  };

  for (const positioned of sorted) {
    const end = positioned.top + positioned.height;
    if (group.length > 0 && positioned.top >= groupEnd) flush();
    group.push(positioned);
    groupEnd = Math.max(groupEnd, end);
  }
  flush();
  return result;
}

function EventContent({
  appointment,
  timezone,
  assignee,
  nowMs,
}: {
  appointment: CalendarAppointmentRow;
  timezone: string;
  assignee: string;
  nowMs: number;
}) {
  return (
    <>
      <div className="truncate text-[9px] leading-[10px] font-extrabold tabular-nums">
        {startTimeLabel(appointment.due_at, timezone)}
      </div>
      <div className="truncate text-[10px] leading-[11px] font-bold">
        {appointment.title}
      </div>
      <div className="truncate text-[8px] leading-[9px] font-semibold opacity-75">
        {assignee}
      </div>
      {isPastDueOpen(appointment, nowMs) ? (
        <span className="sr-only">Needs outcome</span>
      ) : null}
      {appointment.is_dnc_locked ? (
        <span className="sr-only">Read-only · Do not contact</span>
      ) : null}
    </>
  );
}

function EventShell({
  appointment,
  day,
  timezone,
  assignee,
  nowMs,
  className,
  style,
  geometry,
}: {
  appointment: CalendarAppointmentRow;
  day: CalendarDayBounds;
  timezone: string;
  assignee: string;
  nowMs: number;
  className?: string;
  style?: CSSProperties;
  geometry?: {
    top: number;
    height: number;
    column: number;
    columnCount: number;
  };
}) {
  const href = appointmentHref(appointment);
  const tone = appointmentVisualTone(appointment, nowMs);
  const label = `${formatDateKeyLong(day.date)}, ${startTimeLabel(appointment.due_at, timezone)}, ${appointment.title}, ${assignee}`;
  const content = (
    <EventContent
      appointment={appointment}
      timezone={timezone}
      assignee={assignee}
      nowMs={nowMs}
    />
  );
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border px-1.5 py-0.5",
        appointmentToneClass(tone),
        className,
      )}
      style={style}
      title={label}
      data-testid={`calendar-appointment-${appointment.id}`}
      data-appointment-tone={tone}
      data-calendar-top={geometry ? String(geometry.top) : undefined}
      data-calendar-height={geometry ? String(geometry.height) : undefined}
      data-calendar-column={geometry ? String(geometry.column) : undefined}
      data-calendar-column-count={
        geometry ? String(geometry.columnCount) : undefined
      }
    >
      {href ? (
        <Link
          href={href}
          aria-label={label}
          className="block h-full min-h-0 hover:underline"
          data-testid={`calendar-appointment-link-${appointment.id}`}
        >
          {content}
        </Link>
      ) : (
        <div
          className="h-full"
          data-testid={`calendar-appointment-unlinked-${appointment.id}`}
        >
          {content}
        </div>
      )}
    </div>
  );
}

/** Desktop Week timeline. Narrow screens keep using AgendaList. */
export function WeekGrid({
  days,
  appointments,
  timezone,
  viewerRole,
  assignees,
  currentUserId,
  nowMs,
  todayKey,
}: Props) {
  void viewerRole;
  void currentUserId;
  const appointmentsByDay = days.map((_, dayIndex) =>
    appointments
      .filter(
        (appointment) => dayIndexForAppointment(appointment, days) === dayIndex,
      )
      .sort(
        (a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime(),
      ),
  );
  const outsideHours = appointmentsByDay.map((dayAppointments) =>
    dayAppointments.filter(
      (appointment) => !fitsTimeline(appointment, timezone),
    ),
  );
  const hasOutsideHours = outsideHours.some((rows) => rows.length > 0);

  return (
    <div
      className="border-border bg-card overflow-x-auto rounded-2xl border"
      data-testid="calendar-week-grid"
    >
      <div className="min-w-[980px]">
        <div className="grid grid-cols-[52px_repeat(7,minmax(0,1fr))]">
          <div className="border-border border-b" aria-hidden />
          {days.map((day) => {
            const isToday = day.date === todayKey;
            const [weekday, date] = formatColumnHeader(day, timezone).split(
              " ",
            );
            return (
              <div
                key={day.date}
                className="border-border border-b border-l px-1.5 py-2 text-center"
                data-testid={`calendar-day-header-${day.date}`}
              >
                <div className="text-muted-foreground text-[9px] font-bold tracking-[0.1em] uppercase">
                  {weekday?.replace(",", "")}
                </div>
                <div
                  className={cn(
                    "mt-0.5 inline-flex size-7 items-center justify-center rounded-full text-sm font-black",
                    isToday
                      ? "bg-foreground text-background"
                      : "text-foreground",
                  )}
                >
                  {date?.split("/").at(-1)}
                </div>
              </div>
            );
          })}

          <div style={{ height: GRID_HEIGHT }}>
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="border-border/50 text-muted-foreground box-border h-11 border-t pr-2 pt-1 text-right text-[9px] font-bold"
              >
                {hour}
              </div>
            ))}
          </div>

          {days.map((day, dayIndex) => {
            const isToday = day.date === todayKey;
            const positioned = layoutAppointments(
              appointmentsByDay[dayIndex],
              timezone,
            );

            return (
              <div
                key={day.date}
                className={cn(
                  "border-border relative overflow-hidden border-l",
                  isToday && "bg-stone-50/80",
                )}
                style={{
                  height: GRID_HEIGHT,
                  backgroundImage:
                    "repeating-linear-gradient(to bottom, color-mix(in srgb, var(--border) 45%, transparent) 0, color-mix(in srgb, var(--border) 45%, transparent) 1px, transparent 1px, transparent 44px)",
                }}
                data-testid={`calendar-day-column-${day.date}`}
                data-today={isToday || undefined}
              >
                {positioned.map(
                  ({ appointment, top, height, column, columnCount }) => {
                    const assignee =
                      assignees[appointment.assignee_id] ??
                      "Former teammate (name unavailable)";
                    const width = 100 / columnCount;
                    return (
                      <EventShell
                        key={appointment.id}
                        appointment={appointment}
                        day={day}
                        timezone={timezone}
                        assignee={assignee}
                        nowMs={nowMs}
                        className="absolute"
                        style={{
                          top,
                          height,
                          left: `calc(${column * width}% + 4px)`,
                          width: `calc(${width}% - 8px)`,
                        }}
                        geometry={{ top, height, column, columnCount }}
                      />
                    );
                  },
                )}
              </div>
            );
          })}
        </div>

        {hasOutsideHours ? (
          <div
            className="border-border grid grid-cols-[52px_repeat(7,minmax(0,1fr))] border-t"
            data-testid="calendar-outside-hours"
          >
            <div className="text-muted-foreground px-1 py-2 text-center text-[8px] leading-tight font-bold uppercase">
              Outside hours
            </div>
            {days.map((day, dayIndex) => (
              <div
                key={day.date}
                className="border-border flex min-h-11 flex-col gap-1 border-l p-1"
                data-testid={`calendar-outside-hours-${day.date}`}
              >
                {outsideHours[dayIndex].map((appointment) => {
                  const assignee =
                    assignees[appointment.assignee_id] ??
                    "Former teammate (name unavailable)";
                  return (
                    <EventShell
                      key={appointment.id}
                      appointment={appointment}
                      day={day}
                      timezone={timezone}
                      assignee={assignee}
                      nowMs={nowMs}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
