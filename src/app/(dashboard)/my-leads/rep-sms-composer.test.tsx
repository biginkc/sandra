import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ load: vi.fn(), send: vi.fn() }))
vi.mock("./sms-actions", () => ({ loadRepSmsContext: mocks.load, sendRepSms: mocks.send }))

import { RepSmsComposer } from "./rep-sms-composer"

const savedComposition = {
  policyVersion: 1,
  introId: "mel-maria-assistant-1",
  introVersion: 1,
  templateId: "no-answer-callback-time",
  templateVersion: 1,
  initialRemainder: "Maria wasn't able to reach you. What time would work for her to call you back?",
  remainder: "Please text Maria a time that works.",
  body: "Hey, this is Mel, Maria's assistant.\n\nPlease text Maria a time that works.",
}

const context = (status: string) => ({
  orgId: "org-1",
  actorId: "rep-1",
  contactId: "contact-1",
  phone: "+18165550123",
  provider: "sendillo",
  senders: [{ id: "sender-1", number: "+18163706846", label: "Mel", isDefault: true, provider: "sendillo", providerSenderId: "provider-sender-1", grantStatus: "active", compositionPolicyVersion: 1 }],
  obligation: { id: "obligation-1", attemptId: "attempt-1", status, messageBody: savedComposition.body, composition: savedComposition, blockedReason: status === "blocked" ? "sender_grant_missing" : null, senderAssignmentId: "sender-1", fromNumber: "+18163706846", toNumber: "+18165550123" },
})

beforeEach(() => {
  vi.resetAllMocks()
  mocks.send.mockResolvedValue({ ok: true, data: { outcome: { status: "sent", messageId: "message-1", externalId: "provider-1" } } })
})

describe("RepSmsComposer obligation resume", () => {
  it("restores a saved failed dispatch and submits its exact obligation", async () => {
    mocks.load.mockResolvedValue({ ok: true, data: context("failed_not_dispatched") })
    const user = userEvent.setup()
    render(<RepSmsComposer propertyId="property-1" />)
    await user.click(screen.getByRole("button", { name: "Text lead" }))
    await waitFor(() => expect(screen.getByLabelText("Editable message remainder")).toHaveValue(savedComposition.remainder))
    await user.click(screen.getByRole("button", { name: "Send resumed draft" }))
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      obligationId: "obligation-1",
      to: "+18165550123",
    })))
  })

  it("shows review-only state and prevents automatic retry", async () => {
    mocks.load.mockResolvedValue({ ok: true, data: context("unknown") })
    const user = userEvent.setup()
    render(<RepSmsComposer propertyId="property-1" replyToPhone="+18165550999" />)
    await user.click(screen.getByRole("button", { name: "Text lead" }))
    await waitFor(() => expect(screen.getByText(/Automatic retry is disabled/)).toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Send text" })).toBeDisabled()
    expect(screen.queryByRole("button", { name: "Resume draft" })).not.toBeInTheDocument()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it("shows pending reconciliation and does not offer a resume action for an ambiguous provider result", async () => {
    mocks.load.mockResolvedValue({ ok: true, data: context("required") })
    mocks.send.mockResolvedValueOnce({
      ok: true,
      data: {
        outcome: {
          status: "provider_unknown",
          messageId: "attempted-message",
          error: "The provider did not return a definitive receipt.",
        },
      },
    })
    const user = userEvent.setup()
    render(<RepSmsComposer propertyId="property-1" />)
    await user.click(screen.getByRole("button", { name: "Text lead" }))
    await waitFor(() => expect(screen.getByLabelText("Editable message remainder")).toHaveValue(savedComposition.remainder))

    await user.click(screen.getByRole("button", { name: "Send resumed draft" }))

    await waitFor(() => expect(screen.getByText("Pending reconciliation")).toBeInTheDocument())
    expect(screen.getByText(/Reconciliation is pending/)).toBeInTheDocument()
    expect(screen.getByLabelText("Editable message remainder")).toHaveValue(savedComposition.remainder)
    expect(screen.queryByRole("button", { name: "Resume draft" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Send text" })).toBeDisabled()
  })

  it("connects the required template error to its select", async () => {
    const data = context("required") as any
    data.obligation.composition = null
    mocks.load.mockResolvedValue({ ok: true, data })
    const user = userEvent.setup()
    render(<RepSmsComposer propertyId="property-1" />)
    await user.click(screen.getByRole("button", { name: "Text lead" }))

    const template = await screen.findByLabelText("Curated follow-up template")
    expect(template).toHaveAttribute("aria-describedby", "rep-sms-template-error-property-1")
    expect(screen.getByText(/Choose a follow-up template before sending/)).toBeInTheDocument()
  })
})
