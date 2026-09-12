"use client"

import { useRef, useState, type ReactNode } from "react"
import { AlertCircle } from "lucide-react"

import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { wallTimeToUtc } from "@/lib/time/zoned"
import { ACQUISITION_TIME_ZONE } from "@/lib/my-leads/time"
import type { AcquisitionFormSubmitResult, AcquisitionSubmit } from "./types"

// Shared card shell to match the approved My Leads dialog mock: a 22px
// rounded card (~420-440px) with a muted footer band. Spread this onto each
// dialog's <DialogContent className={...}>.
export const DIALOG_CONTENT_CLASS =
  "rounded-[22px] sm:max-w-[440px] gap-4"

// Native select styled to look like the mock's rounded field control.
export const SELECT_FIELD_CLASS =
  "border-border bg-background flex h-[38px] w-full rounded-[12px] border px-3 text-sm font-normal outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"

// Text input / textarea styled to look like the mock's .mtext control.
export const TEXT_FIELD_CLASS = "rounded-[12px] border-border"

export function RequiredHint({ children = "Required" }: { children?: ReactNode }) {
  return <span className="ml-1 text-xs font-normal text-destructive">— {children}</span>
}

// Presentational radio "option card" matching the mock's .opt / .opt.sel rows.
// Wraps a real <input type="radio"> so it stays a role="radio" element for
// tests and screen readers — only the visual treatment changes.
export function OptionCard({
  id,
  name,
  value,
  checked,
  onChange,
  label,
  hint,
  className,
}: {
  id: string
  name: string
  value: string
  checked: boolean
  onChange: () => void
  label: ReactNode
  hint?: ReactNode
  className?: string
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-center gap-2.5 rounded-[12px] border border-border px-3 py-2.5 text-sm transition-colors",
        checked && "border-foreground bg-foreground/[0.04] font-medium",
        className
      )}
    >
      <input
        type="radio"
        id={id}
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="sr-only"
      />
      <span
        aria-hidden="true"
        className={cn(
          "box-border size-4 shrink-0 rounded-full border-[1.5px] border-muted-foreground/40",
          checked && "border-foreground bg-foreground shadow-[inset_0_0_0_2.5px_var(--popover)]"
        )}
      />
      <span className="flex-1">{label}</span>
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  )
}

export function WorkflowDialogHeader({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <DialogHeader>
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription>{description}</DialogDescription>
    </DialogHeader>
  )
}

export function WorkflowDialogFooter({
  submitting,
  submitLabel,
  onCancel,
  destructive = false,
}: {
  submitting: boolean
  submitLabel: string
  onCancel: () => void
  destructive?: boolean
}) {
  return (
    <DialogFooter className="rounded-b-[22px]">
      <Button type="button" variant="outline" disabled={submitting} onClick={onCancel}>
        Cancel
      </Button>
      <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={submitting}>
        {submitting ? "Saving…" : submitLabel}
      </Button>
    </DialogFooter>
  )
}

export function FieldError({ message, id }: { message?: string; id?: string }) {
  if (!message) return null
  return <p id={id} className="text-xs text-destructive">{message}</p>
}

export function WorkflowFormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div className="flex items-start gap-2 rounded-[12px] border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  )
}

export function DateTimeField({
  id,
  label,
  value,
  onChange,
  error,
  required = true,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  error?: string
  required?: boolean
}) {
  const errorId = `${id}-error`
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <input
        id={id}
        type="datetime-local"
        value={value}
        aria-required={required}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        className="border-input bg-background flex h-[38px] w-full rounded-[12px] border px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      <FieldError id={errorId} message={error} />
      <p className="text-xs text-muted-foreground">Central time ({ACQUISITION_TIME_ZONE})</p>
    </div>
  )
}

export function centralDateTimeToIso(value: string):
  | { ok: true; value: string }
  | { ok: false; message: string } {
  if (!value) return { ok: false, message: "Choose a date and time." }
  const [date, time] = value.split("T")
  const converted = wallTimeToUtc({
    date: date || "",
    time: time || "",
    timeZone: ACQUISITION_TIME_ZONE,
  })
  if (converted.ok) return { ok: true, value: converted.utc.toISOString() }
  if (converted.reason === "nonexistent") {
    return { ok: false, message: "That time does not exist in Central time." }
  }
  return { ok: false, message: "Choose a valid Central date and time." }
}

export function useAcquisitionSubmit<T>(
  onSubmit: AcquisitionSubmit<T>,
  onSuccess: () => void
) {
  const submittingRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const clearErrors = () => {
    setError(null)
    setFieldErrors({})
  }

  const submit = async (payload: T) => {
    if (submittingRef.current) return false
    submittingRef.current = true
    setSubmitting(true)
    clearErrors()
    try {
      let result: AcquisitionFormSubmitResult
      try {
        result = await onSubmit(payload)
      } catch {
        result = { ok: false, message: "We couldn't save this change. Try again." }
      }
      if (!result.ok) {
        setError(result.message)
        setFieldErrors(result.fieldErrors || {})
        return false
      }
      onSuccess()
      return true
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  return { submitting, error, fieldErrors, clearErrors, submit }
}
