import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

/**
 * Delete notifications older than 90 days. Called by the daily Vercel
 * cron at `/api/cron/notification-cleanup`. Returns the number of rows
 * deleted so the cron endpoint can surface a usable response.
 *
 * Throws on DB error so the cron handler can report a 500 — the cron
 * isn't time-critical and a clear failure beats a silent swallow.
 */
const RETENTION_DAYS = 90;

export async function runNotificationCleanup(
  supabase: SupabaseClient<Database>,
): Promise<{ deleted: number }> {
  const cutoff = new Date(
    Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { error, count } = await supabase
    .from("notifications")
    .delete({ count: "exact" })
    .lt("created_at", cutoff);
  if (error) {
    throw new Error(`runNotificationCleanup failed: ${error.message}`);
  }
  return { deleted: count ?? 0 };
}
