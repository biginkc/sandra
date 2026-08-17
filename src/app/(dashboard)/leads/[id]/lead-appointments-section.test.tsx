import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LeadAppointmentsSection,
  type LeadAppointmentRow,
} from "./lead-appointments-section";

// Outcome/upcoming controls are covered in their own test file
// (appointment-outcome-row.test.tsx) — stub them here so this suite only
// asserts the section picks the right control per row and formats the
// row copy, not their internals.
vi.mock("@/components/appointments/appointment-outcome-row", () => ({
  AppointmentOutcomeRow: ({
    taskId,
    assigneeId,
  }: {
    taskId: string;
    assigneeId: string;
  }) => (
    <div data-testid={`stub-outcome-row-${taskId}`}>
      outcome row (assignee={assigneeId})
    </div>
  ),
  AppointmentUpcomingActions: ({
    taskId,
    assigneeId,
  }: {
    taskId: string;
    assigneeId: string;
  }) => (
    <div data-testid={`stub-upcoming-actions-${taskId}`}>
      upcoming actions (assignee={assigneeId})
    </div>
  ),
}));

function makeRow(
  overrides: Partial<LeadAppointmentRow> & { id: string },
): LeadAppointmentRow {
  return {
    title: "Appointment — 123 Main St",
    due_at: new Date().toISOString(),
    end_at: null,
    assignee_id: "user-1",
    ...overrides,
  };
}

const TZ = "America/Chicago";
const NOW_MS = new Date("2026-08-16T18:00:00.000Z").getTime();

describe("<LeadAppointmentsSection />", () => {
  it("renders an empty state when the lead has no open appointments", () => {
    render(
      <LeadAppointmentsSection
        appointments={[]}
        timezone={TZ}
        nowMs={NOW_MS}
      />,
    );

    expect(screen.getByTestId("lead-appointments-empty")).toHaveTextContent(
      "No open appointments",
    );
    expect(
      screen.queryByTestId("lead-appointments-section"),
    ).not.toBeInTheDocument();
  });

  it("renders the outcome row for a past-due open appointment, carrying its own assignee", () => {
    const yesterday = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    render(
      <LeadAppointmentsSection
        appointments={[
          makeRow({ id: "appt-1", due_at: yesterday, assignee_id: "user-2" }),
        ]}
        timezone={TZ}
        nowMs={Date.now()}
      />,
    );

    expect(screen.getByTestId("stub-outcome-row-appt-1")).toHaveTextContent(
      "assignee=user-2",
    );
    expect(
      screen.queryByTestId("stub-upcoming-actions-appt-1"),
    ).not.toBeInTheDocument();
  });

  it("renders the compact upcoming overflow for an appointment not yet due", () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    render(
      <LeadAppointmentsSection
        appointments={[
          makeRow({ id: "appt-2", due_at: tomorrow, assignee_id: "user-3" }),
        ]}
        timezone={TZ}
        nowMs={Date.now()}
      />,
    );

    expect(
      screen.getByTestId("stub-upcoming-actions-appt-2"),
    ).toHaveTextContent("assignee=user-3");
    expect(
      screen.queryByTestId("stub-outcome-row-appt-2"),
    ).not.toBeInTheDocument();
  });

  it("renders each appointment's title and lists multiple rows in order", () => {
    const now = Date.now();
    render(
      <LeadAppointmentsSection
        appointments={[
          makeRow({
            id: "appt-1",
            title: "Appointment — 123 Main St",
            due_at: new Date(now - 60 * 60 * 1000).toISOString(),
          }),
          makeRow({
            id: "appt-2",
            title: "Appointment — 456 Oak Ave",
            due_at: new Date(now + 60 * 60 * 1000).toISOString(),
          }),
        ]}
        timezone={TZ}
        nowMs={Date.now()}
      />,
    );

    const section = screen.getByTestId("lead-appointments-section");
    const items = section.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(screen.getByText("Appointment — 123 Main St")).toBeInTheDocument();
    expect(screen.getByText("Appointment — 456 Oak Ave")).toBeInTheDocument();
  });

  describe("device-timezone display (Codex round 3)", () => {
    const originalTz = process.env.TZ;

    beforeEach(() => {
      // Simulate a render environment (or a rep's device) whose local zone
      // differs from the viewer's saved `timezone` prop — without an
      // explicit `timeZone` in the Intl.DateTimeFormat calls, formatting
      // would silently follow this runtime zone instead of the prop.
      process.env.TZ = "America/New_York";
    });

    afterEach(() => {
      process.env.TZ = originalTz;
    });

    it("formats the appointment time in the passed timezone prop, not the runtime's local zone", () => {
      // 2026-01-15T17:30:00Z = 12:30 PM in America/Chicago, 9:30 AM in
      // America/Los_Angeles, 12:30 PM in America/New_York (the runtime
      // zone stubbed above) — three different clock times make it
      // unambiguous which zone actually rendered.
      const dueAt = "2026-01-15T17:30:00.000Z";
      render(
        <LeadAppointmentsSection
          appointments={[
            makeRow({ id: "appt-1", due_at: dueAt, end_at: null }),
          ]}
          timezone="America/Los_Angeles"
          nowMs={NOW_MS}
        />,
      );

      expect(screen.getByText(/9:30\s*AM/)).toBeInTheDocument();
      expect(screen.queryByText(/12:30\s*PM/)).not.toBeInTheDocument();
    });

    it("labels a fall-back offset transition even when the wall-clock end is later", () => {
      render(
        <LeadAppointmentsSection
          appointments={[
            makeRow({
              id: "appt-dst",
              due_at: "2026-11-01T06:30:00.000Z",
              end_at: "2026-11-01T08:00:00.000Z",
            }),
          ]}
          timezone={TZ}
          nowMs={NOW_MS}
        />,
      );

      expect(screen.getByText(/1:30 AM CDT–2:00 AM CST/)).toBeInTheDocument();
    });
  });
});
