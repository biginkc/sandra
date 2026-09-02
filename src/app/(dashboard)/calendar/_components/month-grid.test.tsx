import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import { resolveMonth } from "../range";
import type { CalendarAppointmentRow } from "../types";

import { MonthGrid } from "./month-grid";

const CHI = "America/Chicago";

function dateKeyInZone(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return `${map.year}-${map.month}-${map.day}`;
}

function makeAppt(
  overrides: Partial<CalendarAppointmentRow> & { id: string; due_at: string },
): CalendarAppointmentRow {
  return {
    title: "Appointment",
    description: null,
    end_at: new Date(
      new Date(overrides.due_at).getTime() + 30 * 60 * 1000,
    ).toISOString(),
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

// Built by the PRODUCTION resolver (Codex round 1: the earlier local
// duplicate of the cell-count formula could never catch a resolver bug).
const DAYS = resolveMonth("2026-08-14", CHI).days;
const dayHref = (date: string) => `/calendar?view=week&week=${date}`;

function renderGrid(
  appointments: CalendarAppointmentRow[] = [],
  assignees: Record<string, string> = {},
  overrides: Partial<ComponentProps<typeof MonthGrid>> = {},
) {
  return render(
    <MonthGrid
      days={DAYS}
      appointments={appointments}
      timezone={CHI}
      viewerRole="owner"
      assignees={assignees}
      currentUserId="user-1"
      month="2026-08"
      nowMs={Date.now()}
      todayKey={dateKeyInZone(new Date(), CHI)}
      dayHref={dayHref}
      {...overrides}
    />,
  );
}

describe("<MonthGrid />", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a full padded grid (Aug 2026 in Chicago = 6 rows / 42 cells) with outside-month cells muted", () => {
    renderGrid();
    // Aug 1 2026 is a Saturday -> 6 leading July cells; 42 cells total.
    expect(DAYS).toHaveLength(42);
    for (const day of DAYS) {
      expect(
        screen.getByTestId(`calendar-month-cell-${day.date}`),
      ).toBeInTheDocument();
    }
    expect(
      screen.getByTestId("calendar-month-cell-2026-07-26"),
    ).toHaveAttribute("data-outside-month");
    expect(
      screen.getByTestId("calendar-month-cell-2026-08-01"),
    ).not.toHaveAttribute("data-outside-month");
    expect(screen.getByTestId("calendar-month-cell-2026-08-01")).toHaveClass(
      "rounded-xl",
      "border",
      "min-h-[86px]",
    );
    expect(
      screen.getByTestId("calendar-month-cell-2026-08-01").parentElement,
    ).toHaveClass("gap-1.5");
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

  it("renders today as an inverted circle instead of changing the cell border", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T17:00:00.000Z"));
    renderGrid();

    const cell = screen.getByTestId("calendar-month-cell-2026-08-14");
    const dayLink = screen.getByTestId("calendar-month-day-link-2026-08-14");
    expect(cell).toHaveAttribute("data-today", "true");
    expect(dayLink).toHaveClass(
      "rounded-full",
      "bg-foreground",
      "text-background",
    );
    expect(dayLink).toHaveAttribute(
      "aria-label",
      "View week containing Friday, August 14, 2026",
    );
  });

  it("does not mark today when it appears only as an adjacent-month padding cell", () => {
    renderGrid([], {}, { month: "2026-08", todayKey: "2026-07-31" });

    expect(
      screen.getByTestId("calendar-month-cell-2026-07-31"),
    ).not.toHaveAttribute("data-today");
    expect(
      screen.getByTestId("calendar-month-day-link-2026-07-31"),
    ).not.toHaveClass("bg-foreground", "text-background");
  });

  it("collapses more than three appointments into a +N more link to that day's week view", () => {
    const base = new Date("2026-08-14T15:00:00Z").getTime();
    const appts = [0, 1, 2, 3, 4].map((i) =>
      makeAppt({
        id: `a${i}`,
        due_at: new Date(base + i * 3_600_000).toISOString(),
      }),
    );
    renderGrid(appts);
    expect(
      screen.getByTestId("calendar-month-appointment-a0"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("calendar-month-appointment-a2"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("calendar-month-appointment-a3"),
    ).not.toBeInTheDocument();
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
    expect(
      screen.getByTestId("calendar-month-day-link-2026-08-05"),
    ).toHaveAttribute("href", dayHref("2026-08-05"));
  });

  it("shares lifecycle-first visual tones while preserving link semantics", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T18:00:00.000Z"));
    renderGrid([
      makeAppt({
        id: "property",
        due_at: "2026-08-15T15:00:00.000Z",
        property_id: "property-1",
      }),
      makeAppt({
        id: "contact",
        due_at: "2026-08-15T16:00:00.000Z",
        contact_id: "contact-1",
      }),
      makeAppt({
        id: "personal",
        due_at: "2026-08-15T17:00:00.000Z",
      }),
      makeAppt({
        id: "past",
        due_at: "2026-08-14T15:00:00.000Z",
        property_id: "property-past",
      }),
      makeAppt({
        id: "completed",
        due_at: "2026-08-14T16:00:00.000Z",
        contact_id: "contact-completed",
        status: "completed",
      }),
    ]);

    expect(
      screen.getByTestId("calendar-month-appointment-property"),
    ).toHaveAttribute("data-appointment-tone", "property");
    expect(
      screen.getByTestId("calendar-month-appointment-contact"),
    ).toHaveAttribute("data-appointment-tone", "contact");
    expect(
      screen.getByTestId("calendar-month-appointment-personal"),
    ).toHaveAttribute("data-appointment-tone", "personal");
    expect(
      screen.getByTestId("calendar-month-appointment-past"),
    ).toHaveAttribute("data-appointment-tone", "needs_outcome");
    expect(
      screen.getByTestId("calendar-month-appointment-completed"),
    ).toHaveAttribute("data-appointment-tone", "completed");
    expect(
      screen.getByTestId("calendar-month-appointment-contact"),
    ).toHaveAttribute("href", "/messages?thread=contact-1");
  });

  it("labels every non-self appointment with its owner in the Everyone view (former teammates get the fallback)", () => {
    renderGrid(
      [
        makeAppt({ id: "mine", due_at: "2026-08-06T15:00:00.000Z" }),
        makeAppt({
          id: "teammate",
          due_at: "2026-08-06T16:00:00.000Z",
          assignee_id: "user-2",
        }),
        makeAppt({
          id: "former",
          due_at: "2026-08-06T17:00:00.000Z",
          assignee_id: "user-gone-12345678",
        }),
      ],
      { "user-2": "gretchen@bmhgroupkc.com" },
    );
    expect(
      screen.queryByTestId("calendar-month-owner-mine"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("calendar-month-owner-teammate"),
    ).toHaveTextContent("gretchen@bmhgroupkc.com");
    expect(screen.getByTestId("calendar-month-owner-former")).toHaveTextContent(
      "Former teammate (name unavailable)",
    );
  });
});
