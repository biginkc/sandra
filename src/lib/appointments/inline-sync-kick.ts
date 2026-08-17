import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import {
  processClaimedCalendarMutation,
  type ClaimedCalendarMutationRow,
} from "@/lib/integrations/google/create-worker";
import type { Database } from "@/lib/supabase/types";

/**
 * Immediately advances the one durable calendar mutation created by a
 * successful appointment action. The lifecycle/booking RPC returns this exact
 * ledger id from the same transaction, so a delayed request can never consume
 * an attempt from a newer mutation on the same task.
 *
 * The claim RPC retains the sweep worker's SKIP LOCKED lease and claim-token
 * fencing. A concurrent cron sweep or request therefore wins the row at most
 * once; the loser sees no row and returns. The cron remains the durable retry
 * path if this best-effort user-request kick times out.
 *
 * This function is intentionally not called after completion: completing an
 * appointment creates no ledger row, so a kick there could only target stale
 * history.
 */
type TargetedClaimRpcClient = {
  rpc(
    fn: "fn_claim_calendar_mutation_for_ledger",
    args: { p_ledger_id: string },
  ): Promise<{
    data: ClaimedCalendarMutationRow[] | null;
    error: { message: string } | null;
  }>;
};

// create-worker reserves 3s for final database writes and refuses to start a
// Google call with <=2s left. Ten seconds leaves a real 7s provider window;
// PR #369's old 4s budget deterministically made every connected path fail
// before any provider I/O.
const DEFAULT_INLINE_KICK_TIMEOUT_MS = 10_000;

export async function kickCalendarMutationSync(
  supabase: SupabaseClient<Database>,
  ledgerId: string,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_INLINE_KICK_TIMEOUT_MS;
  try {
    await withTimeout(
      runInlineKick(supabase, ledgerId, Date.now() + timeoutMs),
      timeoutMs,
    );
  } catch (error) {
    reportError(error, {
      tags: { surface: "inline_calendar_sync_kick" },
      extra: { ledgerId },
    });
  }
}

async function runInlineKick(
  supabase: SupabaseClient<Database>,
  ledgerId: string,
  deadlineAt: number,
): Promise<void> {
  const rpcClient = supabase as unknown as TargetedClaimRpcClient;
  const { data, error } = await rpcClient.rpc(
    "fn_claim_calendar_mutation_for_ledger",
    { p_ledger_id: ledgerId },
  );
  if (error) {
    throw new Error(
      `fn_claim_calendar_mutation_for_ledger failed: ${error.message}`,
    );
  }

  const claimed = data?.[0];
  if (!claimed) return;

  try {
    await processClaimedCalendarMutation(supabase, claimed, { deadlineAt });
  } catch (error) {
    reportError(error, {
      tags: { surface: "inline_calendar_sync_kick_unhandled" },
      extra: { ledgerId: claimed.ledger_id },
    });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`inline calendar sync kick timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
