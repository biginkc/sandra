import {
  AlertTriangle,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  Clock3,
  Phone,
  UserRound,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { MyLeadDetailPanel } from "./detail-panel"
import {
  MY_LEAD_STAGE_LABELS,
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
  const stageLabel = MY_LEAD_STAGE_LABELS[row.queueStage]
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
        "overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm",
        row.warningReasons.length > 0 && "border-l-4 border-l-red-500"
      )}
      data-testid={`my-lead-row-${row.propertyId}`}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        <button
          type="button"
          className="min-w-0 flex-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          aria-expanded={detailsOpen}
          aria-controls={`my-lead-detail-${row.propertyId}`}
          onClick={onToggleDetails}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-semibold text-foreground">{row.address}</span>
            <Badge variant="outline">{stageLabel}</Badge>
            {row.archived && <Badge variant="secondary">Archived</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <span>{row.homeownerName || "Homeowner unavailable"}</span>
            {row.phone && (
              <span className="inline-flex items-center gap-1">
                <Phone className="size-3.5" aria-hidden="true" />
                {row.phone}
              </span>
            )}
          </div>
        </button>

        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={detailsOpen ? `Hide details for ${row.address}` : `Show details for ${row.address}`}
          aria-expanded={detailsOpen}
          onClick={onToggleDetails}
        >
          {detailsOpen ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        </Button>
      </div>

      <div className="grid gap-3 border-t px-4 py-3 text-sm md:grid-cols-2 xl:grid-cols-4">
        <InfoItem icon={<UserRound aria-hidden="true" />} label="Assigned to">
          <span>{row.assignment.label || "Assignment unavailable"}</span>
          {row.assignment.state === "launch_initialized" && (
            <span className="text-xs text-muted-foreground">Initialized at launch</span>
          )}
          {row.assignment.state === "unknown" && (
            <span className="text-xs text-muted-foreground">Assignment unavailable</span>
          )}
        </InfoItem>

        <InfoItem icon={<Phone aria-hidden="true" />} label="First call">
          <span>{row.firstCall.label || firstCallLabel(row.firstCall.state)}</span>
          <span className="text-xs text-muted-foreground">
            {row.attemptsCount} {row.attemptsCount === 1 ? "attempt" : "attempts"}
          </span>
        </InfoItem>

        <InfoItem icon={<Clock3 aria-hidden="true" />} label="Motivation">
          <span className="inline-flex items-center gap-1.5">
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

      {row.warningReasons.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t bg-red-50/60 px-4 py-2 dark:bg-red-950/20">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-600" aria-hidden="true" />
          {row.warningReasons.map((warning) => (
            <Badge key={warning} variant="destructive">
              {WARNING_LABELS[warning]}
            </Badge>
          ))}
        </div>
      )}

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

      <div className="flex flex-wrap gap-2 border-t bg-muted/20 px-4 py-2.5">
        {ACTIONS_BY_STAGE[row.queueStage].map(({ action, label }) => (
          <Button
            key={action}
            type="button"
            variant={action === "start-call" || action === "log-attempt" || action === "log-offer" ? "default" : "outline"}
            size="xs"
            onClick={(event) => {
              event.stopPropagation()
              onStageAction(action, row)
            }}
          >
            {label}
          </Button>
        ))}
      </div>

      {detailsOpen && detailState && (
        <div id={`my-lead-detail-${row.propertyId}`}>
          <MyLeadDetailPanel
            state={detailState}
            onRetry={onRetryDetails}
            propertyId={row.propertyId}
            onChanged={onDetailChanged ? () => onDetailChanged() : undefined}
            onLoadDetailPage={onLoadDetailPage}
          />
        </div>
      )}
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
      <div className="flex min-w-0 flex-col truncate text-foreground">{children}</div>
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
