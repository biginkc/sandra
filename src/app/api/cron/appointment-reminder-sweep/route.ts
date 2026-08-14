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
 *   1. `fn_claim_appointment_reminders()` — the primary window claim.
 *      Takes no params (window is fixed inside the function); returns
 *      every freshly-inserted delivery row for appointments newly due in
 *      [now, now+30m].
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
 * Full plan: reactive-puzzling-crane.md v9, PR 3 "Atomic claim RPC" +
 * "Delivery semantics".
 */
export const maxDuration = 60;

const SWEEP_BUDGET_MS = 45_000;
const RETRY_CLAIM_LIMIT = 50;

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
  /** Only present on rows from `fn_claim_reminder_retries` (Codex round 1
   *  lease/fencing rewrite) — `fn_claim_appointment_reminders`'s fresh
   *  inserts carry no lease and never populate these. */
  claim_token?: string | null;
  claimed_status?: "pending" | "failed" | null;
  task_title: string;
  task_due_at: string;
  task_end_at: string | null;
  assignee_id: string;
  assignee_timezone: string;
  assignee_reminder_phone: string | null;
};

type ReminderClaimRpcClient = {
  rpc(fn: "fn_claim_appointment_reminders"): Promise<{
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

function toClaimedRow(row: ClaimedReminderRpcRow): ClaimedReminderRow {
  return {
    deliveryId: row.delivery_id,
    taskId: row.task_id,
    orgId: row.org_id,
    channel: row.channel,
    attempts: row.attempts,
    claimToken: row.claim_token ?? null,
    claimedStatus: row.claimed_status ?? null,
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
  opts: { budgetMs?: number; retryLimit?: number } = {},
): Promise<{
  claimed: number;
  retried: number;
  processed: number;
  outcomes: Record<string, number>;
  budgetExhausted: boolean;
}> {
  const budgetMs = opts.budgetMs ?? SWEEP_BUDGET_MS;
  const retryLimit = opts.retryLimit ?? RETRY_CLAIM_LIMIT;
  const startedAt = Date.now();
  const rpcClient = supabase as unknown as ReminderClaimRpcClient;

  const { data: claimedRows, error: claimError } = await rpcClient.rpc(
    "fn_claim_appointment_reminders",
  );
  if (claimError) {
    throw new Error(`fn_claim_appointment_reminders failed: ${claimError.message}`);
  }

  const { data: retryRows, error: retryError } = await rpcClient.rpc(
    "fn_claim_reminder_retries",
    { p_limit: retryLimit },
  );
  if (retryError) {
    throw new Error(`fn_claim_reminder_retries failed: ${retryError.message}`);
  }

  const work: ClaimedReminderRpcRow[] = [...(claimedRows ?? []), ...(retryRows ?? [])];
  const outcomes: Record<string, number> = {};
  let processed = 0;
  let budgetExhausted = false;

  for (const raw of work) {
    if (Date.now() - startedAt >= budgetMs) {
      budgetExhausted = true;
      break;
    }
    processed += 1;

    let outcome: ReminderDeliveryOutcome;
    try {
      outcome = await deliverAppointmentReminder(supabase, toClaimedRow(raw));
    } catch (e) {
      reportError(e, {
        tags: { surface: "cron_appointment_reminder_sweep_unhandled" },
        extra: { deliveryId: raw.delivery_id, channel: raw.channel },
      });
      outcomes.sweep_level_error = (outcomes.sweep_level_error ?? 0) + 1;
      continue;
    }
    outcomes[outcome.status] = (outcomes[outcome.status] ?? 0) + 1;
    if (outcome.status === "failed") {
      reportError(new Error(outcome.error), {
        tags: { surface: "cron_appointment_reminder_sweep_outcome" },
        extra: { deliveryId: raw.delivery_id, channel: raw.channel },
      });
    }
  }

  return {
    claimed: claimedRows?.length ?? 0,
    retried: retryRows?.length ?? 0,
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
