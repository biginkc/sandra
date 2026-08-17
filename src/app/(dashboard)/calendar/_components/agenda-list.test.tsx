import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { addDaysInZone, getDayBoundsInZone } from "@/lib/time/zoned";

import type { CalendarAppointmentRow, CalendarDayBounds } from "../types";

import { AgendaList } from "./agenda-list";

vi.mock("@/components/appointments/appointment-outcome-row", () => ({
  AppointmentOutcomeRow: ({ taskId }: { taskId: string }) => (
    <div data-testid={`stub-outcome-row-${taskId}`}>outcome row</div>
  ),
}));

const CHI = "America/Chicago";

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

describe("<AgendaList />", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the empty state when there are no appointments", () => {
    const days = buildWeek(new Date("2026-08-19T12:00:00Z"), CHI);
    render(
      <AgendaList
        days={days}
        appointments={[]}
        timezone={CHI}
        viewerRole="owner"
        assignees={{}}
        currentUserId="viewer-1"
        nowMs={Date.now()}
      />,
    );
    expect(screen.getByTestId("calendar-agenda-empty")).toBeInTheDocument();
  });

  it("groups rows under Today/Tomorrow zone-local day headers, in chronological order", () => {
    const days = buildWeek(new Date("2026-08-19T12:00:00Z"), CHI);
    vi.useFakeTimers();
    vi.setSystemTime(
      new Date(new Date(days[0].startUtc).getTime() + 60 * 60 * 1000),
    ); // "now" = day 0

    const day0Start = new Date(days[0].startUtc).getTime();
    const day1Start = new Date(days[1].startUtc).getTime();
    const later = makeAppt({
      id: "later-today",
      due_at: new Date(day0Start + 10 * 60 * 60 * 1000).toISOString(),
      end_at: new Date(day0Start + 10.5 * 60 * 60 * 1000).toISOString(),
    });
    const earlier = makeAppt({
      id: "earlier-today",
      due_at: new Date(day0Start + 3 * 60 * 60 * 1000).toISOString(),
      end_at: new Date(day0Start + 3.5 * 60 * 60 * 1000).toISOString(),
    });
    const tomorrow = makeAppt({
      id: "tomorrow-appt",
      due_at: new Date(day1Start + 2 * 60 * 60 * 1000).toISOString(),
      end_at: new Date(day1Start + 2.5 * 60 * 60 * 1000).toISOString(),
    });

    render(
      <AgendaList
        days={days}
        appointments={[later, earlier, tomorrow]}
        timezone={CHI}
        viewerRole="owner"
        assignees={{}}
        currentUserId="viewer-1"
        nowMs={Date.now()}
      />,
    );

    expect(
      screen.getByTestId(`calendar-agenda-day-header-${days[0].date}`),
    ).toHaveTextContent("Today");
    expect(
      screen.getByTestId(`calendar-agenda-day-header-${days[1].date}`),
    ).toHaveTextContent("Tomorrow");

    // Chronological within the Today group: earlier-today row precedes later-today.
    const order = screen
      .getAllByTestId(
        /^calendar-appointment-(earlier-today|later-today|tomorrow-appt)$/,
      )
      .map((el) => el.getAttribute("data-testid"));
    expect(order).toEqual([
      "calendar-appointment-earlier-today",
      "calendar-appointment-later-today",
      "calendar-appointment-tomorrow-appt",
    ]);
  });

  it("caps visible rows at 40 and reveals the rest via Show more", async () => {
    const days = buildWeek(new Date("2026-08-19T12:00:00Z"), CHI);
    const dayStart = new Date(days[0].startUtc).getTime();
    const appointments = Array.from({ length: 45 }, (_, i) =>
      makeAppt({
        id: `appt-${i}`,
        due_at: new Date(dayStart + i * 5 * 60 * 1000).toISOString(),
        end_at: new Date(
          dayStart + i * 5 * 60 * 1000 + 15 * 60 * 1000,
        ).toISOString(),
      }),
    );

    const { rerender } = render(
      <AgendaList
        days={days}
        appointments={appointments}
        timezone={CHI}
        viewerRole="owner"
        assignees={{}}
        currentUserId="viewer-1"
        nowMs={Date.now()}
      />,
    );

    expect(screen.getAllByTestId(/^calendar-appointment-appt-/)).toHaveLength(
      40,
    );
    const showMore = screen.getByTestId("calendar-agenda-show-more");
    expect(showMore).toHaveTextContent("Show 5 more");
    expect(showMore).toHaveClass("min-h-11", "min-w-11");

    const user = userEvent.setup();
    await user.click(showMore);

    expect(screen.getAllByTestId(/^calendar-appointment-appt-/)).toHaveLength(
      45,
    );
    expect(
      screen.queryByTestId("calendar-agenda-show-more"),
    ).not.toBeInTheDocument();

    const nextDays = buildWeek(new Date("2026-08-26T12:00:00Z"), CHI);
    const nextStart = new Date(nextDays[0].startUtc).getTime();
    const nextAppointments = Array.from({ length: 45 }, (_, i) =>
      makeAppt({
        id: `next-${i}`,
        due_at: new Date(nextStart + i * 5 * 60 * 1000).toISOString(),
        end_at: new Date(
          nextStart + i * 5 * 60 * 1000 + 15 * 60 * 1000,
        ).toISOString(),
      }),
    );
    rerender(
      <AgendaList
        days={nextDays}
        appointments={nextAppointments}
        timezone={CHI}
        viewerRole="owner"
        assignees={{}}
        currentUserId="viewer-1"
        nowMs={Date.now()}
      />,
    );
    expect(screen.getAllByTestId(/^calendar-appointment-next-/)).toHaveLength(
      40,
    );
    expect(screen.getByTestId("calendar-agenda-show-more")).toHaveTextContent(
      "Show 5 more",
    );
  });

  it("shows the outcome row only for a past-due open appointment", () => {
    const days = buildWeek(new Date("2026-08-19T12:00:00Z"), CHI);
    const dayStart = new Date(days[0].startUtc).getTime();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(dayStart + 6 * 60 * 60 * 1000));

    const pastDue = makeAppt({
      id: "past-due",
      due_at: new Date(dayStart + 60 * 60 * 1000).toISOString(),
      end_at: new Date(dayStart + 90 * 60 * 1000).toISOString(),
      status: "open",
    });
    const future = makeAppt({
      id: "future",
      due_at: new Date(dayStart + 8 * 60 * 60 * 1000).toISOString(),
      end_at: new Date(dayStart + 8.5 * 60 * 60 * 1000).toISOString(),
      status: "open",
    });

    render(
      <AgendaList
        days={days}
        appointments={[pastDue, future]}
        timezone={CHI}
        viewerRole="owner"
        assignees={{}}
        currentUserId="viewer-1"
        nowMs={Date.now()}
      />,
    );

    expect(screen.getByTestId("stub-outcome-row-past-due")).toBeInTheDocument();
    expect(
      screen.queryByTestId("stub-outcome-row-future"),
    ).not.toBeInTheDocument();
  });
});
