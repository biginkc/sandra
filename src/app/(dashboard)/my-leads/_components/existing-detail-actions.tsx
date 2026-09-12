"use client"

import {
  AppointmentOutcomeRow,
  AppointmentUpcomingActions,
  type AppointmentLifecycleChange,
} from "@/components/appointments/appointment-outcome-row"
import {
  TaskActionsRow,
  type TaskActionChange,
} from "@/app/(dashboard)/dashboard/_components/task-actions-row"

import type {
  MyLeadAppointmentActionTarget,
  MyLeadCallbackActionTarget,
} from "./types"

/**
 * Reuses Sandra's canonical appointment controls. The target is server-shaped
 * so this surface never guesses an assignee or turns a callback task into an
 * appointment lifecycle mutation.
 */
export function MyLeadAppointmentActions({
  target,
  onChanged,
}: {
  target: MyLeadAppointmentActionTarget
  onChanged?: (change: AppointmentLifecycleChange) => void
}) {
  if (target.state === "past_due") {
    return (
      <AppointmentOutcomeRow
        taskId={target.taskId}
        assigneeId={target.assigneeId}
        onChanged={onChanged}
      />
    )
  }

  return (
    <AppointmentUpcomingActions
      taskId={target.taskId}
      assigneeId={target.assigneeId}
      onChanged={onChanged}
    />
  )
}

/**
 * Reuses Sandra's generic Done/Snooze controls for callback tasks. The
 * server-shaped target keeps the My Leads surface from inventing task state
 * or mutating a callback through the appointment lifecycle RPCs.
 */
export function MyLeadCallbackActions({
  target,
  onChanged,
}: {
  target: MyLeadCallbackActionTarget
  onChanged?: (change: TaskActionChange) => void
}) {
  return <TaskActionsRow taskId={target.taskId} onChanged={onChanged} />
}
