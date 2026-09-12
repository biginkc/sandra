import {
  AlertTriangle,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Clock3,
  Phone,
  UserRound,
} from "lucide-react"

import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { MyLeadDetailPanel } from "./detail-panel"
import {
  MY_LEAD_STAGE_LABELS,
  MY_LEAD_STAGE_ORDER,
  type MyLeadAction,
  type MyLeadDetailGroupName,
  type MyLeadDetailPageResult,
  type MyLeadDetailState,
  type MyLeadQueueRow,
  type MyLeadStage,
  type MyLeadWarning,
} from "./types"

const WARNING_LABELS: Record<MyLeadWarning, string> = {
  first_call_overdue: "First call overdue",
  missing_next_step: "No future next step",
  offer_needed_overdue: "Offer overdue",
  offer_follow_up_overdue: "Offer follow-up overdue",
}

const TEMPERATURE_CLASSES = {
  hot: "bg-red-500",
  warm: "bg-amber-500",
  cold: "bg-sky-500",
} as const

export const STAGE_COLORS: Record<MyLeadStage, string> = {
  not_contacted: "text-blue-700 dark:text-blue-300",
  contacted: "text-foreground",
  needs_offer: "text-amber-700 dark:text-amber-300",
  offer_sent: "text-violet-700 dark:text-violet-300",
  under_contract: "text-green-700 dark:text-green-300",
}

export const STAGE_NEXT: Record<MyLeadStage, string> = {
  not_contacted: "Next: place a call or log an outreach attempt.",
  contacted: "Next: plan a callback, or mark ready when the seller is ready for an offer.",
  needs_offer: "Next: log the offer with a follow-up time.",
  offer_sent: "Next: follow up and record the offer outcome.",
  under_contract: "Signed contract recorded. Archive only when you choose.",
}

const TEMPERATURE_BORDERS = {
  hot: "border-l-red-500",
  warm: "border-l-amber-500",
  cold: "border-l-sky-500",
} as const

const ACTIONS_BY_STAGE: Record<
  MyLeadStage,
  readonly { action: MyLeadAction; label: string }[]
> = {
  not_contacted: [
    { action: "start-call", label: "Start call" },
    { action: "log-attempt", label: "Log attempt" },
    { action: "contract-signed", label: "Contract signed" },
    { action: "handoff", label: "Handoff" },
  ],
  contacted: [
    { action: "start-call", label: "Start call" },
    { action: "log-attempt", label: "Log attempt" },
    { action: "ready-for-offer", label: "Ready to make an offer" },
    { action: "log-offer", label: "Log offer" },
    { action: "contract-signed", label: "Contract signed" },
    { action: "schedule-next-step", label: "Schedule next step" },
    { action: "handoff", label: "Handoff" },
  ],
  needs_offer: [
    { action: "start-call", label: "Start call" },
    { action: "log-attempt", label: "Log attempt" },
    { action: "log-offer", label: "Log offer" },
    { action: "contract-signed", label: "Contract signed" },
    { action: "handoff", label: "Handoff" },
  ],
  offer_sent: [
    { action: "start-call", label: "Start call" },
    { action: "log-attempt", label: "Log attempt" },
    { action: "contract-signed", label: "Contract signed" },
    { action: "decline-offer", label: "Offer declined" },
    { action: "handoff", label: "Handoff" },
  ],
  under_contract: [{ action: "archive", label: "Archive" }],
}

export type MyLeadQueueRowProps = {
  row: MyLeadQueueRow
  detailsOpen: boolean
  detailState?: MyLeadDetailState
  onToggleDetails: () => void
  onRetryDetails: () => void
  onDetailChanged?: () => void
  onLoadDetailPage?: (
    group: MyLeadDetailGroupName,
    cursor: string
  ) => Promise<MyLeadDetailPageResult>
  onStageAction: (action: MyLeadAction, row: MyLeadQueueRow) => void
}

export function MyLeadQueueRow({
  row,
  detailsOpen,
  detailState,
  onToggleDetails,
  onRetryDetails,
  onDetailChanged,
  onLoadDetailPage,
  onStageAction,
}: MyLeadQueueRowProps) {
  const temperature = row.motivation.temperature
  const motivationLabel =
    row.motivation.motivationResponseKind === "provided"
      ? row.motivation.text || "Motivation provided"
      : row.motivation.motivationResponseKind === "no_motivation_provided"
        ? "No motivation provided"
        : "Motivation unanswered"

  return (
    <article
      className={cn(
        "overflow-hidden rounded-[14px] border border-l-[3px] bg-card text-card-foreground",
        temperature ? TEMPERATURE_BORDERS[temperature] : "border-l-stone-300"
      )}
      data-testid={`my-lead-row-${row.propertyId}`}
    >
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50"
        aria-label={detailsOpen ? `Hide details for ${row.address}` : `Show details for ${row.address}`}
        aria-describedby={`my-lead-summary-${row.propertyId}`}
        aria-expanded={detailsOpen}
        aria-controls={`my-lead-detail-${row.propertyId}`}
        onClick={onToggleDetails}
      >
        <span
          className={cn("size-2.5 shrink-0 rounded-full", temperature ? TEMPERATURE_CLASSES[temperature] : "border-2 border-stone-300")}
          title={temperature ? `${capitalize(temperature)} motivation` : motivationLabel}
          aria-label={temperature ? `${temperature} temperature` : motivationLabel}
        />
        <span id={`my-lead-summary-${row.propertyId}`} className="flex min-w-0 flex-1 flex-col gap-x-4 gap-y-2 xl:flex-row xl:items-center">
          <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="break-words text-sm font-bold">{row.homeownerName || "Homeowner unavailable"}</span>
            <span className="break-words text-xs text-muted-foreground">{row.address}</span>
            {row.queueStage === "not_contacted" && <Badge variant="secondary" className="text-blue-700 dark:text-blue-300">New</Badge>}
            {row.archived && <Badge variant="secondary">Archived</Badge>}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
            <span className="tabular-nums">{row.attemptsCount} {row.attemptsCount === 1 ? "attempt" : "attempts"}</span>
            <span title={row.assignment.exactLabel} className="tabular-nums">{row.assignment.state === "known" ? `Assigned ${row.assignment.label}` : row.assignment.state === "launch_initialized" ? "Existing lead · assignment unknown" : "Assignment unavailable"}</span>
            {row.warningReasons.map((warning) => (
              <span key={warning} className="inline-flex max-w-full items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2 py-1 font-semibold text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
                <span className="break-words">{WARNING_LABELS[warning]}</span>
              </span>
            ))}
            {row.queueStage === "contacted" && row.nextStep && <span className="max-w-full break-words rounded-full bg-green-50 px-2 py-1 text-green-700 dark:bg-green-950 dark:text-green-200">{row.nextStep.kind === "callback" ? "Callback" : "Appointment"} · {row.nextStep.label}</span>}
            {row.queueStage === "needs_offer" && !row.warningReasons.includes("offer_needed_overdue") && <span className="rounded-full bg-amber-50 px-2 py-1 text-amber-800 dark:bg-amber-950 dark:text-amber-200">Offer needed</span>}
            {row.offer && <span className="rounded-full bg-violet-50 px-2 py-1 font-semibold text-violet-700 dark:bg-violet-950 dark:text-violet-200">{row.offer.amountLabel} · {capitalize(row.offer.outcome)}</span>}
          </span>
        </span>
        {detailsOpen ? <ChevronUp className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
      </button>

      <div id={`my-lead-detail-${row.propertyId}`} hidden={!detailsOpen}>
      {detailsOpen && <>
      <p className="flex items-center gap-2 border-t px-4 pt-3 text-sm text-muted-foreground"><Phone className="size-3.5" aria-hidden="true" />{row.phone || "Phone unavailable"}</p>
      <div className="grid gap-4 border-t px-4 py-4 text-sm sm:grid-cols-2">
        <InfoItem icon={<UserRound aria-hidden="true" />} label="Assigned">
          <span title={row.assignment.exactLabel}>{row.assignment.label || "Assignment unavailable"}</span>
          {row.assignment.state === "launch_initialized" && (
            <span className="text-xs text-muted-foreground">Initialized at launch</span>
          )}
          {row.assignment.state === "unknown" && (
            <span className="text-xs text-muted-foreground">Assignment unavailable</span>
          )}
        </InfoItem>

        <InfoItem icon={<Phone aria-hidden="true" />} label="First call">
          <span title={row.firstCall.exactLabel}>{row.firstCall.label || firstCallLabel(row.firstCall.state)}</span>
          <span className="text-xs text-muted-foreground">
            {row.attemptsCount} {row.attemptsCount === 1 ? "attempt" : "attempts"}
          </span>
        </InfoItem>

        <InfoItem icon={<Clock3 aria-hidden="true" />} label="Motivation">
          <span className="inline-flex items-start gap-1.5">
            {temperature && (
              <span
                className={cn("size-2 rounded-full", TEMPERATURE_CLASSES[temperature])}
                aria-label={`${temperature} temperature`}
              />
            )}
            {temperature ? `${capitalize(temperature)} · ` : ""}
            {motivationLabel}
          </span>
        </InfoItem>

        <InfoItem icon={<CalendarClock aria-hidden="true" />} label="Next step">
          <span>{row.nextStep?.label || "No future callback or appointment"}</span>
        </InfoItem>
      </div>

      <div className="space-y-3 border-t px-4 py-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Where it is</p>
        <ol aria-label="Lead progress" className="flex flex-wrap gap-x-4 gap-y-3 text-xs">
          {MY_LEAD_STAGE_ORDER.map((stage) => (
            <li key={stage} aria-current={stage === row.queueStage ? "step" : undefined} className={cn("flex items-center gap-2", stage === row.queueStage ? "font-bold text-foreground" : "text-muted-foreground")}>
              <span aria-hidden="true" className={cn("size-2.5 shrink-0 rounded-full border-2", stage === row.queueStage ? "border-blue-600 bg-blue-600 ring-2 ring-blue-200" : "border-stone-300")} />
              {MY_LEAD_STAGE_LABELS[stage]}
            </li>
          ))}
        </ol>
        <p className="text-sm text-muted-foreground">{STAGE_NEXT[row.queueStage]}</p>
      </div>

      {row.offer && (
        <div className="border-t px-4 py-2 text-sm">
          <span className="font-medium">Offer: {row.offer.amountLabel}</span>
          <span className="ml-2 text-muted-foreground">
            {row.offer.method} · Sent {row.offer.sentLabel}
            {row.offer.followUpLabel && ` · Follow-up ${row.offer.followUpLabel}`}
          </span>
          {row.offer.outcome !== "pending" && (
            <Badge variant="secondary" className="ml-2">
              {capitalize(row.offer.outcome)}
            </Badge>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2 border-t bg-muted/20 px-4 py-3">
        {ACTIONS_BY_STAGE[row.queueStage].map(({ action, label }) => (
          <Button
            key={action}
            type="button"
            variant={action === "start-call" || action === "log-attempt" || action === "log-offer" ? "default" : "outline"}
            size="sm"
            onClick={(event) => {
              event.stopPropagation()
              onStageAction(action, row)
            }}
          >
            {label}
          </Button>
        ))}
        <Link href={`/leads/${row.propertyId}`} prefetch={false} className={buttonVariants({ variant: "outline", size: "sm" })}>Open lead</Link>
        {row.zillowHref && <a href={row.zillowHref} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}><ExternalLink aria-hidden="true" /> Open in Zillow</a>}
      </div>

      <MyLeadDetailPanel
            state={detailState ?? { status: "loading" }}
            onRetry={onRetryDetails}
            propertyId={row.propertyId}
            onChanged={onDetailChanged ? () => onDetailChanged() : undefined}
            onLoadDetailPage={onLoadDetailPage}
          />
      </>}
      </div>
    </article>
  )
}

function InfoItem({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span className="[&>svg]:size-3.5">{icon}</span>
        {label}
      </p>
      <div className="flex min-w-0 flex-col break-words whitespace-normal text-foreground">{children}</div>
    </div>
  )
}

function firstCallLabel(state: MyLeadQueueRow["firstCall"]["state"]) {
  switch (state) {
    case "started":
      return "First call started"
    case "unavailable":
      return "First-call timing unavailable"
    default:
      return "First call pending"
  }
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
