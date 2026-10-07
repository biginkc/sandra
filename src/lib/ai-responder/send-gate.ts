/**
 * The AI send gate: ONE pure decision function implementing the Q8 decision
 * table (.planning/messages-v2/PLAN.md section 8, Q8). It is applied top-down,
 * first match wins, by BOTH the early gate (before generation) and the
 * pre-send check (under the send lease, immediately before the provider).
 *
 * Rule text (approved, verbatim, in the plan). Rule 7 is not part of this
 * function: it is the flag + dead-letter behaviour of every "not sent" exit
 * that is not one of rules 0-6 (`flagAndDeadLetter` in ./dispatch). Rules 0
 * and 8 ARE evaluated here, FIRST (before rules 1-6), so code order matches
 * the plan's table:
 *
 *  0. Seller opted out / suppressed, AI responder off for the org or property,
 *     or consent rules forbid a reply -> not sent, nothing flagged (silent by
 *     design; the existing gates apply as they do today).
 *  8. A draft a human discarded, or that was already sent, is never re-sent
 *     or revived -> the run ends silently as already answered.
 *
 *  1. A newer inbound text from the seller exists: live handler -> not sent,
 *     no flag; no live handler -> not sent, flagged.
 *  2. The seller is already answered (an AI reply to this inbound, or any
 *     human/rep text sent after the inbound, submitted or delivered) -> not
 *     sent, no flag.
 *  3. An unrelated conversational text (AI reply to a different inbound, or
 *     any other conversational text that does not answer the seller) has been
 *     submitted or delivered -> not sent, flagged.
 *  4. A competing reply (AI or human) is still queued, not yet submitted: a
 *     rep's text scheduled for a future time -> not sent, no flag; otherwise
 *     retry later (caller applies the 4-attempt budget), flag after the last.
 *  5. Only automated broadcasts that were submitted or delivered -> not sent,
 *     no flag.
 *  6. Otherwise send.
 *
 * No I/O in this file: every fact is gathered by the caller.
 */

/** A newer inbound younger than this has not had time to be stamped `delayed`. */
export const NEWER_INBOUND_GRACE_MS = 10_000;

export type GateRow = {
  id: string;
  created_at: string;
  /** Provider submission time; preferred over created_at for "went out". */
  sent_at?: string | null;
  status?: string | null;
  campaign_id?: string | null;
  metadata?: unknown;
  scheduled_for?: string | null;
};

export type GateAuthor =
  | "broadcast"
  | "ai_this_inbound"
  | "ai_other_inbound"
  | "human_after_inbound"
  | "human_unrelated";

export type GateStage = "submitted" | "queued";

export type GateOutboundFact = {
  author: GateAuthor;
  stage: GateStage;
  /** Queued rep text with a future `scheduled_for` (rule 4: silent). */
  scheduledFuture: boolean;
};

export type NewerInboundFact =
  | { present: false }
  | {
      present: true;
      /** Has a live handler (see `classifyNewerInboundHandler`). */
      handled: boolean;
      /** Age of the newer inbound; null when its timestamp is unusable. */
      ageMs: number | null;
    };

export type SendGateFacts = {
  /** Rule 0: a suppression / disabled / consent exit holds (silent by design). */
  silentExit?: { reason: string } | null;
  /** Rule 8: a human discarded, or already sent, the draft for this inbound. */
  terminalDraft?: boolean;
  newerInbound: NewerInboundFact;
  outbound: readonly GateOutboundFact[];
};

export type SendGatePhase = "early" | "presend";

/** Why a silent skip happened, so callers can keep their reason strings. */
export type SilentSkip =
  | { rule: 0; reason: string }
  | { rule: 8; reason: "already_answered" }
  | { rule: 1; reason: "newer_inbound_handled" }
  | { rule: 2; reason: "already_answered"; answeredBy: "ai" | "human" }
  | { rule: 4; reason: "rep_text_scheduled" }
  | { rule: 5; reason: "broadcast_only" };

export type SendGateDecision =
  | { action: "send"; rule: 6 }
  | ({ action: "skip"; flag: false } & SilentSkip)
  | { action: "skip"; flag: true; rule: 1; reason: "newer_inbound_unhandled" }
  | { action: "skip"; flag: true; rule: 3; reason: "unrelated_conversational_text" }
  | { action: "retry"; rule: 4 }
  /** Early phase only, rule 1: too young to judge; the pre-send check decides. */
  | { action: "defer"; rule: 1 };

export function decideSendGate(
  facts: SendGateFacts,
  options: { phase: SendGatePhase } = { phase: "presend" },
): SendGateDecision {
  // Rule 0 (silent by design) and rule 8 (terminal draft) come first.
  if (facts.silentExit) {
    return { action: "skip", flag: false, rule: 0, reason: facts.silentExit.reason };
  }
  if (facts.terminalDraft) {
    return { action: "skip", flag: false, rule: 8, reason: "already_answered" };
  }

  // Rule 1
  if (facts.newerInbound.present) {
    if (facts.newerInbound.handled) {
      return { action: "skip", flag: false, rule: 1, reason: "newer_inbound_handled" };
    }
    // A timestamp in the future (clock skew) is as young as it gets.
    const young =
      facts.newerInbound.ageMs !== null && facts.newerInbound.ageMs < NEWER_INBOUND_GRACE_MS;
    if (options.phase === "early" && young) return { action: "defer", rule: 1 };
    return { action: "skip", flag: true, rule: 1, reason: "newer_inbound_unhandled" };
  }

  const submitted = facts.outbound.filter((f) => f.stage === "submitted");
  const queued = facts.outbound.filter((f) => f.stage === "queued" && f.author !== "broadcast");

  // Rule 2
  const answering = submitted.find(
    (f) => f.author === "ai_this_inbound" || f.author === "human_after_inbound",
  );
  if (answering) {
    return {
      action: "skip",
      flag: false,
      rule: 2,
      reason: "already_answered",
      answeredBy: answering.author === "ai_this_inbound" ? "ai" : "human",
    };
  }

  // Rule 3
  if (
    submitted.some((f) => f.author === "ai_other_inbound" || f.author === "human_unrelated")
  ) {
    return { action: "skip", flag: true, rule: 3, reason: "unrelated_conversational_text" };
  }

  // Rule 4
  if (queued.length > 0) {
    if (queued.some((f) => f.scheduledFuture)) {
      return { action: "skip", flag: false, rule: 4, reason: "rep_text_scheduled" };
    }
    return { action: "retry", rule: 4 };
  }

  // Rule 5
  if (submitted.some((f) => f.author === "broadcast")) {
    return { action: "skip", flag: false, rule: 5, reason: "broadcast_only" };
  }

  // Rule 6
  return { action: "send", rule: 6 };
}

/**
 * Rule 0 (pure): why an AI reply is silently not sent because of suppression,
 * the responder being off, or consent. Null = none applies. Reasons match the
 * pre-existing skip reasons so existing behaviour and traces are unchanged.
 */
export function silentExitReason(args: {
  configActive: boolean;
  consentState: string | null | undefined;
  propertyDisabled: boolean;
}): string | null {
  if (!args.configActive) return "disabled_org_wide";
  if (args.consentState === "opted_out") return "no_consent";
  if (args.propertyDisabled) return "disabled_per_property";
  return null;
}

// ---------- evidence classification (pure) ---------------------------------

const BROADCAST_GENERATORS = new Set(["norma_precall", "sequence_tick"]);
const SUBMITTED_STATUSES = new Set(["sent", "delivered"]);
const QUEUED_STATUSES = new Set(["pending", "queued"]);

/** Statuses the evidence queries ask for; every other status is not evidence. */
export const GATE_EVIDENCE_STATUSES = ["pending", "queued", "sent", "delivered"] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Classify one outbound row. Null = not evidence (failed, bounced, paused,
 * received...): such a row never answered anyone and is not going to.
 * `sequenceMessageIds` are row ids linked to a sequence step run.
 */
export function classifyGateRow(
  row: GateRow,
  ctx: {
    inboundMessageId: string | null;
    inboundCreatedAtMs: number | null;
    sequenceMessageIds?: ReadonlySet<string>;
    nowMs: number;
  },
): GateOutboundFact | null {
  const status = row.status ?? "";
  const stage: GateStage | null = SUBMITTED_STATUSES.has(status)
    ? "submitted"
    : QUEUED_STATUSES.has(status)
      ? "queued"
      : null;
  if (!stage) return null;

  const meta = record(row.metadata);
  const scheduledMs = row.scheduled_for ? Date.parse(row.scheduled_for) : Number.NaN;
  const scheduledFuture = !Number.isNaN(scheduledMs) && scheduledMs > ctx.nowMs;

  if (row.campaign_id) return { author: "broadcast", stage, scheduledFuture: false };
  if (typeof meta?.generated_by === "string" && BROADCAST_GENERATORS.has(meta.generated_by)) {
    return { author: "broadcast", stage, scheduledFuture: false };
  }
  if (meta?.kind === "seller_appointment_reminder") {
    return { author: "broadcast", stage, scheduledFuture: false };
  }
  if (ctx.sequenceMessageIds?.has(row.id)) {
    return { author: "broadcast", stage, scheduledFuture: false };
  }

  if (meta?.generated_by === "ai_responder_v1") {
    // An AI row with no inbound id (or none known here) can never be proven to
    // answer THIS inbound, and it is not a human reply either.
    const thisInbound =
      !!ctx.inboundMessageId && meta.inbound_message_id === ctx.inboundMessageId;
    return {
      author: thisInbound ? "ai_this_inbound" : "ai_other_inbound",
      stage,
      scheduledFuture: false,
    };
  }

  // Human / rep text: answers this inbound only when it went out at or after
  // it. A submitted row is judged by its submission time (`sent_at`): a rep
  // text created before the inbound but sent after it answers the seller. A
  // queued row has not gone out, so only its creation time exists.
  const wentOutAt =
    stage === "submitted" && row.sent_at && !Number.isNaN(Date.parse(row.sent_at))
      ? row.sent_at
      : row.created_at;
  const createdMs = Date.parse(wentOutAt);
  const after =
    !Number.isNaN(createdMs) &&
    ctx.inboundCreatedAtMs !== null &&
    createdMs >= ctx.inboundCreatedAtMs;
  return {
    author: after ? "human_after_inbound" : "human_unrelated",
    stage,
    scheduledFuture,
  };
}

// ---------- rule 1: is the newer inbound's handler live? --------------------

export type NewerInboundClaim = {
  status: string | null;
  /** ai_response_claims.outcome: what the finished handler actually did. */
  outcome?: string | null;
  error_message?: string | null;
  lease_expires_at?: string | null;
} | null;

export type NewerInboundStamp = {
  /** processing.aiResponder.outcome on the newer inbound row. */
  outcome?: unknown;
  /** processing.aiResponder.workflowRunId on the newer inbound row. */
  workflowRunId?: unknown;
} | null;

/**
 * Claim outcomes that mean the handler dealt with the seller's text: it sent
 * a reply or flagged the property for a human (`sent`, `escalated`), or ended
 * it by design through a suppression / terminal close (`opted_out`,
 * `auto_closed`: rule-0 type exits, silent by design). Every other finished
 * outcome (`skipped`, no consent, disabled, ...) did NOT handle the text.
 */
const HANDLED_CLAIM_OUTCOMES = new Set(["sent", "escalated", "opted_out", "auto_closed"]);

/**
 * "Live handler" (rule 1): a processing claim whose lease has not expired; a
 * claim that COMPLETED by sending a reply or flagging the property for a human
 * (judged by its outcome, not its status: a completed `skipped` claim handled
 * nothing); a retry whose scheduling was confirmed (claim parked
 * `retry_scheduled:*` AND the inbound carries a `delayed` stamp with its
 * workflow run id, written only after `start()` succeeded); or a reply delay
 * with a workflow id. The confirmed delay stamp counts alongside an expired
 * processing claim or a parked retry (the delay workflow may still run it); a
 * COMPLETED or terminally errored claim is authoritative over a stale stamp. A parked retry with no confirmation is not live.
 */
export function classifyNewerInboundHandler(args: {
  claim: NewerInboundClaim;
  stamp: NewerInboundStamp;
  nowMs: number;
}): boolean {
  const { claim, stamp, nowMs } = args;
  const confirmedWorkflow =
    !!stamp &&
    stamp.outcome === "delayed" &&
    typeof stamp.workflowRunId === "string" &&
    stamp.workflowRunId.length > 0;

  if (claim) {
    if (claim.status === "completed") {
      return HANDLED_CLAIM_OUTCOMES.has(claim.outcome ?? "");
    }
    if (claim.status === "processing") {
      const expires = claim.lease_expires_at ? Date.parse(claim.lease_expires_at) : Number.NaN;
      if (!Number.isNaN(expires) && expires > nowMs) return true;
      return confirmedWorkflow;
    }
    if (claim.status === "error") {
      // A parked retry is alive only when its scheduling was confirmed. Any
      // other error is a handler that ENDED without handling the text (e.g.
      // `reply_ineligible`): the delay stamp it was started from is history,
      // not a live delay, so it must not resurrect it.
      return (claim.error_message ?? "").startsWith("retry_scheduled:") && confirmedWorkflow;
    }
    return confirmedWorkflow;
  }
  return confirmedWorkflow;
}

// ---------- rule 8: terminal drafts ----------------------------------------

export type DraftGateDecision = "resolved" | "pending" | "none";

/**
 * Rule 8: a draft a human discarded, or that was already sent, is never
 * re-sent or revived by a retry (the run ends silently as already answered).
 * A still-pending draft means the reply is already held.
 */
export function decideDraftGate(statuses: ReadonlyArray<string | null>): DraftGateDecision {
  if (statuses.some((s) => s === "sent" || s === "discarded")) return "resolved";
  if (statuses.some((s) => s === "pending")) return "pending";
  return "none";
}
