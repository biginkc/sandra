"use client"

import { useState, type FormEvent } from "react"

import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { motivationResponse } from "@/lib/my-leads/validation"
import {
  DIALOG_CONTENT_CLASS,
  FieldError,
  OptionCard,
  SELECT_FIELD_CLASS,
  TEXT_FIELD_CLASS,
  WorkflowDialogFooter,
  WorkflowDialogHeader,
  WorkflowFormError,
  useAcquisitionSubmit,
} from "./workflow-form"
import type {
  AcquisitionFormSubmitResult,
  AcquisitionMotivationResponse,
  AcquisitionReadinessFormPayload,
  AcquisitionSubmit,
  AcquisitionTemperature,
} from "./types"

export type AcquisitionReadinessDialogProps = {
  open: boolean
  propertyId: string
  propertyLabel: string
  initialTemperature?: AcquisitionTemperature
  initialMotivationResponse?: AcquisitionMotivationResponse | null
  onOpenChange: (open: boolean) => void
  onSubmit: AcquisitionSubmit<AcquisitionReadinessFormPayload>
}

export function AcquisitionReadinessDialog({
  open,
  propertyId,
  propertyLabel,
  initialTemperature = null,
  initialMotivationResponse = null,
  onOpenChange,
  onSubmit,
}: AcquisitionReadinessDialogProps) {
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
    const response = motivationResponse(motivationKind, motivationText)
    if (!response.ok) {
      setClientError("Review the highlighted fields.")
      setClientFieldErrors({ motivationText: response.message })
      return
    }
    await submitState.submit({
      propertyId,
      motivationResponse: response.value,
      temperature,
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
          title="Ready to make an offer"
          description={`Capture the seller's motivation before moving ${propertyLabel} to Needs offer / Interested.`}
        />
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
            <WorkflowFormError message={clientError || submitState.error} />

            <div className="flex flex-col gap-2">
              <Label id="acquisition-readiness-motivation-label">Motivation response</Label>
              <div role="radiogroup" aria-labelledby="acquisition-readiness-motivation-label" className="flex flex-col gap-2">
                <OptionCard
                  id="acquisition-motivation-specified"
                  name="acquisition-motivation-response"
                  value="specified"
                  checked={motivationKind === "specified"}
                  onChange={() => {
                    setMotivationKind("specified")
                    clearClientErrors()
                  }}
                  label="Seller specified a motivation"
                />
                <OptionCard
                  id="acquisition-motivation-none"
                  name="acquisition-motivation-response"
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
                  <Label htmlFor="acquisition-motivation-text">Motivation</Label>
                  <Textarea
                    id="acquisition-motivation-text"
                    value={motivationText}
                    onChange={(event) => setMotivationText(event.target.value)}
                    aria-invalid={Boolean(clientFieldErrors.motivationText || submitState.fieldErrors.motivationText)}
                    aria-describedby={clientFieldErrors.motivationText || submitState.fieldErrors.motivationText ? "acquisition-motivation-text-error" : undefined}
                    placeholder="What is driving the seller?"
                    rows={4}
                    className={TEXT_FIELD_CLASS}
                  />
                  <FieldError id="acquisition-motivation-text-error" message={clientFieldErrors.motivationText || submitState.fieldErrors.motivationText} />
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="acquisition-motivation-temperature">Temperature (optional)</Label>
              <select
                id="acquisition-motivation-temperature"
                value={temperature || ""}
                onChange={(event) => setTemperature((event.target.value || null) as AcquisitionTemperature)}
                className={SELECT_FIELD_CLASS}
              >
                <option value="">Keep temperature unchanged</option>
                <option value="hot">Hot</option>
                <option value="warm">Warm</option>
                <option value="cold">Cold</option>
              </select>
              <p className="text-xs text-muted-foreground">Temperature is separate from the motivation response.</p>
            </div>
          </div>
          <WorkflowDialogFooter
            submitting={submitState.submitting}
            submitLabel="Save readiness"
            onCancel={closeDialog}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

export type AcquisitionReadinessSubmitResult = AcquisitionFormSubmitResult
