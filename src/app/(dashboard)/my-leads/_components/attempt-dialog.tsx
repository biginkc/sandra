"use client"

import { useMemo, useState, type FormEvent } from "react"

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
  AcquisitionAttemptFollowUp,
  AcquisitionCallReferenceOption,
  AcquisitionFormSubmitResult,
  AcquisitionSubmit,
} from "./types"
import {
  composeRepSms,
  DEFAULT_REP_SMS_INTRODUCTION,
  REP_SMS_COMPOSITION_POLICY_VERSION,
  REP_SMS_INTRODUCTIONS,
  REP_SMS_TEMPLATES,
} from "@/lib/messaging/rep-sms-composition"

const GSM7_EXTENDED = new Set(["^", "{", "}", "\\", "[", "~", "]", "|", "€"])
const GSM7_BASIC = new Set(
  Array.from("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"),
)

function smsInfo(text: string) {
  const gsm7 = Array.from(text).every((character) => GSM7_BASIC.has(character) || GSM7_EXTENDED.has(character))
  const units = gsm7
    ? Array.from(text).reduce((total, character) => total + (GSM7_EXTENDED.has(character) ? 2 : 1), 0)
    : Array.from(text).length
  const single = gsm7 ? 160 : 70
  const multipart = gsm7 ? 153 : 67
  const segments = units <= single ? 1 : Math.ceil(units / multipart)
  return { length: Array.from(text).length, units, segments, encoding: gsm7 ? "GSM-7" : "UCS-2" } as const
}

type FollowUpState = {
  status: "required" | "draft" | "sending" | "accepted" | "delivered" | "delivery_failed" | "blocked" | "failed_not_dispatched" | "unknown"
  message?: string | null
}

export type AcquisitionAttemptDialogProps = {
  open: boolean
  propertyId: string
  propertyLabel: string
  initialCallActivityId?: string | null
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
  callReferenceOptions = [],
  callReferencesLoading = false,
  callReferencesError = null,
  onRetryCallReferences,
  onOpenChange,
  onSubmit,
}: AcquisitionAttemptDialogProps) {
  const [source, setSource] = useState<AcquisitionAttemptSource>(initialCallActivityId ? "sandra" : "dialpad")
  const [kind, setKind] = useState<AcquisitionAttemptKind>("call")
  const [outcome, setOutcome] = useState<AcquisitionAttemptFormPayload["outcome"] | "">("")
  const [occurredAt, setOccurredAt] = useState("")
  const [note, setNote] = useState("")
  const [recordingUrl, setRecordingUrl] = useState("")
  const [callActivityId, setCallActivityId] = useState(initialCallActivityId || "")
  const [introId, setIntroId] = useState(DEFAULT_REP_SMS_INTRODUCTION.id)
  const [templateId, setTemplateId] = useState("")
  const [remainder, setRemainder] = useState("")
  const [followUpState, setFollowUpState] = useState<FollowUpState | null>(null)
  const availableCalls = initialCallActivityId && !callReferenceOptions.some(call => call.id === initialCallActivityId)
    ? [{ id: initialCallActivityId, label: "Selected Sandra call" }, ...callReferenceOptions]
    : callReferenceOptions
  const sandraAvailable = availableCalls.length > 0
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
    setIntroId(DEFAULT_REP_SMS_INTRODUCTION.id)
    setTemplateId("")
    setRemainder("")
    setFollowUpState(null)
    setClientError(null)
    setClientFieldErrors({})
  }
  const submitState = useAcquisitionSubmit(onSubmit, (result) => {
    if (outcome === "no_answer") {
      const nextFollowUp: FollowUpState = result.ok && result.followUp
        ? result.followUp
        : { status: "required", message: "Attempt recorded. Follow-up still needs to be accepted or delivered." }
      setFollowUpState(nextFollowUp)
      if (nextFollowUp.status === "accepted" || nextFollowUp.status === "delivered") {
        resetFields()
        onOpenChange(false)
      } else {
        setClientError(nextFollowUp.message ?? `Attempt recorded. Follow-up is ${nextFollowUp.status.replaceAll("_", " ")}. Your draft is retained.`)
      }
      return
    }
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
    setFollowUpState(null)
  }

  const selectedIntroduction = REP_SMS_INTRODUCTIONS.find((candidate) => candidate.id === introId) ?? DEFAULT_REP_SMS_INTRODUCTION
  const selectedTemplate = REP_SMS_TEMPLATES.find((candidate) => candidate.id === templateId)
  const followUpComposition = useMemo(() => {
    if (outcome !== "no_answer" || !selectedTemplate || !remainder.trim()) return null
    try {
      return composeRepSms({
        introId: selectedIntroduction.id,
        introVersion: selectedIntroduction.version,
        templateId: selectedTemplate.id,
        templateVersion: selectedTemplate.version,
        initialRemainder: selectedTemplate.remainder,
        remainder,
      })
    } catch {
      return null
    }
  }, [outcome, remainder, selectedIntroduction.id, selectedIntroduction.version, selectedTemplate])
  const followUpPreview = followUpComposition?.finalBody ?? `${selectedIntroduction.body}${remainder.trim() ? `\n\n${remainder.trim()}` : ""}`
  const followUpSmsInfo = smsInfo(followUpPreview)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitState.submitting) return
    clearClientErrors()

    const nextFieldErrors: Record<string, string> = {}
    if (!outcome) nextFieldErrors.outcome = "Choose the external outcome."
    if (source === "sandra" && !availableCalls.some(call => call.id === callActivityId)) {
      nextFieldErrors.callActivityId = "Choose the Sandra call you want to record an outcome for."
    }
    const followUp = outcome === "no_answer"
      ? (() => {
          if (!selectedTemplate) nextFieldErrors.followUpTemplate = "Choose a curated follow-up template."
          if (!remainder.trim()) nextFieldErrors.followUpRemainder = "Add the editable follow-up remainder."
          try {
            return composeRepSms({
              introId: selectedIntroduction.id,
              introVersion: selectedIntroduction.version,
              templateId: selectedTemplate?.id ?? null,
              templateVersion: selectedTemplate?.version ?? null,
              initialRemainder: selectedTemplate?.remainder ?? null,
              remainder,
            })
          } catch {
            return null
          }
        })()
      : null
    if (outcome === "no_answer" && !followUp) {
      nextFieldErrors.followUpRemainder ??= "Choose a template and review the follow-up message."
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
      ...(followUp ? {
        smsBody: followUp.finalBody,
        followUp: {
          policyVersion: REP_SMS_COMPOSITION_POLICY_VERSION,
          introId: followUp.introId,
          introVersion: followUp.introVersion,
          templateId: followUp.templateId ?? selectedTemplate!.id,
          templateVersion: followUp.templateVersion ?? selectedTemplate!.version,
          initialRemainder: followUp.initialRemainder,
          remainder: followUp.remainder,
          body: followUp.finalBody,
        } satisfies AcquisitionAttemptFollowUp,
      } : {}),
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
                    if (nextSource === "sandra" && availableCalls.length === 1) setCallActivityId(availableCalls[0].id)
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
                  {source === "sandra" ? "Existing Sandra call" : "DialPad manual call"}
                </div>
              )}
            </div>

            <div className="text-sm text-muted-foreground">
              {callReferencesLoading ? (
                <p role="status">Loading Sandra calls… You can still log outreach made outside Sandra.</p>
              ) : callReferencesError ? (
                <div role="alert">
                  <p>Could not load Sandra calls. Retry to select a call made in Sandra.</p>
                  {onRetryCallReferences && <button type="button" className="mt-1 underline" onClick={onRetryCallReferences}>Retry loading Sandra calls</button>}
                </div>
              ) : !sandraAvailable ? (
                <p>No Sandra calls need an outcome for this lead. Calls made in Sandra appear here automatically. For outreach made outside Sandra, choose DialPad or Manual outreach.</p>
              ) : (
                <p>For a call made in Sandra, choose Sandra and select the call by date and time.</p>
              )}
            </div>

            {source === "sandra" && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center">
                  <Label htmlFor="acquisition-attempt-call-reference">Sandra call</Label>
                  <RequiredHint />
                </div>
                {sandraAvailable ? (
                  <select
                    id="acquisition-attempt-call-reference"
                    aria-label="Sandra call"
                    value={callActivityId}
                    onChange={(event) => setCallActivityId(event.target.value)}
                    aria-invalid={Boolean(clientFieldErrors.callActivityId || submitState.fieldErrors.callActivityId)}
                    aria-describedby={clientFieldErrors.callActivityId || submitState.fieldErrors.callActivityId ? "acquisition-attempt-call-reference-error" : undefined}
                    aria-required="true"
                    className={SELECT_FIELD_CLASS}
                  >
                    <option value="">Choose a call</option>
                    {availableCalls.map((reference) => (
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
                onChange={(event) => {
                  setOutcome(event.target.value as AcquisitionAttemptFormPayload["outcome"])
                  clearClientErrors()
                }}
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

            {outcome === "no_answer" && (
              <section className="space-y-3 rounded-[14px] border border-blue-200 bg-blue-50/60 p-3 dark:border-blue-900 dark:bg-blue-950/30" aria-labelledby="acquisition-follow-up-heading">
                <div>
                  <h3 id="acquisition-follow-up-heading" className="text-sm font-semibold">Required follow-up text</h3>
                  <p className="mt-1 text-xs text-muted-foreground">The no-answer result stays recorded. Choose approved copy for the follow-up that will be sent by the rep SMS workflow.</p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center">
                    <Label htmlFor="acquisition-follow-up-intro">Assistant introduction</Label>
                  </div>
                  <select
                    id="acquisition-follow-up-intro"
                    aria-label="Assistant introduction"
                    value={introId}
                    onChange={(event) => {
                      setIntroId(event.target.value)
                      clearClientErrors()
                    }}
                    className={SELECT_FIELD_CLASS}
                  >
                    {REP_SMS_INTRODUCTIONS.map((introduction) => (
                      <option key={introduction.id} value={introduction.id}>{introduction.body}</option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">Fixed approved introduction: {selectedIntroduction.body}</p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center">
                    <Label htmlFor="acquisition-follow-up-template">Curated template</Label>
                    <RequiredHint />
                  </div>
                  <select
                    id="acquisition-follow-up-template"
                    aria-label="Curated follow-up template"
                    value={templateId}
                    onChange={(event) => {
                      const nextId = event.target.value
                      setTemplateId(nextId)
                      const template = REP_SMS_TEMPLATES.find((candidate) => candidate.id === nextId)
                      if (template) setRemainder(template.remainder)
                      clearClientErrors()
                    }}
                    aria-required="true"
                    aria-invalid={Boolean(clientFieldErrors.followUpTemplate || submitState.fieldErrors.followUpTemplate)}
                    aria-describedby={clientFieldErrors.followUpTemplate || submitState.fieldErrors.followUpTemplate ? "acquisition-follow-up-template-error" : undefined}
                    className={SELECT_FIELD_CLASS}
                  >
                    <option value="">Choose a follow-up template…</option>
                    {REP_SMS_TEMPLATES.map((template) => (
                      <option key={template.id} value={template.id}>{template.label}</option>
                    ))}
                  </select>
                  <FieldError id="acquisition-follow-up-template-error" message={clientFieldErrors.followUpTemplate || submitState.fieldErrors.followUpTemplate} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="acquisition-follow-up-remainder">Editable remainder</Label>
                  <Textarea
                    id="acquisition-follow-up-remainder"
                    aria-label="Editable follow-up remainder"
                    value={remainder}
                    onChange={(event) => {
                      setRemainder(event.target.value)
                      clearClientErrors()
                    }}
                    aria-invalid={Boolean(clientFieldErrors.followUpRemainder || submitState.fieldErrors.followUpRemainder)}
                    aria-describedby={clientFieldErrors.followUpRemainder || submitState.fieldErrors.followUpRemainder ? "acquisition-follow-up-remainder-error" : undefined}
                    maxLength={2000}
                    rows={3}
                    placeholder="Choose a template first"
                    className={TEXT_FIELD_CLASS}
                  />
                  <FieldError id="acquisition-follow-up-remainder-error" message={clientFieldErrors.followUpRemainder || submitState.fieldErrors.followUpRemainder} />
                </div>
                <div className="space-y-1.5 rounded-[10px] border bg-background p-2.5">
                  <p className="text-xs font-semibold">Complete preview</p>
                  <p className="whitespace-pre-wrap break-words text-sm">{followUpPreview}</p>
                  <p className="text-xs text-muted-foreground">{followUpSmsInfo.length} characters · {followUpSmsInfo.encoding} · {followUpSmsInfo.segments} {followUpSmsInfo.segments === 1 ? "segment" : "segments"}</p>
                </div>
                {followUpState && (
                  <div role={followUpState.status === "sending" ? "status" : "alert"} aria-live="polite" className="rounded-[10px] border px-3 py-2 text-sm">
                    <p className="font-medium">Follow-up {followUpState.status.replaceAll("_", " ")}</p>
                    {followUpState.message && <p className="mt-0.5 text-muted-foreground">{followUpState.message}</p>}
                  </div>
                )}
              </section>
            )}

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
