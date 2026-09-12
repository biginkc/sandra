"use client"

import { useState, type FormEvent } from "react"

import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  DIALOG_CONTENT_CLASS,
  DateTimeField,
  FieldError,
  RequiredHint,
  SELECT_FIELD_CLASS,
  TEXT_FIELD_CLASS,
  WorkflowDialogFooter,
  WorkflowDialogHeader,
  WorkflowFormError,
  centralDateTimeToIso,
  useAcquisitionSubmit,
} from "./workflow-form"
import type {
  AcquisitionAttemptFormPayload,
  AcquisitionAttemptKind,
  AcquisitionAttemptSource,
  AcquisitionCallReferenceOption,
  AcquisitionFormSubmitResult,
  AcquisitionSubmit,
} from "./types"

export type AcquisitionAttemptDialogProps = {
  open: boolean
  propertyId: string
  propertyLabel: string
  initialCallActivityId?: string | null
  callReferenceOptions?: readonly AcquisitionCallReferenceOption[]
  onOpenChange: (open: boolean) => void
  onSubmit: AcquisitionSubmit<AcquisitionAttemptFormPayload>
}

export function AcquisitionAttemptDialog({
  open,
  propertyId,
  propertyLabel,
  initialCallActivityId = null,
  callReferenceOptions = [],
  onOpenChange,
  onSubmit,
}: AcquisitionAttemptDialogProps) {
  const [source, setSource] = useState<AcquisitionAttemptSource>("dialpad")
  const [kind, setKind] = useState<AcquisitionAttemptKind>("call")
  const [outcome, setOutcome] = useState<AcquisitionAttemptFormPayload["outcome"] | "">("")
  const [occurredAt, setOccurredAt] = useState("")
  const [note, setNote] = useState("")
  const [recordingUrl, setRecordingUrl] = useState("")
  const [callActivityId, setCallActivityId] = useState(initialCallActivityId || "")
  const [clientError, setClientError] = useState<string | null>(null)
  const [clientFieldErrors, setClientFieldErrors] = useState<Record<string, string>>({})
  const resetFields = () => {
    setSource(initialCallActivityId ? "sandra" : "dialpad")
    setKind("call")
    setOutcome("")
    setOccurredAt("")
    setNote("")
    setRecordingUrl("")
    setCallActivityId(initialCallActivityId || "")
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
    if (!outcome) nextFieldErrors.outcome = "Choose the external outcome."
    if (source === "sandra" && !callActivityId.trim()) {
      nextFieldErrors.callActivityId = "Enter the existing Sandra call reference."
    }
    const occurred = centralDateTimeToIso(occurredAt)
    if (!occurred.ok) nextFieldErrors.occurredAt = occurred.message
    if (Object.keys(nextFieldErrors).length > 0 || !outcome || !occurred.ok) {
      setClientFieldErrors(nextFieldErrors)
      setClientError("Review the highlighted fields.")
      return
    }

    await submitState.submit({
      propertyId,
      kind: source === "manual" ? kind : "call",
      source,
      outcome,
      occurredAt: occurred.value,
      note: note.trim() || null,
      recordingUrl: recordingUrl.trim() || null,
      callActivityId: source === "sandra" ? callActivityId.trim() : null,
    })
  }

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
        <WorkflowDialogHeader
          title="Log an attempt"
          description={`Record the external outcome for ${propertyLabel}. Opening this dialog does not count as a call.`}
        />
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
            <WorkflowFormError message={clientError || submitState.error} />

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="acquisition-attempt-source">Source</Label>
                <select
                  id="acquisition-attempt-source"
                  value={source}
                  onChange={(event) => {
                    const nextSource = event.target.value as AcquisitionAttemptSource
                    setSource(nextSource)
                    setKind(nextSource === "manual" ? "outreach" : "call")
                    clearClientErrors()
                  }}
                  className={SELECT_FIELD_CLASS}
                >
                  <option value="sandra">Sandra</option>
                  <option value="dialpad">DialPad</option>
                  <option value="manual">Manual outreach</option>
                </select>
              </div>

              {source === "manual" ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="acquisition-attempt-kind">Kind</Label>
                  <select
                    id="acquisition-attempt-kind"
                    value={kind}
                    onChange={(event) => setKind(event.target.value as AcquisitionAttemptKind)}
                    className={SELECT_FIELD_CLASS}
                  >
                    <option value="outreach">Other outreach</option>
                    <option value="call">Call</option>
                  </select>
                </div>
              ) : (
                <div className="flex flex-col justify-end gap-1.5 text-sm text-muted-foreground">
                  {source === "sandra" ? "Existing Sandra call" : "DialPad manual call"}
                </div>
              )}
            </div>

            {source === "sandra" && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center">
                  <Label htmlFor="acquisition-attempt-call-reference">Sandra call reference</Label>
                  <RequiredHint />
                </div>
                {callReferenceOptions.length > 0 ? (
                  <select
                    id="acquisition-attempt-call-reference"
                    aria-label="Sandra call reference"
                    value={callActivityId}
                    onChange={(event) => setCallActivityId(event.target.value)}
                    aria-invalid={Boolean(clientFieldErrors.callActivityId || submitState.fieldErrors.callActivityId)}
                    aria-describedby={clientFieldErrors.callActivityId || submitState.fieldErrors.callActivityId ? "acquisition-attempt-call-reference-error" : undefined}
                    aria-required="true"
                    className={SELECT_FIELD_CLASS}
                  >
                    <option value="">Choose verified call</option>
                    {callReferenceOptions.map((reference) => (
                      <option key={reference.id} value={reference.id}>
                        {reference.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                    A verified Sandra call reference must be supplied by the call flow.
                  </p>
                )}
                <FieldError id="acquisition-attempt-call-reference-error" message={clientFieldErrors.callActivityId || submitState.fieldErrors.callActivityId} />
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center">
                <Label htmlFor="acquisition-attempt-outcome">External outcome</Label>
                <RequiredHint />
              </div>
              <select
                id="acquisition-attempt-outcome"
                value={outcome}
                onChange={(event) => setOutcome(event.target.value as AcquisitionAttemptFormPayload["outcome"])}
                aria-invalid={Boolean(clientFieldErrors.outcome || submitState.fieldErrors.outcome)}
                aria-describedby={clientFieldErrors.outcome || submitState.fieldErrors.outcome ? "acquisition-attempt-outcome-error" : undefined}
                aria-required="true"
                className={SELECT_FIELD_CLASS}
              >
                <option value="">Choose outcome</option>
                <option value="no_answer">No answer</option>
                <option value="reached">Reached</option>
                <option value="wrong_number">Wrong number</option>
              </select>
              <FieldError id="acquisition-attempt-outcome-error" message={clientFieldErrors.outcome || submitState.fieldErrors.outcome} />
            </div>

            <DateTimeField
              id="acquisition-attempt-occurred-at"
              label="When did the outreach occur?"
              value={occurredAt}
              onChange={setOccurredAt}
              error={clientFieldErrors.occurredAt || submitState.fieldErrors.occurredAt}
            />

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="acquisition-attempt-recording">Recording link (optional)</Label>
              <Input
                id="acquisition-attempt-recording"
                type="url"
                value={recordingUrl}
                onChange={(event) => setRecordingUrl(event.target.value)}
                placeholder="https://…"
                className={TEXT_FIELD_CLASS}
              />
              <p className="text-xs text-muted-foreground">Recording links are optional for Sandra and DialPad.</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="acquisition-attempt-note">Note (optional)</Label>
              <Textarea
                id="acquisition-attempt-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Add context for the next rep"
                rows={3}
                className={TEXT_FIELD_CLASS}
              />
            </div>
          </div>
          <WorkflowDialogFooter
            submitting={submitState.submitting}
            submitLabel="Save attempt"
            onCancel={closeDialog}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

export type AcquisitionAttemptSubmitResult = AcquisitionFormSubmitResult
