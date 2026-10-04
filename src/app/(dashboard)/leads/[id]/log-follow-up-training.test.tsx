import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(), loadMyLeadRow: vi.fn(), loadMyLeadCallReferences: vi.fn(),
  submitMyLeadCommand: vi.fn(), submitMyLeadHandoffDrip: vi.fn(),
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock("@/app/(dashboard)/sequences/actions", () => ({ listDripChoices: vi.fn(async () => ({ ok: true, data: [] })), startDripForLeads: vi.fn() }))
vi.mock("@/app/(dashboard)/my-leads/actions", () => ({
  loadMyLeadRow: mocks.loadMyLeadRow, loadMyLeadCallReferences: mocks.loadMyLeadCallReferences,
  submitMyLeadCommand: mocks.submitMyLeadCommand, submitMyLeadHandoffDrip: mocks.submitMyLeadHandoffDrip,
}))

import { LogFollowUpProvider, LogFollowUpTrigger } from "./log-follow-up-button"

// The lead page wraps the trigger exactly like this for an internal training lead.
function page(training: boolean) {
  return (
    <LogFollowUpProvider propertyId="lead-1" propertyLabel="1 Main" assigneeId="rep-9" disabledReason={null} viewer={{ userId: "rep-9", orgId: "org-1" }}>
      <fieldset disabled={training} inert={training || undefined} className="contents"><LogFollowUpTrigger /></fieldset>
    </LogFollowUpProvider>
  )
}

describe("Log follow-up on a training lead", () => {
  beforeEach(() => { for (const m of Object.values(mocks)) m.mockReset() })

  it("the trigger is disabled and clicking it makes no lookup call", async () => {
    render(page(true))
    const button = screen.getByRole("button", { name: "Log follow-up" })
    expect(button).toBeDisabled()
    expect(button.closest("fieldset")).toHaveAttribute("inert")
    await userEvent.setup().click(button)
    expect(mocks.loadMyLeadRow).not.toHaveBeenCalled()
    expect(mocks.loadMyLeadCallReferences).not.toHaveBeenCalled()
    expect(mocks.submitMyLeadCommand).not.toHaveBeenCalled()
  })

  it("control: the same trigger on a normal lead does look the lead up", async () => {
    mocks.loadMyLeadRow.mockResolvedValue({ ok: true, lookup: { status: "unavailable", reason: "archived" } })
    render(page(false))
    await userEvent.setup().click(screen.getByRole("button", { name: "Log follow-up" }))
    expect(mocks.loadMyLeadRow).toHaveBeenCalledTimes(1)
  })
})
