import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import { getSkipTraceProvider } from "./registry";

export const SKIP_TRACE_CREDITS_METRIC_KEY = "skip_trace_credits";

export type SkipTraceBalance =
  | {
      available: true;
      credits: number;
      tier: "ok" | "low" | "critical";
      capturedAt: string;
    }
  | { available: false; reason: "not_checked" | "read_error" };

type SnapshotRow = Pick<
  Database["public"]["Tables"]["metric_snapshots"]["Row"],
  "numerator" | "captured_at"
>;

export function classifySkipTraceCredits(
  credits: number,
): "ok" | "low" | "critical" {
  return credits < 20 ? "critical" : credits < 100 ? "low" : "ok";
}

/**
 * Read only the last successful provider snapshot. This function deliberately
 * has no provider access so dashboard rendering can never wait on a vendor.
 */
export async function getStoredSkipTraceBalance(
  supabase: SupabaseClient<Database>,
): Promise<SkipTraceBalance> {
  const { data, error } = await supabase
    .from("metric_snapshots")
    .select("numerator, captured_at")
    .eq("metric_key", SKIP_TRACE_CREDITS_METRIC_KEY)
    .order("captured_at", { ascending: false })
    .limit(1);

  if (error) return { available: false, reason: "read_error" };
  const row = (data as SnapshotRow[] | null)?.[0];
  if (!row) return { available: false, reason: "not_checked" };

  return {
    available: true,
    credits: row.numerator,
    tier: classifySkipTraceCredits(row.numerator),
    capturedAt: row.captured_at,
  };
}

/**
 * Make the intentional live provider call and persist it as today's latest
 * successful snapshot. A provider or write failure throws before replacing
 * the prior snapshot, so Overview can continue showing the last known value.
 */
export async function captureSkipTraceBalanceSnapshot(
  supabase: SupabaseClient<Database>,
  capturedAtOverride?: Date,
): Promise<Extract<SkipTraceBalance, { available: true }>> {
  const provider = getSkipTraceProvider();
  if (!provider) throw new Error("Skip-trace provider is not configured");

  const credits = await provider.getBalance();
  if (!Number.isSafeInteger(credits) || credits < 0) {
    throw new Error("Skip-trace provider returned an invalid credit balance");
  }

  // Timestamp the completed reading, not the request start. If a slow cron
  // overlaps a faster manual refresh, completion order is the closest safe
  // proxy for which provider reading is newest.
  const capturedAt = (capturedAtOverride ?? new Date()).toISOString();
  const { data: changed, error } = await supabase.rpc(
    "upsert_skip_trace_credit_snapshot",
    {
      p_credits: credits,
      p_captured_at: capturedAt,
    },
  );
  if (error) {
    throw new Error(`Could not store skip-trace balance: ${error.message}`);
  }

  // Another overlapping request may have persisted a newer reading first.
  // Return what is actually stored instead of reporting an unpersisted value.
  if (changed !== true) {
    const stored = await getStoredSkipTraceBalance(supabase);
    if (stored.available) return stored;
    throw new Error("Could not confirm the stored skip-trace balance");
  }

  return {
    available: true,
    credits,
    tier: classifySkipTraceCredits(credits),
    capturedAt,
  };
}

/** Vercel schedules in UTC; enforce the business window in Chicago time. */
export function isWithinCreditRefreshWindow(now = new Date()): boolean {
  const hourPart = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(now)
    .find((part) => part.type === "hour")?.value;
  const hour = Number(hourPart);
  return Number.isInteger(hour) && hour >= 6;
}
