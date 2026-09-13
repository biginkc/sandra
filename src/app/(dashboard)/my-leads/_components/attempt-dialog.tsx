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
  initialCallSource?: "sandra" | "dialpad"
  callReferenceOptions?: readonly AcquisitionCallReferenceOption[]
  callReferencesLoading?: boolean
  callReferencesError?: string | null
  onRetryCallReferences?: () => void
  onOpenChange: (open: boolean) => void
  onSubmit: AcquisitionSubmit<AcquisitionAttemptFormPayload>
}

export function AcquisitionAttemptDialog({
  open,
  propertyId,
  propertyLabel,
  initialCallActivityId = null,
  initialCallSource,
  callReferenceOptions = [],
  callReferencesLoading = false,
  callReferencesError = null,
  onRetryCallReferences,
  onOpenChange,
  onSubmit,
}: AcquisitionAttemptDialogProps) {
  const initialSource = initialCallSource ?? callReferenceOptions.find(call => call.id === initialCallActivityId)?.source ?? "sandra"
  const [selectedSource, setSource] = useState<AcquisitionAttemptSource | null>(null)
  const source = selectedSource ?? (initialCallActivityId ? initialSource : "dialpad")
  const awaitingInitialSource = Boolean(initialCallActivityId && !initialCallSource && callReferencesLoading && !callReferenceOptions.some(call => call.id === initialCallActivityId))
  const [kind, setKind] = useState<AcquisitionAttemptKind>("call")
  const [outcome, setOutcome] = useState<AcquisitionAttemptFormPayload["outcome"] | "">("")
  const [occurredAt, setOccurredAt] = useState("")
  const [note, setNote] = useState("")
  const [recordingUrl, setRecordingUrl] = useState("")
  const [callActivityId, setCallActivityId] = useState(initialCallActivityId || "")
  const availableCalls = initialCallActivityId && !awaitingInitialSource && !callReferenceOptions.some(call => call.id === initialCallActivityId)
    ? [{ id: initialCallActivityId, source: initialSource, label: `Selected ${initialSource === "sandra" ? "Sandra" : "DialPad"} call` }, ...callReferenceOptions]
    : callReferenceOptions
  const sandraAvailable = availableCalls.some(call => (call.source ?? "sandra") === "sandra")
  const sourceCalls = availableCalls.filter(call => (call.source ?? "sandra") === source)
  const sourceLabel = source === "sandra" ? "Sandra" : "DialPad"
  const [clientError, setClientError] = useState<string | null>(null)
  const [clientFieldErrors, setClientFieldErrors] = useState<Record<string, string>>({})
  const resetFields = () => {
    setSource(null)
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
    if (selectedSource === null && awaitingInitialSource) nextFieldErrors.callActivityId = "Wait for the selected call to finish loading."
    if (!outcome) nextFieldErrors.outcome = "Choose the external outcome."
    if ((source === "sandra" || (source === "dialpad" && callActivityId)) && !sourceCalls.some(call => call.id === callActivityId)) {
      nextFieldErrors.callActivityId = `Choose the ${sourceLabel} call you want to record an outcome for.`
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
      callActivityId: source !== "manual" ? callActivityId.trim() || null : null,
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
                    if (nextSource === "sandra" && !sandraAvailable) return
                    setSource(nextSource)
                    const nextCalls = availableCalls.filter(call => (call.source ?? "sandra") === nextSource)
                    setCallActivityId(nextSource === "sandra" && nextCalls.length === 1 ? nextCalls[0].id : "")
                    setKind(nextSource === "manual" ? "outreach" : "call")
                    clearClientErrors()
                  }}
                  className={SELECT_FIELD_CLASS}
                >
                  <option value="sandra" disabled={!sandraAvailable}>Sandra</option>
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
                  {source === "sandra" ? "Existing Sandra call" : callActivityId ? "Existing DialPad call" : "DialPad manual call"}
                </div>
              )}
            </div>

            <div className="text-sm text-muted-foreground">
              {callReferencesLoading ? (
                <p role="status">Loading calls… You can still log outreach made outside Sandra.</p>
              ) : callReferencesError ? (
                <div role="alert">
                  <p>Could not load calls. Retry to select a linked call.</p>
                  {onRetryCallReferences && <button type="button" className="mt-1 underline" onClick={onRetryCallReferences}>Retry loading calls</button>}
                </div>
              ) : availableCalls.length === 0 ? (
                <p>No Sandra calls need an outcome for this lead. Calls made in Sandra appear here automatically. For outreach made outside Sandra, choose DialPad or Manual outreach.</p>
              ) : (
                <p>Choose the source and select a pending call by date and time. DialPad also supports manual entries without a linked call.</p>
              )}
            </div>

            {(source === "sandra" || (source === "dialpad" && sourceCalls.length > 0)) && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center">
                  <Label htmlFor="acquisition-attempt-call-reference">{sourceLabel} call</Label>
                  {source === "sandra" && <RequiredHint />}
                </div>
                {sourceCalls.length > 0 ? (
                  <select
                    id="acquisition-attempt-call-reference"
                    aria-label={`${sourceLabel} call`}
                    value={callActivityId}
                    onChange={(event) => setCallActivityId(event.target.value)}
                    aria-invalid={Boolean(clientFieldErrors.callActivityId || submitState.fieldErrors.callActivityId)}
                    aria-describedby={clientFieldErrors.callActivityId || submitState.fieldErrors.callActivityId ? "acquisition-attempt-call-reference-error" : undefined}
                    aria-required={source === "sandra"}
                    className={SELECT_FIELD_CLASS}
                  >
                    <option value="">{source === "dialpad" ? "Manual call — no linked call" : "Choose a call"}</option>
                    {sourceCalls.map((reference) => (
                      <option key={reference.id} value={reference.id}>
                        {reference.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                    This call is no longer available. Close and reopen this dialog to refresh Sandra calls.
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
