import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import {
  processClaimedCalendarMutation,
  type CalendarMutationOutcome,
  type ClaimedCalendarMutationRow,
} from "@/lib/integrations/google/create-worker";
import type { Database } from "@/lib/supabase/types";

/**
 * Vercel cron → `/api/cron/calendar-mutation-sweep` every 5 minutes
 * (off-minute offset from sequence-tick, same idiom as
 * sweep-stuck-skip-trace/phone-coverage-snapshot's staggered schedules so
 * every 5-minute cron doesn't fire in the same tick).
 *
 * Durable calendar-mutation ledger consumer. PR 2 introduced this as a
 * `create`/`pending`-only pull-forward; PR 3 (migration 20260814210000)
 * widened the claim RPC (renamed fn_claim_calendar_creations ->
 * fn_claim_calendar_mutations) to operation IN (create, reschedule,
 * reassign, cancel), so this route now drains all four. Claims via the
 * service-role-only `fn_claim_calendar_mutations` RPC (FOR UPDATE SKIP
 * LOCKED, attempts bumped atomically with the claim), then hands the row
 * to `processClaimedCalendarMutation`, which dispatches by `operation`,
 * talks to Google, and advances the ledger through provider_done ->
 * finalized (or leaves it pending with `last_error` set for a transient
 * failure, or fails it terminally for a permanent auth/config error).
 *
 * Claiming is one row at a time (`p_limit: 1`), not one upfront batch.
 * This route processes rows sequentially under a wall-clock budget, and
 * the claim RPC bumps `attempts` the instant it claims — if it claimed a
 * whole batch upfront, rows past wherever the budget ran out would have
 * an attempt burned with no Google call ever made against them, and
 * repeated slow sweeps could exhaust a row's attempts (and strand it)
 * without it ever reaching the provider. Claiming immediately before
 * processing each row means `attempts` only increments when the worker
 * is actually about to act on it. `claimLimit` now bounds how many rows
 * a single sweep will process, not the size of one claim call.
 *
 * Time budget: same rationale as sequence-tick — this route must never
 * rely on an unbounded loop; it stops cleanly before the platform kill
 * and reports `budgetExhausted` so a partial run is visible. The budget
 * is checked before every claim, so we never claim (and burn an
 * attempt on) a row we don't have budget left to process.
 */
export const maxDuration = 60;

/** Max rows a single sweep run will claim+process, one at a time — not a
 *  batch-claim size (see the module comment above). */
const MAX_ROWS_PER_SWEEP = 50;
const SWEEP_BUDGET_MS = 45_000;

/**
 * Codex round 10 (finding 1): the sweep's own absolute wall-clock deadline,
 * threaded through to `processClaimedCalendarMutation` as `deadlineAt`
 * (epoch ms) instead of the round-9 per-row `timeoutMs` snapshot. Round 9
 * derived one fixed duration per claimed row and reused it for every Google
 * call that row's handler made — fine for `create`/`cancel`/`reschedule`
 * (at most one Google call each) but wrong for `reassign`, which can make
 * up to three (create, an optional 409-reconcile get, delete): a slow first
 * call left the SAME window for the calls after it, so a row could still
 * blow well past the sweep's real remaining budget even though each
 * individual call was "bounded."
 *
 * An absolute deadline fixes this for free: create-worker.ts recomputes the
 * remaining time immediately before EVERY Google call (see its
 * `nextGoogleCallOptions`), so a slow first call correctly shrinks the
 * window left for the next one. It's derived once per sweep (not
 * re-derived per row) precisely because it's absolute — the "a claim late
 * in a busy sweep gets a shorter leash" property round 9 needed a
 * recompute for falls out automatically as wall-clock time passes.
 *
 * The gap between `SWEEP_BUDGET_MS` (45s) and the route's own `maxDuration`
 * (60s) is the slack create-worker.ts's own reserve/floor spends: worst
 * case, one already-in-flight row gets a bit more runway than the soft
 * budget technically had left, comfortably inside the platform's hard
 * limit.
 */

function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "calendar-mutation-sweep cron needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return createSupabaseClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** fn_claim_calendar_mutations / fn_expire_exhausted_calendar_mutations are
 *  not (and, per this PR's scope, must not be) in the generated
 *  Database["public"]["Functions"] map — same local-cast pattern as the
 *  booking RPC call sites. */
type ExpireExhaustedRow = {
  failed_count: number;
  needs_repair_count: number;
  /** Round 9: ledger row ids that just transitioned to needs_repair this
   *  sweep, so the telemetry event below can name the exact rows an
   *  operator needs to look at instead of a bare count. */
  needs_repair_ids: string[];
};
type ClaimRpcClient = {
  rpc(
    fn: "fn_claim_calendar_mutations",
    args: { p_limit: number },
  ): Promise<{
    data: ClaimedCalendarMutationRow[] | null;
    error: { message: string } | null;
  }>;
  /** Round 7: returns one row of (failed_count, needs_repair_count) — a
   *  provider_done exhaustion is a repair state, not a plain failure, and
   *  the split needs to be visible in the sweep response for
   *  observability rather than folded into one opaque total. PR 3 widened
   *  this from create-only to every operation. */
  rpc(fn: "fn_expire_exhausted_calendar_mutations"): Promise<{
    data: ExpireExhaustedRow[] | null;
    error: { message: string } | null;
  }>;
};

async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = createServiceRoleClient();
    const summary = await runCalendarMutationSweep(supabase);
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    reportError(e, { tags: { surface: "cron_calendar_mutation_sweep" } });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown" },
      { status: 500 },
    );
  }
}

/**
 * Exported separately from the route so integration/unit tests can drive
 * it against a Supabase client directly, same split as
 * sequence-tick's `runSequenceTick`.
 */
export async function runCalendarMutationSweep(
  supabase: ReturnType<typeof createServiceRoleClient>,
  opts: { budgetMs?: number; claimLimit?: number } = {},
): Promise<{
  claimed: number;
  expired: number;
  needsRepair: number;
  outcomes: Record<string, number>;
  budgetExhausted: boolean;
}> {
  const budgetMs = opts.budgetMs ?? SWEEP_BUDGET_MS;
  const claimLimit = opts.claimLimit ?? MAX_ROWS_PER_SWEEP;
  const startedAt = Date.now();
  // Codex round 10 (finding 1): the sweep's absolute wall-clock deadline —
  // derived once, here, not per row/per call. Every Google call any claimed
  // row's handler makes recomputes its own remaining time against THIS same
  // value (see create-worker.ts's `nextGoogleCallOptions`); see the const's
  // doc comment above for why an absolute deadline replaces round 9's
  // per-row duration snapshot.
  const deadlineAt = startedAt + budgetMs;
  const rpcClient = supabase as unknown as ClaimRpcClient;

  // Terminal exhaustion runs once per sweep, before any claiming — not
  // per claim iteration, since the claim loop below calls the claim RPC
  // with p_limit:1 up to claimLimit times. A row stuck at attempts>=5
  // holds idx_task_calendar_mutations_chain_serialization's slot open
  // (that partial index excludes only 'failed'/'provider_done'/'pending')
  // until it's moved there, which would otherwise block PR 3's lifecycle
  // mutations on the same appointment forever. Round 7: a provider_done
  // exhaustion moves to needs_repair (not failed) and deliberately keeps
  // that slot held — needsRepair surfaces that split for observability.
  const { data: expireRows, error: expireError } = await rpcClient.rpc(
    "fn_expire_exhausted_calendar_mutations",
  );
  if (expireError) {
    throw new Error(`fn_expire_exhausted_calendar_mutations failed: ${expireError.message}`);
  }
  const expiredCount = expireRows?.[0]?.failed_count ?? 0;
  const needsRepairCount = expireRows?.[0]?.needs_repair_count ?? 0;
  const needsRepairIds = expireRows?.[0]?.needs_repair_ids ?? [];

  // Round 9: needs_repair is not a passive count — every row in it is a
  // live, unreconciled Google event with no finalized local record, and
  // (unlike 'failed') nothing else re-surfaces it once the exhaustion
  // sweep runs. Without a dedicated, tagged error here, a growing
  // needs_repair backlog is invisible outside a manual DB query. One event
  // per sweep (not per row) carries the count and the exact ledger ids so
  // an operator can act without re-deriving them.
  //
  // Repair workflow for a needs_repair row: 1) look up the Google Calendar
  // event by this ledger row's client_event_id (fn_uuid_to_base32hex(id))
  // on the assignee's calendar — the event exists, only the local
  // finalize kept failing; 2) once found, manually set
  // tasks.google_calendar_event_id to that event's id for the row's
  // source_task_id; 3) finalize the ledger row itself (phase='finalized',
  // result_reason left as 'finalize_needs_repair' or updated to note the
  // manual repair) so it stops holding the chain-serialization slot. If
  // the event can't be found at all, treat it as a permanent loss and
  // move the row to phase='failed' instead.
  if (needsRepairCount > 0) {
    reportError(
      new Error(`calendar-mutation-sweep: ${needsRepairCount} row(s) need manual repair`),
      {
        tags: { surface: "calendar-mutation-sweep", kind: "needs_repair" },
        extra: { needsRepairCount, needsRepairIds },
      },
    );
  }

  const outcomes: Record<string, number> = {};
  let claimed = 0;
  let budgetExhausted = false;

  while (claimed < claimLimit) {
    if (Date.now() - startedAt >= budgetMs) {
      budgetExhausted = true;
      break;
    }

    const { data: claimedRows, error } = await rpcClient.rpc("fn_claim_calendar_mutations", {
      p_limit: 1,
    });
    if (error) {
      throw new Error(`fn_claim_calendar_mutations failed: ${error.message}`);
    }
    const row = claimedRows?.[0];
    if (!row) break;

    claimed += 1;
    // Defense-in-depth: `processClaimedCalendarMutation` is documented to
    // never throw, but this loop must not bet the whole sweep on that
    // invariant holding forever — a claimed row already burned its
    // attempt, and one row's unexpected rejection must never prevent the
    // next claimed row (or the next sweep iteration) from being processed.
    let outcome: CalendarMutationOutcome;
    try {
      outcome = await processClaimedCalendarMutation(supabase, row, { deadlineAt });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      reportError(e, {
        tags: { surface: "cron_calendar_mutation_sweep_unhandled" },
        extra: { ledgerId: row.ledger_id },
      });
      outcomes.sweep_level_error = (outcomes.sweep_level_error ?? 0) + 1;
      continue;
    }
    outcomes[outcome.status] = (outcomes[outcome.status] ?? 0) + 1;
    if (
      outcome.status === "retryable_error" ||
      outcome.status === "permanent_error" ||
      // Codex round 1 (finding 4): a known Google event the worker
      // couldn't act on yet (missing token/pref) — same observability as
      // retryable_error, since it's the same "keep an eye on this" shape.
      outcome.status === "stale_event_needs_token"
    ) {
      reportError(new Error(outcome.error), {
        tags: { surface: "cron_calendar_mutation_sweep_outcome" },
        extra: { ledgerId: outcome.ledgerId, outcomeStatus: outcome.status },
      });
    }
    // Round 9: finalize_conflict is rare (nothing should race a bare
    // `create` ahead of PR 3's chain-serialization index) but silent —
    // unlike retryable/permanent_error it isn't a Google failure, it's the
    // task's calendar_generation moving out from under this create between
    // claim and finalize, leaving the row stuck at provider_done with an
    // orphaned Google event until PR 3's reconciliation lands. Every
    // occurrence is reported individually (not batched like needs_repair
    // above) since it's expected to be effectively zero in steady state.
    if (outcome.status === "finalize_conflict") {
      reportError(
        new Error("calendar-mutation-sweep: finalize CAS lost (calendar_generation moved)"),
        {
          tags: { surface: "cron_calendar_mutation_sweep_outcome", kind: "finalize_conflict" },
          extra: { ledgerId: outcome.ledgerId, taskId: outcome.taskId },
        },
      );
    }
  }

  return { claimed, expired: expiredCount, needsRepair: needsRepairCount, outcomes, budgetExhausted };
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
