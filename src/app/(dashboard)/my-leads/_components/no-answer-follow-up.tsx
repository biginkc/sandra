"use client"

import { savedFollowUpGuidance } from "@/lib/my-leads/follow-up-recovery"

import { useMemo } from "react"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  composeRepSms,
  DEFAULT_REP_SMS_INTRODUCTION,
  REP_SMS_INTRODUCTIONS,
  REP_SMS_TEMPLATES,
  personalizeRepSmsApprovedCopy,
} from "@/lib/messaging/rep-sms-composition"
import { FieldError, RequiredHint, SELECT_FIELD_CLASS, TEXT_FIELD_CLASS } from "./workflow-form"

// The no-answer follow-up text section, moved out of the old attempt dialog (which keeps its own copy until
// p1a-retire deletes it). Only a No answer outcome shows it; voicemail does not.

const GSM7_EXTENDED = new Set(["^", "{", "}", "\\", "[", "~", "]", "|", "€"])
const GSM7_BASIC = new Set(
  Array.from("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"),
)

export function smsInfo(text: string) {
  const gsm7 = Array.from(text).every((character) => GSM7_BASIC.has(character) || GSM7_EXTENDED.has(character))
  const units = gsm7
    ? Array.from(text).reduce((total, character) => total + (GSM7_EXTENDED.has(character) ? 2 : 1), 0)
    : Array.from(text).length
  const single = gsm7 ? 160 : 70
  const multipart = gsm7 ? 153 : 67
  const segments = units <= single ? 1 : Math.ceil(units / multipart)
  return { length: Array.from(text).length, units, segments, encoding: gsm7 ? "GSM-7" : "UCS-2" } as const
}

export type FollowUpState = {
  status: "required" | "draft" | "sending" | "accepted" | "delivered" | "delivery_failed" | "blocked" | "failed_not_dispatched" | "unknown"
  message?: string | null
  obligationId?: string | null
}

export type FollowUpFields = {
  acquisitionsManager: string
  introId: string
  templateId: string
  remainder: string
}

export const EMPTY_FOLLOW_UP_FIELDS: FollowUpFields = {
  acquisitionsManager: "",
  introId: DEFAULT_REP_SMS_INTRODUCTION.id,
  templateId: "",
  remainder: "",
}

export function selectedIntroduction(fields: FollowUpFields) {
  return REP_SMS_INTRODUCTIONS.find((candidate) => candidate.id === fields.introId) ?? DEFAULT_REP_SMS_INTRODUCTION
}

/** The composed follow-up, or null while a template or remainder is missing or the composition is invalid. */
export function composeFollowUp(fields: FollowUpFields) {
  const introduction = selectedIntroduction(fields)
  const template = REP_SMS_TEMPLATES.find((candidate) => candidate.id === fields.templateId)
  try {
    return composeRepSms({
      acquisitionsManager: fields.acquisitionsManager,
      introId: introduction.id,
      introVersion: introduction.version,
      templateId: template?.id ?? null,
      templateVersion: template?.version ?? null,
      initialRemainder: template ? personalizeRepSmsApprovedCopy(template.remainder, fields.acquisitionsManager) : null,
      remainder: fields.remainder,
    })
  } catch {
    return null
  }
}

export function followUpFieldErrors(fields: FollowUpFields): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!fields.acquisitionsManager.trim()) errors.acquisitionsManager = "Enter the acquisitions manager."
  if (!REP_SMS_TEMPLATES.some((candidate) => candidate.id === fields.templateId)) errors.followUpTemplate = "Choose a curated follow-up template."
  if (!fields.remainder.trim()) errors.followUpRemainder = "Add the editable follow-up remainder."
  if (Object.keys(errors).length === 0 && !composeFollowUp(fields)) {
    errors.followUpRemainder = "Choose a template and review the follow-up message."
  }
  return errors
}

export function NoAnswerFollowUp({
  fields,
  onChange,
  locked,
  errors,
  state,
  attemptRecorded,
  onEdited,
}: {
  fields: FollowUpFields
  onChange: (next: FollowUpFields) => void
  /** Attempt recorded or a reconciliation replay is frozen. */
  locked: boolean
  errors: Record<string, string | undefined>
  state: FollowUpState | null
  attemptRecorded: boolean
  onEdited?: () => void
}) {
  const introduction = selectedIntroduction(fields)
  const template = REP_SMS_TEMPLATES.find((candidate) => candidate.id === fields.templateId)
  const manager = fields.acquisitionsManager
  const introBody = manager.trim()
    ? personalizeRepSmsApprovedCopy(introduction.body, manager)
    : "Enter the acquisitions manager to preview the introduction."
  const composition = useMemo(() => (template && fields.remainder.trim() ? composeFollowUp(fields) : null), [fields, template])
  const preview = composition?.finalBody ?? `${introBody}${fields.remainder.trim() ? `\n\n${fields.remainder.trim()}` : ""}`
  const info = smsInfo(preview)
  const edit = (next: FollowUpFields) => {
    onChange(next)
    onEdited?.()
  }

  return (
    <section className="space-y-3 rounded-[14px] border border-blue-200 bg-blue-50/60 p-3 dark:border-blue-900 dark:bg-blue-950/30" aria-labelledby="acquisition-follow-up-heading">
      <div>
        <h3 id="acquisition-follow-up-heading" className="text-sm font-semibold">Required follow-up text</h3>
        <p className="mt-1 text-xs text-muted-foreground">The no-answer result stays recorded. Choose approved copy for the follow-up that will be sent by the rep SMS workflow.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="acquisition-follow-up-manager">Acquisitions manager <RequiredHint /></Label>
        <Input id="acquisition-follow-up-manager" aria-label="Acquisitions manager" value={manager} maxLength={80} disabled={locked} aria-required="true" aria-invalid={Boolean(errors.acquisitionsManager)} aria-describedby={errors.acquisitionsManager ? "acquisition-follow-up-manager-error" : undefined} onChange={(event) => {
          const next = event.target.value
          const untouched = fields.remainder === personalizeRepSmsApprovedCopy(template?.remainder ?? "", manager.trim() || "[manager]")
          edit({
            ...fields,
            acquisitionsManager: next,
            remainder: untouched ? personalizeRepSmsApprovedCopy(template?.remainder ?? "", next || "[manager]") : fields.remainder,
          })
        }} placeholder="Name of the person reaching out" className={TEXT_FIELD_CLASS} />
        <FieldError id="acquisition-follow-up-manager-error" message={errors.acquisitionsManager} />
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center">
          <Label htmlFor="acquisition-follow-up-intro">Assistant introduction</Label>
        </div>
        <select
          id="acquisition-follow-up-intro"
          aria-label="Assistant introduction"
          value={fields.introId}
          disabled={locked}
          onChange={(event) => edit({ ...fields, introId: event.target.value })}
          className={SELECT_FIELD_CLASS}
        >
          {REP_SMS_INTRODUCTIONS.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>{manager.trim() ? personalizeRepSmsApprovedCopy(candidate.body, manager) : candidate.body.replaceAll("Maria", "[manager]")}</option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">Fixed approved introduction: {introBody}</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center">
          <Label htmlFor="acquisition-follow-up-template">Curated template</Label>
          <RequiredHint />
        </div>
        <select
          id="acquisition-follow-up-template"
          aria-label="Curated follow-up template"
          value={fields.templateId}
          disabled={locked}
          onChange={(event) => {
            const nextId = event.target.value
            const picked = REP_SMS_TEMPLATES.find((candidate) => candidate.id === nextId)
            edit({
              ...fields,
              templateId: nextId,
              remainder: picked
                ? (manager.trim() ? personalizeRepSmsApprovedCopy(picked.remainder, manager) : picked.remainder.replaceAll("Maria", "[manager]"))
                : fields.remainder,
            })
          }}
          aria-required="true"
          aria-invalid={Boolean(errors.followUpTemplate)}
          aria-describedby={errors.followUpTemplate ? "acquisition-follow-up-template-error" : undefined}
          className={SELECT_FIELD_CLASS}
        >
          <option value="">Choose a follow-up template…</option>
          {REP_SMS_TEMPLATES.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>{candidate.label}</option>
          ))}
        </select>
        <FieldError id="acquisition-follow-up-template-error" message={errors.followUpTemplate} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="acquisition-follow-up-remainder">Editable remainder</Label>
        <Textarea
          id="acquisition-follow-up-remainder"
          aria-label="Editable follow-up remainder"
          value={fields.remainder}
          disabled={locked}
          onChange={(event) => edit({ ...fields, remainder: event.target.value })}
          aria-invalid={Boolean(errors.followUpRemainder)}
          aria-describedby={errors.followUpRemainder ? "acquisition-follow-up-remainder-error" : undefined}
          maxLength={2000}
          rows={3}
          placeholder="Choose a template first"
          className={TEXT_FIELD_CLASS}
        />
        <FieldError id="acquisition-follow-up-remainder-error" message={errors.followUpRemainder} />
      </div>
      <div className="space-y-1.5 rounded-[10px] border bg-background p-2.5">
        <p className="text-xs font-semibold">Complete preview</p>
        <p className="whitespace-pre-wrap break-words text-sm">{preview}</p>
        <p className="text-xs text-muted-foreground">{info.length} characters · {info.encoding} · {info.segments} {info.segments === 1 ? "segment" : "segments"}</p>
      </div>
      {state && (
        <div role={state.status === "sending" ? "status" : "alert"} aria-live="polite" className="rounded-[10px] border px-3 py-2 text-sm">
          <p className="font-medium">Follow-up {state.status.replaceAll("_", " ")}</p>
          {state.message && <p className="mt-0.5 text-muted-foreground">{state.message}</p>}
        </div>
      )}
      {attemptRecorded && state?.status !== "accepted" && state?.status !== "delivered" && (
        <p className="text-xs text-muted-foreground">
          {savedFollowUpGuidance(state)}
        </p>
      )}
    </section>
  )
}
