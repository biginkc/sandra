import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { resolveMonth } from "../range";
import type { CalendarAppointmentRow } from "../types";

import { MonthGrid } from "./month-grid";

const CHI = "America/Chicago";

function makeAppt(
  overrides: Partial<CalendarAppointmentRow> & { id: string; due_at: string },
): CalendarAppointmentRow {
  return {
    title: "Appointment",
    description: null,
    end_at: new Date(new Date(overrides.due_at).getTime() + 30 * 60 * 1000).toISOString(),
    status: "open",
    outcome: null,
    assignee_id: "user-1",
    property_id: null,
    address: null,
    city: null,
    state: null,
    contact_id: null,
    contact_name: null,
    ...overrides,
  };
}

// Built by the PRODUCTION resolver (Codex round 1: the earlier local
// duplicate of the cell-count formula could never catch a resolver bug).
const DAYS = resolveMonth("2026-08-14", CHI).days;
const dayHref = (date: string) => `/calendar?view=week&week=${date}`;

function renderGrid(appointments: CalendarAppointmentRow[] = []) {
  return render(
    <MonthGrid
      days={DAYS}
      appointments={appointments}
      timezone={CHI}
      viewerRole="owner"
      assignees={{}}
      currentUserId="user-1"
      month="2026-08"
      dayHref={dayHref}
    />,
  );
}

describe("<MonthGrid />", () => {
  it("renders a full padded grid (Aug 2026 in Chicago = 6 rows / 42 cells) with outside-month cells muted", () => {
    renderGrid();
    // Aug 1 2026 is a Saturday -> 6 leading July cells; 42 cells total.
    expect(DAYS).toHaveLength(42);
    for (const day of DAYS) {
      expect(screen.getByTestId(`calendar-month-cell-${day.date}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("calendar-month-cell-2026-07-26")).toHaveAttribute(
      "data-outside-month",
    );
    expect(screen.getByTestId("calendar-month-cell-2026-08-01")).not.toHaveAttribute(
      "data-outside-month",
    );
  });

  it("places an appointment in its zone-local day cell with a compact start-time line", () => {
    // 2026-08-14 16:45 Central = 21:45Z.
    renderGrid([makeAppt({ id: "a1", due_at: "2026-08-14T21:45:00Z" })]);
    const line = screen.getByTestId("calendar-month-appointment-a1");
    expect(line).toHaveTextContent("4:45 PM");
    expect(line).toHaveTextContent("Personal block");
    expect(
      screen.getByTestId("calendar-month-cell-2026-08-14"),
    ).toContainElement(line);
  });

  it("collapses more than three appointments into a +N more link to that day's week view", () => {
    const base = new Date("2026-08-14T15:00:00Z").getTime();
    const appts = [0, 1, 2, 3, 4].map((i) =>
      makeAppt({ id: `a${i}`, due_at: new Date(base + i * 3_600_000).toISOString() }),
    );
    renderGrid(appts);
    expect(screen.getByTestId("calendar-month-appointment-a0")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-month-appointment-a2")).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-month-appointment-a3")).not.toBeInTheDocument();
    const more = screen.getByTestId("calendar-month-more-2026-08-14");
    expect(more).toHaveTextContent("+2 more");
    expect(more).toHaveAttribute("href", dayHref("2026-08-14"));
  });

  it("links a property appointment to its lead page and the day number to the week view", () => {
    renderGrid([
      makeAppt({
        id: "p1",
        due_at: "2026-08-05T15:00:00Z",
        property_id: "prop-9",
        address: "123 Main St",
      }),
    ]);
    expect(screen.getByTestId("calendar-month-appointment-p1")).toHaveAttribute(
      "href",
      "/leads/prop-9",
    );
    expect(screen.getByTestId("calendar-month-day-link-2026-08-05")).toHaveAttribute(
      "href",
      dayHref("2026-08-05"),
    );
  });
});
