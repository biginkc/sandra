import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";

import {
  markClaimTemplateOutcomeMissing,
  staleTemplateSentClaimsQuery,
  TEMPLATE_SENT_MISSING_OUTCOME,
} from "./claims";
import { markPropertyNeedsAttention } from "./dispatch";

/** Attention-flag reason for a seller who was sent a template but whose outcome was never applied. */
export const TEMPLATE_SENT_OUTCOME_MISSING_REASON = TEMPLATE_SENT_MISSING_OUTCOME;

/**
 * Stale-claim sweep for the template step (PLAN 4.6). A claim that recorded a
 * sent template and never reached its outcome (function died between the send
 * and the apply) flags the property for a human with reason
 * `template_sent_outcome_missing`. Each claim is retired from the sweep as it
 * is flagged. Runs from the stale-run cron.
 */
export async function sweepTemplateSentClaims(
  supabase: SupabaseClient<Database>,
  options: { now?: Date; graceMs?: number; limit?: number } = {},
): Promise<{ scanned: number; flagged: number; failed: number }> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.graceMs ?? 5 * 60_000)).toISOString();
  const { data, error } = await staleTemplateSentClaimsQuery(supabase, {
    leaseExpiredBefore: cutoff,
    limit: options.limit ?? 100,
  });
  if (error) {
    reportError(new Error(error.message), { tags: { surface: "ai_responder_template_claim_sweep" } });
    return { scanned: 0, flagged: 0, failed: 1 };
  }
  let flagged = 0;
  let failed = 0;
  for (const claim of data ?? []) {
    try {
      // Flag first: if the flag write fails the marker stays and the next sweep retries.
      const flagOk = claim.property_id
        ? await markPropertyNeedsAttention(supabase, claim.property_id, TEMPLATE_SENT_OUTCOME_MISSING_REASON)
        : true;
      if (!flagOk) {
        failed += 1;
        continue;
      }
      await markClaimTemplateOutcomeMissing(supabase, claim.id);
      flagged += 1;
    } catch (e) {
      failed += 1;
      reportError(e, {
        tags: { surface: "ai_responder_template_claim_sweep" },
        extra: { claimId: claim.id },
      });
    }
  }
  return { scanned: data?.length ?? 0, flagged, failed };
}
