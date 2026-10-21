import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

type Admin = SupabaseClient<Database>;

export const STALE_RUNNING_REASON = "stale_running";

/** Steps that mean "this run is intentionally parked until a later wake". */
export const WAIT_STEP_NAMES = [
  "retry_scheduled",
  "nine_reply_deferred",
  "reply_delay_scheduled",
] as const;

/** Grace after a waiting run's scheduled wake before it counts as crashed. */
export const WAIT_WAKE_MARGIN_MINUTES = 30;

const PAGE = 500;
const ID_CHUNK = 100;

/**
 * Latest scheduled wake per run (max over its wait steps). Ids go in small
 * chunks (URL length) and each chunk is paged (response row cap) so no
 * newer wait step is missed. A wait step without delaySeconds (e.g. the 20s
 * fence re-dispatch) wakes at created_at; the margin covers the short delay.
 */
async function latestWakeByRun(admin: Admin, ids: string[]): Promise<Map<string, number>> {
  const wakeByRun = new Map<string, number>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    for (let from = 0; ; from += PAGE) {
      const { data: waits, error } = await admin
        .from("pipeline_run_steps")
        .select("id, run_id, created_at, detail")
        .in("run_id", chunk)
        .in("name", [...WAIT_STEP_NAMES])
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`sweep stale pipeline runs failed: ${error.message}`);
      for (const w of waits ?? []) {
        const detail = (w.detail ?? {}) as { delaySeconds?: unknown };
        const delay = typeof detail.delaySeconds === "number" ? detail.delaySeconds : 0;
        const wake = new Date(w.created_at).getTime() + delay * 1000;
        if (!Number.isFinite(wake)) continue;
        wakeByRun.set(w.run_id, Math.max(wakeByRun.get(w.run_id) ?? 0, wake));
      }
      if (!waits || waits.length < PAGE) break;
    }
  }
  return wakeByRun;
}

/**
 * Close out runs that never reached a terminal state (crashed function,
 * lost workflow). Only `running` rows older than the cutoff are touched.
 * A run whose latest wait step (retry / send-window deferral / reply delay)
 * schedules a wake time is left alone until wake + WAIT_WAKE_MARGIN_MINUTES.
 * Throws on DB error so the cron route can report it.
 */
export async function sweepStalePipelineRuns(
  admin: Admin,
  opts: { olderThanMinutes?: number; now?: Date } = {},
): Promise<{ swept: number }> {
  const minutes = opts.olderThanMinutes ?? 30;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - minutes * 60_000).toISOString();
  const ids: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("pipeline_runs")
      .select("id")
      .eq("status", "running")
      .lt("started_at", cutoff)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`sweep stale pipeline runs failed: ${error.message}`);
    ids.push(...(data ?? []).map((r) => r.id));
    if (!data || data.length < PAGE) break;
  }
  if (ids.length === 0) return { swept: 0 };

  const wakeByRun = await latestWakeByRun(admin, ids);
  const marginMs = WAIT_WAKE_MARGIN_MINUTES * 60_000;
  const stale = ids.filter((id) => {
    const wake = wakeByRun.get(id);
    return wake === undefined || now.getTime() >= wake + marginMs;
  });
  if (stale.length === 0) return { swept: 0 };

  const sweptIds: string[] = [];
  for (let i = 0; i < stale.length; i += ID_CHUNK) {
    const { data, error } = await admin
      .from("pipeline_runs")
      .update({
        status: "error",
        reason: STALE_RUNNING_REASON,
        completed_at: now.toISOString(),
      })
      .in("id", stale.slice(i, i + ID_CHUNK))
      .eq("status", "running")
      .select("id");
    if (error) throw new Error(`sweep stale pipeline runs failed: ${error.message}`);
    sweptIds.push(...(data ?? []).map((r) => r.id));
  }

  // Race close-out. A wait step inserted after our read but before our
  // update is visible now, so re-read and reopen those runs. A wait step
  // inserted after our update reopens the run itself (recordStep).
  const recheck = sweptIds.length ? await latestWakeByRun(admin, sweptIds) : new Map();
  const reopen = sweptIds.filter((id) => {
    const wake = recheck.get(id);
    return wake !== undefined && now.getTime() < wake + marginMs;
  });
  for (let i = 0; i < reopen.length; i += ID_CHUNK) {
    const { error } = await admin
      .from("pipeline_runs")
      .update({ status: "running", reason: null, completed_at: null })
      .in("id", reopen.slice(i, i + ID_CHUNK))
      .eq("status", "error")
      .eq("reason", STALE_RUNNING_REASON);
    if (error) throw new Error(`sweep stale pipeline runs failed: ${error.message}`);
  }
  const swept = sweptIds.length - reopen.length;
  return { swept };
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
