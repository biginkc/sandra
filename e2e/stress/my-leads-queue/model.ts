/**
 * Abstract fact model of one My Leads queue lead. The seeders produce it, the oracle reads ONLY it, and
 * materialize.ts is the single place that turns it into database rows. The oracle therefore never touches
 * SQL, and a bug in the SQL cannot leak into the expected answer.
 *
 * All times are epoch milliseconds. A world is evaluated at `World.now`.
 */
export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export type Stage = "not_contacted" | "contacted" | "needs_offer" | "offer_sent" | "under_contract";

/** Who wrote an outbound text (design 1.1 "Seller-facing outbound", section 5). */
export type OutboundSource = "human" | "approved_draft" | "ai_template" | "ai_written" | "drip" | "campaign" | "norma_precall";

/**
 * What the transport finally recorded for an outbound text.
 *  sent / delivered         provider accepted it
 *  accepted_then_failed     provider accepted it, a later status event flipped it to delivery_failed
 *  failed                   definitive failure, never accepted
 *  failed_unknown           failed with providerOutcome=provider_unknown (unverified)
 *  queued / pending         not sent (queued: manual or campaign; pending: in flight)
 */
export type SendOutcome = "sent" | "delivered" | "accepted_then_failed" | "failed" | "failed_unknown" | "queued" | "pending";

export type LedgerState = "reserved" | "sending" | "accepted" | "delivered" | "delivery_failed" | "failed_not_dispatched" | "blocked" | "unknown";

/** Reply-to stamp on a human/AI text. `inbound` references a message of the same lead, or (with `lead`, the other lead's key) a
 * contact-only text of the same homeowner; `foreign` a message of another lead (dropped). */
export type Stamp = { kind: "inbound"; ref: string; lead?: string } | { kind: "foreign" } | { kind: "unresolved" };

export type Msg = {
  /** Unique within the lead; also the deterministic tie-break order. */
  ref: string;
  dir: "inbound" | "outbound";
  at: number;
  body: string;
  /** Attributed to the lead only through the homeowner contact (property_id null). */
  contactOnly?: boolean;
  // outbound only
  source?: OutboundSource;
  outcome?: SendOutcome;
  /** When the provider accepted it, if that differs from `at` (a text created earlier but sent later). */
  sentAt?: number;
  failedAt?: number;
  scheduledFor?: number;
  stamp?: Stamp;
  /** A durable ledger receipt linked to this message. */
  ledger?: { state: LedgerState; updatedAt: number };
  /** Drip text: it is the final step of its (completed) enrollment. */
  dripFinal?: boolean;
};

export type Attempt = { at: number; outcome: "no_answer" | "reached" | "voicemail" | "wrong_number" | "not_logged" };

export type LeadEvent = {
  type: "dispo_set" | "my_leads_workflow" | "appointment_booked" | "task_created" | "rep_sms_failure_dismissed" | "note";
  at: number;
  actor: "user" | "system" | "ai";
  /** my_leads_workflow operation. */
  operation?: string;
  /** rep_sms_failure_dismissed: the ref of the dismissed message / ledger / obligation. */
  dismisses?: string;
};

export type Enrollment = {
  status: "active" | "paused" | "completed" | "opted_out" | "cancelled";
  pause?: string;
  nextRunAt: number | null;
  updatedAt: number;
  enrolledAt: number;
  completedAt?: number;
  enrolledBy: "rep" | "ai" | "none";
  steps: number;
  step: number;
  /** An unknown-outcome step claim started at this time. */
  claimAt?: number;
};

export type Appointment = {
  ref: string;
  due: number;
  status: "open" | "snoozed" | "completed" | "cancelled";
  snoozedUntil?: number;
  /** A task on the pending offer's follow-up calendar chain. */
  offerChain?: boolean;
};

export type Offer = {
  sentAt: number;
  followUpAt: number;
  outcome: "pending" | "declined" | "accepted";
  /** follow_up_calendar_chain_id set (chain tasks are appointments with offerChain). */
  hasChain: boolean;
};

export type StandaloneLedger = { ref: string; state: LedgerState; updatedAt: number };
export type Obligation = { ref: string; state: "required" | "draft" | "failed_not_dispatched" | "delivery_failed" | "blocked" | "unknown" | "claimed" | "sending" | "accepted" | "delivered" | "voided" | "exception_closed"; updatedAt: number; leaseExpiresAt?: number };

export type Lead = {
  key: string;
  stage: Stage;
  hasPhone: boolean;
  dnc: boolean;
  /** Episode assignment time (design row 3 headline only; not needed for placement). */
  assignedAt: number;
  attempts: Attempt[];
  messages: Msg[];
  missedCalls: number[];
  events: LeadEvent[];
  enrollment?: Enrollment;
  appointments: Appointment[];
  offer?: Offer;
  ledgers: StandaloneLedger[];
  obligations: Obligation[];
  pin?: { pinnedAt: number; until: number | null };
  aiDraftPending?: boolean;
  /** The homeowner contact is shared with another lead in the same queue (`contactGroup` names the shared contact). */
  contactShared?: boolean;
  contactGroup?: string;
  aiDeadLetter?: number;
  normaNeedsReview?: boolean;
  normaCalling?: boolean;
  /** Spec-question id this lead exercises (see oracle.SPEC_QUESTIONS); the report groups mismatches by it. */
  question?: string;
  /** Free-form tags used by the report. */
  tags?: string[];
};

export type World = { now: number; leads: Lead[] };

export function emptyLead(key: string, now: number, over: Partial<Lead> = {}): Lead {
  return {
    key,
    stage: "contacted",
    hasPhone: true,
    dnc: false,
    assignedAt: now - 30 * DAY,
    attempts: [{ at: now - 30 * DAY, outcome: "no_answer" }],
    messages: [],
    missedCalls: [],
    events: [],
    appointments: [],
    ledgers: [],
    obligations: [],
    ...over,
  };
}
