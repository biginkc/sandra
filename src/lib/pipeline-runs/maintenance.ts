import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

type Admin = SupabaseClient<Database>;

export const STALE_RUNNING_REASON = "stale_running";

/**
 * Close out runs that never reached a terminal state (crashed function,
 * lost workflow). Only `running` rows older than the cutoff are touched.
 * Throws on DB error so the cron route can report it.
 */
export async function sweepStalePipelineRuns(
  admin: Admin,
  opts: { olderThanMinutes?: number; now?: Date } = {},
): Promise<{ swept: number }> {
  const minutes = opts.olderThanMinutes ?? 30;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - minutes * 60_000).toISOString();
  const { data, error } = await admin
    .from("pipeline_runs")
    .update({
      status: "error",
      reason: STALE_RUNNING_REASON,
      completed_at: now.toISOString(),
    })
    .eq("status", "running")
    .lt("started_at", cutoff)
    .select("id");
  if (error) throw new Error(`sweep stale pipeline runs failed: ${error.message}`);
  return { swept: data?.length ?? 0 };
}

/**
 * Coverage: inbound SMS vs. runs recorded in the window. A gap means the
 * recording seam missed messages (or the kill switch is on).
 */
export async function getPipelineCoverage(
  admin: Admin,
  orgId: string,
  opts: { sinceMinutes?: number; now?: Date } = {},
): Promise<{ inboundMessages: number; runs: number }> {
  const minutes = opts.sinceMinutes ?? 60;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - minutes * 60_000).toISOString();
  const [inbound, runs] = await Promise.all([
    admin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("channel", "sms")
      .eq("direction", "inbound")
      .gte("created_at", since),
    admin
      .from("pipeline_runs")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .gte("started_at", since),
  ]);
  if (inbound.error) {
    throw new Error(`pipeline coverage inbound count failed: ${inbound.error.message}`);
  }
  if (runs.error) {
    throw new Error(`pipeline coverage run count failed: ${runs.error.message}`);
  }
  return { inboundMessages: inbound.count ?? 0, runs: runs.count ?? 0 };
}
