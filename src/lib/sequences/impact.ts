import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

/**
 * Count enrollments that would be affected by a sequence edit, so the
 * edit-time impact modal can render "This edit affects N leads (M
 * scheduled for the next step within 7d)".
 *
 * `total_enrolled` counts both active + paused enrollments (paused can
 * be resumed so future edits still affect them).
 * `scheduled_next_7d` counts only active enrollments whose `next_run_at`
 * lands inside the next 7 days — those are the ones most likely to
 * experience the edited step.
 */
export async function getSequenceImpact(
  client: SupabaseClient<Database>,
  sequenceId: string,
): Promise<{ total_enrolled: number; scheduled_next_7d: number }> {
  const now = new Date();
  const sevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const [totalResult, nearResult] = await Promise.all([
    client
      .from("sequence_enrollments")
      .select("*", { count: "exact", head: true })
      .eq("sequence_id", sequenceId)
      .in("status", ["active", "paused"]),
    client
      .from("sequence_enrollments")
      .select("*", { count: "exact", head: true })
      .eq("sequence_id", sequenceId)
      .eq("status", "active")
      .not("next_run_at", "is", null)
      .lte("next_run_at", sevenDays.toISOString()),
  ]);

  return {
    total_enrolled: totalResult.count ?? 0,
    scheduled_next_7d: nearResult.count ?? 0,
  };
}
