import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { processEnrollmentTick } from "@/lib/sequences/tick";
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
 */

const BATCH_SIZE = 100;

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
): Promise<{
  processed: number;
  outcomes: Record<string, number>;
}> {
  const nowIso = new Date().toISOString();
  const { data: due, error } = await supabase
    .from("sequence_enrollments")
    .select(
      "id, sequence_id, property_id, contact_id, current_step_index, enrolled_by_user_id, status",
    )
    .eq("status", "active")
    .not("next_run_at", "is", null)
    .lte("next_run_at", nowIso)
    .order("next_run_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) throw new Error(`fetch due enrollments failed: ${error.message}`);

  const outcomes: Record<string, number> = {};
  for (const enrollment of due ?? []) {
    const outcome = await processEnrollmentTick(supabase, enrollment);
    outcomes[outcome.status] = (outcomes[outcome.status] ?? 0) + 1;
  }

  return {
    processed: (due ?? []).length,
    outcomes,
  };
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
