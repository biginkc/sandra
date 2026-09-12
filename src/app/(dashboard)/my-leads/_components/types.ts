export const MY_LEAD_STAGE_ORDER = [
  "not_contacted",
  "contacted",
  "needs_offer",
  "offer_sent",
  "under_contract",
] as const

export type MyLeadStage = (typeof MY_LEAD_STAGE_ORDER)[number]

export const MY_LEAD_STAGE_LABELS: Record<MyLeadStage, string> = {
  not_contacted: "Not contacted",
  contacted: "Contacted",
  needs_offer: "Needs offer / Interested",
  offer_sent: "Offer Sent",
  under_contract: "Under Contract",
}

export type MyLeadWarning =
  | "first_call_overdue"
  | "missing_next_step"
  | "offer_needed_overdue"
  | "offer_follow_up_overdue"

export type MyLeadTemperature = "hot" | "warm" | "cold" | null

/** Keep the existing temperature separate from the explicit response state. */
export type MyLeadMotivationResponseKind =
  | "provided"
  | "no_motivation_provided"
  | "unanswered"

export type MyLeadAssignmentState =
  | "known"
  | "launch_initialized"
  | "unknown"

export type MyLeadFirstCallState = "pending" | "started" | "unavailable"

export type MyLeadQueueRow = {
  propertyId: string
  queueStage: MyLeadStage
  address: string
  zillowHref?: string | null
  homeownerName: string | null
  phone: string | null
  assignment: {
    label: string
    exactLabel?: string
    state: MyLeadAssignmentState
  }
  firstCall: {
    exactLabel?: string
    state: MyLeadFirstCallState
    label: string | null
  }
  warningReasons: readonly MyLeadWarning[]
  attemptsCount: number
  motivation: {
    temperature: MyLeadTemperature
    motivationResponseKind: MyLeadMotivationResponseKind
    text: string | null
  }
  nextStep: {
    kind: "callback" | "appointment"
    label: string
  } | null
  offer: {
    amountLabel: string
    method: string
    sentLabel: string
    followUpLabel: string | null
    outcome: "pending" | "accepted" | "declined"
  } | null
  archived: boolean
}

export type MyLeadStagePage = {
  stage: MyLeadStage
  rows: readonly MyLeadQueueRow[]
  totalCount: number
  hasMore: boolean
  isLoadingMore?: boolean
}

/** Labels are preformatted by the query adapter so this component does no date math. */
export type MyLeadsKpis = {
  attempts: number
  contactRateLabel: string | null
  assignToFirstCallLabel: string | null
  appointmentsKeptLabel: string | null
  offersSent: number
  staleLeads: number
}

export type MyLeadRepOption = {
  id: string
  label: string
}

export type MyLeadsPeriod = "today" | "week" | "month" | "custom"

export type MyLeadDateRange = {
  startDate: string
  endDate: string
}

export type MyLeadAction =
  | "start-call"
  | "log-attempt"
  | "ready-for-offer"
  | "log-offer"
  | "contract-signed"
  | "decline-offer"
  | "handoff"
  | "archive"
  | "schedule-next-step"

export type MyLeadNote = {
  id: string
  authorLabel: string
  body: string
  createdLabel: string
}

export type MyLeadAttempt = {
  id: string
  actorLabel: string
  outcomeLabel: string
  occurredLabel: string
  sourceLabel?: string
  recordingUrl?: string | null
}

export type MyLeadAppointment = {
  id: string
  label: string
  dueLabel: string
  statusLabel: string
  /** Present only when the existing appointment lifecycle can safely act on this row. */
  lifecycleAction?: MyLeadAppointmentActionTarget
  /** Present only when this task is a callback and the existing task controls can act on it. */
  callbackAction?: MyLeadCallbackActionTarget
}

export type MyLeadAppointmentActionTarget = {
  taskId: string
  assigneeId: string
  state: "past_due" | "upcoming"
}

export type MyLeadCallbackActionTarget = {
  taskId: string
}

export type MyLeadOffer = {
  id: string
  amountLabel: string
  method: string
  sentLabel: string
  outcomeLabel: string
}

export type MyLeadHistoryEvent = {
  id: string
  label: string
  createdLabel: string
}

export type MyLeadDetailGroup<T> = {
  rows: readonly T[]
  hasMore: boolean
  nextCursor: string | null
}

export type MyLeadDetail = {
  notes: MyLeadDetailGroup<MyLeadNote>
  attempts: MyLeadDetailGroup<MyLeadAttempt>
  appointments: MyLeadDetailGroup<MyLeadAppointment>
  offers: MyLeadDetailGroup<MyLeadOffer>
  history: MyLeadDetailGroup<MyLeadHistoryEvent>
}

export type MyLeadDetailResult =
  | { ok: true; detail: MyLeadDetail }
  | { ok: false; message: string }

export type MyLeadDetailState =
  | { status: "loading" }
  | { status: "ready"; detail: MyLeadDetail }
  | { status: "error"; message: string }

export type MyLeadDetailGroupName = keyof MyLeadDetail

export type MyLeadDetailPageResult =
  | { ok: true; group: "notes"; page: MyLeadDetailGroup<MyLeadNote> }
  | { ok: true; group: "attempts"; page: MyLeadDetailGroup<MyLeadAttempt> }
  | { ok: true; group: "appointments"; page: MyLeadDetailGroup<MyLeadAppointment> }
  | { ok: true; group: "offers"; page: MyLeadDetailGroup<MyLeadOffer> }
  | { ok: true; group: "history"; page: MyLeadDetailGroup<MyLeadHistoryEvent> }
  | { ok: false; message: string }

export type AcquisitionCallReferenceOption = {
  id: string
  label: string
}

export type MyLeadsQueueProps = {
  stages: Readonly<Record<MyLeadStage, MyLeadStagePage>>
  kpis: MyLeadsKpis
  search: string
  selectedRepId: string
  selectedPeriod: MyLeadsPeriod
  selectedDateRange: MyLeadDateRange | null
  repOptions: readonly MyLeadRepOption[]
  selectedRepLabel?: string | null
  canSelectRep?: boolean
  onSearchChange: (value: string) => void
  onRepChange: (repId: string) => void
  onPeriodChange: (period: MyLeadsPeriod) => void
  onDateRangeChange: (range: MyLeadDateRange) => void
  onLoadMore: (stage: MyLeadStage) => void | Promise<void>
  onLoadDetail: (propertyId: string) => Promise<MyLeadDetailResult>
  onLoadDetailPage?: (
    propertyId: string,
    group: MyLeadDetailGroupName,
    cursor: string
  ) => Promise<MyLeadDetailPageResult>
  /** Increments after a successful workflow mutation so open rows refetch detail. */
  detailRevision?: number
  /** Called after a confirmed existing note/appointment mutation. */
  onLeadChanged?: (propertyId: string) => void
  onStageAction: (action: MyLeadAction, row: MyLeadQueueRow) => void
}

export type MyLeadDetailPanelProps = {
  state: MyLeadDetailState
  onRetry: () => void
  propertyId?: string
  onChanged?: (group: "notes" | "appointments") => void
  onLoadDetailPage?: (
    group: MyLeadDetailGroupName,
    cursor: string
  ) => Promise<MyLeadDetailPageResult>
}

export type AcquisitionFormSubmitResult =
  | { ok: true }
  | { ok: false; message: string; fieldErrors?: Record<string, string> }

export type AcquisitionAttemptFormPayload = {
  propertyId: string
  kind: AcquisitionAttemptKind
  source: AcquisitionAttemptSource
  outcome: AcquisitionAttemptOutcome
  occurredAt: string
  note: string | null
  recordingUrl: string | null
  callActivityId: string | null
}

export type AcquisitionTemperature = "hot" | "warm" | "cold" | null

export type AcquisitionReadinessFormPayload = {
  propertyId: string
  motivationResponse: AcquisitionMotivationResponse
  temperature: AcquisitionTemperature
}

export type AcquisitionOfferFormPayload = {
  propertyId: string
  amountCents: number
  method: AcquisitionOfferMethod
  sentAt: string
  followUpAt: string
  motivationResponse: AcquisitionMotivationResponse | null
  temperature: AcquisitionTemperature
}

export type AcquisitionLifecycleMode =
  | "contract-signed"
  | "decline-offer"
  | "handoff"
  | "archive"

export type AcquisitionLifecycleFormPayload =
  | {
      propertyId: string
      mode: "contract-signed"
      signedAt: string
      offerId: string | null
    }
  | {
      propertyId: string
      mode: "decline-offer"
      pendingOfferId: string
      occurredAt: string
    }
  | {
      propertyId: string
      mode: "handoff"
      reason: "not_interested" | "needs_nurture"
      recipientUserId: string
    }
  | {
      propertyId: string
      mode: "archive"
      confirmed: true
    }

export type AcquisitionSubmit<T> = (
  payload: T
) => Promise<AcquisitionFormSubmitResult>
import type {
  AcquisitionAttemptKind,
  AcquisitionAttemptOutcome,
  AcquisitionAttemptSource,
  AcquisitionMotivationResponse,
  AcquisitionOfferMethod,
} from "@/lib/my-leads/types"

export type {
  AcquisitionAttemptKind,
  AcquisitionAttemptOutcome,
  AcquisitionAttemptSource,
  AcquisitionMotivationResponse,
  AcquisitionOfferMethod,
} from "@/lib/my-leads/types"
