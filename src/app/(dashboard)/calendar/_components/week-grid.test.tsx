import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addDaysInZone,
  getDayBoundsInZone,
  wallTimeToUtc,
} from "@/lib/time/zoned";

import type { CalendarAppointmentRow, CalendarDayBounds } from "../types";

import { WeekGrid } from "./week-grid";

// Outcome-row internals (server actions, reschedule popover) are covered by
// appointment-outcome-row.test.tsx — stub it here so this suite only
// asserts WHEN WeekGrid decides to show it, matching the tasks-panel.test.tsx
// convention.
vi.mock("@/components/appointments/appointment-outcome-row", () => ({
  AppointmentOutcomeRow: ({ taskId }: { taskId: string }) => (
    <div data-testid={`stub-outcome-row-${taskId}`}>outcome row</div>
  ),
  AppointmentUpcomingActions: ({ taskId }: { taskId: string }) => (
    <div data-testid={`stub-upcoming-actions-${taskId}`}>upcoming actions</div>
  ),
}));

const LA = "America/Los_Angeles";

function dateKeyInZone(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const map: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}`;
}

/** Builds a real 7-day week (using the production zoned.ts helpers, not
 *  hand-computed offsets) anchored on whichever zone-local day `anchor`
 *  falls in, in `tz`. */
function buildWeek(anchor: Date, tz: string): CalendarDayBounds[] {
  const days: CalendarDayBounds[] = [];
  let cursor = getDayBoundsInZone(anchor, tz).dayStart;
  for (let i = 0; i < 7; i++) {
    const dayEnd = addDaysInZone(cursor, 1, tz);
    days.push({
      date: dateKeyInZone(cursor, tz),
      startUtc: cursor.toISOString(),
      endUtc: dayEnd.toISOString(),
    });
    cursor = dayEnd;
  }
  return days;
}

function makeAppt(
  overrides: Partial<CalendarAppointmentRow> & { id: string },
): CalendarAppointmentRow {
  return {
    title: "Appointment",
    description: null,
    due_at: new Date().toISOString(),
    end_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    status: "open",
    outcome: null,
    assignee_id: "user-1",
    property_id: null,
    address: null,
    city: null,
    state: null,
    contact_id: null,
    contact_name: null,
    is_dnc_locked: false,
    ...overrides,
  };
}

describe("<WeekGrid />", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders 7 day columns headered in the given timezone", () => {
    const days = buildWeek(new Date("2026-08-19T12:00:00Z"), LA);
    render(
      <WeekGrid
        days={days}
        appointments={[]}
        timezone={LA}
        viewerRole="owner"
        assignees={{}}
        currentUserId="viewer-1"
        nowMs={Date.now()}
        todayKey={dateKeyInZone(new Date(), LA)}
      />,
    );

    expect(screen.getAllByTestId(/calendar-day-column-/)).toHaveLength(7);
    for (const day of days) {
      const expectedHeader = new Intl.DateTimeFormat("en-US", {
        timeZone: LA,
        weekday: "short",
        month: "numeric",
        day: "numeric",
      }).format(new Date(day.startUtc));
      expect(
        screen.getByTestId(`calendar-day-column-${day.date}`),
      ).toHaveTextContent(expectedHeader);
    }
  });

  it("places an appointment in its zone-local day column with a time label that reflects the PASSED timezone, not the runtime default", () => {
    const days = buildWeek(new Date("2026-08-19T12:00:00Z"), LA);
    const wednesday = days[2];
    const conversion = wallTimeToUtc({
      date: wednesday.date,
      time: "14:00",
      timeZone: LA,
    });
    if (!conversion.ok) throw new Error("fixture conversion failed");
    const dueAt = conversion.utc.toISOString();
    const endAt = new Date(
      conversion.utc.getTime() + 30 * 60 * 1000,
    ).toISOString();
    const appt = makeAppt({
      id: "appt-1",
      due_at: dueAt,
      end_at: endAt,
      title: "Walkthrough",
    });

    const { rerender } = render(
      <WeekGrid
        days={days}
        appointments={[appt]}
        timezone={LA}
        viewerRole="owner"
        assignees={{}}
        currentUserId="viewer-1"
        nowMs={Date.now()}
        todayKey={dateKeyInZone(new Date(), LA)}
      />,
    );

    // Same instant rendered in LA reads as 2:00 PM inside Wednesday's column.
    const wedColumn = screen.getByTestId(
      `calendar-day-column-${wednesday.date}`,
    );
    expect(wedColumn).toHaveTextContent(/2:00.*2:30 PM/);
    expect(
      screen.getByTestId("calendar-appointment-appt-1"),
    ).toBeInTheDocument();

    // Re-rendering with a DIFFERENT display timezone changes the label —
    // proves the component reads the passed `timezone` prop, not whatever
    // the runtime/process default happens to be.
    rerender(
      <WeekGrid
        days={days}
        appointments={[appt]}
        timezone="America/New_York"
        viewerRole="owner"
        assignees={{}}
        currentUserId="viewer-1"
        nowMs={Date.now()}
        todayKey={dateKeyInZone(new Date(), "America/New_York")}
      />,
    );
    expect(
      screen.getByTestId("calendar-appointment-appt-1"),
    ).not.toHaveTextContent(/2:00.*2:30 PM/);
  });

  it("accents today's column", () => {
    const days = buildWeek(new Date("2026-08-19T12:00:00Z"), LA);
    const today = days[3];
    vi.useFakeTimers();
    vi.setSystemTime(
      new Date(new Date(today.startUtc).getTime() + 60 * 60 * 1000),
    );

    render(
      <WeekGrid
        days={days}
        appointments={[]}
        timezone={LA}
        viewerRole="owner"
        assignees={{}}
        currentUserId="viewer-1"
        nowMs={Date.now()}
        todayKey={dateKeyInZone(new Date(), LA)}
      />,
    );

    expect(
      screen.getByTestId(`calendar-day-column-${today.date}`),
    ).toHaveAttribute("data-today", "true");
    expect(
      screen.getByTestId(`calendar-day-column-${days[0].date}`),
    ).not.toHaveAttribute("data-today");
  });

  it("shows the assignee email for owner role and hides it for member role", () => {
    const days = buildWeek(new Date("2026-08-19T12:00:00Z"), LA);
    const appt = makeAppt({
      id: "appt-1",
      due_at: days[0].startUtc,
      end_at: new Date(
        new Date(days[0].startUtc).getTime() + 30 * 60 * 1000,
      ).toISOString(),
      assignee_id: "rep-1",
    });
    const assignees = { "rep-1": "rep@bmh.com" };

    // The label follows the ROW's owner, not the viewer's role: any
    // non-self appointment is labeled (members can view teammates), and
    // your own rows never are.
    const { rerender } = render(
      <WeekGrid
        days={days}
        appointments={[appt]}
        timezone={LA}
        viewerRole="member"
        assignees={assignees}
        currentUserId="viewer-1"
        nowMs={Date.now()}
        todayKey={dateKeyInZone(new Date(), LA)}
      />,
    );
    expect(screen.getByText("rep@bmh.com")).toBeInTheDocument();

    rerender(
      <WeekGrid
        days={days}
        appointments={[appt]}
        timezone={LA}
        viewerRole="member"
        assignees={assignees}
        currentUserId="rep-1"
        nowMs={Date.now()}
        todayKey={dateKeyInZone(new Date(), LA)}
      />,
    );
    expect(screen.queryByText("rep@bmh.com")).not.toBeInTheDocument();
  });

  it("click-through hrefs follow linkage: property -> /leads, contact-only -> /messages?thread, personal block -> unlinked", () => {
    const days = buildWeek(new Date("2026-08-19T12:00:00Z"), LA);
    const start = days[0].startUtc;
    const end = new Date(
      new Date(start).getTime() + 30 * 60 * 1000,
    ).toISOString();
    const appointments = [
      makeAppt({
        id: "prop-appt",
        due_at: start,
        end_at: end,
        property_id: "prop-1",
        address: "123 Main St",
      }),
      makeAppt({
        id: "contact-appt",
        due_at: start,
        end_at: end,
        contact_id: "contact-1",
        contact_name: "Jane Owner",
      }),
      makeAppt({ id: "personal-appt", due_at: start, end_at: end }),
    ];

    const { container } = render(
      <WeekGrid
        days={days}
        appointments={appointments}
        timezone={LA}
        viewerRole="owner"
        assignees={{}}
        currentUserId="viewer-1"
        nowMs={Date.now()}
        todayKey={dateKeyInZone(new Date(), LA)}
      />,
    );

    expect(container.querySelector("a[href='/leads/prop-1']")).not.toBeNull();
    expect(
      container.querySelector("a[href='/messages?thread=contact-1']"),
    ).not.toBeNull();
    expect(
      screen.getByTestId("calendar-appointment-unlinked-personal-appt"),
    ).toBeInTheDocument();
    expect(screen.getByText("Personal block")).toBeInTheDocument();
  });

  it("shows an outcome chip for a completed appointment, and the outcome row ONLY for a past-due open one", () => {
    const days = buildWeek(new Date("2026-08-19T12:00:00Z"), LA);
    const dayStart = new Date(days[0].startUtc).getTime();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(dayStart + 6 * 60 * 60 * 1000)); // noon-ish that day

    const pastDueOpen = makeAppt({
      id: "past-due",
      due_at: new Date(dayStart + 60 * 60 * 1000).toISOString(), // 1h in, already past "now"
      end_at: new Date(dayStart + 90 * 60 * 1000).toISOString(),
      status: "open",
    });
    const futureOpen = makeAppt({
      id: "future",
      due_at: new Date(dayStart + 8 * 60 * 60 * 1000).toISOString(), // still ahead of "now"
      end_at: new Date(dayStart + 8.5 * 60 * 60 * 1000).toISOString(),
      status: "open",
    });
    const completed = makeAppt({
      id: "completed",
      due_at: new Date(dayStart + 2 * 60 * 60 * 1000).toISOString(),
      end_at: new Date(dayStart + 2.5 * 60 * 60 * 1000).toISOString(),
      status: "completed",
      outcome: "held",
    });

    render(
      <WeekGrid
        days={days}
        appointments={[pastDueOpen, futureOpen, completed]}
        timezone={LA}
        viewerRole="owner"
        assignees={{}}
        currentUserId="viewer-1"
        nowMs={Date.now()}
        todayKey={dateKeyInZone(new Date(), LA)}
      />,
    );

    expect(screen.getByTestId("stub-outcome-row-past-due")).toBeInTheDocument();
    expect(
      screen.queryByTestId("stub-outcome-row-future"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("stub-upcoming-actions-future"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("stub-upcoming-actions-past-due"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("stub-outcome-row-completed"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("stub-upcoming-actions-completed"),
    ).not.toBeInTheDocument();

    expect(
      screen.getByTestId("calendar-outcome-chip-completed"),
    ).toHaveTextContent("Held");
    expect(
      screen.queryByTestId("calendar-outcome-chip-past-due"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("calendar-outcome-chip-future"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("calendar-appointment-past-due")).toHaveAttribute(
      "data-appointment-tone",
      "needs_outcome",
    );
    expect(
      screen.getByTestId("calendar-appointment-past-due"),
    ).toHaveTextContent("Needs outcome");
    expect(screen.getByTestId("calendar-appointment-future")).toHaveAttribute(
      "data-appointment-tone",
      "personal",
    );
    expect(
      screen.getByTestId("calendar-appointment-completed"),
    ).toHaveAttribute("data-appointment-tone", "completed");
  });

  it("keeps a DNC-locked appointment as read-only history without lifecycle controls", () => {
    const days = buildWeek(new Date("2026-08-19T12:00:00Z"), LA);
    const dayStart = new Date(days[0].startUtc).getTime();
    const nowMs = dayStart + 6 * 60 * 60 * 1000;
    const locked = makeAppt({
      id: "locked-history",
      due_at: new Date(dayStart + 60 * 60 * 1000).toISOString(),
      end_at: new Date(dayStart + 90 * 60 * 1000).toISOString(),
      is_dnc_locked: true,
    });

    render(
      <WeekGrid
        days={days}
        appointments={[locked]}
        timezone={LA}
        viewerRole="owner"
        assignees={{}}
        currentUserId="viewer-1"
        nowMs={nowMs}
        todayKey={days[0].date}
      />,
    );

    expect(
      screen.getByTestId("calendar-dnc-read-only-locked-history"),
    ).toHaveTextContent("Read-only · Do not contact");
    expect(
      screen.getByTestId("calendar-appointment-locked-history"),
    ).toHaveAttribute("data-appointment-tone", "dnc_locked");
    expect(
      screen.queryByTestId("stub-outcome-row-locked-history"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("stub-upcoming-actions-locked-history"),
    ).not.toBeInTheDocument();
  });
});
