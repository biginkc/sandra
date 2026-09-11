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
  DateTimeField,
  FieldError,
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
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] grid-rows-none flex-col overflow-hidden sm:max-w-xl">
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
                    setSource(event.target.value as AcquisitionAttemptSource)
                    clearClientErrors()
                  }}
                  className="border-input bg-background flex h-9 w-full rounded-lg border px-2.5 py-1.5 text-sm"
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
                    className="border-input bg-background flex h-9 w-full rounded-lg border px-2.5 py-1.5 text-sm"
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
                <Label htmlFor="acquisition-attempt-call-reference">Sandra call reference</Label>
                {callReferenceOptions.length > 0 ? (
                  <select
                    id="acquisition-attempt-call-reference"
                    aria-label="Sandra call reference"
                    value={callActivityId}
                    onChange={(event) => setCallActivityId(event.target.value)}
                    aria-invalid={Boolean(clientFieldErrors.callActivityId || submitState.fieldErrors.callActivityId)}
                    aria-required="true"
                    className="border-input bg-background flex h-9 w-full rounded-lg border px-2.5 py-1.5 text-sm"
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
                <FieldError message={clientFieldErrors.callActivityId || submitState.fieldErrors.callActivityId} />
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="acquisition-attempt-outcome">External outcome</Label>
              <select
                id="acquisition-attempt-outcome"
                value={outcome}
                onChange={(event) => setOutcome(event.target.value as AcquisitionAttemptFormPayload["outcome"])}
                aria-invalid={Boolean(clientFieldErrors.outcome || submitState.fieldErrors.outcome)}
                aria-required="true"
                className="border-input bg-background flex h-9 w-full rounded-lg border px-2.5 py-1.5 text-sm"
              >
                <option value="">Choose outcome</option>
                <option value="no_answer">No answer</option>
                <option value="reached">Reached</option>
                <option value="wrong_number">Wrong number</option>
              </select>
              <FieldError message={clientFieldErrors.outcome || submitState.fieldErrors.outcome} />
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
