import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import {
  processClaimedCalendarMutation,
  type ClaimedCalendarMutationRow,
} from "@/lib/integrations/google/create-worker";
import type { Database } from "@/lib/supabase/types";

/**
 * Best-effort inline "kick" of the durable calendar-mutation ledger,
 * called by every appointment server action right after its lifecycle RPC
 * (book/complete/cancel/reschedule/reassign) commits.
 *
 * Root cause this papers over: `fn_book_appointment` opens a
 * `task_calendar_mutations` row (phase='pending') in the same transaction
 * as the appointment write, and every lifecycle RPC (complete/cancel/
 * reschedule/reassign — migration 20260814210000) raises "calendar sync
 * in progress" for as long as ANY row on that chain sits at phase in
 * (pending, provider_done, needs_repair). The only thing that ever
 * cleared that lock was `calendar-mutation-sweep`
 * (src/app/api/cron/calendar-mutation-sweep/route.ts), a cron running
 * every 5 minutes — so absent this kick, every booking or lifecycle
 * mutation left a 0-5 minute window where the very next lifecycle action
 * on the same appointment deterministically failed with "calendar sync in
 * progress" for no reason other than waiting on the next cron tick (prod
 * evidence: every mutation finalizes on its FIRST worker attempt). This
 * calls the exact same claim + process pipeline the cron sweep uses, just
 * immediately, so the lock usually clears in seconds instead.
 *
 * Concurrency safety is inherited, not reimplemented: `fn_claim_calendar_
 * mutations` claims via `FOR UPDATE SKIP LOCKED` and mints a fresh
 * `claim_token` + 2-minute lease on every claim, and every write
 * `processClaimedCalendarMutation` makes is fenced on that exact token
 * (see create-worker.ts's own fencing comments). An inline kick racing
 * the cron sweep — or another inline kick from a concurrent request — can
 * never double-process a row: whichever caller's claim wins owns it
 * exclusively, and every other caller simply doesn't see it in their
 * claimed batch. Nothing here weakens or bypasses that.
 *
 * `fn_claim_calendar_mutations` has no way to target one chain/ledger id
 * — it claims the oldest `p_limit` due rows across every chain in the
 * org, `ORDER BY created_at`. The row this action's own RPC just wrote is
 * always the newest one (freshly armed, `next_attempt_at` is null so it's
 * immediately eligible), so on an otherwise-idle ledger it's claimed
 * first — but under a genuine backlog of older due rows, a small
 * `p_limit` batch can still miss it. That's an accepted, real limitation
 * (claiming a wider batch than "just this row" is the only lever
 * available without a migration change, which is out of scope here) —
 * this function is best-effort by design, and `calendar-mutation-sweep`
 * remains the durable path that eventually claims every row regardless.
 *
 * Never throws. Bounded to `opts.timeoutMs` wall-clock time via
 * `Promise.race` against a timeout sentinel, in the same spirit as
 * `appointment-reminder-sweep`'s `withDeliveryDeadline` — minus that
 * function's late-resolution reconciliation, which isn't needed here: the
 * claim/process writes are already self-consistent under the lease
 * fencing described above, so an abandoned in-flight call needs no
 * special handling. Either it finishes on its own before this request's
 * process is torn down, or the row's 2-minute lease simply expires and
 * the next cron sweep (or a later inline kick) reclaims it.
 */

type ClaimRpcClient = {
  rpc(
    fn: "fn_claim_calendar_mutations",
    args: { p_limit: number },
  ): Promise<{
    data: ClaimedCalendarMutationRow[] | null;
    error: { message: string } | null;
  }>;
};

/** Small, not 1 — see the module doc comment on why a batch (rather than a
 *  single claim) improves the odds of including the chain this action
 *  just mutated, without turning the kick into a full sweep. */
const INLINE_KICK_CLAIM_LIMIT = 5;

/** "A few seconds" per the caller contract — long enough for the common
 *  case (an org with no Google token connected: every claimed row
 *  finalizes as a `no_token`/`no_event` no-op with zero Google calls) to
 *  finish comfortably, short enough that a stuck/slow Google call can
 *  never meaningfully delay the user-facing action response. */
const DEFAULT_INLINE_KICK_TIMEOUT_MS = 4_000;

export async function kickCalendarMutationSync(
  supabase: SupabaseClient<Database>,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_INLINE_KICK_TIMEOUT_MS;
  try {
    await withTimeout(runInlineKick(supabase, Date.now() + timeoutMs), timeoutMs);
  } catch (e) {
    // Never propagate — every call site awaits this after its own RPC has
    // already committed; the cron sweep is the durable fallback for
    // anything this kick didn't get to (including its own timeout).
    reportError(e, { tags: { surface: "inline_calendar_sync_kick" } });
  }
}

async function runInlineKick(
  supabase: SupabaseClient<Database>,
  deadlineAt: number,
): Promise<void> {
  const rpcClient = supabase as unknown as ClaimRpcClient;
  const { data: claimedRows, error } = await rpcClient.rpc("fn_claim_calendar_mutations", {
    p_limit: INLINE_KICK_CLAIM_LIMIT,
  });
  if (error) {
    throw new Error(`fn_claim_calendar_mutations failed: ${error.message}`);
  }

  for (const row of claimedRows ?? []) {
    // Same defense-in-depth as the cron sweep's own claim loop:
    // processClaimedCalendarMutation is documented to never throw, but one
    // claimed row's unexpected rejection must not stop the rest of this
    // small batch from being attempted.
    try {
      await processClaimedCalendarMutation(supabase, row, { deadlineAt });
    } catch (e) {
      reportError(e, {
        tags: { surface: "inline_calendar_sync_kick_unhandled" },
        extra: { ledgerId: row.ledger_id },
      });
    }
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
