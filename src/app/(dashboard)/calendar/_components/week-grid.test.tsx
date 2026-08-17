import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { wallTimeToUtc } from "@/lib/time/zoned";

import type { CalendarAppointmentRow } from "../types";

import { resolveWeek } from "../range";
import { WeekGrid } from "./week-grid";

const CHI = "America/Chicago";
const DAYS = resolveWeek("2026-08-19", CHI).days;

function at(date: string, time: string): string {
  const converted = wallTimeToUtc({ date, time, timeZone: CHI });
  if (!converted.ok) throw new Error("fixture conversion failed");
  return converted.utc.toISOString();
}

function makeAppt(
  overrides: Partial<CalendarAppointmentRow> & { id: string },
): CalendarAppointmentRow {
  return {
    title: "Seller walkthrough",
    description: null,
    due_at: at(DAYS[2].date, "09:00"),
    end_at: at(DAYS[2].date, "09:30"),
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

function renderWeek(
  appointments: CalendarAppointmentRow[] = [],
  todayKey = DAYS[3].date,
) {
  return render(
    <WeekGrid
      days={DAYS}
      appointments={appointments}
      timezone={CHI}
      viewerRole="owner"
      assignees={{
        "user-1": "Owner",
        "rep-1": "Hugo R.",
      }}
      currentUserId="user-1"
      nowMs={new Date(at(DAYS[2].date, "12:00")).getTime()}
      todayKey={todayKey}
    />,
  );
}

describe("<WeekGrid /> timeline", () => {
  it("renders the fixed 52px + seven-lane timeline with 11 hour rows", () => {
    renderWeek();

    expect(screen.getByTestId("calendar-week-grid")).toHaveTextContent("8 AM");
    expect(screen.getByTestId("calendar-week-grid")).toHaveTextContent("6 PM");
    expect(screen.getAllByTestId(/calendar-day-column-/)).toHaveLength(7);
    expect(screen.getAllByTestId(/calendar-day-header-/)).toHaveLength(7);
    expect(
      screen
        .getByTestId("calendar-week-grid")
        .querySelector(
          ".grid-cols-\\[52px_repeat\\(7\\,minmax\\(0\\,1fr\\)\\)\\]",
        ),
    ).not.toBeNull();
  });

  it("positions events from viewer-zone wall time and duration using the approved formula", () => {
    const oneHour = makeAppt({
      id: "one-hour",
      due_at: at(DAYS[2].date, "09:30"),
      end_at: at(DAYS[2].date, "10:30"),
      assignee_id: "rep-1",
    });
    const short = makeAppt({
      id: "short",
      due_at: at(DAYS[3].date, "08:00"),
      end_at: at(DAYS[3].date, "08:15"),
    });

    renderWeek([oneHour, short]);

    expect(screen.getByTestId("calendar-appointment-one-hour")).toHaveAttribute(
      "data-calendar-top",
      "66",
    );
    expect(screen.getByTestId("calendar-appointment-one-hour")).toHaveAttribute(
      "data-calendar-height",
      "40",
    );
    expect(screen.getByTestId("calendar-appointment-short")).toHaveAttribute(
      "data-calendar-top",
      "0",
    );
    expect(screen.getByTestId("calendar-appointment-short")).toHaveAttribute(
      "data-calendar-height",
      "36",
    );
    expect(
      screen.getByTestId("calendar-appointment-one-hour"),
    ).toHaveTextContent("9:30 AM");
    expect(
      screen.getByTestId("calendar-appointment-one-hour"),
    ).toHaveTextContent("Seller walkthrough");
    expect(
      screen.getByTestId("calendar-appointment-one-hour"),
    ).toHaveTextContent("Hugo R.");
    expect(screen.getByText("8:00 AM")).toHaveClass("leading-[10px]");
  });

  it("splits overlapping appointments into stable horizontal columns", () => {
    renderWeek([
      makeAppt({
        id: "overlap-a",
        due_at: at(DAYS[2].date, "09:00"),
        end_at: at(DAYS[2].date, "10:00"),
      }),
      makeAppt({
        id: "overlap-b",
        due_at: at(DAYS[2].date, "09:00"),
        end_at: at(DAYS[2].date, "10:00"),
      }),
      makeAppt({
        id: "overlap-c",
        due_at: at(DAYS[2].date, "09:30"),
        end_at: at(DAYS[2].date, "10:30"),
      }),
    ]);

    const events = ["overlap-a", "overlap-b", "overlap-c"].map((id) =>
      screen.getByTestId(`calendar-appointment-${id}`),
    );
    expect(events.map((event) => event.dataset.calendarColumn)).toEqual([
      "0",
      "1",
      "2",
    ]);
    for (const event of events) {
      expect(event).toHaveAttribute("data-calendar-column-count", "3");
      expect(event.style.width).toContain("33.3333%");
    }
  });

  it("splits back-to-back short appointments when their minimum rendered heights collide", () => {
    renderWeek([
      makeAppt({
        id: "short-a",
        due_at: at(DAYS[2].date, "08:00"),
        end_at: at(DAYS[2].date, "08:15"),
      }),
      makeAppt({
        id: "short-b",
        due_at: at(DAYS[2].date, "08:15"),
        end_at: at(DAYS[2].date, "08:30"),
      }),
    ]);

    expect(screen.getByTestId("calendar-appointment-short-a")).toHaveAttribute(
      "data-calendar-column-count",
      "2",
    );
    expect(screen.getByTestId("calendar-appointment-short-b")).toHaveAttribute(
      "data-calendar-column",
      "1",
    );
  });

  it("keeps early, late, and boundary-crossing appointments visible in an outside-hours rail", () => {
    const appointments = [
      makeAppt({
        id: "early",
        due_at: at(DAYS[1].date, "07:30"),
        end_at: at(DAYS[1].date, "08:30"),
      }),
      makeAppt({
        id: "late",
        due_at: at(DAYS[2].date, "19:00"),
        end_at: at(DAYS[2].date, "19:30"),
      }),
      makeAppt({
        id: "crosses-boundary",
        due_at: at(DAYS[3].date, "18:30"),
        end_at: at(DAYS[3].date, "19:30"),
      }),
    ];
    renderWeek(appointments);

    const rail = screen.getByTestId("calendar-outside-hours");
    expect(rail).toHaveTextContent("Outside hours");
    for (const appointment of appointments) {
      expect(rail).toContainElement(
        screen.getByTestId(`calendar-appointment-${appointment.id}`),
      );
    }
    expect(screen.getByTestId("calendar-appointment-early")).toHaveTextContent(
      "7:30 AM",
    );
    expect(screen.getByTestId("calendar-appointment-late")).toHaveTextContent(
      "7:00 PM",
    );
  });

  it("tints only the actual today lane and inverts its day number", () => {
    renderWeek([], DAYS[3].date);

    expect(
      screen.getByTestId(`calendar-day-column-${DAYS[3].date}`),
    ).toHaveAttribute("data-today", "true");
    expect(
      screen.getByTestId(`calendar-day-column-${DAYS[0].date}`),
    ).not.toHaveAttribute("data-today");
    expect(
      screen.getByTestId(`calendar-day-header-${DAYS[3].date}`).lastChild,
    ).toHaveClass("bg-foreground", "text-background");
  });

  it("preserves property/contact/personal, needs-outcome, completed, and DNC tones", () => {
    const futureStart = at(DAYS[2].date, "13:00");
    const futureEnd = at(DAYS[2].date, "13:30");
    const appointments = [
      makeAppt({
        id: "property",
        property_id: "prop-1",
        due_at: futureStart,
        end_at: futureEnd,
      }),
      makeAppt({
        id: "contact",
        contact_id: "contact-1",
        due_at: futureStart,
        end_at: futureEnd,
      }),
      makeAppt({
        id: "personal",
        due_at: futureStart,
        end_at: futureEnd,
      }),
      makeAppt({
        id: "needs",
        due_at: at(DAYS[2].date, "10:00"),
        end_at: at(DAYS[2].date, "10:30"),
      }),
      makeAppt({ id: "done", status: "completed", outcome: "held" }),
      makeAppt({ id: "locked", is_dnc_locked: true }),
    ];
    renderWeek(appointments);

    expect(screen.getByTestId("calendar-appointment-property")).toHaveAttribute(
      "data-appointment-tone",
      "property",
    );
    expect(screen.getByTestId("calendar-appointment-contact")).toHaveAttribute(
      "data-appointment-tone",
      "contact",
    );
    expect(screen.getByTestId("calendar-appointment-personal")).toHaveAttribute(
      "data-appointment-tone",
      "personal",
    );
    expect(screen.getByTestId("calendar-appointment-needs")).toHaveAttribute(
      "data-appointment-tone",
      "needs_outcome",
    );
    expect(screen.getByTestId("calendar-appointment-needs")).toHaveTextContent(
      "Needs outcome",
    );
    expect(screen.getByTestId("calendar-appointment-done")).toHaveAttribute(
      "data-appointment-tone",
      "completed",
    );
    expect(screen.getByTestId("calendar-appointment-locked")).toHaveAttribute(
      "data-appointment-tone",
      "dnc_locked",
    );
    expect(screen.getByTestId("calendar-appointment-locked")).toHaveTextContent(
      "Read-only · Do not contact",
    );
  });

  it("keeps property and contact click-throughs while personal blocks remain unlinked", () => {
    renderWeek([
      makeAppt({ id: "property", property_id: "prop-1" }),
      makeAppt({ id: "contact", contact_id: "contact-1" }),
      makeAppt({ id: "personal" }),
    ]);

    expect(
      screen.getByTestId("calendar-appointment-link-property"),
    ).toHaveAttribute("href", "/leads/prop-1");
    expect(
      screen.getByTestId("calendar-appointment-link-property"),
    ).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Tuesday, August 18, 2026"),
    );
    expect(
      screen.getByTestId("calendar-appointment-link-contact"),
    ).toHaveAttribute("href", "/messages?thread=contact-1");
    expect(
      screen.getByTestId("calendar-appointment-unlinked-personal"),
    ).toBeInTheDocument();
  });

  it("renders a full empty timeline without a false today marker for an offset week", () => {
    renderWeek([], "2099-01-01");

    expect(screen.getAllByTestId(/calendar-day-column-/)).toHaveLength(7);
    expect(
      screen
        .getAllByTestId(/calendar-day-column-/)
        .some((lane) => lane.hasAttribute("data-today")),
    ).toBe(false);
    expect(
      screen.queryByTestId(/calendar-appointment-/),
    ).not.toBeInTheDocument();
  });
});
