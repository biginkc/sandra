"use client"

import { useEffect, useMemo, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import type { SendSmsOutcome } from "@/lib/messaging/send"
import { formatPhoneE164 } from "@/lib/phone-format"
import {
  DEFAULT_REP_SMS_INTRODUCTION,
  REP_SMS_INTRODUCTIONS,
  REP_SMS_TEMPLATES,
  composeRepSms,
  type RepSmsIntroduction,
  type RepSmsTemplate,
  type RepSmsComposition,
} from "@/lib/messaging/rep-sms-composition"

import type { RepSmsContext } from "@/lib/messaging/rep-sms"
import { loadRepSmsContext, sendRepSms } from "./sms-actions"

/** The fixed identity used by Acquisitions texts. The remainder stays editable. */
export const REP_SMS_INTRO = DEFAULT_REP_SMS_INTRODUCTION.body
export type { RepSmsIntroduction, RepSmsTemplate }

export type RepSmsSendState =
  | "idle"
  | "sending"
  | "accepted"
  | "delivered"
  | "delivery_failed"
  | "blocked"
  | "provider_unknown"
  | "unknown"
  | "resume"

type RepSmsComposerProps = {
  propertyId: string
  onSent?: (id: string) => void
  /** The exact saved phone used by an open Messages thread, when available. */
  replyToPhone?: string | null
  /** Optional curated catalog override for tests or a future rollout variant. */
  templates?: readonly RepSmsTemplate[]
}

type SendState = {
  status: RepSmsSendState
  message: string | null
}

const INITIAL_SEND_STATE: SendState = { status: "idle", message: null }
const RESUMABLE_OBLIGATION_STATES = new Set(["required", "draft", "failed_not_dispatched"])
const REVIEW_ONLY_OBLIGATION_STATES = new Set(["blocked", "unknown", "delivery_failed", "claimed", "sending"])

type StoredRepSmsSubmission = {
  key: string
  composition: RepSmsComposition
  /** The sender and destination reviewed for this exact provider request. */
  assignmentId?: string
  to?: string
}

function repSmsSubmissionStorageKey(propertyId: string): string {
  return `sandra:rep-sms:submission:${propertyId}`
}

function readStoredRepSmsSubmission(propertyId: string): StoredRepSmsSubmission | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(repSmsSubmissionStorageKey(propertyId))
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<StoredRepSmsSubmission>
    if (!value || typeof value.key !== "string" || !value.key.trim() || !value.composition || typeof value.composition !== "object") return null
    return {
      key: value.key,
      composition: value.composition as RepSmsComposition,
      ...(typeof value.assignmentId === "string" && value.assignmentId.trim() ? { assignmentId: value.assignmentId } : {}),
      ...(typeof value.to === "string" && value.to.trim() ? { to: value.to } : {}),
    }
  } catch {
    return null
  }
}

function writeStoredRepSmsSubmission(propertyId: string, submission: StoredRepSmsSubmission): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(repSmsSubmissionStorageKey(propertyId), JSON.stringify(submission))
  } catch {
    // Private browsing or a full storage quota must not block a send. The
    // server key still protects the current request while this tab remains.
  }
}

function clearStoredRepSmsSubmission(propertyId: string): void {
  if (typeof window === "undefined") return
  try { window.localStorage.removeItem(repSmsSubmissionStorageKey(propertyId)) } catch { /* best effort */ }
}

/**
 * Approximate carrier SMS accounting without counting UTF-16 surrogate pairs
 * as two visible characters. GSM-7 extended characters cost two septets.
 */
export function getRepSmsInfo(text: string) {
  const gsm7 = isGsm7(text)
  const visibleLength = Array.from(text).length
  const units = gsm7
    ? Array.from(text).reduce((total, character) => total + (GSM7_EXTENDED.has(character) ? 2 : 1), 0)
    : visibleLength
  const singleSegmentLimit = gsm7 ? 160 : 70
  const multipartSegmentLimit = gsm7 ? 153 : 67
  const segments = units <= singleSegmentLimit ? 1 : Math.ceil(units / multipartSegmentLimit)
  return {
    length: visibleLength,
    units,
    segments,
    encoding: gsm7 ? "GSM-7" : "UCS-2",
    remaining: Math.max(0, (segments === 1 ? singleSegmentLimit : segments * multipartSegmentLimit) - units),
    singleSegmentLimit,
  } as const
}

const GSM7_EXTENDED = new Set(["^", "{", "}", "\\", "[", "~", "]", "|", "€"])
const GSM7_BASIC = new Set(
  Array.from("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"),
)

function isGsm7(text: string) {
  return Array.from(text).every((character) => GSM7_BASIC.has(character) || GSM7_EXTENDED.has(character))
}

function outcomeState(outcome: SendSmsOutcome | { status: string }): SendState {
  switch (outcome.status) {
    case "sent":
      return { status: "accepted", message: "Accepted by the messaging provider. Delivery status will appear in text history." }
    // Kept for additive provider outcome contracts; the current sender returns
    // `sent` and delivery webhooks update the Messages history asynchronously.
    case "delivered":
      return { status: "delivered", message: "Delivered to the homeowner." }
    case "provider_failed":
    case "provider_deferred":
      return { status: "delivery_failed", message: "The provider did not confirm delivery. Your draft is preserved; review the text history before retrying." }
    case "provider_unknown":
      return { status: "provider_unknown", message: "The messaging provider did not provide a definitive receipt. Reconciliation is pending. Your draft is preserved; review the text history before retrying." }
    case "blocked_no_consent":
    case "blocked_quiet_hours":
    case "blocked_no_phone":
    case "blocked_landline":
    case "blocked_terminal_dispo":
    case "blocked_automated_suppressed":
    case "blocked_fresh_state_unavailable":
    case "blocked_provider_off":
    case "blocked_no_approved_sender":
    case "blocked_not_due":
    case "blocked_campaign_paused":
      return { status: "blocked", message: "Sandra blocked this text before delivery. Review the reason below and resolve it before trying again." }
    default:
      return { status: "unknown", message: "Sandra could not confirm the final send result. Your draft is preserved." }
  }
}

const STATE_LABELS: Record<RepSmsSendState, string> = {
  idle: "Ready",
  sending: "Sending",
  accepted: "Accepted",
  delivered: "Delivered",
  delivery_failed: "Delivery failed",
  blocked: "Blocked",
  provider_unknown: "Pending reconciliation",
  unknown: "Unknown result",
  resume: "Resume available",
}

export function RepSmsComposer({
  propertyId,
  onSent,
  replyToPhone = null,
  templates: providedTemplates,
}: RepSmsComposerProps) {
  const [open, setOpen] = useState(false)
  const [activated, setActivated] = useState(false)
  const [pending, setPending] = useState(false)
  const [context, setContext] = useState<RepSmsContext | null>(null)
  const [senderId, setSenderId] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [introId, setIntroId] = useState(DEFAULT_REP_SMS_INTRODUCTION.id)
  const [selectedTemplateId, setSelectedTemplateId] = useState("")
  const [remainder, setRemainder] = useState("")
  const [sendState, setSendState] = useState<SendState>(INITIAL_SEND_STATE)
  const sendInFlight = useRef(false)
  const submission = useRef<StoredRepSmsSubmission | null>(null)
  const templateRequest = useRef(0)
  const previousPropertyId = useRef(propertyId)

  // A retained component can be reused for a different queue row. Never let
  // the previous lead's draft or selected sender bleed into that new lead.
  useEffect(() => {
    if (previousPropertyId.current === propertyId) return
    previousPropertyId.current = propertyId
    setContext(null)
    setSenderId("")
    setIntroId(DEFAULT_REP_SMS_INTRODUCTION.id)
    setSelectedTemplateId("")
    setRemainder("")
    setSendState(INITIAL_SEND_STATE)
    submission.current = null
  }, [propertyId, providedTemplates])

  useEffect(() => {
    if (!activated) return
    let active = true
    setContext(null)
    setError(null)
    setSendState(INITIAL_SEND_STATE)
    void loadRepSmsContext(propertyId)
      .then((result) => {
        if (!active) return
        if (!result.ok) {
          setError(result.error.message)
          return
        }
        setContext(result.data)
        const obligation = result.data.obligation
        // A saved follow-up owns the exact sender captured with the no-answer
        // attempt. Keep that assignment selected even when the current
        // default changed while the composer was closed.
        const obligationSenderId = obligation?.senderAssignmentId ?? ""
        setSenderId(obligationSenderId || (result.data.senders.find((sender) => sender.isDefault)?.id ?? result.data.senders[0]?.id ?? ""))
        const saved = obligation?.composition
        if (saved && typeof saved === "object" && !Array.isArray(saved)) {
          if (typeof saved.introId === "string") setIntroId(saved.introId)
          if (typeof saved.templateId === "string") setSelectedTemplateId(saved.templateId)
          if (typeof saved.remainder === "string") setRemainder(saved.remainder)
        }
        if (obligation && RESUMABLE_OBLIGATION_STATES.has(obligation.status)) {
          setSendState({ status: "resume", message: "Saved follow-up ready to resume through its original obligation." })
        } else if (obligation && REVIEW_ONLY_OBLIGATION_STATES.has(obligation.status)) {
          setSendState({ status: "unknown", message: `${obligation.blockedReason ?? `Saved follow-up is ${obligation.status.replaceAll("_", " ")}.`} Automatic retry is disabled; review or close the obligation.` })
        } else {
          const stored = readStoredRepSmsSubmission(propertyId)
          if (stored) {
            submission.current = stored
            // Reconcile the exact reviewed route. If the assignment or phone
            // disappeared, the server will fail closed rather than allowing a
            // changed route under the original idempotency key.
            if (stored.assignmentId && result.data.senders.some((sender) => sender.id === stored.assignmentId)) {
              setSenderId(stored.assignmentId)
            }
            const storedComposition = stored.composition
            if (typeof storedComposition.introId === "string") setIntroId(storedComposition.introId)
            if (typeof storedComposition.templateId === "string") setSelectedTemplateId(storedComposition.templateId)
            if (typeof storedComposition.remainder === "string") setRemainder(storedComposition.remainder)
            setSendState({ status: "resume", message: "A previous send needs reconciliation. Review text history, then reconcile the saved request." })
          }
        }
      })
      .catch(() => {
        if (active) setError("Texting access could not be loaded. Please retry.")
      })
    return () => {
      active = false
    }
  }, [propertyId, activated, retry])

  const sender = context?.senders.find((candidate) => candidate.id === senderId)
  const obligation = context?.obligation ?? null
  // A resumed obligation owns the destination captured when the no-answer
  // attempt was recorded. The thread phone is only a hint for a new text and
  // must never make the preview disagree with the fenced server send.
  const recipient = obligation?.toNumber ?? submission.current?.to ?? replyToPhone ?? context?.phone ?? null
  const introduction = REP_SMS_INTRODUCTIONS.find((candidate) => candidate.id === introId) ?? DEFAULT_REP_SMS_INTRODUCTION
  const templates = providedTemplates ?? REP_SMS_TEMPLATES
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId)
  const resumableObligationId = obligation && RESUMABLE_OBLIGATION_STATES.has(obligation.status) ? obligation.id : null
  const reviewOnlyObligation = Boolean(obligation && REVIEW_ONLY_OBLIGATION_STATES.has(obligation.status))
  const obligationOwnsSender = Boolean(obligation && (resumableObligationId || reviewOnlyObligation))
  const submissionLocked = Boolean(submission.current && (sendState.status === "resume" || sendState.status === "provider_unknown" || sendState.status === "unknown"))
  const senderDisplayNumber = obligationOwnsSender ? (obligation?.fromNumber ?? sender?.number) : sender?.number
  const composition = useMemo(() => {
    try {
      return composeRepSms({
        introId: introduction.id,
        introVersion: introduction.version,
        templateId: selectedTemplateId || null,
        templateVersion: selectedTemplate?.version ?? null,
        initialRemainder: selectedTemplate?.remainder ?? remainder,
        remainder,
      })
    } catch {
      return null
    }
  }, [introduction.id, introduction.version, remainder, selectedTemplate, selectedTemplateId])
  const fullBody = composition?.finalBody ?? (remainder.trim() ? `${introduction.body}\n\n${remainder.trim()}` : introduction.body)
  const smsInfo = useMemo(() => getRepSmsInfo(fullBody), [fullBody])
  // The server context is the authority for whether this text is a required
  // no-answer follow-up. Do not infer a requirement from historical attempt
  // rows: old no-answer records may have no obligation, and an already
  // accepted obligation must never turn the free-form composer into a forced
  // template flow.
  const needsTemplate = Boolean(resumableObligationId)
  const missingTemplate = needsTemplate && !selectedTemplateId
  const tooLong = smsInfo.units > 1600
  const canSend = Boolean(sender && recipient && remainder.trim() && composition && !missingTemplate && !tooLong && !reviewOnlyObligation && sendState.status !== "provider_unknown" && sendState.status !== "unknown" && !pending && !sendInFlight.current)
  const canReconcile = Boolean(submission.current && sender && recipient && composition && !tooLong && !pending && !sendInFlight.current && (sendState.status === "provider_unknown" || sendState.status === "unknown" || sendState.status === "resume"))

  const selectTemplate = (id: string) => {
    setSelectedTemplateId(id)
    if (!id) return
    const template = templates.find((candidate) => candidate.id === id)
    if (!template) return
    const requestId = ++templateRequest.current
    // Curated follow-up copy contains a plain editable remainder. Keep the
    // request token so a rapid selection remains deterministic if a future
    // catalog becomes asynchronous.
    if (requestId === templateRequest.current) setRemainder(template.remainder)
  }

  const clearSubmission = () => {
    submission.current = null
    clearStoredRepSmsSubmission(propertyId)
  }

  const send = (mode: "send" | "reconcile" = "send") => {
    const allowed = mode === "reconcile" ? canReconcile : canSend
    if (!allowed || !sender || !recipient || sendInFlight.current || !composition) return
    sendInFlight.current = true
    const submittedComposition = submission.current?.composition ?? composition
    const idempotencyKey = resumableObligationId ?? (() => {
      if (!submission.current) {
        submission.current = {
          key: crypto.randomUUID(),
          composition: submittedComposition,
          assignmentId: sender.id,
          to: recipient,
        }
        writeStoredRepSmsSubmission(propertyId, submission.current)
      }
      return submission.current.key
    })()
    setPending(true)
    setSendState({ status: "sending", message: mode === "reconcile" ? "Sandra is reconciling the saved SMS request." : "Sandra is checking contact restrictions and sending this text." })
    void sendRepSms({
      propertyId,
      assignmentId: sender.id,
      to: recipient,
      obligationId: resumableObligationId,
      idempotencyKey,
      composition: {
        introId: submittedComposition.introId,
        introVersion: submittedComposition.introVersion,
        templateId: submittedComposition.templateId,
        templateVersion: submittedComposition.templateVersion,
        initialRemainder: submittedComposition.initialRemainder,
        remainder: submittedComposition.remainder,
        initialBody: submittedComposition.initialBody,
      },
    })
      .then(async (result) => {
        if (!result.ok) {
          setSendState({ status: "provider_unknown", message: result.error.message || "Sandra could not confirm the final send result. Your draft is preserved; reconcile the saved request before sending again." })
          return
        }
        const next = outcomeState(result.data.outcome)
        const detail = "reason" in result.data.outcome
          ? result.data.outcome.reason
          : "error" in result.data.outcome
            ? result.data.outcome.error
            : null
        setSendState(detail && (next.status === "blocked" || next.status === "delivery_failed")
          ? { ...next, message: `${detail} Your draft is preserved.` }
          : next)
        if (next.status === "accepted" || next.status === "delivered") {
          if (!resumableObligationId) clearSubmission()
          setRemainder((current) => current === remainder ? "" : current)
          setSelectedTemplateId("")
          if (onSent && "messageId" in result.data.outcome && typeof result.data.outcome.messageId === "string") {
            onSent(result.data.outcome.messageId)
          }
          if (resumableObligationId) {
            // The accepted obligation is intentionally omitted by the context
            // read model. Refresh before allowing a new manual message so the
            // next send cannot reuse the completed obligation id.
            const refreshed = await loadRepSmsContext(propertyId)
            if (refreshed.ok) {
              setContext(refreshed.data)
              setSenderId(refreshed.data.senders.find((candidate) => candidate.isDefault)?.id ?? refreshed.data.senders[0]?.id ?? "")
            } else {
              setError(refreshed.error.message)
              // Keep the old obligation visible for diagnosis, but block a
              // new manual send until an authoritative read succeeds. Using
              // the stale resumable id here could otherwise reuse a completed
              // obligation after the refresh itself failed.
              setSendState({ status: "unknown", message: "The saved follow-up completed, but Sandra could not refresh the current texting context. Retry the context load before sending another text." })
            }
          }
        } else if (!resumableObligationId && (next.status === "blocked" || next.status === "delivery_failed")) {
          // A definitive pre-provider result consumed this key but did not
          // send. A later explicit retry is a new logical submission.
          clearSubmission()
        }
      })
      .catch(() => {
        setSendState({ status: "provider_unknown", message: "Sandra lost the send result. Your draft is preserved; reconcile the saved request before sending again." })
      })
      .finally(() => {
        sendInFlight.current = false
        setPending(false)
      })
  }

  const resetForRetry = () => {
    if (!resumableObligationId) clearSubmission()
    setSendState({ status: "resume", message: "Draft retained. Review the text history, then send again when it is safe." })
  }

  return <div className="space-y-2" data-testid="rep-sms-composer">
    <Button
      type="button"
      variant="outline"
      onClick={() => { setActivated(true); setOpen((value) => !value) }}
      aria-expanded={open}
    >
      {open ? "Hide text" : "Text lead"}
    </Button>
    {activated && <div hidden={!open} className="space-y-4 rounded-lg border bg-background p-3">
      {error ? <div role="alert" className="flex items-center justify-between gap-2 text-sm text-destructive">{error}<Button type="button" variant="outline" onClick={() => setRetry((value) => value + 1)}>Retry</Button></div> : !context ? <p role="status">Loading your texting numbers…</p> : !context.senders.length ? <p className="text-sm">No texting number is assigned to you. Ask an owner to add one in Manage Acquisitions.</p> : <>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm" htmlFor={`rep-sms-sender-${propertyId}`}>
            <span className="font-medium">Send from</span>
            <select id={`rep-sms-sender-${propertyId}`} className="rounded border p-2" disabled={pending || obligationOwnsSender || submissionLocked} value={senderId} onChange={(event) => setSenderId(event.target.value)}>
              <option value="">Choose your number</option>
              {context.senders.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label} · {obligationOwnsSender && candidate.id === senderId ? (obligation?.fromNumber ?? candidate.number) : candidate.number}{candidate.isDefault ? " (default)" : ""}</option>)}
            </select>
          </label>
          <div className="flex flex-col justify-end text-sm text-muted-foreground">
            <span><span className="font-medium text-foreground">From:</span> {formatPhoneE164(senderDisplayNumber) ?? "No selected texting number"}</span>
            <span><span className="font-medium text-foreground">To:</span> {formatPhoneE164(recipient) ?? "No usable mobile number"}</span>
            <span className="text-xs">Replies use the saved phone in this thread.</span>
          </div>
        </div>

        <div className="rounded-md border border-blue-200 bg-blue-50/60 p-3 text-sm dark:border-blue-900 dark:bg-blue-950/30">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="font-medium" htmlFor={`rep-sms-intro-${propertyId}`}>Assistant introduction</label>
            <select id={`rep-sms-intro-${propertyId}`} aria-label="Assistant introduction" className="rounded border bg-background px-2 py-1 text-xs font-medium" disabled={pending || submissionLocked} value={introId} onChange={(event) => setIntroId(event.target.value)}>
              {REP_SMS_INTRODUCTIONS.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.body}</option>)}
            </select>
          </div>
          <p className="mt-2 text-foreground">{introduction.body}</p>
          <p className="mt-1 text-xs text-muted-foreground">Choose an approved Mel-as-Maria&apos;s-assistant introduction. It stays read-only in the final message; the follow-up remainder stays editable below.</p>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={`rep-sms-template-${propertyId}`} className="text-sm font-medium">Curated follow-up template{needsTemplate && <span className="ml-1 text-destructive">— required</span>}</label>
          </div>
          <select
            id={`rep-sms-template-${propertyId}`}
            aria-label="Curated follow-up template"
            className="w-full rounded border p-2 text-sm"
            disabled={pending || submissionLocked}
            value={selectedTemplateId}
            onChange={(event) => selectTemplate(event.target.value)}
            aria-required={needsTemplate}
            aria-invalid={missingTemplate}
            aria-describedby={missingTemplate ? `rep-sms-template-error-${propertyId}` : undefined}
          >
            <option value="">{needsTemplate ? "Choose a follow-up template…" : "Choose a template (optional)…"}</option>
            {templates.map((template) => <option key={template.id} value={template.id}>{template.label}</option>)}
          </select>
          {templates.length === 0 && <p className="text-xs text-muted-foreground">No curated follow-up templates are available. Ask an owner to refresh the rollout catalog.</p>}
          {missingTemplate && <p className="text-xs text-destructive" id={`rep-sms-template-error-${propertyId}`}>Choose a follow-up template before sending after a no-answer attempt.</p>}
        </div>

        <div className="space-y-1.5">
          <label htmlFor={`rep-sms-remainder-${propertyId}`} className="text-sm font-medium">Editable remainder</label>
          <textarea
            id={`rep-sms-remainder-${propertyId}`}
            aria-label="Editable message remainder"
            value={remainder}
            onChange={(event) => setRemainder(event.target.value)}
            disabled={pending || submissionLocked}
            maxLength={2000}
            rows={4}
            placeholder="Choose a template or write the follow-up here…"
            className="min-h-[96px] w-full resize-y rounded border bg-transparent p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <div className="space-y-2 rounded-md border bg-muted/20 p-3">
          <div className="flex items-center justify-between gap-2 text-sm font-medium"><span>Complete preview</span><span className="text-xs text-muted-foreground">Mel → {formatPhoneE164(recipient) ?? "—"}</span></div>
          <p className="whitespace-pre-wrap break-words rounded bg-background p-3 text-sm">{fullBody}</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{smsInfo.length} characters</span>
            <span>{smsInfo.encoding}</span>
            <span>{smsInfo.segments} {smsInfo.segments === 1 ? "segment" : "segments"}</span>
            <span>{smsInfo.remaining} remaining in current segment budget</span>
            {tooLong && <span className="font-medium text-destructive">Message exceeds 1,600 characters</span>}
          </div>
        </div>

        {sendState.status !== "idle" && <div role={sendState.status === "sending" ? "status" : "alert"} aria-live="polite" className="rounded-md border px-3 py-2 text-sm">
          <p className="font-medium">{STATE_LABELS[sendState.status]}</p>
          {sendState.message && <p className="mt-0.5 text-muted-foreground">{sendState.message}</p>}
          {(sendState.status === "unknown" || sendState.status === "delivery_failed") && !reviewOnlyObligation && !submission.current && <Button type="button" variant="link" size="xs" disabled={pending} onClick={resetForRetry}>Resume draft</Button>}
          {canReconcile && !reviewOnlyObligation && sendState.status !== "resume" && <Button type="button" variant="link" size="xs" disabled={pending} onClick={() => send("reconcile")}>Reconcile saved send</Button>}
        </div>}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">{needsTemplate ? "No answer recorded. A curated follow-up template is required." : "Review the complete preview before sending."}</p>
          <Button type="button" disabled={!canSend} onClick={() => send("send")}>{pending ? "Sending…" : sendState.status === "resume" ? (submission.current ? "Reconcile saved send" : "Send resumed draft") : "Send text"}</Button>
        </div>
      </>}
    </div>}
  </div>
}
