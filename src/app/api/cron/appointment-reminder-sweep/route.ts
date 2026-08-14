import { after, NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import {
  deliverAppointmentReminder,
  markReminderDeliveryTimedOut,
  resolveTimedOutReminderDelivery,
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
 *   2. `fn_claim_reminder_retries(p_limit)` — crash-safety complement:
 *      failed deliveries with attempts<3, or pending deliveries stuck
 *      >10min (a sweep that claimed but crashed before marking
 *      sent/failed). Codex round 4 (finding 1): claimed one row at a time
 *      inside its own budget-checked loop, same pattern as the primary
 *      claim — see that round's comment on the retry loop below for why a
 *      bulk `p_limit: retryLimit` call was wrong.
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
 * Codex round 5 (finding 1) — claim SCHEDULING inside the shared budget:
 * round 3/4 made both claims budget-checked and one-row-at-a-time, but the
 * route still ran the primary loop to completion (up to
 * `primaryClaimLimit` appointments) BEFORE ever attempting a retry. Under
 * sustained primary volume the primary loop alone can consume the entire
 * `SWEEP_BUDGET_MS`, so the retry loop never runs at all — an eligible
 * retry (a recoverable Slack/SMS failure) sits unclaimed while its 15-
 * minute grace (see above) keeps ticking. Two sweeps in a row starved this
 * way (10 minutes) leaves only one more sweep before the grace expires and
 * `fn_claim_reminder_retries` permanently suppresses the row — a
 * transient delivery failure becomes a silently dropped reminder.
 *
 * Fix: three phases inside the same budget, not one-way primary-then-retry:
 *   1. Retries FIRST, up to `RETRY_RESERVED_QUOTA` (10) rows or half the
 *      remaining budget, whichever comes first. Retries are closest to
 *      expiry (they've already failed once), so they always get first
 *      claim on budget every sweep, regardless of primary backlog size —
 *      this is what guarantees an eligible retry is attempted before its
 *      grace can expire across two consecutive sweeps.
 *   2. Primaries, for whatever budget remains. The phase-1 cap (10 rows /
 *      half-budget) is a reservation in the other direction: a retry
 *      backlog can never consume the FULL budget in phase 1, so primaries
 *      are guaranteed to run every sweep too.
 *   3. Any budget still unused after primaries goes back to retries — so a
 *      light primary load doesn't leave banked budget on the table when
 *      there's a deeper retry backlog than phase 1's reserved quota.
 * Each phase reuses the same one-row-at-a-time, budget-checked-before-every-
 * claim discipline from rounds 3/4; only the ORDER and the phase-1 cap are
 * new.
 *
 * Full plan: reactive-puzzling-crane.md v9, PR 3 "Atomic claim RPC" +
 * "Delivery semantics".
 */
export const maxDuration = 60;

const SWEEP_BUDGET_MS = 45_000;
/** Max delivery rows the retry claim will process in one sweep — not a
 *  batch-claim size; `fn_claim_reminder_retries` is always called with
 *  `p_limit: 1` inside a budget-checked loop (Codex round 4, finding 1),
 *  same pattern as the primary claim. */
const RETRY_CLAIM_LIMIT = 50;
/** Max appointments the primary window claim will process in one sweep —
 *  not a batch-claim size; `fn_claim_appointment_reminders` is always
 *  called with `p_limit: 1` (see module comment above). */
const MAX_APPOINTMENTS_PER_SWEEP = 50;
/** Codex round 5 (finding 1): the reserved "retries go first" quota — the
 *  retry phase (phase 1, see the scheduling rationale above) stops after
 *  this many rows even if more are eligible and budget remains, so a deep
 *  retry backlog can't consume the whole sweep before primaries get a
 *  turn. Phase 1 also stops at half the remaining budget, whichever comes
 *  first — the item cap alone isn't enough if individual deliveries are
 *  slow. */
const RETRY_RESERVED_QUOTA = 10;

/** Codex round 6 (finding 2): a single slack/sms provider call has no bound
 *  of its own (Slack SDK: no default request timeout; Sendillo: same,
 *  though round 7 adds best-effort cancellation via AbortSignal — see
 *  `withDeliveryDeadline`) and could otherwise consume this row's
 *  remaining phase budget or the whole `SWEEP_BUDGET_MS` sweep, starving
 *  every row behind it. `deliverRow` below races `deliverAppointmentReminder`
 *  against a per-row deadline derived from whichever budget boundary
 *  applies to the CURRENT phase (phase 1's `halfBudgetMs` reservation cap,
 *  or the plain overall budget for phases 2/3) — see `withDeliveryDeadline`.
 *  Bell is exempt: it's a direct DB write (`createNotification`), not an
 *  external provider call, so it isn't in scope for this finding and isn't
 *  raced. */
const REMINDER_TIMED_OUT_LAST_ERROR = "delivery timeout, completion ambiguous";

/**
 * Races one delivery against `deadlineMs`.
 *
 * Codex round 7 (finding 1): round 6 recorded a timeout as a retryable
 * `failed` outcome — but the abandoned provider call is NOT cancelled (true
 * cross-SDK cancellation isn't reliable), so it can still reach Slack/
 * Sendillo AFTER that write lands. A `failed` row is immediately
 * retry-eligible; a late provider SUCCESS can't persist over it (the fence
 * expects `failed`, not the real eventual status), so the retry worker
 * re-sends on top of a delivery that may already have gone out — a
 * guaranteed duplicate under a slow provider.
 *
 * Fix: a timed-out row is fenced into `timeout_ambiguous` instead (see
 * `markReminderDeliveryTimedOut`'s doc comment) — a non-resend holding
 * state, excluded from `fn_claim_reminder_retries`'s eligibility by
 * construction. The still-running `runPromise` gets a continuation (via
 * `after()`, so it survives past this sweep's own HTTP response) that
 * fences the row's REAL resolution once it settles:
 * `resolveTimedOutReminderDelivery` writes `timeout_ambiguous -> sent`
 * (with the real provider id) on late success, or `timeout_ambiguous ->
 * failed` (now safely retryable — the provider definitively did not
 * deliver) on late definite failure. A continuation that itself never
 * resolves leaves the row in `timeout_ambiguous` — surfaced by
 * `reportLingeringAmbiguousDeliveries` below once it's been stuck an hour,
 * for manual operator reconciliation.
 */
async function withDeliveryDeadline(
  supabase: ReturnType<typeof createServiceRoleClient>,
  row: ClaimedReminderRow,
  deadlineMs: number,
): Promise<ReminderDeliveryOutcome> {
  // Codex round 7 (finding 1, item 5): best-effort cancellation for the sms
  // channel's fetch-based Sendillo call (bell/slack ignore this signal —
  // see deliverAppointmentReminder's doc comment). Tearing down the
  // connection at the deadline shrinks how long a timed-out row can sit
  // ambiguous waiting for `runPromise` to settle on its own; it does NOT
  // change how the eventual outcome is interpreted (see
  // SendilloMessagingProvider.sendSms's doc comment for why not).
  const deadlineController = new AbortController();
  const runPromise = deliverAppointmentReminder(supabase, row, {
    signal: deadlineController.signal,
  });

  const TIMED_OUT = Symbol("delivery-timed-out");
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      deadlineController.abort();
      resolve(TIMED_OUT);
    }, Math.max(0, deadlineMs));
  });

  const result = await Promise.race([runPromise, timeoutPromise]);
  clearTimeout(timer!);
  if (result !== TIMED_OUT) {
    return result;
  }

  await markReminderDeliveryTimedOut(supabase, row);

  after(async () => {
    try {
      const lateOutcome = await runPromise;
      await resolveTimedOutReminderDelivery(supabase, row, lateOutcome);
    } catch (error) {
      // deliverAppointmentReminder never throws (see its own doc comment)
      // — this is defense-in-depth for a genuinely unexpected rejection.
      // The true outcome is unknown here (unlike a definite sent/failed
      // result), so the row is deliberately left in timeout_ambiguous
      // rather than guessed at — the hourly lingering-ambiguous telemetry
      // surfaces it for manual reconciliation.
      reportError(error instanceof Error ? error : new Error(String(error)), {
        tags: { surface: "cron_appointment_reminder_sweep_late_rejection" },
        extra: { deliveryId: row.deliveryId, channel: row.channel },
      });
    }
  });

  return { status: "timeout_ambiguous", deliveryId: row.deliveryId, channel: row.channel };
}

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
  /** Codex round 4 (finding 3): only `fn_claim_reminder_retries` ever
   *  populates this (undefined on every `fn_claim_appointment_reminders`
   *  row, which shares this same RPC row shape) — non-null means a PRIOR
   *  attempt already reached the provider (Slack/SMS) and only crashed on
   *  its own mark-sent write. `deliverAppointmentReminder` reconciles
   *  (marks sent using this id) instead of re-sending. */
  provider_message_id?: string | null;
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
    providerMessageId: row.provider_message_id ?? null,
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
    // Codex round 7 (finding 1), item 4: kept OUTSIDE
    // `runAppointmentReminderSweep` deliberately — that function's own unit
    // tests drive it against an `rpc`-only fake Supabase client, and this
    // telemetry query is a `.from(...)` call unrelated to the claim/delivery
    // loop's own budget/outcome contract. Never lets a telemetry failure
    // fail the sweep's own response — see its own try/catch.
    await reportLingeringAmbiguousDeliveries(supabase);
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    reportError(e, { tags: { surface: "cron_appointment_reminder_sweep" } });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown" },
      { status: 500 },
    );
  }
}

const AMBIGUOUS_STALE_THRESHOLD_MS = 60 * 60 * 1000;

/**
 * Codex round 7 (finding 1), item 4: `timeout_ambiguous` rows are
 * deliberately excluded from `fn_claim_reminder_retries`'s eligibility (its
 * candidates CTE only ever matches `status IN ('failed', 'pending')` — see
 * 20260814200000_appointment_reminders.sql) so a row this route can't
 * confirm sent/failed is NEVER auto-resent. That means a row whose
 * continuation (see `withDeliveryDeadline`'s `after()` call) never
 * resolves — the provider call itself hung past this function's own
 * `maxDuration`, or the continuation was killed before finishing — has no
 * automatic path out of `timeout_ambiguous`.
 *
 * Surfaces any such row older than an hour so an operator notices and
 * reconciles it manually: check the Slack/Sendillo dashboard for whether
 * the message actually went out, then `update task_reminder_deliveries set
 * status = 'sent' | 'failed' where id = ...` directly (no RPC needed —
 * this table is service-role-only).
 *
 * `created_at` is used as the staleness clock in lieu of a dedicated
 * `ambiguous_since`/`resolved_at` column: a delivery row is only ever
 * inserted right before its first provider call (at claim time, near
 * `due_at`), so it's a close proxy for "how long has this been
 * unresolved" without a schema change beyond this fix's scope.
 */
export async function reportLingeringAmbiguousDeliveries(
  supabase: ReturnType<typeof createServiceRoleClient>,
): Promise<void> {
  const cutoff = new Date(Date.now() - AMBIGUOUS_STALE_THRESHOLD_MS).toISOString();
  const { count, error } = await supabase
    .from("task_reminder_deliveries")
    .select("id", { count: "exact", head: true })
    .eq("status", "timeout_ambiguous")
    .lt("created_at", cutoff);

  if (error) {
    reportError(new Error(`lingering timeout_ambiguous count query failed: ${error.message}`), {
      tags: { surface: "cron_appointment_reminder_sweep_ambiguous_telemetry" },
    });
    return;
  }
  if (count && count > 0) {
    reportError(
      new Error(`${count} appointment reminder deliveries stuck in timeout_ambiguous >1h`),
      {
        tags: { surface: "cron_appointment_reminder_sweep_ambiguous_telemetry" },
        extra: { count },
      },
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
  // Phase 1's reservation boundary (see the scheduling doc comment above) —
  // hoisted above its original single use site so `deliverRow` /
  // `claimAndDeliverOneRetryRow` can derive each delivery's timeout
  // deadline from it too (Codex round 6, finding 2).
  const halfBudgetMs = budgetMs / 2;

  const outcomes: Record<string, number> = {};
  let processed = 0;
  let budgetExhausted = false;

  async function deliverRow(
    raw: ClaimedReminderRpcRow,
    attemptsAlreadyBumped: boolean,
    deadlineMs: number,
  ): Promise<void> {
    processed += 1;
    const claimedRow = toClaimedRow(raw, { attemptsAlreadyBumped });
    let outcome: ReminderDeliveryOutcome;
    try {
      // Codex round 6 (finding 2): bell is a direct DB write
      // (`createNotification`), not an external provider call — no bound
      // needed. Slack/sms go through the race so a hung provider call can't
      // consume this row's phase/sweep budget.
      outcome =
        raw.channel === "bell"
          ? await deliverAppointmentReminder(supabase, claimedRow)
          : await withDeliveryDeadline(supabase, claimedRow, deadlineMs);
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
    } else if (outcome.status === "timeout_ambiguous") {
      // Codex round 7 (finding 1): distinct from a genuine `failed` — this
      // row isn't retryable yet, just unresolved. Reported immediately
      // (per-occurrence) as a lower-severity signal; `timeout_ambiguous`
      // rows still stuck an hour later are separately escalated by
      // `reportLingeringAmbiguousDeliveries`.
      reportError(new Error(REMINDER_TIMED_OUT_LAST_ERROR), {
        tags: { surface: "cron_appointment_reminder_sweep_outcome_ambiguous" },
        extra: { deliveryId: raw.delivery_id, channel: raw.channel },
      });
    } else if (outcome.status === "aborted_ambiguous") {
      // Codex round 8: `deliverSms` can return this directly (not only via
      // the timeout race — e.g. Sendillo's own internal send timeout can
      // abort before the sweep's own deadline does) without ever going
      // through `withDeliveryDeadline`'s timeout branch, so it needs its
      // own report here too, same lower-severity posture as
      // `timeout_ambiguous` above.
      reportError(new Error(outcome.lastError), {
        tags: { surface: "cron_appointment_reminder_sweep_outcome_ambiguous" },
        extra: { deliveryId: raw.delivery_id, channel: raw.channel },
      });
    }
  }

  // Claim one appointment via the primary window claim (p_limit: 1) and
  // deliver every channel row it produced. Budget-checked BEFORE the claim
  // call and again before each row's delivery — mirrors calendar-mutation-
  // sweep's solved pattern (Codex round 3, finding 1). Claiming immediately
  // before processing means reminder_claimed_at/the delivery lease is only
  // spent on an appointment this sweep is actually about to attempt; an
  // appointment the budget runs out before reaching is simply never
  // claimed, left for the next sweep 5 minutes later (well inside the
  // 30-minute window). Returns false when the budget was already spent
  // (sets `budgetExhausted`) or nothing was due — either way the caller's
  // loop should stop.
  let claimedAppointments = 0;
  async function claimAndDeliverOnePrimaryAppointment(): Promise<boolean> {
    if (Date.now() - startedAt >= budgetMs) {
      budgetExhausted = true;
      return false;
    }
    const { data: claimedRows, error: claimError } = await rpcClient.rpc(
      "fn_claim_appointment_reminders",
      { p_limit: 1 },
    );
    if (claimError) {
      throw new Error(`fn_claim_appointment_reminders failed: ${claimError.message}`);
    }
    if (!claimedRows || claimedRows.length === 0) return false; // nothing due right now
    claimedAppointments += 1;
    for (const raw of claimedRows) {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= budgetMs) {
        budgetExhausted = true;
        break;
      }
      // Phase 2 has no boundary short of the overall budget.
      await deliverRow(raw, false, budgetMs - elapsed);
    }
    return true;
  }

  // Claim one delivery row via the retry claim (crash-safety complement)
  // and deliver it. Codex round 4 (finding 1): same budget-checked,
  // one-row-at-a-time pattern as the primary claim — NOT a single bulk call
  // for up to retryLimit rows. fn_claim_reminder_retries atomically bumps
  // `attempts` (and mints a fresh lease) on every row it claims within that
  // one call, regardless of whether this sweep's delivery loop actually
  // gets to all of them before the budget runs out. A bulk claim of, say,
  // 50 rows followed by a budget-exhausted delivery loop left the
  // undelivered remainder with attempts already spent on a lease they never
  // got a chance to use — nudging rows toward the attempts<3 cap without
  // ever being attempted, the exact bug the primary claim's p_limit:1 loop
  // already solved. Claiming one row immediately before delivering it means
  // a row's attempts/lease are only spent right before this sweep is
  // actually about to act on it; a row the budget runs out before reaching
  // is simply never claimed this pass, left for the next sweep with
  // attempts untouched — same contract as the primary claim.
  const retryRows: ClaimedReminderRpcRow[] = [];
  /** `phaseBoundaryMs` is `halfBudgetMs` for phase 1's calls (so a hung
   *  delivery is timed out at the phase-1/phase-2 boundary, not just the
   *  overall budget) and `budgetMs` for phase 3's (no boundary short of the
   *  overall budget by then) — Codex round 6, finding 2. */
  async function claimAndDeliverOneRetryRow(phaseBoundaryMs: number): Promise<boolean> {
    if (Date.now() - startedAt >= budgetMs) {
      budgetExhausted = true;
      return false;
    }
    const { data, error: retryError } = await rpcClient.rpc("fn_claim_reminder_retries", {
      p_limit: 1,
    });
    if (retryError) {
      throw new Error(`fn_claim_reminder_retries failed: ${retryError.message}`);
    }
    if (!data || data.length === 0) return false; // nothing eligible right now
    retryRows.push(...data);
    for (const raw of data) {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= budgetMs) {
        budgetExhausted = true;
        break;
      }
      const deadlineMs = Math.min(phaseBoundaryMs, budgetMs) - elapsed;
      await deliverRow(raw, true, deadlineMs);
    }
    return true;
  }

  // Phase 1 — retries first, reserved quota (Codex round 5, finding 1: see
  // the scheduling rationale in the module doc comment). Stops at
  // RETRY_RESERVED_QUOTA rows, at half the budget, on budget exhaustion, or
  // when nothing more is eligible — whichever comes first.
  const retryFirstPassCap = Math.min(retryLimit, RETRY_RESERVED_QUOTA);
  while (
    retryRows.length < retryFirstPassCap &&
    !budgetExhausted &&
    Date.now() - startedAt < halfBudgetMs
  ) {
    const claimed = await claimAndDeliverOneRetryRow(halfBudgetMs);
    if (!claimed) break;
  }

  // Phase 2 — primaries get whatever budget remains after phase 1's
  // reservation. Phase 1's cap guarantees this phase always gets a turn,
  // even under a deep retry backlog.
  while (!budgetExhausted && claimedAppointments < primaryClaimLimit) {
    const claimed = await claimAndDeliverOnePrimaryAppointment();
    if (!claimed) break;
  }

  // Phase 3 — any budget left after primaries goes back to retries, so a
  // retry backlog deeper than phase 1's reserved quota still gets processed
  // this sweep when there's room, instead of banking unused budget.
  while (!budgetExhausted && retryRows.length < retryLimit) {
    const claimed = await claimAndDeliverOneRetryRow(budgetMs);
    if (!claimed) break;
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
