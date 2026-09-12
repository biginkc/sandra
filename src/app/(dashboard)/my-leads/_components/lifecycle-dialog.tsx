"use client"

import { useState, type FormEvent } from "react"

import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  DIALOG_CONTENT_CLASS,
  DateTimeField,
  FieldError,
  RequiredHint,
  SELECT_FIELD_CLASS,
  WorkflowDialogFooter,
  WorkflowDialogHeader,
  WorkflowFormError,
  centralDateTimeToIso,
  useAcquisitionSubmit,
} from "./workflow-form"
import type {
  AcquisitionFormSubmitResult,
  AcquisitionLifecycleFormPayload,
  AcquisitionLifecycleMode,
  AcquisitionSubmit,
} from "./types"

export type AcquisitionRecipientOption = {
  id: string
  label: string
}

export type AcquisitionLifecycleDialogProps = {
  open: boolean
  mode: AcquisitionLifecycleMode
  propertyId: string
  propertyLabel: string
  pendingOfferId?: string | null
  recipientOptions?: readonly AcquisitionRecipientOption[]
  initialRecipientUserId?: string
  onOpenChange: (open: boolean) => void
  onSubmit: AcquisitionSubmit<AcquisitionLifecycleFormPayload>
}

const COPY: Record<AcquisitionLifecycleMode, { title: string; description: string; submitLabel: string }> = {
  "contract-signed": {
    title: "Record contract signed",
    description: "Manually record the signed contract. This does not treat signing as a completed closing.",
    submitLabel: "Record contract",
  },
  "decline-offer": {
    title: "Record offer declined",
    description: "Record the declined offer, apply Needs sequence, and reassign the lead. Nothing is enrolled or scheduled automatically.",
    submitLabel: "Record decline",
  },
  handoff: {
    title: "Hand off lead",
    description: "Move this lead out of the active queue with an explicit Needs sequence decision.",
    submitLabel: "Hand off lead",
  },
  archive: {
    title: "Archive Under Contract lead",
    description: "Archive the queue entry while preserving its Under Contract history.",
    submitLabel: "Archive lead",
  },
}

export function AcquisitionLifecycleDialog({
  open,
  mode,
  propertyId,
  propertyLabel,
  pendingOfferId = null,
  recipientOptions = [],
  initialRecipientUserId = "",
  onOpenChange,
  onSubmit,
}: AcquisitionLifecycleDialogProps) {
  const [signedAt, setSignedAt] = useState("")
  const [declinedAt, setDeclinedAt] = useState("")
  const [offerId, setOfferId] = useState("")
  const [reason, setReason] = useState<"not_interested" | "needs_nurture" | "">("")
  const [recipientUserId, setRecipientUserId] = useState(initialRecipientUserId)
  const [confirmed, setConfirmed] = useState(false)
  const [clientError, setClientError] = useState<string | null>(null)
  const [clientFieldErrors, setClientFieldErrors] = useState<Record<string, string>>({})
  const resetFields = () => {
    setSignedAt("")
    setDeclinedAt("")
    setOfferId("")
    setReason("")
    setRecipientUserId(initialRecipientUserId)
    setConfirmed(false)
    setClientError(null)
    setClientFieldErrors({})
  }
  const submitState = useAcquisitionSubmit(onSubmit, () => {
    resetFields()
    onOpenChange(false)
  })
  const closeDialog = () => {
    if (submitState.submitting) return
    resetFields()
    submitState.clearErrors()
    onOpenChange(false)
  }

  const clearClientErrors = () => {
    setClientError(null)
    setClientFieldErrors({})
    submitState.clearErrors()
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitState.submitting) return
    clearClientErrors()
    const nextFieldErrors: Record<string, string> = {}

    if (mode === "contract-signed") {
      const converted = centralDateTimeToIso(signedAt)
      if (!converted.ok) nextFieldErrors.signedAt = converted.message
      if (Object.keys(nextFieldErrors).length > 0 || !converted.ok) {
        setClientError("Review the highlighted fields.")
        setClientFieldErrors(nextFieldErrors)
        return
      }
      await submitState.submit({
        propertyId,
        mode,
        signedAt: converted.value,
        offerId: offerId.trim() || null,
      })
      return
    }

    if (mode === "decline-offer") {
      if (!pendingOfferId) nextFieldErrors.pendingOfferId = "No pending offer is available to decline."
      const converted = centralDateTimeToIso(declinedAt)
      if (!converted.ok) nextFieldErrors.occurredAt = converted.message
      if (Object.keys(nextFieldErrors).length > 0 || !pendingOfferId || !converted.ok) {
        setClientError("Review the highlighted fields.")
        setClientFieldErrors(nextFieldErrors)
        return
      }
      await submitState.submit({
        propertyId,
        mode,
        pendingOfferId,
        occurredAt: converted.value,
      })
      return
    }

    if (mode === "handoff") {
      if (!reason) nextFieldErrors.reason = "Choose a handoff reason."
      if (!recipientUserId) nextFieldErrors.recipientUserId = "Choose the configured recipient."
      if (Object.keys(nextFieldErrors).length > 0 || !reason || !recipientUserId) {
        setClientError("Review the highlighted fields.")
        setClientFieldErrors(nextFieldErrors)
        return
      }
      await submitState.submit({
        propertyId,
        mode,
        reason,
        recipientUserId,
      })
      return
    }

    if (!confirmed) nextFieldErrors.confirmed = "Confirm that you want to archive this queue entry."
    if (Object.keys(nextFieldErrors).length > 0) {
      setClientError("Review the highlighted fields.")
      setClientFieldErrors(nextFieldErrors)
      return
    }
    await submitState.submit({ propertyId, mode, confirmed: true })
  }

  const fieldError = (field: string) => clientFieldErrors[field] || submitState.fieldErrors[field]
  const copy = COPY[mode]

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) onOpenChange(true)
        else closeDialog()
      }}
    >
      <DialogContent
        className={`flex max-h-[calc(100dvh-2rem)] grid-rows-none flex-col overflow-hidden ${DIALOG_CONTENT_CLASS}`}
      >
        <WorkflowDialogHeader title={copy.title} description={`${copy.description} (${propertyLabel})`} />
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
            <WorkflowFormError message={clientError || submitState.error} />

            {mode === "contract-signed" && (
              <>
                <DateTimeField
                  id="acquisition-contract-signed-at"
                  label="Signed at"
                  value={signedAt}
                  onChange={setSignedAt}
                  error={fieldError("signedAt")}
                />
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="acquisition-contract-offer-id">Existing offer ID (optional)</Label>
                  <input
                    id="acquisition-contract-offer-id"
                    value={offerId}
                    onChange={(event) => setOfferId(event.target.value)}
                    placeholder="Leave blank if there is no matching offer"
                    className="border-input bg-background flex h-[38px] w-full rounded-[12px] border px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  />
                </div>
              </>
            )}

            {mode === "decline-offer" && (
              <>
                <div className="rounded-[12px] border border-border bg-muted/30 px-3 py-2 text-sm">
                  <p className="font-medium">Current pending offer</p>
                  <p className="mt-1 break-all text-muted-foreground">
                    {pendingOfferId || "No pending offer is available."}
                  </p>
                </div>
                <FieldError id="acquisition-offer-pending-id-error" message={fieldError("pendingOfferId")} />
                <DateTimeField
                  id="acquisition-offer-declined-at"
                  label="Declined at"
                  value={declinedAt}
                  onChange={setDeclinedAt}
                  error={fieldError("occurredAt")}
                />
              </>
            )}

            {mode === "handoff" && (
              <>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center">
                    <Label htmlFor="acquisition-handoff-reason">Handoff reason</Label>
                    <RequiredHint />
                  </div>
                  <select
                    id="acquisition-handoff-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value as typeof reason)}
                    aria-invalid={Boolean(fieldError("reason"))}
                    aria-describedby={fieldError("reason") ? "acquisition-handoff-reason-error" : undefined}
                    className={SELECT_FIELD_CLASS}
                  >
                    <option value="">Choose reason</option>
                    <option value="not_interested">Not interested</option>
                    <option value="needs_nurture">Needs nurture</option>
                  </select>
                  <FieldError id="acquisition-handoff-reason-error" message={fieldError("reason")} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center">
                    <Label htmlFor="acquisition-handoff-recipient">Reassign to</Label>
                    <RequiredHint />
                  </div>
                  <select
                    id="acquisition-handoff-recipient"
                    value={recipientUserId}
                    onChange={(event) => setRecipientUserId(event.target.value)}
                    aria-invalid={Boolean(fieldError("recipientUserId"))}
                    aria-describedby={fieldError("recipientUserId") ? "acquisition-handoff-recipient-error" : undefined}
                    className={SELECT_FIELD_CLASS}
                  >
                    <option value="">Choose configured recipient</option>
                    {recipientOptions.map((recipient) => (
                      <option key={recipient.id} value={recipient.id}>
                        {recipient.label}
                      </option>
                    ))}
                  </select>
                  <FieldError id="acquisition-handoff-recipient-error" message={fieldError("recipientUserId")} />
                  <p className="text-xs text-muted-foreground">The parent action supplies the authorized same-org recipient list.</p>
                </div>
              </>
            )}

            {mode === "archive" && (
              <label className="flex items-start gap-2 rounded-[12px] border border-border p-3 text-sm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  aria-invalid={Boolean(fieldError("confirmed"))}
                  aria-describedby={fieldError("confirmed") ? "acquisition-archive-confirmed-error" : undefined}
                  className="mt-0.5"
                />
                <span>I understand this archives the queue entry and preserves its Under Contract history.</span>
              </label>
            )}
            <FieldError id="acquisition-archive-confirmed-error" message={fieldError("confirmed")} />
          </div>
          <WorkflowDialogFooter
            submitting={submitState.submitting}
            submitLabel={copy.submitLabel}
            onCancel={closeDialog}
            destructive={mode === "decline-offer" || mode === "archive"}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

export type AcquisitionLifecycleSubmitResult = AcquisitionFormSubmitResult
