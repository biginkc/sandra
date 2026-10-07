import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import { finishRun } from "./record";
import type { MaybeRunContext, RunStatus } from "./types";

/** Structural copy of AiDispatchOutcome so this module has no dispatch import. */
export type DispatchOutcomeLike =
  | { outcome: "sent"; messageId: string; confidence: number }
  | { outcome: "escalated"; reason: string }
  | { outcome: "auto_closed"; reason: string }
  | { outcome: "opted_out"; reason: string }
  | { outcome: "skipped"; reason: string };

export function runStatusForOutcome(outcome: DispatchOutcomeLike): {
  status: RunStatus;
  finalOutcome: string;
  reason: string | null;
  outboundMessageId: string | null;
} {
  switch (outcome.outcome) {
    case "sent":
      return {
        status: "replied",
        finalOutcome: "sent",
        reason: null,
        outboundMessageId: outcome.messageId,
      };
    case "escalated":
      return {
        // Waiting on a human decision (below threshold / proposed) is a
        // hold; everything else needs human attention.
        status: outcome.reason.startsWith("jev_below_threshold")
          ? "held"
          : "escalated",
        finalOutcome: "escalated",
        reason: outcome.reason,
        outboundMessageId: null,
      };
    case "auto_closed":
    case "opted_out":
      return {
        status: "closed",
        finalOutcome: outcome.outcome,
        reason: outcome.reason,
        outboundMessageId: null,
      };
    case "skipped":
      return {
        status: "skipped",
        finalOutcome: "skipped",
        reason: outcome.reason,
        outboundMessageId: null,
      };
  }
}

/** The one funnel call: stamp the run's terminal state from a dispatch outcome. */
export async function finishRunFromOutcome(
  admin: SupabaseClient<Database>,
  ctx: MaybeRunContext,
  outcome: DispatchOutcomeLike,
): Promise<void> {
  if (!ctx) return;
  const mapped = runStatusForOutcome(outcome);
  await finishRun(admin, ctx, {
    status: mapped.status,
    finalOutcome: mapped.finalOutcome,
    reason: mapped.reason,
    ...(mapped.outboundMessageId
      ? { outboundMessageId: mapped.outboundMessageId }
      : {}),
  });
}
