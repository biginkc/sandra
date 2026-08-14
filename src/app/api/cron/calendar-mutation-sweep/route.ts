import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import {
  processClaimedCalendarCreation,
  type CalendarCreationOutcome,
  type ClaimedCalendarCreationRow,
} from "@/lib/integrations/google/create-worker";
import type { Database } from "@/lib/supabase/types";

/**
 * Vercel cron → `/api/cron/calendar-mutation-sweep` every 5 minutes
 * (off-minute offset from sequence-tick, same idiom as
 * sweep-stuck-skip-trace/phone-coverage-snapshot's staggered schedules so
 * every 5-minute cron doesn't fire in the same tick).
 *
 * PR-2 pull-forward of PR 3's durable calendar-mutation ledger consumer —
 * the `create`/`pending` slice only (PR 3 adds the sibling sweep for
 * reschedule/reassign/cancel). Claims via the service-role-only
 * `fn_claim_calendar_creations` RPC (FOR UPDATE SKIP LOCKED, attempts
 * bumped atomically with the claim), then hands each row to
 * `processClaimedCalendarCreation`, which talks to Google and advances
 * the ledger through provider_done -> finalized (or leaves it pending
 * with `last_error` set for a transient failure, or fails it terminally
 * for a permanent auth/config error).
 *
 * Time budget: same rationale as sequence-tick — this route must never
 * rely on an unbounded loop; it stops cleanly before the platform kill
 * and reports `budgetExhausted` so a partial run is visible.
 */
export const maxDuration = 60;

const CLAIM_LIMIT = 50;
const SWEEP_BUDGET_MS = 45_000;

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

/** fn_claim_calendar_creations is not (and, per this PR's scope, must not
 *  be) in the generated Database["public"]["Functions"] map — same
 *  local-cast pattern as the booking RPC call sites. */
type ClaimRpcClient = {
  rpc(
    fn: "fn_claim_calendar_creations",
    args: { p_limit: number },
  ): Promise<{
    data: ClaimedCalendarCreationRow[] | null;
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
  outcomes: Record<string, number>;
  budgetExhausted: boolean;
}> {
  const budgetMs = opts.budgetMs ?? SWEEP_BUDGET_MS;
  const claimLimit = opts.claimLimit ?? CLAIM_LIMIT;
  const startedAt = Date.now();

  const { data: claimedRows, error } = await (
    supabase as unknown as ClaimRpcClient
  ).rpc("fn_claim_calendar_creations", { p_limit: claimLimit });
  if (error) {
    throw new Error(`fn_claim_calendar_creations failed: ${error.message}`);
  }

  const outcomes: Record<string, number> = {};
  let claimed = 0;
  let budgetExhausted = false;
  for (const row of claimedRows ?? []) {
    if (Date.now() - startedAt >= budgetMs) {
      budgetExhausted = true;
      break;
    }
    claimed += 1;
    const outcome: CalendarCreationOutcome = await processClaimedCalendarCreation(
      supabase,
      row,
    );
    outcomes[outcome.status] = (outcomes[outcome.status] ?? 0) + 1;
    if (outcome.status === "retryable_error" || outcome.status === "permanent_error") {
      reportError(new Error(outcome.error), {
        tags: { surface: "cron_calendar_mutation_sweep_outcome" },
        extra: { ledgerId: outcome.ledgerId, outcomeStatus: outcome.status },
      });
    }
  }

  return { claimed, outcomes, budgetExhausted };
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
