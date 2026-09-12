import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/appointments/appointment-outcome-row", () => ({
  AppointmentOutcomeRow: ({ taskId, assigneeId }: { taskId: string; assigneeId: string }) => (
    <div data-testid="shared-past-due-action">{taskId}:{assigneeId}</div>
  ),
  AppointmentUpcomingActions: ({ taskId, assigneeId }: { taskId: string; assigneeId: string }) => (
    <div data-testid="shared-upcoming-action">{taskId}:{assigneeId}</div>
  ),
}))

vi.mock("@/app/(dashboard)/dashboard/_components/task-actions-row", () => ({
  TaskActionsRow: ({ taskId }: { taskId: string }) => (
    <div data-testid="shared-task-action">{taskId}</div>
  ),
}))

import {
  MyLeadAppointmentActions,
  MyLeadCallbackActions,
} from "./existing-detail-actions"

describe("MyLeadAppointmentActions", () => {
  it("binds past-due rows to the shared outcome lifecycle", () => {
    render(
      <MyLeadAppointmentActions
        target={{ taskId: "task-1", assigneeId: "rep-1", state: "past_due" }}
      />
    )

    expect(screen.getByTestId("shared-past-due-action")).toHaveTextContent("task-1:rep-1")
    expect(screen.queryByTestId("shared-upcoming-action")).not.toBeInTheDocument()
  })

  it("binds future rows to the shared reschedule/cancel menu", () => {
    render(
      <MyLeadAppointmentActions
        target={{ taskId: "task-2", assigneeId: "rep-2", state: "upcoming" }}
      />
    )

    expect(screen.getByTestId("shared-upcoming-action")).toHaveTextContent("task-2:rep-2")
    expect(screen.queryByTestId("shared-past-due-action")).not.toBeInTheDocument()
  })

  it("binds callback rows to the shared Done/Snooze controls", () => {
    render(<MyLeadCallbackActions target={{ taskId: "callback-1" }} />)

    expect(screen.getByTestId("shared-task-action")).toHaveTextContent("callback-1")
  })
})
