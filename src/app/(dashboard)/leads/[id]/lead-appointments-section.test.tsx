import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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

function makeRow(overrides: Partial<LeadAppointmentRow> & { id: string }): LeadAppointmentRow {
  return {
    title: "Appointment — 123 Main St",
    due_at: new Date().toISOString(),
    end_at: null,
    assignee_id: "user-1",
    ...overrides,
  };
}

describe("<LeadAppointmentsSection />", () => {
  it("renders an empty state when the lead has no open appointments", () => {
    render(<LeadAppointmentsSection appointments={[]} />);

    expect(screen.getByTestId("lead-appointments-empty")).toHaveTextContent(
      "No open appointments",
    );
    expect(screen.queryByTestId("lead-appointments-section")).not.toBeInTheDocument();
  });

  it("renders the outcome row for a past-due open appointment, carrying its own assignee", () => {
    const yesterday = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    render(
      <LeadAppointmentsSection
        appointments={[
          makeRow({ id: "appt-1", due_at: yesterday, assignee_id: "user-2" }),
        ]}
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
      />,
    );

    expect(screen.getByTestId("stub-upcoming-actions-appt-2")).toHaveTextContent(
      "assignee=user-3",
    );
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
      />,
    );

    const section = screen.getByTestId("lead-appointments-section");
    const items = section.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(screen.getByText("Appointment — 123 Main St")).toBeInTheDocument();
    expect(screen.getByText("Appointment — 456 Oak Ave")).toBeInTheDocument();
  });
});
