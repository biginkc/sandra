export type StepKind =
  | "gate"
  | "jev"
  | "threshold"
  | "action"
  | "reply"
  | "hold"
  | "shadow";

export type StepResult =
  | "pass"
  | "block"
  | "applied"
  | "held"
  | "sent"
  | "would_apply"
  | "error"
  | "skipped";

export type RunStatus =
  | "running"
  | "replied"
  | "held"
  | "escalated"
  | "closed"
  | "skipped"
  | "error";

export type RunMode = "shadow" | "automatic" | "legacy";

/**
 * Handle for one in-flight pipeline run. `seq` is the last step number issued;
 * recordStep bumps it synchronously before awaiting, so concurrent callers in
 * one process always get distinct, ordered numbers.
 */
export type PipelineRunContext = {
  runId: string;
  orgId: string;
  seq: number;
};

/** Optional everywhere so call sites stay one-liners and tests stay unchanged. */
export type MaybeRunContext = PipelineRunContext | null | undefined;
