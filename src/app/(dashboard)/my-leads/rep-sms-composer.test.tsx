import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ load: vi.fn(), send: vi.fn(), acknowledge: vi.fn() }))
vi.mock("./sms-actions", () => ({ loadRepSmsContext: mocks.load, sendRepSms: mocks.send, acknowledgeRepSmsSubmission: mocks.acknowledge }))

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

const genericContext = () => ({ ...context("none"), obligation: null })

beforeEach(() => {
  vi.resetAllMocks()
  window.localStorage.clear()
  mocks.send.mockResolvedValue({ ok: true, data: { outcome: { status: "sent", messageId: "message-1", externalId: "provider-1" } } })
  mocks.acknowledge.mockResolvedValue({ ok: true, data: { ok: true, state: "accepted" } })
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

  it("locks a resumed obligation to its captured sender assignment and number", async () => {
    const data = context("failed_not_dispatched") as any
    data.senders = [
      ...data.senders,
      { id: "sender-2", number: "+18165550000", label: "Other", isDefault: true, provider: "sendillo", providerSenderId: "provider-sender-2", grantStatus: "active", compositionPolicyVersion: 1 },
    ]
    data.senders[0].isDefault = false
    mocks.load.mockResolvedValue({ ok: true, data })
    const user = userEvent.setup()
    render(<RepSmsComposer propertyId="property-1" />)
    await user.click(screen.getByRole("button", { name: "Text lead" }))

    const sender = await screen.findByLabelText("Send from")
    expect(sender).toHaveValue("sender-1")
    expect(sender).toBeDisabled()
    expect(screen.getByText("From:").parentElement).toHaveTextContent("+1 (816) 370-6846")
  })

  it("persists a generic submission key and reconciles it after a response-loss reload", async () => {
    mocks.load.mockResolvedValue({ ok: true, data: genericContext() })
    mocks.send.mockReset()
    mocks.send
      .mockResolvedValueOnce({ ok: true, data: { outcome: { status: "provider_unknown", messageId: "message-1", error: "receipt unavailable" } } })
      .mockResolvedValueOnce({ ok: true, data: { outcome: { status: "sent", messageId: "message-1", externalId: "provider-1" } } })
    const user = userEvent.setup()
    const first = render(<RepSmsComposer propertyId="property-1" />)
    await user.click(screen.getByRole("button", { name: "Text lead" }))
    const remainder = await screen.findByLabelText("Editable message remainder")
    await user.type(remainder, "Please text Maria a time that works.")
    await user.click(screen.getByRole("button", { name: "Send text" }))
    await waitFor(() => expect(screen.getByText("Pending reconciliation")).toBeInTheDocument())
    expect(remainder).toBeDisabled()
    const firstKey = mocks.send.mock.calls[0][0].idempotencyKey
    expect(firstKey).toMatch(/^[0-9a-f-]{36}$/i)
    expect(window.localStorage.getItem("sandra:rep-sms:submission:org-1:rep-1:property-1")).toContain(firstKey)

    first.unmount()
    render(<RepSmsComposer propertyId="property-1" />)
    await user.click(screen.getByRole("button", { name: "Text lead" }))
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Reconcile saved send" })).toHaveLength(1))
    expect(screen.getByLabelText("Editable message remainder")).toHaveValue("Please text Maria a time that works.")
    await user.click(screen.getByRole("button", { name: "Reconcile saved send" }))
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2))
    expect(mocks.send.mock.calls[1][0].idempotencyKey).toBe(firstKey)
    expect(window.localStorage.getItem("sandra:rep-sms:submission:org-1:rep-1:property-1")).toBeNull()
  })

  it("keeps the exact generic draft when the browser acknowledgement is lost", async () => {
    mocks.load.mockResolvedValue({ ok: true, data: genericContext() })
    mocks.send.mockResolvedValue({ ok: true, data: { outcome: { status: "sent", messageId: "message-1", externalId: "provider-1" } } })
    mocks.acknowledge.mockResolvedValue({ ok: false, error: { message: "acknowledgement unavailable" } })
    const user = userEvent.setup()
    render(<RepSmsComposer propertyId="property-1" />)
    await user.click(screen.getByRole("button", { name: "Text lead" }))
    const remainder = await screen.findByLabelText("Editable message remainder")
    await user.type(remainder, "Please text Maria a time that works.")
    await user.click(screen.getByRole("button", { name: "Send text" }))

    await waitFor(() => expect(screen.getByText(/could not record the acknowledgement/)).toBeInTheDocument())
    const key = mocks.send.mock.calls[0][0].idempotencyKey
    expect(mocks.acknowledge).toHaveBeenCalledWith({ propertyId: "property-1", idempotencyKey: key })
    expect(window.localStorage.getItem("sandra:rep-sms:submission:org-1:rep-1:property-1")).toContain(key)
    expect(screen.getByRole("button", { name: "Reconcile saved send" })).toBeInTheDocument()
  })

  it("restores the service-owned draft after browser storage loss and keeps its exact request", async () => {
    mocks.load.mockResolvedValueOnce({ ok: true, data: genericContext() })
    mocks.send.mockReset()
    mocks.send.mockResolvedValueOnce({
      ok: true,
      data: { outcome: { status: "provider_unknown", messageId: "receipt-1", error: "receipt unavailable" } },
    }).mockResolvedValueOnce({
      ok: true,
      data: { outcome: { status: "sent", messageId: "message-1", externalId: "provider-1" } },
    })
    const user = userEvent.setup()
    const first = render(<RepSmsComposer propertyId="property-1" />)
    await user.click(screen.getByRole("button", { name: "Text lead" }))
    const remainder = await screen.findByLabelText("Editable message remainder")
    await user.type(remainder, "Please text Maria a time that works.")
    await user.click(screen.getByRole("button", { name: "Send text" }))
    await waitFor(() => expect(screen.getByText("Pending reconciliation")).toBeInTheDocument())
    const firstRequest = mocks.send.mock.calls[0][0]
    const firstKey = firstRequest.idempotencyKey
    expect(firstKey).toMatch(/^[0-9a-f-]{36}$/i)

    // Simulate storage eviction or a private-browsing storage policy. The
    // server ledger remains authoritative and is supplied on the next load.
    window.localStorage.clear()
    first.unmount()
    mocks.load.mockResolvedValue({
      ok: true,
      data: {
        ...genericContext(),
        submission: {
          key: firstKey,
          receiptId: "receipt-1",
          state: "delivered",
          assignmentId: "sender-1",
          from: "+18163706846",
          to: "+18165550123",
          body: savedComposition.body,
          composition: savedComposition,
          providerMessageId: "provider-1",
          providerError: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    })
    render(<RepSmsComposer propertyId="property-1" />)
    await user.click(screen.getByRole("button", { name: "Text lead" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Reconcile saved send" })).toBeInTheDocument())
    expect(screen.getByLabelText("Editable message remainder")).toHaveValue(savedComposition.remainder)
    expect(screen.getByLabelText("Editable message remainder")).toBeDisabled()
    expect(screen.getByText("From:").parentElement).toHaveTextContent("+1 (816) 370-6846")
    await user.click(screen.getByRole("button", { name: "Reconcile saved send" }))
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2))
    expect(mocks.send.mock.calls[1][0]).toEqual(expect.objectContaining({
      idempotencyKey: firstKey,
      assignmentId: "sender-1",
      to: "+18165550123",
      composition: expect.objectContaining({ remainder: savedComposition.remainder }),
    }))
  })

  it("fails closed when a scoped saved send no longer has its exact sender assignment", async () => {
    const savedAt = Date.now()
    window.localStorage.setItem("sandra:rep-sms:submission:org-1:rep-1:property-1", JSON.stringify({
      key: "saved-key",
      orgId: "org-1",
      actorId: "rep-1",
      contactId: "contact-1",
      createdAt: savedAt,
      assignmentId: "sender-removed",
      from: "+18163706846",
      to: "+18165550123",
      composition: savedComposition,
    }))
    mocks.load.mockResolvedValue({ ok: true, data: genericContext() })
    const user = userEvent.setup()
    render(<RepSmsComposer propertyId="property-1" />)
    await user.click(screen.getByRole("button", { name: "Text lead" }))
    await waitFor(() => expect(screen.getByText(/exact texting number is no longer assigned/)).toBeVisible())
    expect(screen.getByRole("button", { name: "Send text" })).toBeDisabled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it("cleans an expired scoped saved send without restoring its body", async () => {
    window.localStorage.setItem("sandra:rep-sms:submission:org-1:rep-1:property-1", JSON.stringify({
      key: "expired-key",
      orgId: "org-1",
      actorId: "rep-1",
      contactId: "contact-1",
      createdAt: Date.now() - 25 * 60 * 60 * 1000,
      assignmentId: "sender-1",
      from: "+18163706846",
      to: "+18165550123",
      composition: savedComposition,
    }))
    mocks.load.mockResolvedValue({ ok: true, data: genericContext() })
    const user = userEvent.setup()
    render(<RepSmsComposer propertyId="property-1" />)
    await user.click(screen.getByRole("button", { name: "Text lead" }))
    const remainder = await screen.findByLabelText("Editable message remainder")
    expect(remainder).toHaveValue("")
    expect(window.localStorage.getItem("sandra:rep-sms:submission:org-1:rep-1:property-1")).toBeNull()
  })

  it("refreshes authoritative context after an obligation is accepted before a new manual send", async () => {
    mocks.load
      .mockResolvedValueOnce({ ok: true, data: context("failed_not_dispatched") })
      .mockResolvedValueOnce({ ok: true, data: genericContext() })
    const user = userEvent.setup()
    render(<RepSmsComposer propertyId="property-1" />)
    await user.click(screen.getByRole("button", { name: "Text lead" }))
    await screen.findByRole("button", { name: "Send resumed draft" })
    await user.click(screen.getByRole("button", { name: "Send resumed draft" }))
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2))
    const remainder = screen.getByLabelText("Editable message remainder")
    await user.type(remainder, "A new manual message after the saved follow-up.")
    await user.click(screen.getByRole("button", { name: "Send text" }))
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2))
    expect(mocks.send.mock.calls[0][0].obligationId).toBe("obligation-1")
    expect(mocks.send.mock.calls[1][0].obligationId).toBeNull()
    expect(mocks.send.mock.calls[1][0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i)
  })
})
