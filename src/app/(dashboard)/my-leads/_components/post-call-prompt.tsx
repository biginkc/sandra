"use client"

import { useContext, useEffect, useRef, useState, type FormEvent } from "react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { StartDripPicker } from "@/components/sequences/start-drip-picker"
import { startDripForLeads, type DripChoice } from "@/app/(dashboard)/sequences/actions"
import { REP_SMS_ASSISTANT, REP_SMS_COMPOSITION_POLICY_VERSION } from "@/lib/messaging/rep-sms-composition"
import { suggestOutcome } from "@/lib/my-leads/outcome-suggestion"
import { quickPickDueAt, type QuickPick } from "@/lib/my-leads/quick-picks"
import { formatZonedDateTime } from "@/lib/time/zoned"
import {
  EMPTY_FOLLOW_UP_FIELDS,
  NoAnswerFollowUp,
  composeFollowUp,
  followUpFieldErrors,
  type FollowUpFields,
  type FollowUpState,
} from "./no-answer-follow-up"
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
  WorkflowRecoveryContext,
  centralDateTimeFromIso,
  centralDateTimeToIso,
  useAcquisitionSubmit,
} from "./workflow-form"
import type {
  AcquisitionAttemptFollowUp,
  AcquisitionAttemptFormPayload,
  AcquisitionAttemptKind,
  AcquisitionAttemptSource,
  AcquisitionCallReferenceOption,
  AcquisitionSubmit,
  PostCallExtras,
  PostCallExtrasState,
} from "./types"

const TIME_ZONE = "America/Chicago"

export type PromptOutcome = Extract<AcquisitionAttemptFormPayload["outcome"], "reached" | "no_answer" | "voicemail" | "wrong_number">
const OUTCOMES: { value: PromptOutcome; label: string }[] = [
  { value: "reached", label: "Reached" },
  { value: "no_answer", label: "No answer" },
  { value: "voicemail", label: "Voicemail" },
  { value: "wrong_number", label: "Wrong number" },
]
const PICKS: { value: QuickPick; label: string; testId: string }[] = [
  { value: "tomorrow", label: "Tomorrow", testId: "post-call-pick-tomorrow" },
  { value: "three_days", label: "3 days", testId: "post-call-pick-3-days" },
  { value: "next_week", label: "Next week", testId: "post-call-pick-next-week" },
]
type PickState = QuickPick | "custom" | null

export const acquisitionsManagerStorageKey = (userId: string) => `my-leads:acquisitions-manager:${userId}`

function readRememberedManager(userId: string | undefined): string | null {
  if (!userId) return null
  try {
    return window.localStorage.getItem(acquisitionsManagerStorageKey(userId))
  } catch {
    return null
  }
}
function rememberManager(userId: string | undefined, value: string) {
  if (!userId || !value.trim()) return
  try {
    window.localStorage.setItem(acquisitionsManagerStorageKey(userId), value.trim())
  } catch {
    // Storage is a convenience; the prompt works without it.
  }
}

export type PostCallPromptProps = {
  open: boolean
  propertyId: string
  propertyLabel: string
  initialCallActivityId?: string | null
  /** Pre-selected outcome (the auto-open prompt's guess from the Dialpad call); the rep can change it. */
  initialOutcome?: PromptOutcome | null
  callReferenceOptions?: readonly AcquisitionCallReferenceOption[]
  callReferencesLoading?: boolean
  callReferencesError?: string | null
  onRetryCallReferences?: () => void
  onDripChanged?: () => void
  previewDripChoices?: DripChoice[]
  onOpenChange: (open: boolean) => void
  onSubmit: AcquisitionSubmit<AcquisitionAttemptFormPayload>
  /** The signed-in rep: keys the remembered acquisitions manager. */
  viewerUserId?: string
  /** The viewer's label from the roster; the acquisitions manager default. */
  viewerLabel?: string | null
  /** The lead's open next step time; a future one hides the "No next step yet" hint. */
  nextStepAt?: string | null
  /** Progress of the note and next step saved after the attempt. */
  extras?: PostCallExtrasState | null
  onRetryExtras?: () => void
  /** Ready to make an offer: the existing readiness dialog. */
  onReadyForOffer?: () => void
  /** Dead / Nurture: the existing handoff dialog (same required reason). */
  onDeadNurture?: () => void
  /** "dock" renders inline (no dialog) for the call screen. Default "dialog". */
  variant?: "dialog" | "dock"
}

export function PostCallPrompt({
  open,
  propertyId,
  propertyLabel,
  initialCallActivityId = null,
  initialOutcome = null,
  callReferenceOptions = [],
  callReferencesLoading = false,
  callReferencesError = null,
  onRetryCallReferences,
  onDripChanged,
  previewDripChoices,
  onOpenChange,
  onSubmit,
  viewerUserId,
  viewerLabel,
  nextStepAt = null,
  extras = null,
  onRetryExtras,
  onReadyForOffer,
  onDeadNurture,
  variant = "dialog",
}: PostCallPromptProps) {
  const [source, setSource] = useState<AcquisitionAttemptSource>(initialCallActivityId ? "sandra" : "dialpad")
  const [outcome, setOutcome] = useState<PromptOutcome | "">(initialOutcome ?? "")
  const outcomeTouched = useRef(false)
  const [occurredAt, setOccurredAt] = useState(() => centralDateTimeFromIso(new Date().toISOString()))
  const [note, setNote] = useState("")
  const [recordingUrl, setRecordingUrl] = useState("")
  const [callActivityId, setCallActivityId] = useState(initialCallActivityId || "")
  const [follow, setFollow] = useState<FollowUpFields>(() => ({
    ...EMPTY_FOLLOW_UP_FIELDS,
    acquisitionsManager: readRememberedManager(viewerUserId) ?? viewerLabel ?? "",
  }))
  const [followUpState, setFollowUpState] = useState<FollowUpState | null>(null)
  const [pick, setPick] = useState<PickState>(null)
  const [customAt, setCustomAt] = useState("")
  // One id per opening: the idempotency key of the note and the appointment.
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID())
  const [sentNextStepAt, setSentNextStepAt] = useState<string | null>(null)
  const [sentNote, setSentNote] = useState<string | null>(null)
  // Once the attempt is durably recorded the prompt is a receipt: its payload stays frozen so a
  // changed field cannot generate a second attempt with a new idempotency key.
  const [attemptRecorded, setAttemptRecorded] = useState(false)
  const [savedForDrip, setSavedForDrip] = useState(false)
  const [clientError, setClientError] = useState<string | null>(null)
  const [clientFieldErrors, setClientFieldErrors] = useState<Record<string, string>>({})
  const recovery = useContext(WorkflowRecoveryContext)
  const reconciliation = recovery?.reconciliation
  const reconciliationLocked = Boolean(reconciliation)
  const locked = attemptRecorded || reconciliationLocked
  const [openedAt] = useState(() => Date.now())
  const hasNextStep = nextStepAt !== null && Date.parse(nextStepAt) > openedAt

  const preservedCallId = reconciliationLocked && source !== "manual" && callActivityId && !callReferenceOptions.some((call) => call.id === callActivityId)
    ? callActivityId
    : null
  const availableCalls: AcquisitionCallReferenceOption[] = initialCallActivityId && !callReferenceOptions.some((call) => call.id === initialCallActivityId)
    ? [{ id: initialCallActivityId, label: "Selected Sandra call" }, ...callReferenceOptions]
    : preservedCallId
      ? [{ id: preservedCallId, label: "Original saved Sandra call" }, ...callReferenceOptions]
      : [...callReferenceOptions]
  const sandraAvailable = availableCalls.length > 0

  // Pre-guess the outcome from the linked call until the rep chooses one.
  useEffect(() => {
    if (outcomeTouched.current || reconciliationLocked || source !== "sandra") return
    const reference = callReferenceOptions.find((call) => call.id === callActivityId)
    if (!reference) return
    const guess = suggestOutcome({
      provider: reference.provider ?? null,
      callOutcome: reference.callOutcome ?? null,
      talkSeconds: reference.talkSeconds ?? null,
    })
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (guess) setOutcome(guess)
  }, [callReferenceOptions, callActivityId, source, reconciliationLocked])

  useEffect(() => {
    if (!reconciliation) return
    /* eslint-disable react-hooks/set-state-in-effect -- restores a frozen payload when a reconciliation starts, like the dialog this replaces */
    const payload = reconciliation.payload
    if (typeof payload.source === "string") setSource(payload.source as AcquisitionAttemptSource)
    if (typeof payload.outcome === "string") {
      outcomeTouched.current = true
      setOutcome(payload.outcome as PromptOutcome)
    }
    setOccurredAt(centralDateTimeFromIso(payload.occurredAt))
    setNote(typeof payload.note === "string" ? payload.note : "")
    setRecordingUrl(typeof payload.recordingUrl === "string" ? payload.recordingUrl : "")
    setCallActivityId(typeof payload.callActivityId === "string" ? payload.callActivityId : "")
    const followUp = payload.followUp && typeof payload.followUp === "object" && !Array.isArray(payload.followUp)
      ? payload.followUp as Record<string, unknown>
      : null
    setFollow(followUp
      ? {
          acquisitionsManager: typeof followUp.acquisitionsManager === "string" ? followUp.acquisitionsManager : REP_SMS_ASSISTANT,
          introId: typeof followUp.introId === "string" ? followUp.introId : EMPTY_FOLLOW_UP_FIELDS.introId,
          templateId: typeof followUp.templateId === "string" ? followUp.templateId : "",
          remainder: typeof followUp.remainder === "string" ? followUp.remainder : "",
        }
      : { ...EMPTY_FOLLOW_UP_FIELDS })
    setClientError(null)
    setClientFieldErrors({})
    setFollowUpState(null)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [reconciliation])

  const resetFields = () => {
    outcomeTouched.current = false
    setSource(initialCallActivityId ? "sandra" : "dialpad")
    setOutcome("")
    setOccurredAt(centralDateTimeFromIso(new Date().toISOString()))
    setNote("")
    setRecordingUrl("")
    setCallActivityId(initialCallActivityId || "")
    setFollow({ ...EMPTY_FOLLOW_UP_FIELDS, acquisitionsManager: readRememberedManager(viewerUserId) ?? viewerLabel ?? "" })
    setFollowUpState(null)
    setPick(null)
    setCustomAt("")
    setSubmissionId(crypto.randomUUID())
    setSentNextStepAt(null)
    setSentNote(null)
    setAttemptRecorded(false)
    setSavedForDrip(false)
    setClientError(null)
    setClientFieldErrors({})
  }

  const submitState = useAcquisitionSubmit(onSubmit, (result) => {
    if (result.ok && result.attemptRecorded) setAttemptRecorded(true)
    if (outcome === "no_answer") {
      const next: FollowUpState = result.ok && result.followUp
        ? result.followUp
        : { status: "required", message: "Attempt recorded. Follow-up still needs to be accepted or delivered." }
      setFollowUpState(next)
      if (next.status === "accepted" || next.status === "delivered") {
        setSavedForDrip(true)
      } else {
        setClientError(next.message ?? `Attempt recorded. Follow-up is ${next.status.replaceAll("_", " ")}. Your draft is retained.`)
      }
      return
    }
    setSavedForDrip(true)
  })

  const closeDialog = () => {
    if (submitState.submitting) return
    // A user-initiated close while a save is uncertain or already saved asks first.
    if (recovery && !recovery.confirmClose()) return
    resetFields()
    submitState.clearErrors()
    onOpenChange(false)
  }
  const clearClientErrors = () => {
    setClientError(null)
    setClientFieldErrors({})
    submitState.clearErrors()
    setFollowUpState(null)
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitState.submitting || attemptRecorded) return
    clearClientErrors()

    const fieldErrors: Record<string, string> = {}
    if (!outcome) fieldErrors.outcome = "Choose what happened on the call."
    if (source === "sandra" && !availableCalls.some((call) => call.id === callActivityId)) {
      fieldErrors.callActivityId = "Choose the Sandra call you want to record an outcome for."
    }
    if (outcome === "no_answer") Object.assign(fieldErrors, followUpFieldErrors(follow))
    // The occurred-at field exists only for manual sources; a linked call is recorded as now.
    let occurred: string = new Date().toISOString()
    if (source !== "sandra") {
      const converted = centralDateTimeToIso(occurredAt)
      if (!converted.ok) fieldErrors.occurredAt = converted.message
      else occurred = converted.value
    }
    // A quick pick is a computed time; "Pick" needs a time the rep actually chose.
    let nextStep: PostCallExtras["nextStep"] = null
    if (pick && pick !== "custom") {
      nextStep = { pick: pick === "tomorrow" ? "tomorrow" : pick === "three_days" ? "three_days" : "next_week", dueAt: quickPickDueAt(pick, new Date()).toISOString() }
    } else if (pick === "custom") {
      const converted = centralDateTimeToIso(customAt)
      if (!converted.ok) fieldErrors.nextStep = converted.message
      else if (Date.parse(converted.value) <= Date.now()) fieldErrors.nextStep = "Choose a time in the future."
      else nextStep = { pick: "custom", dueAt: converted.value }
    }
    if (Object.keys(fieldErrors).length > 0 || !outcome) {
      setClientFieldErrors(fieldErrors)
      setClientError("Review the highlighted fields.")
      return
    }

    const composed = outcome === "no_answer" ? composeFollowUp(follow) : null
    const selectedTemplateId = follow.templateId
    setSentNextStepAt(nextStep?.dueAt ?? null)
    setSentNote(note.trim() || null)
    if (outcome === "no_answer") rememberManager(viewerUserId, follow.acquisitionsManager)
    await submitState.submit({
      propertyId,
      kind: (source === "manual" ? "outreach" : "call") satisfies AcquisitionAttemptKind,
      source,
      outcome,
      occurredAt: occurred,
      // The note is written to lead_notes with the extras, not to the attempt.
      note: null,
      recordingUrl: source === "dialpad" ? recordingUrl.trim() || null : null,
      callActivityId: source !== "manual" ? callActivityId.trim() || null : null,
      ...(composed
        ? {
            smsBody: composed.finalBody,
            followUp: {
              policyVersion: REP_SMS_COMPOSITION_POLICY_VERSION,
              acquisitionsManager: composed.acquisitionsManager,
              introId: composed.introId,
              introVersion: composed.introVersion,
              templateId: composed.templateId ?? selectedTemplateId,
              templateVersion: composed.templateVersion ?? 0,
              initialRemainder: composed.initialRemainder,
              remainder: composed.remainder,
              body: composed.finalBody,
            } satisfies AcquisitionAttemptFollowUp,
          }
        : {}),
      postCall: { submissionId, note: note.trim() || null, nextStep },
    })
  }

  const pickedLabel = (() => {
    if (!pick) return null
    if (pick === "custom") {
      const converted = centralDateTimeToIso(customAt)
      return converted.ok ? formatZonedDateTime(new Date(converted.value), TIME_ZONE) : null
    }
    return formatZonedDateTime(quickPickDueAt(pick, new Date()), TIME_ZONE)
  })()

  const receipt = attemptRecorded || savedForDrip ? (
    <ReceiptLines extras={extras} sentNextStepAt={sentNextStepAt} note={sentNote} onRetry={onRetryExtras} />
  ) : null

  const manualSource = source !== "sandra"

  const promptBody = (
    <>
        {savedForDrip ? (
          <div className="space-y-4 overflow-y-auto">
            {receipt}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" data-testid="post-call-ready-for-offer" onClick={onReadyForOffer} disabled={!onReadyForOffer}>
                Ready to make an offer
              </Button>
              <Button type="button" variant="outline" size="sm" data-testid="post-call-dead-nurture" onClick={onDeadNurture} disabled={!onDeadNurture}>
                Dead / Nurture
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">Add to a drip (optional).</p>
            <StartDripPicker inline previewChoices={previewDripChoices} onChoose={async (sequenceId) => {
              const result = await startDripForLeads(sequenceId, [propertyId])
              if (!result.ok) return { status: "failed", reason: result.error.message }
              const item = result.data.results[0]
              if (item?.status === "enrolled") { onDripChanged?.(); onOpenChange(false); return { status: "enrolled", reason: item.reason } }
              return { status: item?.status ?? "failed", reason: item?.reason ?? "Could not start drip." }
            }} />
            <button type="button" className="text-sm underline" onClick={() => onOpenChange(false)}>Done without a drip</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
              <WorkflowFormError message={clientError || submitState.error} />
              {receipt}

              <div className="flex flex-col gap-1.5">
                <div className="flex items-center">
                  <Label id="post-call-outcome-label">What happened</Label>
                  <RequiredHint />
                </div>
                <div
                  role="radiogroup"
                  aria-labelledby="post-call-outcome-label"
                  aria-required="true"
                  aria-invalid={Boolean(clientFieldErrors.outcome || submitState.fieldErrors.outcome)}
                  data-testid="post-call-outcome"
                  className="grid grid-cols-2 gap-2"
                >
                  {OUTCOMES.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={outcome === option.value}
                      data-testid={`post-call-outcome-${option.value.replaceAll("_", "-")}`}
                      disabled={locked}
                      onClick={() => {
                        outcomeTouched.current = true
                        setOutcome(option.value)
                        clearClientErrors()
                      }}
                      className={`rounded-[12px] border px-3 py-2 text-sm font-medium transition-colors disabled:opacity-60 ${outcome === option.value ? "border-teal-700 bg-teal-50 text-teal-900 dark:bg-teal-950/40 dark:text-teal-100" : "border-border bg-background hover:bg-muted"}`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <FieldError id="post-call-outcome-error" message={clientFieldErrors.outcome || submitState.fieldErrors.outcome} />
              </div>

              {outcome === "no_answer" && (
                <NoAnswerFollowUp
                  fields={follow}
                  onChange={setFollow}
                  onEdited={clearClientErrors}
                  locked={locked}
                  errors={{
                    acquisitionsManager: clientFieldErrors.acquisitionsManager,
                    followUpTemplate: clientFieldErrors.followUpTemplate || submitState.fieldErrors.followUpTemplate,
                    followUpRemainder: clientFieldErrors.followUpRemainder || submitState.fieldErrors.followUpRemainder,
                  }}
                  state={followUpState}
                  attemptRecorded={attemptRecorded}
                />
              )}

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="post-call-note">Note (optional)</Label>
                <Textarea
                  id="post-call-note"
                  data-testid="post-call-note"
                  value={note}
                  disabled={locked}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Add context for the next rep"
                  rows={3}
                  maxLength={5000}
                  className={TEXT_FIELD_CLASS}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label id="post-call-next-label">Next step (optional)</Label>
                <div role="group" aria-labelledby="post-call-next-label" className="flex flex-wrap gap-2">
                  {PICKS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      data-testid={option.testId}
                      aria-pressed={pick === option.value}
                      disabled={locked}
                      onClick={() => { setPick(pick === option.value ? null : option.value); clearClientErrors() }}
                      className={`rounded-full border px-3 py-1.5 text-sm transition-colors disabled:opacity-60 ${pick === option.value ? "border-teal-700 bg-teal-50 text-teal-900 dark:bg-teal-950/40 dark:text-teal-100" : "border-border bg-background hover:bg-muted"}`}
                    >
                      {option.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    data-testid="post-call-pick-pick"
                    aria-pressed={pick === "custom"}
                    disabled={locked}
                    onClick={() => { setPick(pick === "custom" ? null : "custom"); clearClientErrors() }}
                    className={`rounded-full border px-3 py-1.5 text-sm transition-colors disabled:opacity-60 ${pick === "custom" ? "border-teal-700 bg-teal-50 text-teal-900 dark:bg-teal-950/40 dark:text-teal-100" : "border-border bg-background hover:bg-muted"}`}
                  >
                    Pick
                  </button>
                </div>
                {pick === "custom" && (
                  <DateTimeField
                    id="post-call-next-step-at"
                    label="Call again at"
                    value={customAt}
                    onChange={setCustomAt}
                    error={clientFieldErrors.nextStep}
                    disabled={locked}
                  />
                )}
                {pick && pick !== "custom" && <FieldError message={clientFieldErrors.nextStep} />}
                {pickedLabel ? (
                  <p className="text-xs text-muted-foreground">Phone appointment, {pickedLabel} Central.</p>
                ) : !hasNextStep ? (
                  <p className="text-xs text-muted-foreground" data-testid="post-call-no-next-step">No next step yet</p>
                ) : null}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="post-call-source">Where was this call?</Label>
                <select
                  id="post-call-source"
                  value={source}
                  disabled={locked}
                  onChange={(event) => {
                    const next = event.target.value as AcquisitionAttemptSource
                    if (next === "sandra" && !sandraAvailable) return
                    setSource(next)
                    if (next === "manual") setCallActivityId("")
                    if (next === "sandra" && availableCalls.length === 1) setCallActivityId(availableCalls[0].id)
                    clearClientErrors()
                  }}
                  className={SELECT_FIELD_CLASS}
                >
                  <option value="sandra" disabled={!sandraAvailable}>Sandra call</option>
                  <option value="dialpad">DialPad</option>
                  <option value="manual">Other outreach</option>
                </select>
                {callReferencesLoading ? (
                  <p role="status" className="text-xs text-muted-foreground">Loading Sandra calls…</p>
                ) : callReferencesError ? (
                  <div role="alert" className="text-xs text-muted-foreground">
                    <p>Could not load Sandra calls. Retry to select a call made in Sandra.</p>
                    {onRetryCallReferences && <button type="button" className="mt-1 underline" onClick={onRetryCallReferences}>Retry loading Sandra calls</button>}
                  </div>
                ) : null}
              </div>

              {(source === "sandra" || (source === "dialpad" && sandraAvailable)) && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center">
                    <Label htmlFor="post-call-call-reference">{source === "sandra" ? "Sandra call" : "Call to resolve (optional)"}</Label>
                    {source === "sandra" && <RequiredHint />}
                  </div>
                  {sandraAvailable ? (
                    <select
                      id="post-call-call-reference"
                      aria-label={source === "sandra" ? "Sandra call" : "Call to resolve"}
                      value={callActivityId}
                      disabled={locked}
                      onChange={(event) => setCallActivityId(event.target.value)}
                      aria-invalid={Boolean(clientFieldErrors.callActivityId || submitState.fieldErrors.callActivityId)}
                      aria-required={source === "sandra"}
                      className={SELECT_FIELD_CLASS}
                    >
                      <option value="">{source === "sandra" ? "Choose a call" : "Match by recording link, or log a separate call"}</option>
                      {availableCalls.map((reference) => (
                        <option key={reference.id} value={reference.id}>{reference.label}</option>
                      ))}
                    </select>
                  ) : (
                    <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                      This call is no longer available. Close and reopen this prompt to refresh Sandra calls.
                    </p>
                  )}
                  <FieldError message={clientFieldErrors.callActivityId || submitState.fieldErrors.callActivityId} />
                </div>
              )}

              {manualSource && (
                <DateTimeField
                  id="post-call-occurred-at"
                  label="When did it occur?"
                  value={occurredAt}
                  onChange={setOccurredAt}
                  error={clientFieldErrors.occurredAt || submitState.fieldErrors.occurredAt}
                  disabled={locked}
                />
              )}

              {source === "dialpad" && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="post-call-recording">Recording link {callActivityId ? "(optional)" : "(required)"}</Label>
                  <Input
                    id="post-call-recording"
                    type="url"
                    value={recordingUrl}
                    disabled={locked}
                    onChange={(event) => setRecordingUrl(event.target.value)}
                    placeholder="https://…"
                    aria-invalid={Boolean(clientFieldErrors.recordingUrl || submitState.fieldErrors.recordingUrl)}
                    className={TEXT_FIELD_CLASS}
                  />
                  <FieldError message={clientFieldErrors.recordingUrl || submitState.fieldErrors.recordingUrl} />
                  <p className="text-xs text-muted-foreground">Paste the shared DialPad recording link.</p>
                </div>
              )}
            </div>
            {variant === "dock" ? (
              <div className="flex justify-end gap-2">
                <Button type="submit" disabled={attemptRecorded || submitState.submitting || recovery?.blocked || recovery?.busy}>
                  {submitState.submitting ? "Saving…" : recovery?.reconciliation ? "Reconcile saved change" : attemptRecorded ? "Attempt recorded" : "Save"}
                </Button>
              </div>
            ) : (
              <WorkflowDialogFooter
                submitting={submitState.submitting}
                submitLabel={attemptRecorded ? "Attempt recorded" : "Save"}
                onCancel={closeDialog}
                disabled={attemptRecorded}
              />
            )}
          </form>
        )}
    </>
  )

  if (variant === "dock") {
    return (
      <section data-testid="post-call-prompt" data-variant="dock" aria-label="Post-call prompt" className="flex flex-col gap-3 rounded-[16px] border border-border bg-card p-4">
        <div>
          <h2 className="text-base font-bold">How did the call go?</h2>
          <p className="text-xs text-muted-foreground">{`Record the outcome for ${propertyLabel}. Opening this prompt does not count as a call.`}</p>
        </div>
        {promptBody}
      </section>
    )
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
        data-testid="post-call-prompt"
        className={`flex max-h-[calc(100dvh-2rem)] grid-rows-none flex-col overflow-hidden ${DIALOG_CONTENT_CLASS}`}
      >
        <WorkflowDialogHeader
          title="How did the call go?"
          description={`Record the outcome for ${propertyLabel}. Opening this prompt does not count as a call.`}
        />
        {promptBody}
      </DialogContent>
    </Dialog>
  )
}

export function ReceiptLines({
  extras,
  sentNextStepAt,
  note,
  onRetry,
  attemptSaved = true,
}: {
  /** False for the reload banner of an earlier, unconfirmed save: never claim "Attempt saved" there. */
  attemptSaved?: boolean
  extras: PostCallExtrasState | null
  sentNextStepAt: string | null
  /** The note the rep typed; shown with a copy button whenever it was not saved. */
  note: string | null
  onRetry?: () => void
}) {
  const parts = attemptSaved ? ["Attempt saved"] : []
  let failed = false
  let detail: string | undefined
  let noteNotSaved = false
  if (extras?.status === "saving") parts.push("Saving note and next step…")
  if (extras?.status === "done") {
    const result = extras.result
    if (!result.ok) {
      failed = true
      detail = result.message
      parts.push("Note and next step not saved")
      noteNotSaved = true
    } else {
      if (result.note === "saved") parts.push("Note saved")
      if (result.note === "failed") { failed = true; parts.push("Note not saved") }
      if (result.nextStep === "created") {
        parts.push(sentNextStepAt ? `Next step set for ${formatZonedDateTime(new Date(sentNextStepAt), TIME_ZONE)}` : "Next step set")
      }
      if (result.nextStep === "failed") { failed = true; parts.push("Next step not set") }
      detail = result.message
      noteNotSaved = result.note !== "saved"
    }
  }
  const [copied, setCopied] = useState(false)
  return (
    <div role="status" data-testid="post-call-receipt" className="space-y-1 text-sm text-teal-800 dark:text-teal-200">
      <p>{parts.join(" · ")}</p>
      {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      {note && noteNotSaved && (
        <div className="space-y-1 rounded-md border border-border bg-muted/30 p-2 text-foreground" data-testid="post-call-unsaved-note">
          <p className="text-xs font-medium">Your note was not saved. Copy it so you do not have to retype it:</p>
          <p className="whitespace-pre-wrap break-words text-sm">{note}</p>
          <button
            type="button"
            data-testid="post-call-copy-note"
            className="text-xs underline"
            onClick={() => {
              try {
                void navigator.clipboard.writeText(note).then(() => setCopied(true), () => setCopied(false))
              } catch {
                setCopied(false)
              }
            }}
          >
            {copied ? "Copied" : "Copy note"}
          </button>
        </div>
      )}
      {failed && onRetry && (
        <button type="button" data-testid="post-call-retry-extras" className="text-xs underline" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  )
}
