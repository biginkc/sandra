import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { NormaMissingFunctionError, sweepResumeCallInProgress } from "@/lib/norma";
import type { Database } from "@/lib/supabase/types";

/**
 * Vercel cron → `/api/cron/sweep-stuck-call-in-progress` every five minutes.
 * A tab crash or transport failure can leave a call_in_progress pause behind;
 * only that pause reason is eligible, and only after the 30-minute backstop.
 */
export const maxDuration = 60;

const STALE_AFTER_MS = 30 * 60 * 1000;
const MAX_ROWS_PER_SWEEP = 200;

function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("call-in-progress sweep needs Supabase service credentials.");
  return createSupabaseClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const summary = await runSoftphoneSweep(createServiceRoleClient());
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    reportError(error, { tags: { surface: "cron_sweep_stuck_call_in_progress" } });
    return NextResponse.json({ error: error instanceof Error ? error.message : "unknown" }, { status: 500 });
  }
}

type SweepClient = ReturnType<typeof createServiceRoleClient>;

async function runSoftphoneSweep(
  supabase: SweepClient,
  now = Date.now(),
): Promise<{ candidates: number; resumed: number; skippedCompletedWrapups: number }> {
  const cutoff = new Date(now - STALE_AFTER_MS).toISOString();
  const { data: stale, error: staleError } = await supabase
    .from("sequence_enrollments")
    .select("id, property_id, updated_at")
    .eq("status", "paused")
    .eq("pause_reason", "call_in_progress")
    .lt("updated_at", cutoff)
    .order("updated_at", { ascending: true })
    .limit(MAX_ROWS_PER_SWEEP);
  if (staleError) throw new Error(`fetch stale call pauses failed: ${staleError.message}`);
  if (!stale?.length) return { candidates: 0, resumed: 0, skippedCompletedWrapups: 0 };

  const propertyIds = [...new Set(stale.map((row) => row.property_id).filter((id): id is string => Boolean(id)))];
  const { data: completed, error: completedError } = propertyIds.length
    ? await supabase.from("call_activities").select("property_id, ended_at").in("property_id", propertyIds).not("ended_at", "is", null)
    : { data: [], error: null };
  if (completedError) throw new Error(`fetch completed call wraps failed: ${completedError.message}`);

  const completedByProperty = new Map<string, string[]>();
  for (const row of completed ?? []) {
    if (!row.property_id || !row.ended_at) continue;
    const values = completedByProperty.get(row.property_id) ?? [];
    values.push(row.ended_at);
    completedByProperty.set(row.property_id, values);
  }
  const resumableIds = stale
    .filter((row) => !(completedByProperty.get(row.property_id) ?? []).some((endedAt) => endedAt >= row.updated_at))
    .map((row) => row.id);
  const skippedCompletedWrapups = stale.length - resumableIds.length;
  if (!resumableIds.length) return { candidates: stale.length, resumed: 0, skippedCompletedWrapups };

  // The activation re-checks everything under each enrollment lock: the row is
  // still paused as call_in_progress, and no Norma call request holds the lead.
  // A softphone pause under a Norma hold is left for a later sweep.
  const resumeAt = new Date(now).toISOString();
  let resumed: number;
  try {
    resumed = await sweepResumeCallInProgress(supabase, { enrollmentIds: resumableIds, resumeAt });
  } catch (error) {
    if (!(error instanceof NormaMissingFunctionError)) throw error;
    // Deployed ahead of the Norma migration: no hold exists yet, so use the
    // original activation.
    const { count, error: resumeError } = await supabase
      .from("sequence_enrollments")
      .update({ status: "active", pause_reason: null, next_run_at: resumeAt, updated_at: resumeAt }, { count: "exact" })
      .in("id", resumableIds)
      .eq("status", "paused")
      .eq("pause_reason", "call_in_progress");
    if (resumeError) throw new Error(`resume stale call pauses failed: ${resumeError.message}`);
    resumed = count ?? 0;
  }
  return { candidates: stale.length, resumed, skippedCompletedWrapups };
}

export { handle as POST };
