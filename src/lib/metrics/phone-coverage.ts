import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

/**
 * Count properties that have at least one homeowner phone number and
 * upsert the result into metric_snapshots for today. A re-run on the
 * same day updates the existing row rather than creating a duplicate.
 *
 * Throws on DB error so the cron handler can surface a 500.
 */
export async function capturePhoneCoverageSnapshot(
  supabase: SupabaseClient<Database>,
): Promise<{ numerator: number; denominator: number }> {
  const { data, error: countErr } = await supabase.rpc(
    "count_phone_coverage_stats",
  );
  if (countErr) {
    throw new Error(
      `capturePhoneCoverageSnapshot: count failed: ${countErr.message}`,
    );
  }

  const row = (
    data as Array<{ numerator: number; denominator: number }> | null
  )?.[0];
  const numerator = Number(row?.numerator ?? 0);
  const denominator = Number(row?.denominator ?? 0);

  const { error: upsertErr } = await supabase
    .from("metric_snapshots")
    .upsert(
      {
        metric_key: "phone_coverage",
        numerator,
        denominator,
        captured_at: new Date().toISOString(),
      },
      { onConflict: "metric_key,captured_on" },
    );
  if (upsertErr) {
    throw new Error(
      `capturePhoneCoverageSnapshot: upsert failed: ${upsertErr.message}`,
    );
  }

  return { numerator, denominator };
}
