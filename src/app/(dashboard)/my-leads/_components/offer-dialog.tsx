"use client"

import { useState, type FormEvent } from "react"

import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { motivationResponse, offerAmountCents, offerFollowUp } from "@/lib/my-leads/validation"
import {
  DIALOG_CONTENT_CLASS,
  DateTimeField,
  FieldError,
  OptionCard,
  SELECT_FIELD_CLASS,
  TEXT_FIELD_CLASS,
  WorkflowDialogFooter,
  WorkflowDialogHeader,
  WorkflowFormError,
  centralDateTimeToIso,
  useAcquisitionSubmit,
} from "./workflow-form"
import type {
  AcquisitionFormSubmitResult,
  AcquisitionMotivationResponse,
  AcquisitionOfferFormPayload,
  AcquisitionOfferMethod,
  AcquisitionSubmit,
  AcquisitionTemperature,
} from "./types"

export type AcquisitionOfferDialogProps = {
  open: boolean
  propertyId: string
  propertyLabel: string
  motivationRequired: boolean
  initialTemperature?: AcquisitionTemperature
  initialMotivationResponse?: AcquisitionMotivationResponse | null
  onOpenChange: (open: boolean) => void
  onSubmit: AcquisitionSubmit<AcquisitionOfferFormPayload>
}

export function AcquisitionOfferDialog({
  open,
  propertyId,
  propertyLabel,
  motivationRequired,
  initialTemperature = null,
  initialMotivationResponse = null,
  onOpenChange,
  onSubmit,
}: AcquisitionOfferDialogProps) {
  const [amount, setAmount] = useState("")
  const [method, setMethod] = useState<AcquisitionOfferMethod | "">("")
  const [sentAt, setSentAt] = useState("")
  const [followUpAt, setFollowUpAt] = useState("")
  const [motivationKind, setMotivationKind] = useState<"specified" | "no_motivation">(
    initialMotivationResponse?.kind || "specified"
  )
  const [motivationText, setMotivationText] = useState(
    initialMotivationResponse?.kind === "specified" ? initialMotivationResponse.text : ""
  )
  const [temperature, setTemperature] = useState<AcquisitionTemperature>(initialTemperature)
  const [clientError, setClientError] = useState<string | null>(null)
  const [clientFieldErrors, setClientFieldErrors] = useState<Record<string, string>>({})
  const resetFields = () => {
    setAmount("")
    setMethod("")
    setSentAt("")
    setFollowUpAt("")
    setMotivationKind(initialMotivationResponse?.kind || "specified")
    setMotivationText(
      initialMotivationResponse?.kind === "specified" ? initialMotivationResponse.text : ""
    )
    setTemperature(initialTemperature)
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

    const amountResult = offerAmountCents(amount)
    if (!amountResult.ok) nextFieldErrors.amount = amountResult.message
    if (!method) nextFieldErrors.method = "Choose how the offer was made."
    const sentResult = centralDateTimeToIso(sentAt)
    if (!sentResult.ok) nextFieldErrors.sentAt = sentResult.message
    const followUpResult = centralDateTimeToIso(followUpAt)
    if (!followUpResult.ok) nextFieldErrors.followUpAt = followUpResult.message

    let response: AcquisitionMotivationResponse | null = null
    if (motivationRequired) {
      const motivationResult = motivationResponse(motivationKind, motivationText)
      if (!motivationResult.ok) nextFieldErrors.motivationText = motivationResult.message
      else response = motivationResult.value
    }

    if (sentResult.ok && followUpResult.ok) {
      const followUpValidation = offerFollowUp(sentResult.value, followUpResult.value)
      if (!followUpValidation.ok) nextFieldErrors.followUpAt = followUpValidation.message
    }

    if (
      Object.keys(nextFieldErrors).length > 0 ||
      !amountResult.ok ||
      !method ||
      !sentResult.ok ||
      !followUpResult.ok
    ) {
      setClientError("Review the highlighted fields.")
      setClientFieldErrors(nextFieldErrors)
      return
    }

    await submitState.submit({
      propertyId,
      amountCents: amountResult.value,
      method,
      sentAt: sentResult.value,
      followUpAt: followUpResult.value,
      motivationResponse: response,
      temperature,
    })
  }

  const fieldError = (field: string) => clientFieldErrors[field] || submitState.fieldErrors[field]

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
          title="Log offer"
          description={`Record the offer already made to ${propertyLabel}. This does not send a contract or create a follow-up task.`}
        />
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
            <WorkflowFormError message={clientError || submitState.error} />

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="acquisition-offer-amount">Offer amount</Label>
                <div className="flex items-center gap-1.5 rounded-[12px] border border-border px-3 has-focus-visible:border-ring has-focus-visible:ring-3 has-focus-visible:ring-ring/50">
                  <span className="text-sm font-semibold text-muted-foreground">$</span>
                  <Input
                    id="acquisition-offer-amount"
                    inputMode="decimal"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    placeholder="0.00"
                    aria-invalid={Boolean(fieldError("amount"))}
                    aria-describedby={fieldError("amount") ? "acquisition-offer-amount-error" : undefined}
                    aria-required="true"
                    className="h-[36px] border-0 px-0 font-semibold shadow-none focus-visible:ring-0"
                  />
                </div>
                <FieldError id="acquisition-offer-amount-error" message={fieldError("amount")} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="acquisition-offer-method">Offer method</Label>
                <select
                  id="acquisition-offer-method"
                  value={method}
                  onChange={(event) => setMethod(event.target.value as AcquisitionOfferMethod)}
                  aria-invalid={Boolean(fieldError("method"))}
                  aria-describedby={fieldError("method") ? "acquisition-offer-method-error" : undefined}
                  aria-required="true"
                  className={SELECT_FIELD_CLASS}
                >
                  <option value="">Choose method</option>
                  <option value="verbal">Verbal</option>
                  <option value="email_text">Email / text</option>
                  <option value="dropbox_sign">Dropbox Sign (logging only)</option>
                </select>
                <FieldError id="acquisition-offer-method-error" message={fieldError("method")} />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <DateTimeField
                id="acquisition-offer-sent-at"
                label="Offer sent"
                value={sentAt}
                onChange={setSentAt}
                error={fieldError("sentAt")}
              />
              <DateTimeField
                id="acquisition-offer-follow-up-at"
                label="Required follow-up"
                value={followUpAt}
                onChange={setFollowUpAt}
                error={fieldError("followUpAt")}
              />
            </div>

            {motivationRequired ? (
              <div className="flex flex-col gap-2">
                <Label id="acquisition-offer-motivation-label">Motivation response</Label>
                <div role="radiogroup" aria-labelledby="acquisition-offer-motivation-label" className="flex flex-col gap-2">
                  <OptionCard
                    id="acquisition-offer-motivation-specified"
                    name="acquisition-offer-motivation-response"
                    value="specified"
                    checked={motivationKind === "specified"}
                    onChange={() => {
                      setMotivationKind("specified")
                      clearClientErrors()
                    }}
                    label="Seller specified a motivation"
                  />
                  <OptionCard
                    id="acquisition-offer-motivation-none"
                    name="acquisition-offer-motivation-response"
                    value="no_motivation"
                    checked={motivationKind === "no_motivation"}
                    onChange={() => {
                      setMotivationKind("no_motivation")
                      setMotivationText("")
                      clearClientErrors()
                    }}
                    label="No motivation provided"
                  />
                </div>
                {motivationKind === "specified" && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="acquisition-offer-motivation-text">Motivation</Label>
                    <Textarea
                      id="acquisition-offer-motivation-text"
                      value={motivationText}
                      onChange={(event) => setMotivationText(event.target.value)}
                      aria-invalid={Boolean(fieldError("motivationText"))}
                      aria-describedby={fieldError("motivationText") ? "acquisition-offer-motivation-text-error" : undefined}
                      placeholder="What is driving the seller?"
                      rows={3}
                      className={TEXT_FIELD_CLASS}
                    />
                    <FieldError id="acquisition-offer-motivation-text-error" message={fieldError("motivationText")} />
                  </div>
                )}
              </div>
            ) : (
              <p className="rounded-[12px] border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                Motivation is already recorded for this lead.
              </p>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="acquisition-offer-temperature">Temperature (optional)</Label>
              <select
                id="acquisition-offer-temperature"
                value={temperature || ""}
                onChange={(event) => setTemperature((event.target.value || null) as AcquisitionTemperature)}
                className={SELECT_FIELD_CLASS}
              >
                <option value="">Keep temperature unchanged</option>
                <option value="hot">Hot</option>
                <option value="warm">Warm</option>
                <option value="cold">Cold</option>
              </select>
            </div>
          </div>
          <WorkflowDialogFooter
            submitting={submitState.submitting}
            submitLabel="Save offer"
            onCancel={closeDialog}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

export type AcquisitionOfferSubmitResult = AcquisitionFormSubmitResult
