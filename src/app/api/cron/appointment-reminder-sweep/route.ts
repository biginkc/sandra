import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import {
  deliverAppointmentReminder,
  type ClaimedReminderRow,
  type ReminderDeliveryOutcome,
} from "@/lib/notifications/reminders";
import type { Database } from "@/lib/supabase/types";

/**
 * Vercel cron → `/api/cron/appointment-reminder-sweep` every 5 minutes,
 * off-minute offset from both `sequence-tick` (every 5 minutes on the
 * minute) and `calendar-mutation-sweep` (every 5 minutes starting at
 * minute 4) so no two 5-minute crons fire in the same tick (same
 * staggering idiom as every other cron in vercel.json).
 *
 * Two claims per invocation:
 *   1. `fn_claim_appointment_reminders(p_limit)` — the primary window
 *      claim, one appointment at a time (see the budget-loop comment
 *      below). Window is fixed inside the function; each call returns the
 *      freshly-inserted delivery row(s) — one per enabled channel — for a
 *      single appointment newly due in [now, now+30m].
 *   2. `fn_claim_reminder_retries()` — crash-safety complement: failed
 *      deliveries with attempts<3, or pending deliveries stuck >10min
 *      (a sweep that claimed but crashed before marking sent/failed).
 *
 * Every claimed row is delivered via `deliverAppointmentReminder`, which
 * never throws (see its own doc comment) — this loop's try/catch is
 * defense-in-depth only, same posture as `calendar-mutation-sweep`'s own
 * loop: one row's unexpected rejection must never abort the rest of the
 * sweep.
 *
 * Codex round 3 (finding 1): the primary claim used to be a single
 * unbounded call — every appointment due in the window, claimed (and
 * leased) in one shot regardless of whether this sweep had budget left to
 * process them. Mirrors calendar-mutation-sweep's solved pattern instead:
 * `fn_claim_appointment_reminders` now takes `p_limit` and the route calls
 * it with `p_limit: 1` inside a budget-checked loop, one appointment at a
 * time, so reminder_claimed_at/lease is only spent on an appointment this
 * sweep is actually about to attempt — an appointment the budget runs out
 * before reaching is left UNCLAIMED for the next sweep (starts within 5
 * minutes, comfortably inside the 30-minute window). The migration also
 * widens `fn_claim_reminder_retries`'s due_at revalidation to a 15-minute
 * grace past due (was a strict `> now()`) — a near-due overflow row
 * claimed with only seconds to spare would otherwise be suppressed by its
 * own first retry pass once it goes stale-pending 10 minutes later.
 *
 * Full plan: reactive-puzzling-crane.md v9, PR 3 "Atomic claim RPC" +
 * "Delivery semantics".
 */
export const maxDuration = 60;

const SWEEP_BUDGET_MS = 45_000;
const RETRY_CLAIM_LIMIT = 50;
/** Max appointments the primary window claim will process in one sweep —
 *  not a batch-claim size; `fn_claim_appointment_reminders` is always
 *  called with `p_limit: 1` (see module comment above). */
const MAX_APPOINTMENTS_PER_SWEEP = 50;

function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "appointment-reminder-sweep cron needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return createSupabaseClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** fn_claim_appointment_reminders / fn_claim_reminder_retries are not (and,
 *  per this PR's scope, must not be) in the generated
 *  Database["public"]["Functions"] map — same local-cast pattern as the
 *  booking/calendar-sweep RPC call sites. */
type ClaimedReminderRpcRow = {
  delivery_id: string;
  task_id: string;
  org_id: string;
  channel: "bell" | "slack" | "sms";
  attempts: number;
  /** Codex round 2 fix: both claim RPCs now mint a fresh claim_token +
   *  2-minute lease on every row they hand back — `fn_claim_appointment_reminders`
   *  on the initial insert, `fn_claim_reminder_retries` on a reclaim — so
   *  this is never null coming back from either. */
  claim_token: string;
  claimed_status: "pending" | "failed";
  task_title: string;
  task_due_at: string;
  task_end_at: string | null;
  assignee_id: string;
  assignee_timezone: string;
  assignee_reminder_phone: string | null;
};

type ReminderClaimRpcClient = {
  rpc(
    fn: "fn_claim_appointment_reminders",
    args: { p_limit: number },
  ): Promise<{
    data: ClaimedReminderRpcRow[] | null;
    error: { message: string } | null;
  }>;
  rpc(
    fn: "fn_claim_reminder_retries",
    args: { p_limit: number },
  ): Promise<{
    data: ClaimedReminderRpcRow[] | null;
    error: { message: string } | null;
  }>;
};

function toClaimedRow(
  row: ClaimedReminderRpcRow,
  opts: { attemptsAlreadyBumped: boolean },
): ClaimedReminderRow {
  return {
    deliveryId: row.delivery_id,
    taskId: row.task_id,
    orgId: row.org_id,
    channel: row.channel,
    attempts: row.attempts,
    attemptsAlreadyBumped: opts.attemptsAlreadyBumped,
    claimToken: row.claim_token,
    claimedStatus: row.claimed_status,
    taskTitle: row.task_title,
    taskDueAt: row.task_due_at,
    taskEndAt: row.task_end_at,
    assigneeId: row.assignee_id,
    assigneeTimezone: row.assignee_timezone,
    assigneeReminderPhone: row.assignee_reminder_phone,
  };
}

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
    const summary = await runAppointmentReminderSweep(supabase);
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    reportError(e, { tags: { surface: "cron_appointment_reminder_sweep" } });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown" },
      { status: 500 },
    );
  }
}

/**
 * Exported separately from the route so unit tests can drive it against a
 * stubbed Supabase client directly, same split as
 * `runCalendarMutationSweep` / `runSequenceTick`.
 */
export async function runAppointmentReminderSweep(
  supabase: ReturnType<typeof createServiceRoleClient>,
  opts: { budgetMs?: number; retryLimit?: number; primaryClaimLimit?: number } = {},
): Promise<{
  /** Appointments claimed by the primary window this sweep — the claim's
   *  own unit (one at a time, see module comment), NOT delivery rows; one
   *  claimed appointment can carry 1-3 delivery rows (bell/slack/sms). */
  claimed: number;
  /** Delivery rows claimed by the retry RPC. */
  retried: number;
  /** Total delivery rows actually handed to the delivery worker, from
   *  either source. */
  processed: number;
  outcomes: Record<string, number>;
  budgetExhausted: boolean;
}> {
  const budgetMs = opts.budgetMs ?? SWEEP_BUDGET_MS;
  const retryLimit = opts.retryLimit ?? RETRY_CLAIM_LIMIT;
  const primaryClaimLimit = opts.primaryClaimLimit ?? MAX_APPOINTMENTS_PER_SWEEP;
  const startedAt = Date.now();
  const rpcClient = supabase as unknown as ReminderClaimRpcClient;

  const outcomes: Record<string, number> = {};
  let processed = 0;
  let budgetExhausted = false;

  async function deliverRow(
    raw: ClaimedReminderRpcRow,
    attemptsAlreadyBumped: boolean,
  ): Promise<void> {
    processed += 1;
    let outcome: ReminderDeliveryOutcome;
    try {
      outcome = await deliverAppointmentReminder(
        supabase,
        toClaimedRow(raw, { attemptsAlreadyBumped }),
      );
    } catch (e) {
      reportError(e, {
        tags: { surface: "cron_appointment_reminder_sweep_unhandled" },
        extra: { deliveryId: raw.delivery_id, channel: raw.channel },
      });
      outcomes.sweep_level_error = (outcomes.sweep_level_error ?? 0) + 1;
      return;
    }
    outcomes[outcome.status] = (outcomes[outcome.status] ?? 0) + 1;
    if (outcome.status === "failed") {
      reportError(new Error(outcome.error), {
        tags: { surface: "cron_appointment_reminder_sweep_outcome" },
        extra: { deliveryId: raw.delivery_id, channel: raw.channel },
      });
    }
  }

  // Primary window claim: one appointment at a time, budget-checked BEFORE
  // every claim call — mirrors calendar-mutation-sweep's solved pattern
  // (Codex round 3, finding 1). Claiming immediately before processing
  // means reminder_claimed_at/the delivery lease is only spent on an
  // appointment this sweep is actually about to attempt; an appointment
  // the budget runs out before reaching is simply never claimed, left for
  // the next sweep 5 minutes later (well inside the 30-minute window).
  let claimedAppointments = 0;
  while (claimedAppointments < primaryClaimLimit) {
    if (Date.now() - startedAt >= budgetMs) {
      budgetExhausted = true;
      break;
    }
    const { data: claimedRows, error: claimError } = await rpcClient.rpc(
      "fn_claim_appointment_reminders",
      { p_limit: 1 },
    );
    if (claimError) {
      throw new Error(`fn_claim_appointment_reminders failed: ${claimError.message}`);
    }
    if (!claimedRows || claimedRows.length === 0) break; // nothing due right now
    claimedAppointments += 1;

    for (const raw of claimedRows) {
      if (Date.now() - startedAt >= budgetMs) {
        budgetExhausted = true;
        break;
      }
      await deliverRow(raw, false);
    }
    if (budgetExhausted) break;
  }

  // Retry claim: crash-safety complement, bulk claim (already atomically
  // leased/fenced per row by fn_claim_reminder_retries) bounded by
  // retryLimit — only attempted if the primary claim left budget.
  let retryRows: ClaimedReminderRpcRow[] = [];
  if (!budgetExhausted) {
    const { data, error: retryError } = await rpcClient.rpc("fn_claim_reminder_retries", {
      p_limit: retryLimit,
    });
    if (retryError) {
      throw new Error(`fn_claim_reminder_retries failed: ${retryError.message}`);
    }
    retryRows = data ?? [];

    for (const raw of retryRows) {
      if (Date.now() - startedAt >= budgetMs) {
        budgetExhausted = true;
        break;
      }
      await deliverRow(raw, true);
    }
  }

  return {
    claimed: claimedAppointments,
    retried: retryRows.length,
    processed,
    outcomes,
    budgetExhausted,
  };
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
