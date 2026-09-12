import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { completeTaskAction, snoozeTaskAction, toast } = vi.hoisted(() => ({
  completeTaskAction: vi.fn(),
  snoozeTaskAction: vi.fn(),
  toast: { error: vi.fn() },
}))

vi.mock("../../tasks/actions", () => ({
  completeTaskAction,
  snoozeTaskAction,
}))

vi.mock("sonner", () => ({ toast }))

import { TaskActionsRow } from "./task-actions-row"

describe("TaskActionsRow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    completeTaskAction.mockResolvedValue({ ok: true, data: { id: "task-1" } })
    snoozeTaskAction.mockResolvedValue({ ok: true, data: { id: "task-1" } })
  })

  it("reports a confirmed completion to the owning detail surface", async () => {
    const user = userEvent.setup()
    const onChanged = vi.fn()
    render(<TaskActionsRow taskId="task-1" onChanged={onChanged} />)

    await user.click(screen.getByTestId("task-done-task-1"))

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ kind: "completed", taskId: "task-1" }))
    expect(completeTaskAction).toHaveBeenCalledWith("task-1")
  })

  it("does not report a failed completion", async () => {
    completeTaskAction.mockResolvedValueOnce({
      ok: false,
      error: { code: "TASK_COMPLETE_FAILED", message: "conflict" },
    })
    const user = userEvent.setup()
    const onChanged = vi.fn()
    render(<TaskActionsRow taskId="task-1" onChanged={onChanged} />)

    await user.click(screen.getByTestId("task-done-task-1"))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("conflict"))
    expect(onChanged).not.toHaveBeenCalled()
  })

  it("reports a confirmed snooze with the server action input", async () => {
    const user = userEvent.setup()
    const onChanged = vi.fn()
    render(<TaskActionsRow taskId="task-1" onChanged={onChanged} />)

    await user.click(screen.getByTestId("task-snooze-task-1"))
    await user.click(screen.getByTestId("task-snooze-1d-task-1"))

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ kind: "snoozed", taskId: "task-1", until: expect.any(String) })))
    expect(snoozeTaskAction).toHaveBeenCalledWith("task-1", expect.any(String))
  })
})
