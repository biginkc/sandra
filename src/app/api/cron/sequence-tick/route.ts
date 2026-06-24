import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { processEnrollmentTick } from "@/lib/sequences/tick";
import { failQueuedMessage, releaseQueuedMessage } from "@/lib/messaging/send";
import type { Database } from "@/lib/supabase/types";

/**
 * Vercel cron → `/api/cron/sequence-tick` every 5 minutes.
 *
 * Fetches up to `BATCH_SIZE` active enrollments due for processing, then
 * hands each one off to `processEnrollmentTick` which handles claim +
 * pause-rule checks + action + advance. The service-role client bypasses
 * RLS; combined with the `sequence_step_runs` unique-index claim, this
 * endpoint is safe to call concurrently (e.g. if Vercel double-fires a
 * scheduled invocation).
 *
 * Returns a summary of outcomes so the cron dashboard can reason about
 * health at a glance.
 *
 * Time budget: before the 2026-06-12 incident this route had no
 * maxDuration and an unbounded drain loop — with a bulk campaign's
 * 8k+ queued messages coming due, Vercel killed the function mid-batch
 * on EVERY run (504 every 5 minutes), churning the DB and risking
 * messages stranded in 'pending'. Both loops now stop cleanly when the
 * elapsed-time budget is spent and report `budgetExhausted` so the cron
 * dashboard can see partial runs. maxDuration gives the worst case
 * (slow provider + slow DB) room to exit through our own guard instead
 * of the platform kill.
 */
export const maxDuration = 300;

const BATCH_SIZE = 100;
/** Max queued-message releases per tick. The elapsed-time budget below is
 *  still the hard safety rail; this cap lets healthy runs catch up faster
 *  while stopping cleanly before the platform can kill the invocation. */
const DRAIN_BATCH_SIZE = 240;
/** Stop starting new work after this much elapsed time — leaves the
 *  remaining maxDuration as headroom for the in-flight release to
 *  finish and the summary to flush. */
const TICK_BUDGET_MS = 240_000;
/** How far a quiet-hours-blocked row is pushed out of the due-window.
 *  Without this, oldest-first + a hard cap lets a head of blocked rows
 *  pin the queue: every tick re-selects the same blocked rows and
 *  eligible messages behind them never release. (Opted-out rows are
 *  terminal-failed instead — they can never become sendable.) */
const BLOCKED_DEFER_MS = 30 * 60_000;

function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "sequence-tick cron needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return createSupabaseClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
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
    const summary = await runSequenceTick(supabase);
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    reportError(e, { tags: { surface: "cron_sequence_tick" } });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown" },
      { status: 500 },
    );
  }
}

/**
 * Exported separately from the route so integration tests can drive it
 * against the test Supabase without constructing an HTTP request +
 * setting CRON_SECRET. Production always goes through the handler.
 */
export async function runSequenceTick(
  supabase: ReturnType<typeof createServiceRoleClient>,
  opts: { budgetMs?: number; drainLimit?: number } = {},
): Promise<{
  processed: number;
  outcomes: Record<string, number>;
  /** Messages actually handed to the provider this tick (status=sent). */
  drained: number;
  /** Per-outcome tally of every release attempt, blocked ones included. */
  drainOutcomes: Record<string, number>;
  budgetExhausted: boolean;
}> {
  const budgetMs = opts.budgetMs ?? TICK_BUDGET_MS;
  const drainLimit = opts.drainLimit ?? DRAIN_BATCH_SIZE;
  const startedAt = Date.now();
  const withinBudget = () => Date.now() - startedAt < budgetMs;
  let budgetExhausted = false;

  const nowIso = new Date().toISOString();
  const { data: due, error } = await supabase
    .from("sequence_enrollments")
    .select(
      "id, org_id, sequence_id, property_id, contact_id, current_step_index, enrolled_by_user_id, status",
    )
    .eq("status", "active")
    .not("next_run_at", "is", null)
    .lte("next_run_at", nowIso)
    .order("next_run_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) throw new Error(`fetch due enrollments failed: ${error.message}`);

  const outcomes: Record<string, number> = {};
  let processed = 0;
  for (const enrollment of due ?? []) {
    if (!withinBudget()) {
      budgetExhausted = true;
      break;
    }
    const outcome = await processEnrollmentTick(supabase, enrollment);
    outcomes[outcome.status] = (outcomes[outcome.status] ?? 0) + 1;
    processed += 1;
  }

  // Drain scheduled queued messages — release any row where
  // scheduled_for <= now. Consent + quiet-hours are re-checked at
  // release time; unreleasable messages (opted-out, quiet hours) are
  // left queued for the next tick. Stops at the time budget so the
  // platform never kills us mid-release; whatever is left stays
  // cleanly `queued` for the next tick.
  const { data: dueMessages } = await supabase
    .from("messages")
    .select("id")
    .eq("status", "queued")
    .lte("scheduled_for", nowIso)
    .not("scheduled_for", "is", null)
    .order("scheduled_for", { ascending: true })
    .limit(drainLimit);

  let drained = 0;
  const drainOutcomes: Record<string, number> = {};
  for (const msg of dueMessages ?? []) {
    if (!withinBudget()) {
      budgetExhausted = true;
      break;
    }
    const outcome = await releaseQueuedMessage(supabase, msg.id);
    drainOutcomes[outcome.status] = (drainOutcomes[outcome.status] ?? 0) + 1;
    if (outcome.status === "sent") {
      drained += 1;
    } else if (outcome.status === "blocked_quiet_hours") {
      // Quiet-hours rows become sendable later — defer them out of the
      // due-window so they stop occupying oldest-first head slots.
      // Guarded on status so we never touch a row another worker
      // resolved in the meantime.
      await supabase
        .from("messages")
        .update({
          scheduled_for: new Date(Date.now() + BLOCKED_DEFER_MS).toISOString(),
        })
        .eq("id", msg.id)
        .eq("status", "queued");
    } else if (
      outcome.status === "blocked_no_consent" ||
      outcome.status === "blocked_terminal_dispo"
    ) {
      // Opted-out or terminal-disposition rows can never send —
      // terminal-fail instead of deferring forever, so queued counts /
      // drain ETA stay truthful and the row surfaces in failed-today.
      await failQueuedMessage(
        supabase,
        msg.id,
        `${outcome.reason} (failed by sequence-tick drain).`,
      );
    }
  }

  return {
    processed,
    outcomes,
    drained,
    drainOutcomes,
    budgetExhausted,
  };
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
