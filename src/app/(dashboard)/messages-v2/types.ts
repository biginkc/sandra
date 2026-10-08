/**
 * Local row types for the Messages v2 evidence layer. Kept independent of
 * src/lib/supabase/types.ts (the migration agent owns that file); the shapes
 * mirror supabase/migrations/20261008143000_pipeline_runs.sql.
 */

export const RUN_STATUSES = [
  "running",
  "replied",
  "held",
  "escalated",
  "closed",
  "skipped",
  "error",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export type RunMode = "shadow" | "automatic" | "legacy";

export type StepKind =
  "gate" | "jev" | "threshold" | "action" | "reply" | "hold" | "shadow";

export type StepResult =
  | "pass"
  | "block"
  | "applied"
  | "held"
  | "sent"
  | "would_apply"
  | "error"
  | "skipped";

export type PipelineRun = {
  id: string;
  org_id: string;
  inbound_message_id: string;
  property_id: string | null;
  contact_id: string | null;
  conversation_id: string | null;
  status: RunStatus;
  mode: RunMode;
  final_outcome: string | null;
  reason: string | null;
  classification_run_id: string | null;
  claim_id: string | null;
  outbound_message_id: string | null;
  inbound_preview: string | null;
  started_at: string;
  completed_at: string | null;
};

export type PipelineRunStep = {
  id: string;
  run_id: string;
  org_id: string;
  seq: number;
  kind: StepKind;
  name: string;
  result: StepResult;
  detail: Record<string, unknown> | null;
  created_at: string;
};

/** A run with its ordered steps, as rendered by the feed. */
export type RunWithSteps = PipelineRun & { steps: PipelineRunStep[] };

/** Display-only context for a run's seller. */
export type RunLabel = {
  /** First name, or "Unknown ···1234" for unmatched senders. */
  name: string;
  /** "123 Main St, Kansas City" or null. */
  address: string | null;
};

export type ModeBadge = {
  /** Outcome label, e.g. "not_interested". */
  label: string;
  mode: "AUTO" | "HELD" | "SHADOW" | "LEGACY" | "UNKNOWN";
  /** Auto-apply confidence floor; only meaningful (and shown) for AUTO. */
  minConfidence?: number | null;
};

/** Health of the hold queries, so truncation and failures are never silent. */
export type HoldsMeta = {
  /** Best-known open-hold count (>= shown; exact when not truncated). */
  total: number;
  shown: number;
  truncated: boolean;
  /**
   * exact: `total` = distinct held properties. capped: more than the count cap
   * DISTINCT properties, so the total is only "cap+". incomplete: a source hit
   * its fetch limit, so `total` is only a lower bound ("N+"). unavailable: any
   * hold source or count query failed, so no total is known.
   */
  totalState: "exact" | "capped" | "incomplete" | "unavailable";
  /** Sources whose query failed; their holds are missing, not zero. pending_draft here means draft status is unavailable. */
  failed: HoldSource[];
  /** Auxiliary lookups (run context, steps, drafts) that errored; cards may be incomplete. */
  contextErrors: string[];
  /** The dead-letter lookup errored (not merely a missing table): markers may be missing. */
  deadLetterUnavailable?: boolean;
};

export type HoldSource =
  "needs_attention" | "jev_decision" | "disposition_review" | "pending_draft";

/**
 * An open hold: something a human still has to act on. Derived from the
 * underlying sources of truth (properties.needs_human_attention, pending
 * jev_lead_decisions, pending ai_disposition_reviews), one card per property.
 * `run` is the most recent pipeline run for context, or null when the hold is
 * older than the pipeline-run seam.
 */
export type DeadLetterInfo = {
  inbound_message_id: string | null;
  run_id: string | null;
  late: boolean;
};

export type HoldSeen = {
  through: string | null;
  flagReason: string | null;
  flagAt: string | null;
};

/** Luna's pending pick for a hold (a suggestion only; never auto-applied). */
export type LunaHoldSuggestion = {
  id: string;
  outcome: string;
  confidence: number;
  inbound_message_id: string;
};

export type OpenHold<R extends PipelineRun = PipelineRun> = {
  /** Property id (one hold per property). */
  id: string;
  /** null for a pending draft that cannot be tied to a property. */
  property_id: string | null;
  conversation_id: string | null;
  sources: HoldSource[];
  /** ISO time the oldest underlying item opened; null when unknown (never guessed from updated_at). */
  since: string | null;
  /**
   * When the hold began, for alert eligibility only. null = unknown (a property
   * flagged before start times were tracked): such a hold never alerts.
   */
  alert_since?: string | null;
  /** Plain-text description of why it is open (source labels + escalation reason). */
  reason: string;
  run: R | null;
  /** A pending Claude reply draft exists for this hold's run. */
  draft_held?: boolean;
  /**
   * The newest pending draft. `body` / `edited_body` are present only when the
   * page asked for them (the hold actions need to show and send the text).
   */
  draft?: {
    id: string;
    inbound_message_id: string | null;
    body?: string;
    edited_body?: string | null;
    /** Version of the human edit (null = never edited). Sent back with Send / Edit so a changed draft is refused. */
    edited_at?: string | null;
  };
  /**
   * What this card displayed, for the stale-click guard: Dismiss / Take over
   * send it back and the server refuses (STALE) when anything newer exists.
   * `through` is the newest pending decision / review / draft created_at shown.
   */
  seen?: HoldSeen;
  /** Inbound message ids tied to this hold (used to match dead letters). */
  message_ids?: string[];
  /** A dead-letter row exists: the reply text was saved for review (text never loaded). */
  dead_letter?: boolean;
  /** At least one dead-letter for this hold is `sent_late` (provider accepted it after the timeout). Does NOT mean every dead-letter is late; see `dead_letters`. */
  dead_letter_late?: boolean;
  /** One entry per inbound/run dead-letter on this hold; `late` = provider accepted it late. */
  dead_letters?: DeadLetterInfo[];
  /** Latest alert delivery for this hold's property (hold_alert_deliveries); absent = none recorded. */
  alert?: { status: "pending" | "sending" | "sent" | "failed" | "skipped"; reason: string | null };
  /** The property's raw last_ai_escalation_reason (e.g. `send_timeout_then_sent`); null/absent when none. */
  flag_reason?: string | null;
  /** Luna's pending suggestion for this hold (only when the Luna flag is on). */
  luna?: LunaHoldSuggestion;
};

export type PipelineCoverage = { inboundMessages: number; runs: number };

export type HeaderStats = {
  runsLastHour: number;
  openHolds: number;
};
