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
  mode: "AUTO" | "HELD" | "SHADOW" | "LEGACY";
  /** Auto-apply confidence floor; only meaningful (and shown) for AUTO. */
  minConfidence?: number | null;
};

/** Health of the hold queries, so truncation and failures are never silent. */
export type HoldsMeta = {
  /** Best-known open-hold count (>= shown; exact when not truncated). */
  total: number;
  shown: number;
  truncated: boolean;
  /** Sources whose query failed; their holds are missing, not zero. */
  failed: HoldSource[];
  /** Auxiliary lookups (run context, steps, drafts) that errored; cards may be incomplete. */
  contextErrors: string[];
};

export type HoldSource =
  "needs_attention" | "jev_decision" | "disposition_review";

/**
 * An open hold: something a human still has to act on. Derived from the
 * underlying sources of truth (properties.needs_human_attention, pending
 * jev_lead_decisions, pending ai_disposition_reviews), one card per property.
 * `run` is the most recent pipeline run for context, or null when the hold is
 * older than the pipeline-run seam.
 */
export type OpenHold<R extends PipelineRun = PipelineRun> = {
  /** Property id (one hold per property). */
  id: string;
  property_id: string;
  conversation_id: string | null;
  sources: HoldSource[];
  /** ISO time the oldest underlying item opened; null when unknown (never guessed from updated_at). */
  since: string | null;
  /** Plain-text description of why it is open (source labels + escalation reason). */
  reason: string;
  run: R | null;
  /** A pending Claude reply draft exists for this hold's run (body not shown in Phase 0). */
  draft_held?: boolean;
};

export type PipelineCoverage = { inboundMessages: number; runs: number };

export type HeaderStats = {
  runsLastHour: number;
  openHolds: number;
};
