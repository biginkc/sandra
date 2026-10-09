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
  /** "In Call next: <reason>" when the lead is currently in the Call next strip. */
  stripReason?: string
  dripReply?: import('@/lib/my-leads/drip-queries').MyLeadDrip | null
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
  nextStep:
    | { kind: "appointment"; mode: "phone" | "in_person"; label: string; dueAt?: string }
    // Legacy rows only, until the next-step read-model migration applies.
    | { kind: "callback"; label: string; dueAt?: string }
    | null
  offer: {
    amountLabel: string
    method: string
    sentLabel: string
    followUpLabel: string | null
    outcome: "pending" | "accepted" | "declined" | "superseded"
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

export type MyLeadsKpis = Pick<import("@/lib/my-leads/queries").AcquisitionKpis,
  "attempts" | "reached" | "offersSent" | "contactWithoutFollowUp" | "needsOffers" | "appointmentsOverdue" |
  "lastAttemptAt" | "lastAttemptClockVersion" | "asOf" | "missingRecordings" | "recordingExpectationUnknown" | "averageTalkSeconds" |
  "talkTimeSamples" | "talkTimeUnknown" | "conversationsOverFiveMinutes">

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
  callActivityId?: string | null
  /** A Dialpad call's activity id: Sandra's own copy of the recording plays only when it is authorized and stored. */
  dialpadCallActivityId?: string | null
  followUpObligationId?: string | null
  followUpStatus?: "required" | "draft" | "claimed" | "sending" | "accepted" | "delivered" | "failed_not_dispatched" | "unknown" | "blocked" | "delivery_failed" | "voided" | "exception_closed" | null
  followUpMessage?: string | null
  followUpBlockedReason?: string | null
  note?: string | null
}

export type MyLeadAppointment = {
  id: string
  label: string
  dueLabel: string
  statusLabel: string
  /** ISO due time and task type, exposed as data-next-step-* attributes (seam S4). */
  dueAt?: string
  taskType?: "appointment" | "callback"
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

export type MyLeadSmsMessage = {
  id: string
  body: string
  direction: "inbound" | "outbound"
  createdAt: string
  createdLabel: string
  deliveryStatus: string
  attachmentCount: number
}

export type MyLeadDetailGroup<T> = {
  rows: readonly T[]
  hasMore: boolean
  nextCursor: string | null
}

export type MyLeadDetail = {
  /** Newest first, including earlier pages; the strip reverses the complete group. */
  messages: MyLeadDetailGroup<MyLeadSmsMessage>
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
  | { ok: true; group: "messages"; page: MyLeadDetailGroup<MyLeadSmsMessage> }
  | { ok: true; group: "notes"; page: MyLeadDetailGroup<MyLeadNote> }
  | { ok: true; group: "attempts"; page: MyLeadDetailGroup<MyLeadAttempt> }
  | { ok: true; group: "appointments"; page: MyLeadDetailGroup<MyLeadAppointment> }
  | { ok: true; group: "offers"; page: MyLeadDetailGroup<MyLeadOffer> }
  | { ok: true; group: "history"; page: MyLeadDetailGroup<MyLeadHistoryEvent> }
  | { ok: false; message: string }

export type AcquisitionCallReferenceOption = {
  id: string
  label: string
  /** From the linked call; null when the read predates the P1c migration. */
  callOutcome?: string | null
  talkSeconds?: number | null
  provider?: string | null
}

export type MyLeadsQueueProps = {
  stages: Readonly<Record<MyLeadStage, MyLeadStagePage>>
  drips?: import('@/lib/my-leads/drip-queries').MyLeadDripSnapshot | null
  kpis: MyLeadsKpis
  search: string
  selectedRepId: string
  repOptions: readonly MyLeadRepOption[]
  selectedRepLabel?: string | null
  canSelectRep?: boolean
  /** Background queue replacement must not remove open detail/media controls. */
  onReviewingChange?: (active: boolean) => void
  onSearchChange: (value: string) => void
  onRepChange: (repId: string) => void
  onLoadMore: (stage: MyLeadStage) => void | Promise<void>
  onLoadDetail: (propertyId: string) => Promise<MyLeadDetailResult>
  onLoadDetailPage?: (
    propertyId: string,
    group: MyLeadDetailGroupName,
    cursor: string | null
  ) => Promise<MyLeadDetailPageResult>
  /** Increments after a successful workflow mutation so open rows refetch detail. */
  detailRevision?: number
  /** Lead opened from a deep link; starts expanded and scrolled into view. */
  focusPropertyId?: string | null
  /** Changes for every new deep-link navigation, so a repeated target re-focuses. */
  focusNonce?: number
  /** The deep-linked lead when no loaded page has it; pinned at the top of its section. */
  pinnedRow?: MyLeadQueueRow | null
  /** Called after a confirmed existing note/appointment mutation. */
  onLeadChanged?: (propertyId: string) => void
  onStageAction: (action: MyLeadAction, row: MyLeadQueueRow) => void
}

/** Props of the Call next strip (P1b). The strip is read-only derived data. */
export type MyLeadsStripProps = {
  rows: readonly import("@/lib/my-leads/call-next").CallNextRow[]
  excluded: readonly import("@/lib/my-leads/call-next").CallNextExcluded[]
  hiddenCount: number
  snapshotAt: string
  /** False when an owner views a rep's strip: reading is allowed, acting is not. */
  canAct: boolean
  busyPropertyId?: string | null
  error?: string | null
  triageOpen: boolean
  triage: import("@/lib/my-leads/call-next").TriageSnapshot | null
  triageLoading: boolean
  triageError: string | null
  onToggleTriage: () => void
  onLoadMoreTriage: () => void
  onCall: (propertyId: string) => void
  onCallToday: (propertyId: string) => void
  onNotToday: (propertyId: string) => void
  /** Opens the existing handoff dialog (its reason field stays required). */
  onDeadNurture: (propertyId: string) => void
  /**
   * Client-side pins (P2 2.8): these leads sort first, in this order, and show the given reason text
   * ("Callback due now") instead of the ranked reason. The ranking RPC is untouched.
   */
  pinned?: readonly { propertyId: string; reason: string }[]
}

export type MyLeadDetailPanelProps = {
  visible?: boolean
  state: MyLeadDetailState
  onRetry: () => void
  propertyId?: string
  onChanged?: (group: "notes" | "appointments") => void
  onLoadDetailPage?: (
    group: MyLeadDetailGroupName,
    cursor: string | null
  ) => Promise<MyLeadDetailPageResult>
}

export type AcquisitionFormSubmitResult =
  | {
      ok: true
      /** The attempt may be durable before its SMS obligation is resolved. */
      attemptRecorded?: boolean
      followUp?: {
        obligationId?: string | null
        status:
          | "required"
          | "draft"
          | "sending"
          | "accepted"
          | "delivered"
          | "delivery_failed"
          | "blocked"
          | "failed_not_dispatched"
          | "unknown"
        message?: string | null
      } | null
    }
  | { ok: false; message: string; fieldErrors?: Record<string, string> }

export type AcquisitionAttemptFollowUp = {
  acquisitionsManager: string
  policyVersion: number
  introId: string
  introVersion: number
  templateId: string
  templateVersion: number
  initialRemainder: string
  remainder: string
  body: string
}

/** Post-call prompt extras. They ride beside the attempt command and never reach it. */
export type PostCallNextStep = {
  pick: "tomorrow" | "three_days" | "next_week" | "custom"
  /** ISO instant. */
  dueAt: string
}
export type PostCallExtras = {
  /** A UUID minted when the prompt opens; the idempotency key for the note and the appointment. */
  submissionId: string
  note: string | null
  nextStep: PostCallNextStep | null
  /** The Sandra call the attempt records; lets the server refuse extras for a call another prompt already saved. */
  callActivityId?: string | null
}
export type PostCallExtrasResult =
  | {
      ok: true
      note: "saved" | "skipped" | "failed"
      nextStep: "created" | "skipped" | "failed"
      message?: string
    }
  | { ok: false; message: string; /** Another prompt already saved this call: the stored extras are dropped, never retried. */ alreadySaved?: true; /** No proof yet that this save committed: nothing was written; the stored extras stay for Retry. */ pending?: true }
/** What the prompt shows after the attempt is saved. */
export type PostCallExtrasState =
  | { status: "saving" }
  | { status: "done"; result: PostCallExtrasResult }

export type AcquisitionAttemptFormPayload = {
  propertyId: string
  kind: AcquisitionAttemptKind
  source: AcquisitionAttemptSource
  outcome: AcquisitionAttemptOutcome
  occurredAt: string
  note: string | null
  recordingUrl: string | null
  callActivityId: string | null
  /** Required only for a no-answer outcome when the rep SMS rollout applies. */
  smsBody?: string | null
  followUp?: AcquisitionAttemptFollowUp | null
  /** Post-call prompt only; stripped before the command is built. */
  postCall?: PostCallExtras
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
      sequenceId?: string | null
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
