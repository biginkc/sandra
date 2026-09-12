import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { AcquisitionAttemptDialog } from "./attempt-dialog"
import { AcquisitionLifecycleDialog } from "./lifecycle-dialog"
import { AcquisitionOfferDialog } from "./offer-dialog"
import { AcquisitionReadinessDialog } from "./readiness-dialog"
import type {
  AcquisitionFormSubmitResult,
} from "./types"

const baseProps = {
  open: true,
  propertyId: "property-1",
  propertyLabel: "123 Main Street",
  onOpenChange: vi.fn(),
}

describe("My Leads workflow dialogs", () => {
  it("requires motivation text or accepts the explicit No motivation provided response", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn(async () => ({ ok: true as const }))
    render(
      <AcquisitionReadinessDialog
        {...baseProps}
        onSubmit={onSubmit}
      />
    )

    await user.click(screen.getByRole("button", { name: "Save readiness" }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText("Specify the motivation or choose No motivation provided.")).toBeInTheDocument()
    expect(screen.getByLabelText("Motivation")).toHaveAttribute(
      "aria-describedby",
      "acquisition-motivation-text-error",
    )
    expect(screen.getByText("Specify the motivation or choose No motivation provided.")).toHaveAttribute(
      "id",
      "acquisition-motivation-text-error",
    )

    await user.click(screen.getByRole("radio", { name: "No motivation provided" }))
    await user.click(screen.getByRole("button", { name: "Save readiness" }))

    expect(onSubmit).toHaveBeenCalledWith({
      propertyId: "property-1",
      motivationResponse: { kind: "no_motivation", text: null },
      temperature: null,
    })
  })

  it("keeps temperature independent from a specified readiness response", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn(async () => ({ ok: true as const }))
    render(
      <AcquisitionReadinessDialog
        {...baseProps}
        onSubmit={onSubmit}
      />
    )

    await user.type(screen.getByLabelText("Motivation"), "Needs to sell before moving")
    await user.selectOptions(screen.getByLabelText("Temperature (optional)"), "hot")
    await user.click(screen.getByRole("button", { name: "Save readiness" }))

    expect(onSubmit).toHaveBeenCalledWith({
      propertyId: "property-1",
      motivationResponse: { kind: "specified", text: "Needs to sell before moving" },
      temperature: "hot",
    })
  })

  it("requires an offer follow-up and logs a positive amount without sending anything", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn(async () => ({ ok: true as const }))
    render(
      <AcquisitionOfferDialog
        {...baseProps}
        motivationRequired
        onSubmit={onSubmit}
      />
    )

    await user.type(screen.getByLabelText("Offer amount"), "125000.00")
    await user.selectOptions(screen.getByLabelText("Offer method"), "dropbox_sign")
    fireEvent.change(screen.getByLabelText("Offer sent"), { target: { value: "2026-09-12T09:00" } })
    await user.click(screen.getByRole("radio", { name: "No motivation provided" }))
    await user.click(screen.getByRole("button", { name: "Save offer" }))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText("Choose a date and time.")).toBeInTheDocument()
    expect(screen.getByLabelText("Required follow-up")).toHaveAttribute(
      "aria-describedby",
      "acquisition-offer-follow-up-at-error",
    )

    fireEvent.change(screen.getByLabelText("Required follow-up"), { target: { value: "2026-09-13T09:00" } })
    await user.click(screen.getByRole("button", { name: "Save offer" }))

    expect(onSubmit).toHaveBeenCalledWith({
      propertyId: "property-1",
      amountCents: 12_500_000,
      method: "dropbox_sign",
      sentAt: "2026-09-12T14:00:00.000Z",
      followUpAt: "2026-09-13T14:00:00.000Z",
      motivationResponse: { kind: "no_motivation", text: null },
      temperature: null,
    })
  })

  it("accepts an optional recording for a DialPad manual call", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn(async () => ({ ok: true as const }))
    render(
      <AcquisitionAttemptDialog
        {...baseProps}
        onSubmit={onSubmit}
      />
    )

    await user.selectOptions(screen.getByLabelText("External outcome"), "no_answer")
    fireEvent.change(screen.getByLabelText("When did the outreach occur?"), {
      target: { value: "2026-09-12T09:00" },
    })
    await user.click(screen.getByRole("button", { name: "Save attempt" }))

    expect(onSubmit).toHaveBeenCalledWith({
      propertyId: "property-1",
      kind: "call",
      source: "dialpad",
      outcome: "no_answer",
      occurredAt: "2026-09-12T14:00:00.000Z",
      note: null,
      recordingUrl: null,
      callActivityId: null,
    })
  })

  it("preserves fields after a failed submit and prevents duplicate requests", async () => {
    const user = userEvent.setup()
    let resolveSubmit!: (result: AcquisitionFormSubmitResult) => void
    const onSubmit = vi.fn(
      () =>
        new Promise<AcquisitionFormSubmitResult>((resolve) => {
          resolveSubmit = resolve
        })
    )
    render(
      <AcquisitionAttemptDialog
        {...baseProps}
        onSubmit={onSubmit}
      />
    )

    await user.selectOptions(screen.getByLabelText("External outcome"), "reached")
    fireEvent.change(screen.getByLabelText("When did the outreach occur?"), {
      target: { value: "2026-09-12T09:00" },
    })
    await user.type(screen.getByLabelText("Note (optional)"), "Seller asked for a callback")
    const saveButton = screen.getByRole("button", { name: "Save attempt" })
    await user.click(saveButton)
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())
    expect(saveButton).toBeDisabled()
    await user.click(saveButton)
    expect(onSubmit).toHaveBeenCalledOnce()

    resolveSubmit({
      ok: false,
      message: "The lead changed before this attempt was saved.",
      fieldErrors: { outcome: "Refresh the lead and try again." },
    })
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The lead changed before this attempt was saved."))
    expect(screen.getByLabelText("Note (optional)")).toHaveValue("Seller asked for a callback")
    expect(screen.getByText("Refresh the lead and try again.")).toBeInTheDocument()
    expect(screen.getByLabelText("External outcome")).toHaveAttribute(
      "aria-describedby",
      "acquisition-attempt-outcome-error",
    )
  })

  it("emits lifecycle payloads for contract, decline, handoff, and archive modes", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn(async () => ({ ok: true as const }))
    const { rerender } = render(
      <AcquisitionLifecycleDialog
        {...baseProps}
        mode="contract-signed"
        onSubmit={onSubmit}
      />
    )

    fireEvent.change(screen.getByLabelText("Signed at"), { target: { value: "2026-09-12T10:00" } })
    expect(screen.getByLabelText("Signed at")).toHaveValue("2026-09-12T10:00")
    fireEvent.change(screen.getByLabelText("Existing offer ID (optional)"), { target: { value: "offer-1" } })
    await user.click(screen.getByRole("button", { name: "Record contract" }))
    expect(onSubmit).toHaveBeenLastCalledWith({
      propertyId: "property-1",
      mode: "contract-signed",
      signedAt: "2026-09-12T15:00:00.000Z",
      offerId: "offer-1",
    })

    rerender(
      <AcquisitionLifecycleDialog
        {...baseProps}
        mode="decline-offer"
        pendingOfferId="offer-2"
        onSubmit={onSubmit}
      />
    )
    fireEvent.change(screen.getByLabelText("Declined at"), { target: { value: "2026-09-12T11:00" } })
    await user.click(screen.getByRole("button", { name: "Record decline" }))
    expect(onSubmit).toHaveBeenLastCalledWith({
      propertyId: "property-1",
      mode: "decline-offer",
      pendingOfferId: "offer-2",
      occurredAt: "2026-09-12T16:00:00.000Z",
    })

    rerender(
      <AcquisitionLifecycleDialog
        {...baseProps}
        mode="handoff"
        recipientOptions={[{ id: "jarrad", label: "Jarrad" }]}
        onSubmit={onSubmit}
      />
    )
    await user.selectOptions(screen.getByLabelText("Handoff reason"), "needs_nurture")
    await user.selectOptions(screen.getByLabelText("Reassign to"), "jarrad")
    await user.click(screen.getByRole("button", { name: "Hand off lead" }))
    expect(onSubmit).toHaveBeenLastCalledWith({
      propertyId: "property-1",
      mode: "handoff",
      reason: "needs_nurture",
      recipientUserId: "jarrad",
    })

    rerender(
      <AcquisitionLifecycleDialog
        {...baseProps}
        mode="archive"
        onSubmit={onSubmit}
      />
    )
    await user.click(screen.getByRole("checkbox"))
    await user.click(screen.getByRole("button", { name: "Archive lead" }))
    expect(onSubmit).toHaveBeenLastCalledWith({
      propertyId: "property-1",
      mode: "archive",
      confirmed: true,
    })
  })

  it("associates lifecycle validation errors with their controls", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn(async () => ({ ok: true as const }))
    render(
      <AcquisitionLifecycleDialog
        {...baseProps}
        mode="handoff"
        recipientOptions={[{ id: "jarrad", label: "Jarrad" }]}
        onSubmit={onSubmit}
      />,
    )

    await user.click(screen.getByRole("button", { name: "Hand off lead" }))

    expect(screen.getByLabelText("Handoff reason")).toHaveAttribute(
      "aria-describedby",
      "acquisition-handoff-reason-error",
    )
    expect(screen.getByLabelText("Reassign to")).toHaveAttribute(
      "aria-describedby",
      "acquisition-handoff-recipient-error",
    )
    expect(screen.getByText("Choose a handoff reason.")).toHaveAttribute(
      "id",
      "acquisition-handoff-reason-error",
    )
  })
})
